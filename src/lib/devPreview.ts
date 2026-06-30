/**
 * Local, no-auth, pre-seeded preview mode.
 *
 * Set `AMBRIUM_DEV_PREVIEW=1` (dev only — never honored in production) and the
 * app serves a fixed demo user + a fully-seeded workspace so /dashboard renders
 * with realistic data WITHOUT Clerk sign-in or a Postgres/Hyperdrive connection.
 * This exists so agents (and humans) can actually run the app and verify UI
 * changes end-to-end before marking work done. See AGENTS.md.
 *
 * It is read-only: page reads are served from this fixture; mutations (assign,
 * connect, refresh) still hit real APIs and aren't expected to persist here.
 */
import type {
  AnalysisResult,
  AnalysisSnapshot,
  FreeTierUsageRow,
  GitHubRepoSummary,
  LocalUser,
  NormalizedCostRow,
  Provider,
  ProviderConnection,
  RepoSignal,
  StoredConnection,
  WorkspaceStore,
} from "./types"

export function isDevPreview(): boolean {
  return process.env.AMBRIUM_DEV_PREVIEW === "1" && process.env.NODE_ENV !== "production"
}

export const DEV_PREVIEW_USER: LocalUser = {
  id: "dev-preview-user",
  email: "dev@ambrium.local",
  name: "Dev Preview",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSignedInAt: new Date().toISOString(),
}

// ---- time helpers (current month, deterministic-ish) ----
const NOW = new Date()
const MONTH_START = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1))
const MONTH_END = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 0))
const MONTH_END_RESET = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 1) - 1)
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const PERIOD = { from: ymd(MONTH_START), to: ymd(MONTH_END) }
const TWO_HOURS_AGO = new Date(NOW.getTime() - 2 * 3_600_000).toISOString()

const OWNER = "sam"
const repoFull = (name: string) => `${OWNER}/${name}`

const REPO_NAMES = ["clip-anywhere", "promptlint", "inkdrop", "duckboard", "old-portfolio", "habit-grid", "ship-list"]

function repo(name: string, pushedDaysAgo: number): GitHubRepoSummary {
  const pushedAt = new Date(NOW.getTime() - pushedDaysAgo * 86_400_000).toISOString()
  return {
    id: REPO_NAMES.indexOf(name) + 1,
    owner: OWNER,
    name,
    fullName: repoFull(name),
    private: true,
    defaultBranch: "main",
    htmlUrl: `https://github.com/${repoFull(name)}`,
    pushedAt,
    updatedAt: pushedAt,
  }
}

const GITHUB_REPOS: GitHubRepoSummary[] = [
  repo("clip-anywhere", 1),
  repo("promptlint", 2),
  repo("inkdrop", 4),
  repo("duckboard", 6),
  repo("old-portfolio", 28),
  repo("habit-grid", 3),
  repo("ship-list", 5),
]

let costSeq = 0
function cost(
  provider: Provider,
  serviceName: string,
  amount: number,
  attributedRepo: string | null,
  attribution: NormalizedCostRow["attribution"] = "verified",
  resourceName?: string,
): NormalizedCostRow {
  costSeq += 1
  return {
    provider,
    serviceName,
    resourceId: `res-${costSeq}`,
    resourceName: resourceName ?? `${serviceName} resource`,
    billingPeriodStart: PERIOD.from,
    billingPeriodEnd: PERIOD.to,
    cost: amount,
    currency: "USD",
    attribution,
    attributionReason:
      attributedRepo === null
        ? "No repo matched this billing row."
        : attribution === "inferred"
          ? "Inferred from repo config and resource naming."
          : `Attributed to ${attributedRepo} by resource naming.`,
    signalId: null,
    source: "live",
    attributedRepo,
  }
}

