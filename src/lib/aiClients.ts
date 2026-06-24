// Clients for AI coding-tool subscriptions: Anthropic (Claude / Claude Code),
// OpenAI (Codex), and Cursor. Each exposes a verify() for the connect flow and a
// fetch…CostUsage() the cost engine calls on refresh. All return the same
// normalized shape so the engine maps them into NormalizedCostRow /
// ProviderUsageSample uniformly.
//
// These read each vendor's ORGANIZATION/TEAM cost & usage APIs, which require an
// admin/team key (individual subscription keys can't read billing). Parsing is
// deliberately tolerant of response-shape drift: we coerce numbers and skip
// rows we can't read rather than throwing the whole sync away.

export interface AiCostRow {
  service: string
  cost: number
  currency: string
}

export interface AiUsageRow {
  service: string
  quantity: number
  unit: string
}

export interface AiCostUsage {
  accountLabel: string
  costRows: AiCostRow[]
  usage: AiUsageRow[]
}

export interface AiPeriod {
  // YYYY-MM-DD, inclusive start / inclusive end of the current month.
  from: string
  to: string
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function rfc3339Start(date: string): string {
  return `${date}T00:00:00Z`
}

// Cost Explorer-style exclusive end: the day after the period's last day.
function dayAfter(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function unixSeconds(date: string): number {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000)
}

// ---------------- Anthropic (Claude) ----------------

const ANTHROPIC_BASE = "https://api.anthropic.com/v1/organizations"

function anthropicHeaders(adminKey: string): Record<string, string> {
  return {
    "x-api-key": adminKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  }
}

async function anthropicGet(adminKey: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${ANTHROPIC_BASE}${path}`, { headers: anthropicHeaders(adminKey) })
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    const error = (payload?.error as { message?: string } | undefined)?.message
    if (response.status === 401 || response.status === 403) {
      throw new Error("Anthropic rejected the key. Use an Admin API key (sk-ant-admin…) with billing access.")
    }
    throw new Error(`Anthropic request failed: ${error ?? `status ${response.status}`}`)
  }
  return payload ?? {}
}

export async function verifyAnthropicKey(adminKey: string): Promise<{ accountLabel: string }> {
  // A 1-day cost report is the cheapest call that requires admin/billing scope.
  const today = new Date().toISOString().slice(0, 10)
  await anthropicGet(
    adminKey,
    `/cost_report?starting_at=${encodeURIComponent(rfc3339Start(today))}&limit=1`
  )
  return { accountLabel: "Anthropic organization" }
}

export async function fetchAnthropicCostUsage(adminKey: string, period: AiPeriod): Promise<AiCostUsage> {
  const start = encodeURIComponent(rfc3339Start(period.from))
  const end = encodeURIComponent(rfc3339Start(dayAfter(period.to)))

  // Cost report grouped by description (model / line item). Page through results.
  const costByService = new Map<string, number>()
  let currency = "USD"
  let page: string | null = null
  for (let guard = 0; guard < 20; guard += 1) {
    const pageParam = page ? `&page=${encodeURIComponent(page)}` : ""
    const data = await anthropicGet(
      adminKey,
      `/cost_report?starting_at=${start}&ending_at=${end}&group_by[]=description${pageParam}`
    )
    for (const bucket of (data.data as Array<Record<string, unknown>> | undefined) ?? []) {
      for (const result of (bucket.results as Array<Record<string, unknown>> | undefined) ?? []) {
        const amount = toNumber(result.amount)
        if (amount === 0) continue
        if (typeof result.currency === "string") currency = result.currency
        const service =
          (typeof result.description === "string" && result.description) ||
          (typeof result.model === "string" && result.model) ||
          "Claude usage"
        costByService.set(service, (costByService.get(service) ?? 0) + amount)
      }
    }
    if (data.has_more && typeof data.next_page === "string") page = data.next_page
    else break
  }

  // Token usage from the messages usage report.
  let inputTokens = 0
  let outputTokens = 0
  try {
    let usagePage: string | null = null
    for (let guard = 0; guard < 20; guard += 1) {
      const pageParam = usagePage ? `&page=${encodeURIComponent(usagePage)}` : ""
      const data = await anthropicGet(
        adminKey,
        `/usage_report/messages?starting_at=${start}&ending_at=${end}&bucket_width=1d${pageParam}`
      )
      for (const bucket of (data.data as Array<Record<string, unknown>> | undefined) ?? []) {
        for (const result of (bucket.results as Array<Record<string, unknown>> | undefined) ?? []) {
          for (const [key, value] of Object.entries(result)) {
            if (/input_tokens$/i.test(key)) inputTokens += toNumber(value)
            else if (/output_tokens$/i.test(key)) outputTokens += toNumber(value)
          }
        }
      }
      if (data.has_more && typeof data.next_page === "string") usagePage = data.next_page
      else break
    }
  } catch {
    // Usage report is best-effort; cost rows already carry the headline number.
  }

  const costRows: AiCostRow[] = [...costByService.entries()].map(([service, cost]) => ({
    service,
    cost: Number(cost.toFixed(4)),
    currency,
  }))
  const usage: AiUsageRow[] = []
  if (inputTokens > 0) usage.push({ service: "Input tokens", quantity: Math.round(inputTokens), unit: "tokens" })
  if (outputTokens > 0) usage.push({ service: "Output tokens", quantity: Math.round(outputTokens), unit: "tokens" })

  return { accountLabel: "Anthropic organization", costRows, usage }
}

// ---------------- OpenAI (Codex) ----------------

const OPENAI_BASE = "https://api.openai.com/v1/organization"

async function openAiGet(adminKey: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${OPENAI_BASE}${path}`, {
    headers: { authorization: `Bearer ${adminKey}` },
  })
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    const error = (payload?.error as { message?: string } | undefined)?.message
    if (response.status === 401 || response.status === 403) {
      throw new Error("OpenAI rejected the key. Use an Admin key (sk-admin-…) with organization billing access.")
    }
    throw new Error(`OpenAI request failed: ${error ?? `status ${response.status}`}`)
  }
  return payload ?? {}
}

