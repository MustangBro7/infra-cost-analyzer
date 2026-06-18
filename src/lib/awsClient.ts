// Minimal AWS Signature Version 4 signing + the two AWS calls we need, built on
// WebCrypto so it also runs on Cloudflare Workers (no aws-sdk dependency).
//
// We use AWS's Free Tier Usage API (GetFreeTierUsage), which returns actual
// consumption against each free-tier limit — exactly what the dashboard needs
// to show "used out of total" for AWS while on the free tier.

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string | null
}

export interface AwsFreeTierUsageItem {
  service: string
  description: string
  actualUsageAmount: number
  limit: number
  unit: string
  freeTierType: string
}

export interface AwsCostRow {
  service: string
  cost: number
  currency: string
  usageQuantity: number | null
  usageUnit: string | null
}

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data) as BufferSource)
  return toHex(new Uint8Array(digest))
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data) as BufferSource)
  return new Uint8Array(signature)
}

export interface Sigv4Input {
  method: string
  host: string
  path: string
  query?: string
  headers?: Record<string, string>
  payload: string
  service: string
  region: string
  credentials: AwsCredentials
  amzDate: string // YYYYMMDDTHHMMSSZ
  dateStamp: string // YYYYMMDD
}

/**
 * Computes the SigV4 Authorization header and signature for a request. Exposed
 * for unit testing against AWS's documented signing test vectors.
 */
export async function sigv4Sign(input: Sigv4Input): Promise<{ authorization: string; signature: string; headers: Record<string, string> }> {
  const baseHeaders: Record<string, string> = {
    host: input.host,
    "x-amz-date": input.amzDate,
    ...(input.headers ?? {}),
  }
  if (input.credentials.sessionToken) {
    baseHeaders["x-amz-security-token"] = input.credentials.sessionToken
  }

  const sortedHeaderKeys = Object.keys(baseHeaders)
    .map((key) => key.toLowerCase())
    .sort()
  const canonicalHeaders = sortedHeaderKeys
    .map((key) => {
      const original = Object.keys(baseHeaders).find((candidate) => candidate.toLowerCase() === key) as string
      return `${key}:${baseHeaders[original].trim().replace(/\s+/g, " ")}\n`
    })
    .join("")
  const signedHeaders = sortedHeaderKeys.join(";")

  const payloadHash = await sha256Hex(input.payload)
  const canonicalRequest = [
    input.method,
    input.path,
    input.query ?? "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")

  const scope = `${input.dateStamp}/${input.region}/${input.service}/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n")

  const kDate = await hmac(new TextEncoder().encode(`AWS4${input.credentials.secretAccessKey}`), input.dateStamp)
  const kRegion = await hmac(kDate, input.region)
  const kService = await hmac(kRegion, input.service)
  const kSigning = await hmac(kService, "aws4_request")
  const signature = toHex(await hmac(kSigning, stringToSign))

  const authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return { authorization, signature, headers: { ...baseHeaders, authorization } }
}

function timestamps(now = new Date()): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

async function awsJsonRequest<T>(input: {
  host: string
  service: string
  region: string
  target: string
  body: unknown
  credentials: AwsCredentials
}): Promise<T> {
  const payload = JSON.stringify(input.body)
  const { amzDate, dateStamp } = timestamps()
  const headers = {
    "content-type": "application/x-amz-json-1.1",
    "x-amz-target": input.target,
  }
  const signed = await sigv4Sign({
    method: "POST",
    host: input.host,
    path: "/",
    query: "",
    headers,
    payload,
    service: input.service,
    region: input.region,
    credentials: input.credentials,
    amzDate,
    dateStamp,
  })
  const response = await fetch(`https://${input.host}/`, {
    method: "POST",
    headers: { ...headers, ...signed.headers },
    body: payload,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`AWS ${input.target} failed ${response.status}: ${text.slice(0, 300)}`)
  }
  return response.json() as Promise<T>
}

/**
 * Verifies credentials by calling STS GetCallerIdentity. Returns the account id
 * and ARN, or throws if the credentials are invalid.
 */
