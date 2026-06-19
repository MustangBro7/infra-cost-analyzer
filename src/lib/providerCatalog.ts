import type { Provider, ProviderConnection, RepoSignal, WorkspaceStore } from "./types"

type ProviderConfig = Omit<ProviderConnection, "status" | "detected">

export const PROVIDERS: Record<Exclude<Provider, "unknown">, ProviderConfig> = {
  github: {
    provider: "github",
    label: "GitHub",
    authMode: "github_app",
    requiredSecrets: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"],
    setupNotes: "Install the GitHub App on selected repositories with read-only metadata, contents, actions, deployments, and webhooks.",
  },
  vercel: {
    provider: "vercel",
    label: "Vercel",
    authMode: "oauth",
    requiredSecrets: ["VERCEL_TOKEN"],
    setupNotes: "Authorize team/project billing. Use the billing charges endpoint for FOCUS cost rows and project metadata for repo mapping.",
  },
  aws: {
    provider: "aws",
    label: "AWS",
    authMode: "iam_role",
    requiredSecrets: ["AWS_ROLE_ARN", "AWS_EXTERNAL_ID"],
    setupNotes: "Create a read-only cross-account role with Cost Explorer and tag/resource inventory access.",
  },
  gcp: {
    provider: "gcp",
    label: "Google Cloud",
    authMode: "oauth",
    requiredSecrets: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    setupNotes: "Authorize billing account/project discovery and connect a BigQuery detailed billing export for resource-level costs.",
  },
  azure: {
    provider: "azure",
    label: "Azure",
    authMode: "oauth",
    requiredSecrets: ["AZURE_CLIENT_ID", "AZURE_TENANT_ID"],
    setupNotes: "Grant Cost Management Reader over the subscription/resource groups used by the repo.",
  },
  cloudflare: {
    provider: "cloudflare",
    label: "Cloudflare",
    authMode: "api_token",
    requiredSecrets: ["CLOUDFLARE_PROVIDER_API_TOKEN"],
    setupNotes: "Provide a scoped account token for Workers/Pages/D1/R2 inventory and billing usage where enabled.",
  },
  motherduck: {
    provider: "motherduck",
    label: "MotherDuck",
    authMode: "api_token",
    requiredSecrets: ["MOTHERDUCK_DATABASE_URL"],
    setupNotes: "Connect a PostgreSQL endpoint to track database storage usage and paid-plan storage cost.",
  },
  digitalocean: {
    provider: "digitalocean",
    label: "DigitalOcean",
    authMode: "api_token",
    requiredSecrets: ["DIGITALOCEAN_TOKEN"],
    setupNotes: "Provide a read-only token for projects, resources, balance, invoices, and billing history.",
  },
  docker: {
    provider: "docker",
    label: "Docker",
    authMode: "none",
    requiredSecrets: [],
    setupNotes: "Docker is scanned as deployment evidence. Exact cost attribution comes from the cloud provider running the containers.",
  },
}

export function buildProviderConnections(signals: RepoSignal[], env: NodeJS.ProcessEnv, workspace: WorkspaceStore): ProviderConnection[] {
  const detected = new Set(signals.map((signal) => signal.provider))
  return Object.values(PROVIDERS).map((config) => {
    const providerDetected = detected.has(config.provider)
    const configured = config.requiredSecrets.every((secret) => Boolean(env[secret]))
    const saved = workspace.connections[config.provider]
    if (saved) {
      return {
        ...config,
        detected: providerDetected || config.provider === "github" || config.provider === "vercel",
        status: saved.status === "connected" ? "connected" : "setup_required",
        accountLabel: saved.accountLabel,
        connectedAt: saved.connectedAt,
        lastVerifiedAt: saved.lastVerifiedAt,
        lastError: saved.lastError,
      }
    }
    return {
      ...config,
      detected: providerDetected,
      status: providerDetected ? (configured || config.requiredSecrets.length === 0 ? "connected" : "setup_required") : "not_detected",
    }
  })
}
