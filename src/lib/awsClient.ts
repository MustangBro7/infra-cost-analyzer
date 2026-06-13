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
    headers: { ...headers, ...signed.headers, accept: "application/json" },
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

/**
 * Calls the AWS Free Tier Usage API (us-east-1 only, on the management account)
 * and returns the items with a positive free-tier limit. Each item carries the
 * real actual-vs-limit numbers AWS reports.
 */
export async function getAwsFreeTierUsage(credentials: AwsCredentials): Promise<AwsFreeTierUsageItem[]> {
  const payload = await awsJsonRequest<{
    freeTierUsages?: Array<{
      service?: string
      description?: string
      actualUsageAmount?: number
      limit?: number
      unit?: string
      freeTierType?: string
    }>
  }>({
    host: "freetier.us-east-1.amazonaws.com",
    service: "freetier",
    region: "us-east-1",
    target: "AWSFreeTierService.GetFreeTierUsage",
    body: {},
    credentials,
  })

  return (payload.freeTierUsages ?? [])
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