const COST_ROWS: NormalizedCostRow[] = [
  // clip-anywhere (video transcode SaaS)
  cost("aws", "EC2 + S3 + Transcode", 78.0, "clip-anywhere"),
  cost("cloudflare", "Stream + R2", 22.4, "clip-anywhere"),
  cost("anthropic", "Messages (API)", 28.0, "clip-anywhere", "verified", "claude-3-5-sonnet"),
  // promptlint (AI prompt linter)
  cost("openai", "Completions (API)", 24.0, "promptlint", "verified", "gpt-4o"),
  cost("anthropic", "Messages (API)", 27.0, "promptlint", "verified", "claude-3-5-haiku"),
  cost("cursor", "Cursor Pro (subscription)", 10.0, "promptlint"),
  // inkdrop (markdown notes)
  cost("vercel", "Hosting + bandwidth", 12.0, "inkdrop"),
  cost("cloudflare", "Workers Paid", 6.2, "inkdrop"),
  cost("openai", "Embeddings (API)", 16.0, "inkdrop", "verified", "text-embedding-3"),
  // duckboard (analytics) — inferred
  cost("gcp", "BigQuery", 13.0, "duckboard", "inferred"),
  cost("motherduck", "Compute", 9.0, "duckboard", "inferred"),
  // old-portfolio (stale)
  cost("aws", "Route 53 + idle EC2 nano", 4.1, "old-portfolio"),
  // AI subscriptions (flat)
  cost("anthropic", "Claude Pro (subscription)", 20.0, null, "verified", "claude-pro-seat"),
  cost("openai", "ChatGPT Plus (subscription)", 20.0, null, "verified", "chatgpt-plus-seat"),
  cost("cursor", "Cursor Team (subscription)", 10.0, null, "verified", "cursor-team-seat"),
  // Unmapped AWS spend → leaks + assignment queue ($18.40)
  cost("aws", "S3 · marketing-assets", 8.4, null),
  cost("aws", "CloudWatch Logs · us-east-1", 5.0, null),
  cost("aws", "Data transfer · NAT gateway", 5.0, null),
]

function usage(
  provider: Provider,
  planName: string,
  service: string,
  used: number,
  limit: number,
  unit: string,
): FreeTierUsageRow {
  const percentUsed = Math.round((used / limit) * 100)
  return {
    provider,
    planName,
    service,
    used,
    limit,
    unit,
    remaining: Math.max(limit - used, 0),
    percentUsed,
    source: "measured",
    note: `${used} of ${limit} ${unit} used this period.`,
  }
}

const FREE_TIER: FreeTierUsageRow[] = [
  usage("cloudflare", "Workers Free", "Workers Requests", 820_000, 1_000_000, "req"),
  usage("motherduck", "Free", "Free compute units", 6.4, 10, "units"),
  usage("github", "Free", "Actions minutes", 1_180, 2_000, "min"),
  usage("vercel", "Hobby", "Bandwidth", 41, 100, "GB"),
  usage("gcp", "Free", "Cloud Run requests", 180_000, 2_000_000, "req"),
  usage("vercel", "Hobby", "Image Optimization", 420, 5_000, "src"),
  usage("anthropic", "Claude Max", "Value at API rates", 123.05, 200, "USD est."),
  usage("openai", "ChatGPT Pro", "Value at API rates", 250.25, 300, "USD est."),
]