export async function verifyOpenAiKey(adminKey: string): Promise<{ accountLabel: string }> {
  const start = unixSeconds(new Date().toISOString().slice(0, 8) + "01")
  await openAiGet(adminKey, `/costs?start_time=${start}&limit=1`)
  return { accountLabel: "OpenAI organization" }
}

export async function fetchOpenAiCostUsage(adminKey: string, period: AiPeriod): Promise<AiCostUsage> {
  const start = unixSeconds(period.from)
  const end = unixSeconds(dayAfter(period.to))

  const costByService = new Map<string, number>()
  let currency = "USD"
  let page: string | null = null
  for (let guard = 0; guard < 20; guard += 1) {
    const pageParam = page ? `&page=${encodeURIComponent(page)}` : ""
    const data = await openAiGet(
      adminKey,
      `/costs?start_time=${start}&end_time=${end}&bucket_width=1d&limit=180&group_by[]=line_item${pageParam}`
    )
    for (const bucket of (data.data as Array<Record<string, unknown>> | undefined) ?? []) {
      for (const result of (bucket.results as Array<Record<string, unknown>> | undefined) ?? []) {
        const amountObj = result.amount as { value?: unknown; currency?: unknown } | undefined
        const amount = toNumber(amountObj?.value)
        if (amount === 0) continue
        if (typeof amountObj?.currency === "string") currency = (amountObj.currency as string).toUpperCase()
        const service = (typeof result.line_item === "string" && result.line_item) || "OpenAI usage"
        costByService.set(service, (costByService.get(service) ?? 0) + amount)
      }
    }
    if (data.has_more && typeof data.next_page === "string") page = data.next_page
    else break
  }

  let inputTokens = 0
  let outputTokens = 0
  try {
    let usagePage: string | null = null
    for (let guard = 0; guard < 20; guard += 1) {
      const pageParam = usagePage ? `&page=${encodeURIComponent(usagePage)}` : ""
      const data = await openAiGet(
        adminKey,
        `/usage/completions?start_time=${start}&end_time=${end}&bucket_width=1d&limit=180${pageParam}`
      )
      for (const bucket of (data.data as Array<Record<string, unknown>> | undefined) ?? []) {
        for (const result of (bucket.results as Array<Record<string, unknown>> | undefined) ?? []) {
          inputTokens += toNumber(result.input_tokens)
          outputTokens += toNumber(result.output_tokens)
        }
      }
      if (data.has_more && typeof data.next_page === "string") usagePage = data.next_page
      else break
    }
  } catch {
    // Usage endpoint best-effort.
  }

  const costRows: AiCostRow[] = [...costByService.entries()].map(([service, cost]) => ({
    service,
    cost: Number(cost.toFixed(4)),
    currency,
  }))
  const usage: AiUsageRow[] = []
  if (inputTokens > 0) usage.push({ service: "Input tokens", quantity: Math.round(inputTokens), unit: "tokens" })
  if (outputTokens > 0) usage.push({ service: "Output tokens", quantity: Math.round(outputTokens), unit: "tokens" })

  return { accountLabel: "OpenAI organization", costRows, usage }
}