export async function verifyAwsCredentials(credentials: AwsCredentials): Promise<{ accountId: string; arn: string }> {
  const payload = "Action=GetCallerIdentity&Version=2011-06-15"
  const { amzDate, dateStamp } = timestamps()
  const headers = { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }
  const signed = await sigv4Sign({
    method: "POST",
    host: "sts.amazonaws.com",
    path: "/",
    query: "",
    headers,
    payload,
    service: "sts",
    region: "us-east-1",
    credentials,
    amzDate,
    dateStamp,
  })
  const response = await fetch("https://sts.amazonaws.com/", {
    method: "POST",
    headers: { ...headers, ...signed.headers },
    body: payload,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`AWS STS verification failed ${response.status}: ${text.slice(0, 200)}`)
  }
  const accountId = text.match(/<Account>([^<]+)<\/Account>/)?.[1] ?? ""
  const arn = text.match(/<Arn>([^<]+)<\/Arn>/)?.[1] ?? ""
  return { accountId, arn }
}

export interface AwsRoleRef {
  roleArn: string
  externalId: string
  region?: string
}

/**
 * The SaaS principal: the app's own AWS identity (an IAM user with only
 * sts:AssumeRole) that customer read-only roles trust. Locally these come from
 * .env.local; in production they are Worker secrets. Never a customer credential.
 */
function saasCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env): AwsCredentials | null {
  const accessKeyId = env.AWS_SAAS_ACCESS_KEY_ID
  const secretAccessKey = env.AWS_SAAS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) return null
  return { accessKeyId, secretAccessKey, sessionToken: env.AWS_SAAS_SESSION_TOKEN || null }
}

export function hasAwsSaasPrincipal(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AWS_SAAS_ACCESS_KEY_ID && env.AWS_SAAS_SECRET_ACCESS_KEY)
}

/**
 * Assumes a customer's read-only role via STS using the SaaS principal, gated by
 * the per-connection ExternalId (confused-deputy protection). Returns short-lived
 * role credentials (with a session token) used for the actual cost/usage calls.
 * This is the engine behind the one-click "Launch Stack" connect: no long-lived
 * customer keys are ever stored — only the role ARN + external id.
 */
export async function assumeAwsRole(
  ref: AwsRoleRef,
  env: NodeJS.ProcessEnv = process.env
): Promise<AwsCredentials & { accountId: string; arn: string }> {
  const saas = saasCredentialsFromEnv(env)
  if (!saas) {
    throw new Error("AWS SaaS principal is not configured (set AWS_SAAS_ACCESS_KEY_ID and AWS_SAAS_SECRET_ACCESS_KEY).")
  }
  const payload = new URLSearchParams({
    Action: "AssumeRole",
    Version: "2011-06-15",
    RoleArn: ref.roleArn,
    RoleSessionName: "infra-cost-analyzer",
    ExternalId: ref.externalId,
    DurationSeconds: "3600",
  }).toString()
  const { amzDate, dateStamp } = timestamps()
  const headers = { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }
  const signed = await sigv4Sign({
    method: "POST",
    host: "sts.amazonaws.com",
    path: "/",
    query: "",
    headers,
    payload,
    service: "sts",
    region: "us-east-1",
    credentials: saas,
    amzDate,
    dateStamp,
  })
  const response = await fetch("https://sts.amazonaws.com/", {
    method: "POST",
    headers: { ...headers, ...signed.headers },
    body: payload,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`AWS STS AssumeRole failed ${response.status}: ${text.slice(0, 500)}`)
  }
  const accessKeyId = text.match(/<AccessKeyId>([^<]+)<\/AccessKeyId>/)?.[1] ?? ""
  const secretAccessKey = text.match(/<SecretAccessKey>([^<]+)<\/SecretAccessKey>/)?.[1] ?? ""
  const sessionToken = text.match(/<SessionToken>([^<]+)<\/SessionToken>/)?.[1] ?? ""
  const arn = text.match(/<Arn>([^<]+)<\/Arn>/)?.[1] ?? ""
  const accountId = arn.match(/::(\d+):/)?.[1] ?? ""
  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new Error("AWS AssumeRole returned no credentials.")
  }
  return { accessKeyId, secretAccessKey, sessionToken, accountId, arn }
}

/**
 * Turns whatever the AWS connection stored into usable credentials: a role
 * reference ({roleArn, externalId}) is assumed via STS to short-lived creds; a
 * legacy access-key object is returned as-is. Returns null if neither is usable.
 */