const AI_LOCAL_USAGE = {
  anthropic: {
    month: PERIOD.from.slice(0, 7),
    subscriptionUsd: 20,
    planLabel: "Max",
    toolLabel: "Claude Code",
    limits: [
      { label: "Session messages", used: 38, limit: 50, unit: "messages", period: "session", resetsAt: new Date(NOW.getTime() + 42 * 60_000).toISOString() },
      { label: "Weekly messages", used: 312, limit: 500, unit: "messages", period: "weekly", resetsAt: new Date(NOW.getTime() + 3 * 86_400_000).toISOString() },
      { label: "Monthly included value", used: 123.05, limit: 200, unit: "USD est.", period: "monthly", resetsAt: MONTH_END_RESET.toISOString() },
    ],
    models: [
      {
        model: "claude-opus-4-8",
        inputTokens: 1_180_000,
        cacheTokens: 3_900_000,
        outputTokens: 420_000,
        inputUsd: 5.9,
        cacheUsd: 1.95,
        outputUsd: 10.5,
        estimatedApiUsd: 18.35,
        rates: { inputPerMillion: 5, cachePerMillion: 0.5, cacheReadPerMillion: 0.5, outputPerMillion: 25 },
      },
      {
        model: "claude-sonnet-4",
        inputTokens: 7_600_000,
        cacheTokens: 18_000_000,
        outputTokens: 5_100_000,
        inputUsd: 22.8,
        cacheUsd: 5.4,
        outputUsd: 76.5,
        estimatedApiUsd: 104.7,
        rates: { inputPerMillion: 3, cachePerMillion: 0.3, cacheReadPerMillion: 0.3, outputPerMillion: 15 },
      },
    ],
    totals: { inputTokens: 8_780_000, cacheTokens: 21_900_000, outputTokens: 5_520_000, inputUsd: 28.7, cacheUsd: 7.35, outputUsd: 87, estimatedApiUsd: 123.05 },
  },
  openai: {
    month: PERIOD.from.slice(0, 7),
    subscriptionUsd: 20,
    planLabel: "Pro",
    toolLabel: "Codex",
    limits: [
      { label: "Session limit", used: 76, limit: 100, unit: "turns", period: "session", resetsAt: new Date(NOW.getTime() + 26 * 60_000).toISOString() },
      { label: "Weekly limit", used: 584, limit: 1_000, unit: "turns", period: "weekly", resetsAt: new Date(NOW.getTime() + 5 * 86_400_000).toISOString() },
      { label: "Monthly included value", used: 250.25, limit: 300, unit: "USD est.", period: "monthly", resetsAt: MONTH_END_RESET.toISOString() },
    ],
    models: [
      {
        model: "gpt-5.5",
        inputTokens: 9_400_000,
        cacheTokens: 22_500_000,
        outputTokens: 3_800_000,
        inputUsd: 47,
        cacheUsd: 11.25,
        outputUsd: 114,
        estimatedApiUsd: 172.25,
        rates: { inputPerMillion: 5, cachePerMillion: 0.5, cacheReadPerMillion: null, outputPerMillion: 30 },
      },
      {
        model: "gpt-5.4-mini",
        inputTokens: 28_000_000,
        cacheTokens: 40_000_000,
        outputTokens: 12_000_000,
        inputUsd: 21,
        cacheUsd: 3,
        outputUsd: 54,
        estimatedApiUsd: 78,
        rates: { inputPerMillion: 0.75, cachePerMillion: 0.075, cacheReadPerMillion: null, outputPerMillion: 4.5 },
      },
    ],
    totals: { inputTokens: 37_400_000, cacheTokens: 62_500_000, outputTokens: 15_800_000, inputUsd: 68, cacheUsd: 14.25, outputUsd: 168, estimatedApiUsd: 250.25 },
  },
}

function conn(
  provider: Provider,
  accountLabel: string,
  opts: { lastError?: string | null; metadata?: Record<string, unknown> } = {},
): StoredConnection {
  return {
    provider,
    status: "connected",
    accountLabel,
    connectedAt: "2026-02-01T00:00:00.000Z",
    lastVerifiedAt: TWO_HOURS_AGO,
    lastError: opts.lastError ?? null,
    metadata: opts.metadata ?? {},
  }
}

const CONNECTIONS: Partial<Record<Provider, StoredConnection>> = {
  vercel: conn("vercel", "4 projects"),
  cloudflare: conn("cloudflare", "3 zones", { lastError: "API token expires in 3 days." }),
  aws: conn("aws", "Cost Explorer", { metadata: { costExplorer: true } }),
  openai: conn("openai", "Usage API", { metadata: { source: "both", showApi: true, localUsage: AI_LOCAL_USAGE.openai } }),
  anthropic: conn("anthropic", "Usage API", { metadata: { source: "both", showApi: true, localUsage: AI_LOCAL_USAGE.anthropic } }),
  cursor: conn("cursor", "Team seat"),
  github: conn("github", "12 repos", { metadata: { installationId: 1 } }),
}

function providerConnection(
  provider: Provider,
  status: ProviderConnection["status"],
  detected: boolean,
  setupNotes: string,
  accountLabel: string | null = null,
): ProviderConnection {
  return {
    provider,
    label: provider,
    status,
    authMode: status === "connected" ? "api_token" : "none",
    detected,
    requiredSecrets: [],
    setupNotes,
    accountLabel,
    connectedAt: status === "connected" ? "2026-02-01T00:00:00.000Z" : null,
    lastVerifiedAt: status === "connected" ? TWO_HOURS_AGO : null,
    lastError: provider === "cloudflare" ? "API token expires in 3 days." : null,
  }
}

const PROVIDER_CONNECTIONS: ProviderConnection[] = [
  providerConnection("vercel", "connected", true, "Connected via OAuth.", "4 projects"),
  providerConnection("cloudflare", "connected", true, "Connected via API token.", "3 zones"),
  providerConnection("aws", "connected", true, "Connected via read-only role.", "Cost Explorer"),
  providerConnection("openai", "connected", true, "Connected via admin key.", "Usage API"),
  providerConnection("anthropic", "connected", true, "Connected via admin key.", "Usage API"),
  providerConnection("cursor", "connected", true, "Connected via team key.", "Team seat"),
  providerConnection("github", "connected", true, "Connected via GitHub App.", "12 repos"),
  providerConnection("gcp", "setup_required", true, "Usage detected for duckboard, ship-list. Connect a BigQuery billing export."),
  providerConnection("motherduck", "setup_required", true, "Usage detected for duckboard. Connect a read token."),
]

