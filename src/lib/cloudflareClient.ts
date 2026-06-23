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
 * Workers requests, R2 storage + operations, D1 rows read/written, Workers KV
 * (per-op + storage), Durable Objects (requests + storage), and Queues message
 * operations. Each metric is queried independently, so a product that isn't
 * enabled (or a single permission gap) never hides the others. Returns an error
 * string (not a throw) when nothing could be read — the most common cause is a
 * token missing the Account Analytics: Read permission — so the dashboard
 * degrades gracefully.
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

  // Workers KV is a daily-aggregated dataset, so it filters on `date` (not
  // `datetime`) and buckets operations by actionType (read/write/delete/list),
  // each of which has its own Free-plan allowance.
  const kv = (async () => {
    const kvVariables = { accountTag: accountId, dateStart: period.from, dateEnd: period.to }
    const query = `query($accountTag: string, $dateStart: string, $dateEnd: string) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        kvOperationsAdaptiveGroups(limit: 10000, filter: { date_geq: $dateStart, date_leq: $dateEnd }) {
          sum { requests }
          dimensions { actionType }
        }
        kvStorageAdaptiveGroups(limit: 1000, filter: { date_geq: $dateStart, date_leq: $dateEnd }) {
          max { byteCount }
        }
      } }
    }`
    try {
      const data = await cloudflareGraphQL<{
        viewer?: { accounts?: Array<{
          kvOperationsAdaptiveGroups?: Array<{ sum?: { requests?: number }; dimensions?: { actionType?: string } }>
          kvStorageAdaptiveGroups?: Array<{ max?: { byteCount?: number } }>
        }> }
      }>(token, query, kvVariables)
      const account = data.viewer?.accounts?.[0]
      const byAction = new Map<string, number>()
      for (const node of account?.kvOperationsAdaptiveGroups ?? []) {
        const action = node.dimensions?.actionType
        if (!action) continue
        byAction.set(action, (byAction.get(action) ?? 0) + (node.sum?.requests ?? 0))
      }
      // Title-case each op type so it maps to its allowance: "read" -> "KV Reads".
      const labels: Record<string, string> = { read: "KV Reads", write: "KV Writes", delete: "KV Deletes", list: "KV Lists" }
      for (const [action, count] of byAction) {
        if (count <= 0) continue
        const service = labels[action] ?? `KV ${action.charAt(0).toUpperCase()}${action.slice(1)}s`
        usage.push({ service, quantity: count, unit: "operations" })
      }
      const peakBytes = (account?.kvStorageAdaptiveGroups ?? []).reduce(
        (max, node) => Math.max(max, node.max?.byteCount ?? 0),
        0
      )
      if (peakBytes > 0) usage.push({ service: "KV Storage", quantity: peakBytes / 1e9, unit: "GB" })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "KV usage query failed.")
    }
  })()

  // Durable Objects (Workers Paid only) — requests and peak stored bytes. No
  // Free-plan allowance, so these surface as measured-only lines.
  const durableObjects = (async () => {
    const query = `query($accountTag: string, $start: string, $end: string) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
          sum { requests }
        }
        durableObjectsPeriodicGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
          max { storedBytes }
        }
      } }
    }`
    try {
      const data = await cloudflareGraphQL<{
        viewer?: { accounts?: Array<{
          durableObjectsInvocationsAdaptiveGroups?: Array<{ sum?: { requests?: number } }>
          durableObjectsPeriodicGroups?: Array<{ max?: { storedBytes?: number } }>
        }> }
      }>(token, query, variables)
      const account = data.viewer?.accounts?.[0]
      const requests = (account?.durableObjectsInvocationsAdaptiveGroups ?? []).reduce(
        (sum, node) => sum + (node.sum?.requests ?? 0),
        0
      )
      if (requests > 0) usage.push({ service: "Durable Objects Requests", quantity: requests, unit: "requests" })
      const storedBytes = (account?.durableObjectsPeriodicGroups ?? []).reduce(
        (max, node) => Math.max(max, node.max?.storedBytes ?? 0),
        0
      )
      if (storedBytes > 0) usage.push({ service: "Durable Objects Storage", quantity: storedBytes / 1e9, unit: "GB" })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Durable Objects usage query failed.")
    }
  })()

  // Queues (Workers Paid only) — billable message operations. No Free allowance.
  const queues = (async () => {
    const query = `query($accountTag: string, $start: string, $end: string) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        queueMessageOperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
          sum { billableOperations }
        }
      } }
    }`
    try {
      const data = await cloudflareGraphQL<{
        viewer?: { accounts?: Array<{ queueMessageOperationsAdaptiveGroups?: Array<{ sum?: { billableOperations?: number } }> }> }
      }>(token, query, variables)
      const ops = (data.viewer?.accounts?.[0]?.queueMessageOperationsAdaptiveGroups ?? []).reduce(
        (sum, node) => sum + (node.sum?.billableOperations ?? 0),
        0
      )
      if (ops > 0) usage.push({ service: "Queue Operations", quantity: ops, unit: "operations" })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Queues usage query failed.")
    }
  })()

  await Promise.all([workers, r2Storage, r2Ops, d1, kv, durableObjects, queues])

  // Only surface an error when we got nothing at all — a partial failure (e.g.
  // R2 not enabled) shouldn't nag the user. The Workers query is the canary for
  // a missing Account Analytics: Read permission.
  const error =
    usage.length === 0 && errors.length > 0
      ? `Cloudflare usage query failed (${errors[0]}). The API token needs Account Analytics: Read.`
      : null
  return { usage, error }
}

