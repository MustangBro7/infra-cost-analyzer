export interface CloudflareAccount {
  id: string
  name: string
}

interface CloudflareEnvelope<T> {
  success: boolean
  errors?: Array<{ code?: number; message?: string }>
  result: T
}

async function cloudflareRequest<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  })
  const payload = (await response.json().catch(() => null)) as CloudflareEnvelope<T> | null
  if (!response.ok || !payload?.success) {
    const detail = payload?.errors?.[0]?.message ?? `status ${response.status}`
    throw new Error(`Cloudflare request failed: ${detail}`)
  }
  return payload.result
}

export interface CloudflareSubscription {
  id?: string
  state?: string
  price?: number
  currency?: string
  frequency?: string
  product?: { name?: string; public_name?: string }
  rate_plan?: { id?: string; public_name?: string }
}

export async function listCloudflareAccounts(token: string): Promise<CloudflareAccount[]> {
  return cloudflareRequest<CloudflareAccount[]>("/accounts?per_page=25", token)
}

export async function listCloudflareSubscriptions(token: string, accountId: string): Promise<CloudflareSubscription[]> {
  const result = await cloudflareRequest<CloudflareSubscription[] | null>(
    `/accounts/${encodeURIComponent(accountId)}/subscriptions`,
    token
  )
  return result ?? []
}

export interface CloudflareUsage {
  service: string
  quantity: number
  unit: string
}

export interface CloudflareUsageResult {
  usage: CloudflareUsage[]
  error: string | null
}

// Cloudflare's GraphQL Analytics API uses lowercase custom scalars (`string`)
// and ISO `datetime` filters. See
// https://developers.cloudflare.com/analytics/graphql-api/
async function cloudflareGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  const payload = (await response.json().catch(() => null)) as {
    data?: T
    errors?: Array<{ message?: string }>
  } | null
  if (!response.ok || !payload || payload.errors?.length) {
    throw new Error(payload?.errors?.[0]?.message ?? `status ${response.status}`)
  }
  return payload.data as T
}

/**
 * Pulls real consumption for an account from the Cloudflare GraphQL Analytics
 * API so usage can show actual-vs-limit across every product we can read:
 * Workers requests, R2 storage + operations, and D1 rows read/written. Each
 * metric is queried independently, so a product that isn't enabled (or a single
 * permission gap) never hides the others. Returns an error string (not a throw)
 * when nothing could be read — the most common cause is a token missing the
 * Account Analytics: Read permission — so the dashboard degrades gracefully.
 */
export async function getCloudflareAccountUsage(
  token: string,
  accountId: string,
  period: { from: string; to: string }
): Promise<CloudflareUsageResult> {
  const variables = {
    accountTag: accountId,
    start: `${period.from}T00:00:00Z`,
    end: `${period.to}T23:59:59Z`,
  }
  const usage: CloudflareUsage[] = []
  const errors: string[] = []

  const workers = (async () => {
    const query = `query($accountTag: string, $start: string, $end: string) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
          sum { requests subrequests }
        }
      } }
    }`
    try {
      const data = await cloudflareGraphQL<{
        viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum?: { requests?: number; subrequests?: number } }> }> }
      }>(token, query, variables)
      const nodes = data.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? []
      const requests = nodes.reduce((sum, node) => sum + (node.sum?.requests ?? 0), 0)
      const subrequests = nodes.reduce((sum, node) => sum + (node.sum?.subrequests ?? 0), 0)
      if (requests > 0) usage.push({ service: "Workers Requests", quantity: requests, unit: "requests" })
      if (subrequests > 0) usage.push({ service: "Workers Subrequests", quantity: subrequests, unit: "subrequests" })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Workers usage query failed.")
    }
  })()

  const r2Storage = (async () => {
    const query = `query($accountTag: string, $start: string, $end: string) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        r2StorageAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_leq: $end }) {
          max { payloadSize metadataSize objectCount }
        }
      } }
    }`
    try {
      const data = await cloudflareGraphQL<{
        viewer?: { accounts?: Array<{ r2StorageAdaptiveGroups?: Array<{ max?: { payloadSize?: number; metadataSize?: number; objectCount?: number } }> }> }
      }>(token, query, variables)
      const node = data.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups?.[0]?.max
      const bytes = (node?.payloadSize ?? 0) + (node?.metadataSize ?? 0)
      if (bytes > 0) usage.push({ service: "R2 Storage", quantity: bytes / 1e9, unit: "GB" })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "R2 storage query failed.")
    }
  })()

  const r2Ops = (async () => {
    const query = `query($accountTag: string, $start: string, $end: string) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
          sum { requests }
        }
      } }
    }`
    try {
      const data = await cloudflareGraphQL<{
        viewer?: { accounts?: Array<{ r2OperationsAdaptiveGroups?: Array<{ sum?: { requests?: number } }> }> }
      }>(token, query, variables)
      const ops = (data.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups ?? []).reduce(
        (sum, node) => sum + (node.sum?.requests ?? 0),
        0
      )
      if (ops > 0) usage.push({ service: "R2 Operations", quantity: ops, unit: "operations" })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "R2 operations query failed.")
    }
  })()

  const d1 = (async () => {
    const query = `query($accountTag: string, $start: string, $end: string) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        d1AnalyticsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
          sum { rowsRead rowsWritten }
        }
      } }
    }`
    try {
      const data = await cloudflareGraphQL<{
        viewer?: { accounts?: Array<{ d1AnalyticsAdaptiveGroups?: Array<{ sum?: { rowsRead?: number; rowsWritten?: number } }> }> }
      }>(token, query, variables)
      const nodes = data.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? []
      const rowsRead = nodes.reduce((sum, node) => sum + (node.sum?.rowsRead ?? 0), 0)
      const rowsWritten = nodes.reduce((sum, node) => sum + (node.sum?.rowsWritten ?? 0), 0)
      if (rowsRead > 0) usage.push({ service: "D1 Rows Read", quantity: rowsRead, unit: "rows" })
      if (rowsWritten > 0) usage.push({ service: "D1 Rows Written", quantity: rowsWritten, unit: "rows" })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "D1 usage query failed.")
    }
  })()

  await Promise.all([workers, r2Storage, r2Ops, d1])

  // Only surface an error when we got nothing at all — a partial failure (e.g.
  // R2 not enabled) shouldn't nag the user. The Workers query is the canary for
  // a missing Account Analytics: Read permission.
  const error =
    usage.length === 0 && errors.length > 0
      ? `Cloudflare usage query failed (${errors[0]}). The API token needs Account Analytics: Read.`
      : null
  return { usage, error }
}

export async function verifyCloudflareToken(token: string) {
  const verified = await cloudflareRequest<{ id: string; status: string }>("/user/tokens/verify", token)
  if (verified.status !== "active") {
    throw new Error(`Cloudflare token is not active (status: ${verified.status}).`)
  }

  let accounts: CloudflareAccount[] = []
  try {
    accounts = await listCloudflareAccounts(token)
  } catch {
    accounts = []
  }

  return {
    tokenId: verified.id,
    accountLabel: accounts[0]?.name ?? `Token ${verified.id.slice(0, 8)}`,
    accounts,
  }
}