const LIVE_SYNC: AnalysisResult["liveSync"] = [
  { provider: "vercel", status: "success", message: "Synced.", rows: 6, syncedAt: TWO_HOURS_AGO },
  { provider: "aws", status: "success", message: "Synced.", rows: 12, syncedAt: TWO_HOURS_AGO },
  { provider: "openai", status: "success", message: "Synced.", rows: 4, syncedAt: TWO_HOURS_AGO },
  { provider: "anthropic", status: "success", message: "Synced.", rows: 4, syncedAt: TWO_HOURS_AGO },
  { provider: "cursor", status: "success", message: "Synced.", rows: 2, syncedAt: TWO_HOURS_AGO },
  { provider: "github", status: "success", message: "Synced.", rows: 7, syncedAt: TWO_HOURS_AGO },
  {
    provider: "cloudflare",
    status: "error",
    message: "Cloudflare API token expires in 3 days. Reconnect to keep cost sync.",
    rows: 0,
    syncedAt: TWO_HOURS_AGO,
  },
]

function signal(provider: Provider, sourcePath: string, title: string): RepoSignal {
  return { id: `${provider}-${sourcePath}`, provider, signalType: "file", sourcePath, title, evidence: sourcePath, confidence: 0.9 }
}

// Per-repo signals so confidence resolves to "verified" (detected + connected)
// for these repos, "confirmed" for repos with explicit links, "inferred" otherwise.
const REPO_SIGNALS: Record<string, RepoSignal[]> = {
  "clip-anywhere": [
    signal("aws", "infra/main.tf", "AWS S3 + Transcode"),
    signal("cloudflare", "wrangler.toml", "Cloudflare Stream"),
    signal("anthropic", ".env.example", "Anthropic API key"),
  ],
  inkdrop: [signal("vercel", "vercel.json", "Vercel project"), signal("openai", "package.json", "OpenAI SDK")],
  "habit-grid": [signal("cloudflare", "wrangler.toml", "Cloudflare Workers"), signal("vercel", "vercel.json", "Vercel")],
}

function baseAnalysis(overrides: Partial<AnalysisResult>): AnalysisResult {
  return {
    repo: {
      name: "workspace",
      owner: OWNER,
      path: ".",
      remoteUrl: null,
      scannedAt: TWO_HOURS_AGO,
    },
    period: PERIOD,
    summary: { totalCost: 0, exactCost: 0, inferredCost: 0, detectedProviders: 0, signals: 0, confidence: 0.8 },
    signals: [],
    providerConnections: [],
    providerBreakdown: [],
    costRows: [],
    freeTier: [],
    resourceItems: [],
    actions: [],
    liveSync: [],
    ...overrides,
  }
}

const OVERVIEW_ANALYSIS: AnalysisResult = baseAnalysis({
  signals: Object.values(REPO_SIGNALS).flat(),
  providerConnections: PROVIDER_CONNECTIONS,
  costRows: COST_ROWS,
  freeTier: FREE_TIER,
  liveSync: LIVE_SYNC,
  summary: {
    totalCost: COST_ROWS.reduce((s, r) => s + r.cost, 0),
    exactCost: COST_ROWS.filter((r) => r.attribution !== "inferred").reduce((s, r) => s + r.cost, 0),
    inferredCost: COST_ROWS.filter((r) => r.attribution === "inferred").reduce((s, r) => s + r.cost, 0),
    detectedProviders: 9,
    signals: Object.values(REPO_SIGNALS).flat().length,
    confidence: 0.85,
  },
})

function snapshot(key: string, analysis: AnalysisResult): AnalysisSnapshot {
  return { key, analysis, computedAt: TWO_HOURS_AGO }
}

const ANALYSIS_SNAPSHOTS: Record<string, AnalysisSnapshot> = {
  __overview__: snapshot("__overview__", OVERVIEW_ANALYSIS),
}
for (const [name, signals] of Object.entries(REPO_SIGNALS)) {
  const full = repoFull(name)
  ANALYSIS_SNAPSHOTS[full] = snapshot(
    full,
    baseAnalysis({
      repo: { name, owner: OWNER, path: ".", remoteUrl: null, scannedAt: TWO_HOURS_AGO },
      signals,
      costRows: COST_ROWS.filter((r) => r.attributedRepo === name),
      providerConnections: PROVIDER_CONNECTIONS,
      freeTier: FREE_TIER,
      liveSync: LIVE_SYNC,
      summary: { totalCost: 0, exactCost: 0, inferredCost: 0, detectedProviders: signals.length, signals: signals.length, confidence: 0.9 },
    }),
  )
}

