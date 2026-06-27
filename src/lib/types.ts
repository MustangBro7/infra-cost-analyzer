import type { DashboardWidgetId, DashboardWidgetLayout, DashboardWidgetSize } from "./dashboardLayout"

export type Provider =
  | "github"
  | "vercel"
  | "aws"
  | "gcp"
  | "azure"
  | "cloudflare"
  | "motherduck"
  | "digitalocean"
  | "docker"
  // AI coding tools / subscriptions (cost + token usage pulled from each
  // vendor's organization usage & cost API).
  | "anthropic"
  | "openai"
  | "cursor"
  // A user-defined connector registered at runtime (by the user or their AI
  // agent) via the extension API. The specific connector is identified by
  // `customProviderId` on each row; see CustomProviderDef.
  | "custom"
  | "unknown"

export type SignalType =
  | "file"
  | "workflow"
  | "package"
  | "iac"
  | "deployment"
  | "env"
  | "container"
  | "documentation"

export type Attribution = "verified" | "user_confirmed" | "inferred"

export interface RepoSignal {
  id: string
  provider: Provider
  signalType: SignalType
  sourcePath: string
  title: string
  evidence: string
  confidence: number
  matchedResource?: string
}

export interface ProviderConnection {
  provider: Provider
  label: string
  status: "connected" | "setup_required" | "not_detected" | "unavailable"
  authMode: "github_app" | "oauth" | "iam_role" | "api_token" | "local_scan" | "none"
  detected: boolean
  requiredSecrets: string[]
  setupNotes: string
  accountLabel?: string | null
  connectedAt?: string | null
  lastVerifiedAt?: string | null
  lastError?: string | null
}

export interface NormalizedCostRow {
  provider: Provider
  serviceName: string
  resourceId: string | null
  resourceName: string | null
  billingPeriodStart: string
  billingPeriodEnd: string
  cost: number
  currency: string
  attribution: Attribution
  attributionReason: string
  signalId: string | null
  source?: "live"
  // Lowercased short name of the repo this row is tied to within its account
  // (e.g. a Vercel project linked to the repo). null = account-level / shared.
  attributedRepo?: string | null
  // For provider === "custom": which user-defined connector produced this row,
  // and its display label. Lets the dashboard group/show each custom provider
  // distinctly even though they share the "custom" Provider value.
  customProviderId?: string
  customLabel?: string
}

/**
 * A measured consumption sample pulled live from a provider, independent of
 * cost. Used to compute free-tier usage remaining even when the cost is $0.
 */
export interface ProviderUsageSample {
  provider: Provider
  service: string
  quantity: number
  unit: string
  customProviderId?: string
  customLabel?: string
}

/**
 * Free-tier / consumption usage line for a connected provider. `used` is null
 * when the provider publishes an allowance but reported no consumption; `limit`
 * is null when the provider reported real usage for which we have no published
 * free allowance (we still show the measured amount, like AWS does).
 */
export interface FreeTierUsageRow {
  provider: Provider
  planName: string
  service: string
  used: number | null
  limit: number | null
  unit: string
  remaining: number | null
  percentUsed: number | null
  source: "measured" | "allowance"
  note: string
  customProviderId?: string
  customLabel?: string
}

export interface ProviderBreakdown {
  provider: Provider
  total: number
  exact: number
  inferred: number
  signalCount: number
}

/**
 * A discrete infrastructure resource within an account (e.g. a Cloudflare
 * Worker script or a domain) with its usage, surfaced so the user can assign it
 * to a repo for drilled-down visibility. Uses the same assignment mechanism as
 * cost rows (stable `itemKey` + optional auto-attribution).
 */
export interface ResourceUsageItem {
  provider: Provider
  itemKey: string
  kind: string
  name: string
  quantity: number
  unit: string
  attributedRepo?: string | null
  customProviderId?: string
  customLabel?: string
}

export interface AnalysisResult {
  repo: {
    name: string
    owner: string
    path: string
    remoteUrl: string | null
    scannedAt: string
  }
  period: {
    from: string
    to: string
  }
  summary: {
    totalCost: number
    exactCost: number
    inferredCost: number
    detectedProviders: number
    signals: number
    confidence: number
  }
  signals: RepoSignal[]
  providerConnections: ProviderConnection[]
  providerBreakdown: ProviderBreakdown[]
  costRows: NormalizedCostRow[]
  freeTier: FreeTierUsageRow[]
  resourceItems: ResourceUsageItem[]
  actions: string[]
  liveSync: Array<{
    provider: Provider
    status: "not_connected" | "success" | "empty" | "error"
    message: string
    rows: number
    syncedAt: string | null
  }>
}

export interface GitHubRepoSummary {
  id: number
  owner: string
  name: string
  fullName: string
  private: boolean
  defaultBranch: string
  htmlUrl: string
  pushedAt?: string | null
  updatedAt?: string | null
}

export interface StoredConnection {
  provider: Provider
  status: "connected" | "setup_required" | "error"
  accountLabel: string | null
  accessToken?: string
  installationId?: number
  selectedRepoFullName?: string
  connectedAt: string
  lastVerifiedAt: string | null
  lastError: string | null
  metadata: Record<string, unknown>
}