export async function resolveAwsCredentials(
  parsed: unknown,
  env: NodeJS.ProcessEnv = process.env
): Promise<AwsCredentials | null> {
  if (parsed && typeof parsed === "object") {
    const candidate = parsed as Partial<AwsRoleRef> & Partial<AwsCredentials>
    if (typeof candidate.roleArn === "string" && typeof candidate.externalId === "string") {
      const assumed = await assumeAwsRole(
        { roleArn: candidate.roleArn, externalId: candidate.externalId, region: candidate.region },
        env
      )
      return { accessKeyId: assumed.accessKeyId, secretAccessKey: assumed.secretAccessKey, sessionToken: assumed.sessionToken }
    }
    if (typeof candidate.accessKeyId === "string" && typeof candidate.secretAccessKey === "string") {
      return { accessKeyId: candidate.accessKeyId, secretAccessKey: candidate.secretAccessKey, sessionToken: candidate.sessionToken ?? null }
    }
  }
  return null
}

/**
 * Calls the AWS Free Tier Usage API (us-east-1 only, on the management account)
 * and returns the items with a positive free-tier limit. Each item carries the
 * real actual-vs-limit numbers AWS reports.
 */
export async function getAwsFreeTierUsage(credentials: AwsCredentials): Promise<AwsFreeTierUsageItem[]> {
  interface RawItem {
    service?: string
    description?: string
    actualUsageAmount?: number
    limit?: number
    unit?: string
    freeTierType?: string
  }
  const collected: RawItem[] = []
  let nextToken: string | undefined
  // The API paginates; loop until there are no more pages (cap to be safe).
  for (let page = 0; page < 20; page += 1) {
    const payload = await awsJsonRequest<{ freeTierUsages?: RawItem[]; nextToken?: string }>({
      host: "freetier.us-east-1.api.aws",
      service: "freetier",
      region: "us-east-1",
      target: "AWSFreeTierService.GetFreeTierUsage",
      body: nextToken ? { maxResults: 1000, nextToken } : { maxResults: 1000 },
      credentials,
    })
    collected.push(...(payload.freeTierUsages ?? []))
    if (!payload.nextToken) break
    nextToken = payload.nextToken
  }

  return collected
    .filter((item) => typeof item.limit === "number" && (item.limit ?? 0) > 0)
    .map((item) => ({
      service: item.service ?? "AWS service",
      description: item.description ?? item.service ?? "AWS free tier",
      actualUsageAmount: typeof item.actualUsageAmount === "number" ? item.actualUsageAmount : 0,
      limit: item.limit as number,
      unit: item.unit ?? "units",
      freeTierType: item.freeTierType ?? "Free Tier",
    }))
}

interface CostExplorerMetric {
  Amount?: string
  Unit?: string
}

/**
 * Parses the Cost Explorer GetCostAndUsage response into per-service rows.
 * Exposed for unit testing. The response groups results by time then by the
 * SERVICE dimension; we read the first (only) MONTHLY period.
 */
export function parseCostExplorerResponse(payload: {
  ResultsByTime?: Array<{
    Groups?: Array<{ Keys?: string[]; Metrics?: Record<string, CostExplorerMetric> }>
  }>
}): AwsCostRow[] {
  const groups = payload.ResultsByTime?.[0]?.Groups ?? []
  return groups
    .map((group): AwsCostRow | null => {
      const cost = Number.parseFloat(group.Metrics?.UnblendedCost?.Amount ?? "")
      if (!Number.isFinite(cost)) return null
      const usageQuantity = Number.parseFloat(group.Metrics?.UsageQuantity?.Amount ?? "")
      return {
        service: group.Keys?.[0] ?? "AWS service",
        cost,
        currency: group.Metrics?.UnblendedCost?.Unit ?? "USD",
        usageQuantity: Number.isFinite(usageQuantity) ? usageQuantity : null,
        usageUnit: group.Metrics?.UsageQuantity?.Unit ?? null,
      }
    })
    .filter((row): row is AwsCostRow => Boolean(row))
}

/**
 * Calls AWS Cost Explorer (GetCostAndUsage) for the period, grouped by service,
 * returning both unblended cost and usage quantity. Requires ce:GetCostAndUsage.
 * Cost Explorer's end date is exclusive, so callers pass the first day of the
 * next month as `to`.
 */
export async function getAwsCostAndUsage(
  credentials: AwsCredentials,
  period: { from: string; to: string }
): Promise<AwsCostRow[]> {
  const payload = await awsJsonRequest<Parameters<typeof parseCostExplorerResponse>[0]>({
    host: "ce.us-east-1.amazonaws.com",
    service: "ce",
    region: "us-east-1",
    target: "AWSInsightsIndexService.GetCostAndUsage",
    body: {
      TimePeriod: { Start: period.from, End: period.to },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost", "UsageQuantity"],
      GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    },
    credentials,
  })
  return parseCostExplorerResponse(payload)
}