// ---------------- Cursor ----------------

const CURSOR_BASE = "https://api.cursor.com"

function cursorAuth(apiKey: string): string {
  // Cursor Admin API uses HTTP Basic with the key as the username, empty password.
  const encoded = Buffer.from(`${apiKey}:`).toString("base64")
  return `Basic ${encoded}`
}

async function cursorRequest(
  apiKey: string,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<Record<string, unknown>> {
  const response = await fetch(`${CURSOR_BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: cursorAuth(apiKey),
      "content-type": "application/json",
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("Cursor rejected the key. Use a Team API key from the Cursor Admin API settings.")
    }
    const error = (payload?.error as string | undefined) ?? `status ${response.status}`
    throw new Error(`Cursor request failed: ${error}`)
  }
  return payload ?? {}
}

export async function verifyCursorKey(apiKey: string): Promise<{ accountLabel: string }> {
  const data = await cursorRequest(apiKey, "/teams/members")
  const members = (data.teamMembers as unknown[] | undefined) ?? (data.members as unknown[] | undefined) ?? []
  const count = members.length
  return { accountLabel: count > 0 ? `Cursor team · ${count} member${count === 1 ? "" : "s"}` : "Cursor team" }
}

export async function fetchCursorCostUsage(apiKey: string, period: AiPeriod): Promise<AiCostUsage> {
  let accountLabel = "Cursor team"
  try {
    accountLabel = (await verifyCursorKey(apiKey)).accountLabel
  } catch {
    // Non-fatal; the spend call below also surfaces auth errors.
  }

  // Monthly spend per team member (spendCents). Sum into one cost row.
  const costRows: AiCostRow[] = []
  try {
    const data = await cursorRequest(apiKey, "/teams/spend", { method: "POST", body: {} })
    const members = (data.teamMemberSpend as Array<Record<string, unknown>> | undefined) ?? []
    const totalCents = members.reduce((sum, member) => sum + toNumber(member.spendCents), 0)
    if (totalCents > 0) {
      costRows.push({ service: "Cursor usage", cost: Number((totalCents / 100).toFixed(4)), currency: "USD" })
    }
  } catch (error) {
    throw error instanceof Error ? error : new Error("Cursor spend query failed.")
  }

  // Best-effort daily usage (lines applied / requests) over the month.
  const usage: AiUsageRow[] = []
  try {
    const startMs = new Date(`${period.from}T00:00:00Z`).getTime()
    const endMs = new Date(`${dayAfter(period.to)}T00:00:00Z`).getTime()
    const data = await cursorRequest(apiKey, "/teams/daily-usage-data", {
      method: "POST",
      body: { startDate: startMs, endDate: endMs },
    })
    const rows = (data.data as Array<Record<string, unknown>> | undefined) ?? []
    let linesAdded = 0
    let requests = 0
    for (const row of rows) {
      linesAdded += toNumber(row.totalLinesAdded) + toNumber(row.acceptedLinesAdded)
      requests +=
        toNumber(row.composerRequests) +
        toNumber(row.chatRequests) +
        toNumber(row.agentRequests) +
        toNumber(row.totalApplies)
    }
    if (requests > 0) usage.push({ service: "AI requests", quantity: Math.round(requests), unit: "requests" })
    if (linesAdded > 0) usage.push({ service: "Lines added", quantity: Math.round(linesAdded), unit: "lines" })
  } catch {
    // Usage is best-effort; spend already carries the cost.
  }

  return { accountLabel, costRows, usage }
}