/**
 * A user-defined ("custom") provider connector, registered at runtime via the
 * extension API (by the user or their AI coding agent) so the platform can pull
 * cost and usage from hosting providers we don't ship a built-in integration
 * for. It is a declarative HTTP-to-JSON mapping the cost engine executes on each
 * refresh — no code deploy required. The pasted secret lives on the matching
 * StoredConnection (workspace.customConnections), never in the definition.
 */
export interface CustomProviderDef {
  // Stable id (e.g. "cpr_ab12cd"). Used as customProviderId on every row.
  id: string
  name: string
  // Optional 1–2 char badge + chart color for the dashboard.
  shortLabel?: string | null
  color?: string | null
  homepage?: string | null
  // How to authenticate. The user's pasted secret is injected wherever the
  // request template references {{token}}; this just picks the transport.
  auth: {
    type: "bearer" | "header" | "basic" | "query" | "none"
    headerName?: string | null
    queryParam?: string | null
  }
  // The HTTP request to make. URL/headers/body may use {{token}} plus the time
  // placeholders {{periodStart}} {{periodEnd}} (YYYY-MM-DD), {{monthStart}},
  // and {{periodStartUnix}} {{periodEndUnix}} (seconds).
  request: {
    method: "GET" | "POST"
    url: string
    headers?: Record<string, string>
    body?: string | null
  }
  // Extract cost rows from the JSON response. itemsPath is a dot path to an
  // array ("" means the response itself is the array). amountField/serviceField
  // are dot paths within each item.
  cost?: {
    itemsPath: string
    amountField: string
    amountInCents?: boolean
    serviceField?: string | null
    currency?: string | null
  } | null
  // Extract usage samples (e.g. tokens, GB, requests) the same way.
  usage?: {
    itemsPath: string
    quantityField: string
    serviceField?: string | null
    unitField?: string | null
    unit?: string | null
  } | null
  createdAt: string
  updatedAt: string
}

/**
 * A persisted analysis result so the dashboard renders from the database
 * instead of recomputing live provider/GitHub data on every page load.
 */
export interface AnalysisSnapshot {
  key: string
  analysis: AnalysisResult
  computedAt: string
}

export interface WorkspaceStore {
  connections: Partial<Record<Provider, StoredConnection>>
  githubRepos: GitHubRepoSummary[]
  selectedRepoFullName: string | null
  syncedRepoFullNames: string[]
  events: ConnectionEvent[]
  analysisSnapshots: Record<string, AnalysisSnapshot>
  // Which connected provider accounts each repo is linked to (keyed by repo full
  // name). When unset for a repo, a sensible default is derived (the connected
  // providers its scan detected). Drives per-repo cost filtering.
  repoProviderLinks: Record<string, Provider[]>
  // Manual assignment of individual account billing line items to a repo, keyed
  // by a stable cost-item key. Value is a repo full name, or "__account__" to
  // force account-level. Lets the user split an account's cost across repos.
  costAssignments: Record<string, string>
  // Optional monthly spend budget (USD) the dashboard tracks actual + projected
  // spend against. null/undefined = no budget set.
  monthlyBudgetUsd?: number | null
  // User-controlled dashboard widget order and widths.
  dashboardLayout?: Array<DashboardWidgetLayout | { id: DashboardWidgetId; size: DashboardWidgetSize }>
  // User-defined provider connectors registered via the extension API, keyed by
  // CustomProviderDef.id.
  customProviders: Record<string, CustomProviderDef>
  // Pasted secrets for custom providers, keyed by CustomProviderDef.id. Stored
  // server-side only (publicStore never exposes accessToken), exactly like the
  // built-in provider connections.
  customConnections: Record<string, StoredConnection>
}

export interface LocalUser {
  id: string
  email: string
  name: string
  createdAt: string
  lastSignedInAt: string
}

export interface LocalSession {
  id: string
  userId: string
  createdAt: string
  expiresAt: string
}

/**
 * A companion-CLI pairing (OAuth Device Authorization Grant, RFC 8628). The CLI
 * starts a pairing (pending), the signed-in user approves it in the browser by
 * typing the userCode (authorized + a short-lived cliToken is minted), and the
 * CLI polls until it receives the cliToken to call the /api/cli/* endpoints.
 */
export interface CliPairing {
  deviceCode: string
  userCode: string
  userId: string | null
  status: "pending" | "authorized" | "denied"
  createdAt: string
  // Expiry of the device/user code (the approval window).
  expiresAt: string
  cliToken: string | null
  cliTokenExpiresAt: string | null
}

export interface AppStore {
  users: Record<string, LocalUser>
  sessions: Record<string, LocalSession>
  workspaces: Record<string, WorkspaceStore>
  // Companion-CLI pairings, keyed by deviceCode. Pruned on access once expired.
  cliPairings: Record<string, CliPairing>
}

export interface ConnectionEvent {
  id: string
  provider: Provider | "system"
  level: "info" | "success" | "warning" | "error"
  message: string
  createdAt: string
}