export interface CloudflareResource {
  kind: "Worker" | "Domain"
  name: string
  quantity: number
  unit: string
}

/**
 * Lists the account's discrete infra resources with usage so each can be
 * assigned to a repo: Workers broken out per script, and domains (zones) per
 * request volume. Best-effort — each query is independent and a failure just
 * omits that resource kind.
 */
export async function getCloudflareAccountResources(
  token: string,
  accountId: string,
  period: { from: string; to: string }
): Promise<CloudflareResource[]> {
  const variables = {
    accountTag: accountId,
    start: `${period.from}T00:00:00Z`,
    end: `${period.to}T23:59:59Z`,
  }
  const resources: CloudflareResource[] = []

  // Workers, broken out per script.
  try {
    const query = `query($accountTag: string, $start: string, $end: string) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(limit: 200, filter: { datetime_geq: $start, datetime_leq: $end }) {
          sum { requests }
          dimensions { scriptName }
        }
      } }
    }`
    const data = await cloudflareGraphQL<{
      viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum?: { requests?: number }; dimensions?: { scriptName?: string } }> }> }
    }>(token, query, variables)
    const byScript = new Map<string, number>()
    for (const node of data.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? []) {
      const name = node.dimensions?.scriptName
      if (!name) continue
      byScript.set(name, (byScript.get(name) ?? 0) + (node.sum?.requests ?? 0))
    }
    for (const [name, requests] of byScript) {
      if (requests > 0) resources.push({ kind: "Worker", name, quantity: requests, unit: "requests" })
    }
  } catch {
    // Workers analytics unavailable — skip.
  }

  // Domains (zones) under this account, by request volume.
  try {
    const zones = await cloudflareRequest<Array<{ id: string; name: string }>>(
      `/zones?account.id=${encodeURIComponent(accountId)}&per_page=50`,
      token
    )
    const zoneTags = zones.map((zone) => zone.id)
    if (zoneTags.length > 0) {
      const query = `query($zoneTags: [string!], $start: string, $end: string) {
        viewer { zones(filter: { zoneTag_in: $zoneTags }) {
          zoneTag
          httpRequests1mGroups(limit: 1, filter: { datetime_geq: $start, datetime_leq: $end }) {
            sum { requests }
          }
        } }
      }`
      const data = await cloudflareGraphQL<{
        viewer?: { zones?: Array<{ zoneTag?: string; httpRequests1mGroups?: Array<{ sum?: { requests?: number } }> }> }
      }>(token, query, { zoneTags, start: variables.start, end: variables.end })
      const nameByTag = new Map(zones.map((zone) => [zone.id, zone.name]))
      for (const zone of data.viewer?.zones ?? []) {
        const requests = (zone.httpRequests1mGroups ?? []).reduce((sum, node) => sum + (node.sum?.requests ?? 0), 0)
        const name = zone.zoneTag ? nameByTag.get(zone.zoneTag) : undefined
        if (name && requests > 0) resources.push({ kind: "Domain", name, quantity: requests, unit: "requests" })
      }
    }
  } catch {
    // Zone analytics unavailable — skip.
  }

  return resources
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
