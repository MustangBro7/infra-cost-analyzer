const TOKEN_URL = "https://oauth2.googleapis.com/token"
const SCOPES =
  "https://www.googleapis.com/auth/cloud-billing.readonly https://www.googleapis.com/auth/cloud-platform.read-only https://www.googleapis.com/auth/bigquery.readonly"

interface ServiceAccountKey {
  type?: string
  project_id?: string
  client_email?: string
  private_key?: string
}

export interface GcpBillingAccount {
  name: string
  displayName: string
  open: boolean
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function verifyGcpServiceAccount(keyJson: string) {
  const key = parseServiceAccountKey(keyJson)
  const accessToken = await mintAccessToken(key.client_email, key.private_key)
  const billingAccounts = await listBillingAccounts(accessToken)

  return {
    accountLabel: key.client_email,
    projectId: key.project_id ?? null,
    billingAccounts,
  }
}

// WebCrypto (instead of node:crypto.createSign) so this also runs on Cloudflare Workers.
async function signRs256(privateKeyPem: string, data: string): Promise<Uint8Array> {
  const base64Body = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "")
  if (!base64Body || /-----BEGIN/.test(privateKeyPem.replace(/-----BEGIN PRIVATE KEY-----/, ""))) {
    throw new Error("private_key must be an unencrypted PKCS#8 key (BEGIN PRIVATE KEY).")
  }
  const der = Buffer.from(base64Body, "base64")
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data))
  return new Uint8Array(signature)
}

async function mintAccessToken(clientEmail: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claims = base64url(
    JSON.stringify({ iss: clientEmail, scope: SCOPES, aud: TOKEN_URL, iat: now, exp: now + 3600 })
  )

  let signature: Uint8Array
  try {
    signature = await signRs256(privateKey, `${header}.${claims}`)
  } catch {
    throw new Error("Could not sign with the provided private_key. Check that the key JSON was pasted intact.")
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${base64url(Buffer.from(signature))}`,
    }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Google token exchange failed ${response.status}: ${text.slice(0, 300)}`)
  }
  const payload = (await response.json()) as { access_token?: string }
  if (!payload.access_token) {
    throw new Error("Google token exchange returned no access token.")
  }
  return payload.access_token
}

export interface GcpBillingExportRow {
  serviceName: string
  projectId: string | null
  cost: number
  currency: string
  usageAmount: number | null
  usageUnit: string | null
}

const TABLE_ID_PATTERN = /^[a-z][a-z0-9-]*\.[A-Za-z0-9_$]+\.[A-Za-z0-9_$]+$/

