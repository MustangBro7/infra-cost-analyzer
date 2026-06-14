export interface VercelTeam {
  id: string
  slug: string
  name: string
}

export interface VercelProject {
  id: string
  name: string
  framework: string | null
  link?: {
    type?: string
    repo?: string
    repoId?: number
    org?: string
  }
}

export interface VercelOAuthToken {
  access_token: string
  token_type: string
  expires_in?: number
  scope?: string
  refresh_token?: string
  id_token?: string
}

export interface VercelUserInfo {
  sub?: string
  name?: string
  email?: string
  username?: string
  picture?: string
  [key: string]: unknown
}

async function vercelRequest<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.vercel.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Vercel request failed ${response.status}: ${body.slice(0, 300)}`)
  }
  return response.json() as Promise<T>
}

async function vercelTextRequest(path: string, token: string): Promise<string> {
  const response = await fetch(`https://api.vercel.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "accept-encoding": "gzip",
    },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Vercel request failed ${response.status}: ${body.slice(0, 300)}`)
  }
  return response.text()
}

export async function verifyVercelToken(token: string) {
  const user = await vercelRequest<{ user: { id: string; username?: string; name?: string; email?: string } }>("/v2/user", token)
  let teams: VercelTeam[] = []
  try {
    const teamPayload = await vercelRequest<{ teams: VercelTeam[] }>("/v2/teams", token)
    teams = teamPayload.teams ?? []
  } catch {
    teams = []
  }
  return {
    accountLabel: user.user.name || user.user.username || user.user.email || user.user.id,
    user: user.user,
    teams,
  }
}

export async function exchangeVercelAuthorizationCode(input: {
  code: string
  codeVerifier: string
  redirectUri: string
  clientId: string
  clientSecret?: string
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
  })
  if (input.clientSecret) {
    body.set("client_secret", input.clientSecret)
  }

  const response = await fetch("https://api.vercel.com/login/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Vercel OAuth token exchange failed ${response.status}: ${text.slice(0, 300)}`)
  }
  return response.json() as Promise<VercelOAuthToken>
}

