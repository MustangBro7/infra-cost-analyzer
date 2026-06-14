export type Provider =
  | "github"
  | "vercel"
  | "aws"
  | "gcp"
  | "azure"
  | "cloudflare"
  | "digitalocean"
  | "docker"
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
}

export interface ProviderBreakdown {
  provider: Provider
  total: number
  exact: number
  inferred: number
  signalCount: number
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

export interface AppStore {
  users: Record<string, LocalUser>
  sessions: Record<string, LocalSession>
  workspaces: Record<string, WorkspaceStore>
}

export interface ConnectionEvent {
  id: string
  provider: Provider | "system"
  level: "info" | "success" | "warning" | "error"
  message: string
  createdAt: string
}