export function normalizeBillingExportTableId(raw: string): string {
  const tableId = raw.trim().replace(/`/g, "").replace(/:/, ".")
  if (!TABLE_ID_PATTERN.test(tableId)) {
    throw new Error(
      "Billing export table must look like project-id.dataset.gcp_billing_export_v1_XXXXXX (find it in BigQuery where Cloud Billing export writes)."
    )
  }
  return tableId
}

export async function queryGcpBillingExportCosts(
  keyJson: string,
  rawTableId: string,
  period: { from: string; to: string }
): Promise<GcpBillingExportRow[]> {
  const key = parseServiceAccountKey(keyJson)
  const tableId = normalizeBillingExportTableId(rawTableId)
  const projectId = tableId.split(".")[0]
  const accessToken = await mintAccessToken(key.client_email as string, key.private_key as string)

  const query = [
    "SELECT service.description AS service_name,",
    "  project.id AS project_id,",
    "  SUM(cost) + IFNULL(SUM((SELECT SUM(c.amount) FROM UNNEST(credits) AS c)), 0) AS total_cost,",
    "  ANY_VALUE(currency) AS currency,",
    "  SUM(usage.amount_in_pricing_units) AS usage_amount,",
    "  ANY_VALUE(usage.pricing_unit) AS usage_unit",
    `FROM \`${tableId}\``,
    "WHERE usage_start_time >= TIMESTAMP(@period_from)",
    "  AND usage_start_time < TIMESTAMP_ADD(TIMESTAMP(@period_to), INTERVAL 1 DAY)",
    "GROUP BY service_name, project_id",
    "ORDER BY total_cost DESC",
    "LIMIT 100",
  ].join("\n")

  const response = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/queries`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query,
      useLegacySql: false,
      timeoutMs: 30000,
      parameterMode: "NAMED",
      queryParameters: [
        { name: "period_from", parameterType: { type: "STRING" }, parameterValue: { value: period.from } },
        { name: "period_to", parameterType: { type: "STRING" }, parameterValue: { value: period.to } },
      ],
    }),
  })
  if (!response.ok) {
    const text = await response.text()
    let detail = text.slice(0, 300)
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } }
      if (parsed.error?.message) detail = parsed.error.message
    } catch {
      // keep raw text
    }
    throw new Error(`BigQuery billing export query failed: ${detail}`)
  }

  const payload = (await response.json()) as {
    jobComplete?: boolean
    rows?: Array<{ f?: Array<{ v?: unknown }> }>
  }
  if (payload.jobComplete === false) {
    throw new Error("BigQuery billing export query did not finish within 30 seconds. Try again.")
  }

  return (payload.rows ?? [])
    .map((row): GcpBillingExportRow | null => {
      const cells = row.f ?? []
      const cost = Number.parseFloat(String(cells[2]?.v ?? ""))
      if (!Number.isFinite(cost)) return null
      const usageAmount = Number.parseFloat(String(cells[4]?.v ?? ""))
      return {
        serviceName: typeof cells[0]?.v === "string" && cells[0].v ? cells[0].v : "Google Cloud service",
        projectId: typeof cells[1]?.v === "string" && cells[1].v ? cells[1].v : null,
        cost,
        currency: typeof cells[3]?.v === "string" && cells[3].v ? cells[3].v : "USD",
        usageAmount: Number.isFinite(usageAmount) ? usageAmount : null,
        usageUnit: typeof cells[5]?.v === "string" && cells[5].v ? cells[5].v : null,
      }
    })
    .filter((row): row is GcpBillingExportRow => Boolean(row))
}

/**
 * Scans the service account's project for a Cloud Billing export table
 * (gcp_billing_export_v1_* / gcp_billing_export_resource_v1_*) so the user
 * does not have to find and paste the table id manually. Returns null when
 * nothing is found or the key lacks BigQuery list permissions.
 */
export async function discoverBillingExportTable(keyJson: string): Promise<string | null> {
  const key = parseServiceAccountKey(keyJson)
  if (!key.project_id) return null
  const accessToken = await mintAccessToken(key.client_email, key.private_key)
  const headers = { authorization: `Bearer ${accessToken}` }

  const datasetsResponse = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${key.project_id}/datasets?maxResults=50`,
    { headers }
  )
  if (!datasetsResponse.ok) return null
  const datasetsPayload = (await datasetsResponse.json()) as {
    datasets?: Array<{ datasetReference?: { datasetId?: string } }>
  }
  const datasetIds = (datasetsPayload.datasets ?? [])
    .map((dataset) => dataset.datasetReference?.datasetId)
    .filter((id): id is string => Boolean(id))
    .slice(0, 15)

  let resourceLevelMatch: string | null = null
  for (const datasetId of datasetIds) {
    const tablesResponse = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${key.project_id}/datasets/${datasetId}/tables?maxResults=200`,
      { headers }
    )
    if (!tablesResponse.ok) continue
    const tablesPayload = (await tablesResponse.json()) as {
      tables?: Array<{ tableReference?: { tableId?: string } }>
    }
    for (const table of tablesPayload.tables ?? []) {
      const tableId = table.tableReference?.tableId
      if (!tableId) continue
      if (/^gcp_billing_export_v1_/.test(tableId)) {
        return `${key.project_id}.${datasetId}.${tableId}`
      }
      if (/^gcp_billing_export_resource_v1_/.test(tableId) && !resourceLevelMatch) {
        resourceLevelMatch = `${key.project_id}.${datasetId}.${tableId}`
      }
    }
  }
  return resourceLevelMatch
}

function parseServiceAccountKey(keyJson: string): ServiceAccountKey & { client_email: string; private_key: string } {
  let key: ServiceAccountKey
  try {
    key = JSON.parse(keyJson) as ServiceAccountKey
  } catch {
    throw new Error("Service account key must be valid JSON.")
  }
  if (key.type !== "service_account" || !key.client_email || !key.private_key) {
    throw new Error("Expected a Google service account key JSON with type, client_email, and private_key fields.")
  }
  return key as ServiceAccountKey & { client_email: string; private_key: string }
}

async function listBillingAccounts(accessToken: string): Promise<GcpBillingAccount[] | null> {
  const response = await fetch("https://cloudbilling.googleapis.com/v1/billingAccounts?pageSize=25", {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) return null
  const payload = (await response.json()) as {
    billingAccounts?: Array<{ name?: string; displayName?: string; open?: boolean }>
  }
  return (payload.billingAccounts ?? []).map((account) => ({
    name: account.name ?? "",
    displayName: account.displayName ?? "",
    open: Boolean(account.open),
  }))
}
