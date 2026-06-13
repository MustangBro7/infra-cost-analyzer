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

/**
 * Pulls real consumption for an account from the Cloudflare GraphQL Analytics
 * API so free-tier usage can show actual-vs-limit. Currently reports Workers
 * request volume for the period. Returns an empty list (not an error) when the
 * token lacks Account Analytics: Read or the account has no Workers traffic, so
 * the dashboard degrades to showing the published allowance only.
 */
export async function getCloudflareAccountUsage(
  token: string,
  accountId: string,
  period: { from: string; to: string }
): Promise<CloudflareUsageResult> {
  // Cloudflare's GraphQL API uses lowercase custom scalars (`string`) and the
  // `workersInvocationsAdaptive` dataset filtered by ISO `datetime`. See
  // https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
  const query = `query AccountUsage($accountTag: string, $start: string, $end: string) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
          sum { requests }
        }
      }
    }
  }`
  const variables = {
    accountTag: accountId,
    start: `${period.from}T00:00:00Z`,
    end: `${period.to}T23:59:59Z`,
  }

  let response: Response
  try {
    response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    })
  } catch (error) {
    return { usage: [], error: error instanceof Error ? error.message : "Cloudflare analytics request failed." }
  }

  const payload = (await response.json().catch(() => null)) as {
    data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }> }> } }
    errors?: Array<{ message?: string }>
  } | null
  if (!response.ok || !payload || payload.errors?.length) {
    const detail = payload?.errors?.[0]?.message ?? `status ${response.status}`
    // The most common cause is a token missing the Account Analytics: Read permission.
    return {
      usage: [],
      error: `Cloudflare usage query failed (${detail}). The API token needs Account Analytics: Read.`,
    }
  }

  const nodes = payload.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? []
  const requests = nodes.reduce((sum, node) => sum + (node.sum?.requests ?? 0), 0)
  if (requests <= 0) return { usage: [], error: null }
  return { usage: [{ service: "Workers Requests", quantity: requests, unit: "requests" }], error: null }
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
