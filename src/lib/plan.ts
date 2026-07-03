import type { BillingPlan, Provider, WorkspaceStore } from "./types"

/**
 * The advertised plan entitlements (see /pricing and README):
 *   Free  — 2 projects, 2 providers, monthly background refresh, no email alerts.
 *   Indie — unlimited projects/providers, refresh on every cron tick, alerts.
 *
 * `maxSyncedRepos`/`maxProviders` of null mean unlimited. `backgroundRefreshDays`
 * is the minimum age a snapshot must reach before the cron sweep re-pulls it
 * (0 = refresh on every tick). Manual "Refresh now" stays available on every
 * plan — only automation and alerting are gated.
 */
export interface PlanLimits {
  maxSyncedRepos: number | null
  maxProviders: number | null
  backgroundRefreshDays: number
  emailAlerts: boolean
}

export const PLAN_LIMITS: Record<BillingPlan, PlanLimits> = {
  free: { maxSyncedRepos: 2, maxProviders: 2, backgroundRefreshDays: 30, emailAlerts: false },
  indie: { maxSyncedRepos: null, maxProviders: null, backgroundRefreshDays: 0, emailAlerts: true },
}

/**
 * Thrown when an action would exceed the workspace's plan entitlements. Carries
 * a stable `code` so API routes/UI can distinguish it from ordinary failures
 * (e.g. to render an upgrade CTA instead of a red error).
 */
export class PlanLimitError extends Error {
  readonly code = "plan_limit"
  constructor(message: string) {
    super(message)
    this.name = "PlanLimitError"
  }
}

/**
 * The plan a workspace is entitled to right now. Indie requires an indie
 * subscription that is active or in dunning (past_due keeps access while Dodo
 * retries payment); a cancelled subscription keeps access until the paid
 * period it already covers runs out.
 */
export function workspacePlan(workspace: Pick<WorkspaceStore, "billingSubscription">): BillingPlan {
  const subscription = workspace.billingSubscription
  if (!subscription || subscription.plan !== "indie") return "free"
  if (subscription.status === "active" || subscription.status === "past_due") return "indie"
  if (subscription.status === "cancelled" && subscription.currentPeriodEnd) {
    if (new Date(subscription.currentPeriodEnd).getTime() > Date.now()) return "indie"
  }
  return "free"
}

export function planLimits(workspace: Pick<WorkspaceStore, "billingSubscription">): PlanLimits {
  return PLAN_LIMITS[workspacePlan(workspace)]
}

/**
 * Billing providers currently connected, which is what the "2 providers" limit
 * counts. GitHub is excluded — it is the repo source every workspace needs,
 * not a cost source. Each connected custom provider counts as one.
 */
export function connectedProviderCount(
  workspace: Pick<WorkspaceStore, "connections" | "customConnections">
): number {
  const builtIn = Object.values(workspace.connections).filter(
    (connection) => connection && connection.status === "connected" && connection.provider !== "github"
  ).length
  const custom = Object.values(workspace.customConnections ?? {}).filter(
    (connection) => connection.status === "connected"
  ).length
  return builtIn + custom
}

/**
 * Throws PlanLimitError when connecting `provider` would exceed the plan's
 * provider limit. Reconnecting/updating a provider that already has a
 * connection entry is always allowed.
 */
export function assertCanConnectProvider(workspace: WorkspaceStore, provider: Provider): void {
  if (provider === "github") return
  if (workspace.connections[provider]) return
  const limits = planLimits(workspace)
  if (limits.maxProviders == null) return
  if (connectedProviderCount(workspace) >= limits.maxProviders) {
    throw new PlanLimitError(
      `The Free plan connects up to ${limits.maxProviders} providers. Upgrade to Indie ($5/month) for unlimited providers.`
    )
  }
}

/** Same check for a custom (user-defined) provider connection, by definition id. */
export function assertCanConnectCustomProvider(workspace: WorkspaceStore, customProviderId: string): void {
  if (workspace.customConnections?.[customProviderId]) return
  const limits = planLimits(workspace)
  if (limits.maxProviders == null) return
  if (connectedProviderCount(workspace) >= limits.maxProviders) {
    throw new PlanLimitError(
      `The Free plan connects up to ${limits.maxProviders} providers. Upgrade to Indie ($5/month) for unlimited providers.`
    )
  }
}

/**
 * Throws PlanLimitError when syncing `repoFullName` would exceed the plan's
 * project limit. Repos already synced never re-trip the limit.
 */
export function assertCanSyncRepo(workspace: WorkspaceStore, repoFullName: string): void {
  if (workspace.syncedRepoFullNames.includes(repoFullName)) return
  const limits = planLimits(workspace)
  if (limits.maxSyncedRepos == null) return
  if (workspace.syncedRepoFullNames.length >= limits.maxSyncedRepos) {
    throw new PlanLimitError(
      `The Free plan syncs up to ${limits.maxSyncedRepos} repositories. Upgrade to Indie ($5/month) for unlimited projects.`
    )
  }
}