export function devPreviewWorkspace(): WorkspaceStore {
  return {
    connections: CONNECTIONS,
    githubRepos: GITHUB_REPOS,
    selectedRepoFullName: null,
    syncedRepoFullNames: GITHUB_REPOS.map((r) => r.fullName),
    events: [],
    analysisSnapshots: ANALYSIS_SNAPSHOTS,
    repoProviderLinks: {
      // Explicit links → "confirmed" confidence for promptlint.
      [repoFull("promptlint")]: ["openai", "anthropic", "cursor"],
    },
    costAssignments: {},
    customProviders: {},
    customConnections: {},
    billingSubscription: null,
    monthlyBudgetUsd: 300,
    dashboardLayout: undefined,
  }
}

export function devPreviewSnapshot(key: string): AnalysisSnapshot {
  return ANALYSIS_SNAPSHOTS[key] ?? ANALYSIS_SNAPSHOTS.__overview__
}

// Real-shaped 6-month per-repo history for the Projects sparklines.
export function devPreviewTrends(): Record<string, Array<{ month: string; total: number }>> {
  const months: string[] = []
  for (let i = 5; i >= 1; i -= 1) {
    const d = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - i, 1))
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`)
  }
  const series: Record<string, number[]> = {
    [repoFull("clip-anywhere")]: [60, 72, 80, 95, 110],
    [repoFull("promptlint")]: [20, 28, 35, 44, 52],
    [repoFull("inkdrop")]: [30, 31, 33, 32, 34],
    [repoFull("duckboard")]: [10, 14, 17, 19, 21],
    [repoFull("old-portfolio")]: [4, 4, 4, 4, 4],
  }
  const out: Record<string, Array<{ month: string; total: number }>> = {}
  for (const [full, totals] of Object.entries(series)) {
    out[full] = totals.map((total, i) => ({ month: months[i], total }))
  }
  return out
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  const [fy, fm] = from.split("-").map(Number)
  const [ty, tm] = to.split("-").map(Number)
  let y = fy
  let m = fm
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

// Seeded historical analytics so the Insights "cost history" panel renders with
// real-shaped monthly data instead of spinning (analytics reads need a DB).
export function devPreviewAnalyticsDashboard(input: { from: string; to: string; month: string }) {
  const months = monthsBetween(input.from, input.to)
  const total = COST_ROWS.reduce((s, r) => s + r.cost, 0)
  // Ramp prior months up to the current total.
  const monthlyTotals = months.map((month, i) => ({
    month,
    currency: "USD",
    total: Math.round((total * (0.55 + (0.45 * i) / Math.max(months.length - 1, 1))) * 100) / 100,
    lastObservedAt: TWO_HOURS_AGO,
  }))
  const providerShare: Array<[Provider, number]> = [
    ["aws", 0.3],
    ["anthropic", 0.24],
    ["openai", 0.19],
    ["cloudflare", 0.12],
    ["vercel", 0.08],
    ["gcp", 0.07],
  ]
  const providers = months.flatMap((month, i) =>
    providerShare.map(([provider, share]) => ({
      month,
      provider,
      currency: "USD",
      total: Math.round(monthlyTotals[i].total * share * 100) / 100,
      lastObservedAt: TWO_HOURS_AGO,
    })),
  )
  const serviceTotals = new Map<string, { provider: Provider; serviceName: string; total: number }>()
  for (const row of COST_ROWS) {
    const key = `${row.provider}:${row.serviceName}`
    const cur = serviceTotals.get(key) ?? { provider: row.provider, serviceName: row.serviceName, total: 0 }
    cur.total += row.cost
    serviceTotals.set(key, cur)
  }
  const services = [...serviceTotals.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, 8)
    .map((s) => ({ provider: s.provider, serviceName: s.serviceName, currency: "USD", total: Math.round(s.total * 100) / 100, lastObservedAt: TWO_HOURS_AGO }))
  return {
    trends: { from: input.from, to: input.to, repo: null, trends: monthlyTotals, providers, lastObservedAt: TWO_HOURS_AGO },
    services: { month: input.month, repo: null, services, lastObservedAt: TWO_HOURS_AGO },
  }
}