export async function fetchVercelUserInfo(accessToken: string) {
  const response = await fetch("https://api.vercel.com/login/oauth/userinfo", {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Vercel userinfo failed ${response.status}: ${text.slice(0, 300)}`)
  }
  return response.json() as Promise<VercelUserInfo>
}

/**
 * Best-effort lookup of the billing plan (e.g. "hobby", "pro", "enterprise") so
 * the card can show it. When a team is selected the team's plan is what governs
 * billing access; otherwise the personal account's plan. Returns null if Vercel
 * doesn't expose it for this token.
 */
export async function fetchVercelPlan(token: string, teamId?: string | null): Promise<string | null> {
  try {
    if (teamId) {
      const team = await vercelRequest<{ billing?: { plan?: string } }>(
        `/v2/teams/${encodeURIComponent(teamId)}`,
        token
      )
      return team.billing?.plan ?? null
    }
    const payload = await vercelRequest<{ user: { billing?: { plan?: string } } }>("/v2/user", token)
    return payload.user.billing?.plan ?? null
  } catch {
    return null
  }
}

export async function listVercelProjects(token: string, teamId?: string | null): Promise<VercelProject[]> {
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : ""
  const payload = await vercelRequest<{ projects: VercelProject[] }>(`/v10/projects${query}`, token)
  return payload.projects ?? []
}

export interface VercelFocusCharge {
  ChargePeriodStart?: string
  ChargePeriodEnd?: string
  ServiceName?: string
  ResourceId?: string
  ResourceName?: string
  BillingCurrency?: string
  EffectiveCost?: number | string
  BilledCost?: number | string
  ListCost?: number | string
  ConsumedQuantity?: number | string
  ConsumedUnit?: string
  PricingQuantity?: number | string
  PricingUnit?: string
  ProviderName?: string
  Tags?: Record<string, string>
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Account usage (works on the FREE Hobby tier, unlike FOCUS billing charges).
//
// `/v2/usage?type=requests` returns per-day edge requests, bandwidth, function
// invocations + duration, and monitoring events; `type=builds` returns build
// execution time. These power the free-tier "how much have I used / how much is
// left" view even when there is no billed cost. Each daily row also carries a
// per-project `breakdown` (percent share) so usage can be attributed per repo.
// ---------------------------------------------------------------------------

const VERCEL_GB = 1_000_000_000

export interface VercelUsageMetric {
  service: string
  quantity: number
  unit: string
}

export interface VercelProjectUsage {
  id: string
  name: string
  requests: number
  bandwidthBytes: number
}

export interface VercelAccountUsage {
  metrics: VercelUsageMetric[]
  projects: VercelProjectUsage[]
  error: string | null
}

interface VercelBreakdownItem {
  id?: string
  name?: string
  title?: string
  percent?: number
}

interface VercelUsageRequestsRow {
  request_hit_count?: number
  request_miss_count?: number
  monitoring_metric_count?: number
  bandwidth_outgoing_bytes?: number
  bandwidth_incoming_bytes?: number
  function_execution_successful_gb_hours?: number
  function_execution_error_gb_hours?: number
  function_execution_timeout_gb_hours?: number
  function_invocation_successful_count?: number
  function_invocation_error_count?: number
  function_invocation_throttle_count?: number
  function_invocation_timeout_count?: number
  breakdown?: {
    requests?: VercelBreakdownItem[]
    bandwidth?: VercelBreakdownItem[]
  }
}

interface VercelUsageBuildsRow {
  build_build_seconds?: number
}

async function fetchVercelUsageRows<T>(
  token: string,
  type: string,
  params: URLSearchParams
): Promise<T[]> {
  const query = new URLSearchParams(params)
  query.set("type", type)
  const payload = await vercelRequest<{ data?: T[] }>(`/v2/usage?${query.toString()}`, token)
  return payload.data ?? []
}

export async function fetchVercelAccountUsage(
  token: string,
  input: { from: string; to: string; teamId?: string | null }
): Promise<VercelAccountUsage> {
  const params = new URLSearchParams({
    from: `${input.from}T00:00:00.000Z`,
    to: `${input.to}T23:59:59.999Z`,
  })
  if (input.teamId) params.set("teamId", input.teamId)

  const errors: string[] = []
  let requestRows: VercelUsageRequestsRow[] = []
  try {
    requestRows = await fetchVercelUsageRows<VercelUsageRequestsRow>(token, "requests", params)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Vercel usage (requests) failed.")
  }
  let buildRows: VercelUsageBuildsRow[] = []
  try {
    buildRows = await fetchVercelUsageRows<VercelUsageBuildsRow>(token, "builds", params)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Vercel usage (builds) failed.")
  }

  const sum = <R>(rows: R[], pick: (row: R) => number | undefined): number =>
    rows.reduce((acc, row) => acc + (pick(row) ?? 0), 0)

  const edgeRequests = sum(requestRows, (r) => (r.request_hit_count ?? 0) + (r.request_miss_count ?? 0))
  const outgoingBytes = sum(requestRows, (r) => r.bandwidth_outgoing_bytes)
  const incomingBytes = sum(requestRows, (r) => r.bandwidth_incoming_bytes)
  const invocations = sum(
    requestRows,
    (r) =>
      (r.function_invocation_successful_count ?? 0) +
      (r.function_invocation_error_count ?? 0) +
      (r.function_invocation_throttle_count ?? 0) +
      (r.function_invocation_timeout_count ?? 0)
  )
  const gbHours = sum(
    requestRows,
    (r) =>
      (r.function_execution_successful_gb_hours ?? 0) +
      (r.function_execution_error_gb_hours ?? 0) +
      (r.function_execution_timeout_gb_hours ?? 0)
  )
  const monitoring = sum(requestRows, (r) => r.monitoring_metric_count)
  const buildSeconds = sum(buildRows, (r) => r.build_build_seconds)

  const metrics: VercelUsageMetric[] = []
  const push = (service: string, quantity: number, unit: string) => {
    if (Number.isFinite(quantity) && quantity > 0) metrics.push({ service, quantity, unit })
  }
  push("Edge Requests", edgeRequests, "requests")
  push("Fast Data Transfer", outgoingBytes / VERCEL_GB, "GB")
  push("Incoming Data Transfer", incomingBytes / VERCEL_GB, "GB")
  push("Function Invocations", invocations, "invocations")
  push("Provisioned Memory", gbHours, "GB-hours")
  push("Monitoring Events", monitoring, "events")
  push("Build Execution", buildSeconds / 60, "minutes")

  // Per-project breakdown: each day reports a percent share per project, so we
  // weight that day's totals by the share and accumulate across the period.
  const projects = new Map<string, VercelProjectUsage>()
  const projectFor = (item: VercelBreakdownItem): VercelProjectUsage | null => {
    if (!item.id) return null
    let existing = projects.get(item.id)
    if (!existing) {
      existing = { id: item.id, name: item.name ?? item.title ?? item.id, requests: 0, bandwidthBytes: 0 }
      projects.set(item.id, existing)
    }
    return existing
  }
  for (const row of requestRows) {
    const dayRequests = (row.request_hit_count ?? 0) + (row.request_miss_count ?? 0)
    const dayBandwidth = row.bandwidth_outgoing_bytes ?? 0
    for (const item of row.breakdown?.requests ?? []) {
      const project = projectFor(item)
      if (project) project.requests += dayRequests * ((item.percent ?? 0) / 100)
    }
    for (const item of row.breakdown?.bandwidth ?? []) {
      const project = projectFor(item)
      if (project) project.bandwidthBytes += dayBandwidth * ((item.percent ?? 0) / 100)
    }
  }

  return {
    metrics,
    projects: [...projects.values()],
    error: errors.length ? errors[0] : null,
  }
}

export async function listVercelBillingCharges(
  token: string,
  input: { from: string; to: string; teamId?: string | null; slug?: string | null }
): Promise<VercelFocusCharge[]> {
  const params = new URLSearchParams({
    from: `${input.from}T00:00:00.000Z`,
    to: `${input.to}T23:59:59.999Z`,
  })
  if (input.teamId) params.set("teamId", input.teamId)
  if (input.slug) params.set("slug", input.slug)
  const body = await vercelTextRequest(`/v1/billing/charges?${params.toString()}`, token)
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as VercelFocusCharge)
}
