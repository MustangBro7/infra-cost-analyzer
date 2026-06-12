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
  source?: "estimate" | "live"
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

export interface WorkspaceStore {
  connections: Partial<Record<Provider, StoredConnection>>
  githubRepos: GitHubRepoSummary[]
  selectedRepoFullName: string | null
  events: ConnectionEvent[]
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
