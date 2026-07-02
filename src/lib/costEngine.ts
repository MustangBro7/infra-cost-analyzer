import type {
  AnalysisResult,
  FreeTierUsageRow,
  NormalizedCostRow,
  Provider,
  ProviderBreakdown,
  ProviderUsageSample,
  RepoSignal,
  ResourceUsageItem,
  WorkspaceStore,
} from "./types"
import { buildProviderConnections } from "./providerCatalog"
import { computeFreeTierUsage } from "./freeTier"
import { attributeCostRows, attributeRepoForName, type VercelProjectLink } from "./costAttribution"
import { readWorkspace, upsertConnection } from "./localStore"
import { getAwsCostAndUsage, getAwsFreeTierUsage, resolveAwsCredentials, type AwsCostRow, type AwsCredentials } from "./awsClient"
import { fetchVercelAccountUsage, listVercelBillingCharges } from "./vercelClient"
import { getCloudflareAccountResources, getCloudflareAccountUsage, listCloudflareAccounts, listCloudflareSubscriptions, type CloudflareAccount, type CloudflareSubscription } from "./cloudflareClient"
import { queryGcpBillingExportCosts } from "./gcpClient"
import { fetchMotherDuckUsage, type MotherDuckPlan } from "./motherduckClient"
import { fetchAnthropicCostUsage, fetchOpenAiCostUsage, fetchCursorCostUsage, type AiCostUsage } from "./aiClients"
import { runCustomProvider } from "./customProvider"
import { sameUtcMonth } from "./dateRange"

function period() {
  const now = new Date()
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }
}

export function summarizeByProvider(costRows: NormalizedCostRow[], signals: RepoSignal[]): ProviderBreakdown[] {
  const signalCounts = signals.reduce((acc, signal) => {
    acc.set(signal.provider, (acc.get(signal.provider) ?? 0) + 1)
    return acc
  }, new Map<Provider, number>())

  const rows = costRows.reduce((acc, row) => {
    const current = acc.get(row.provider) ?? {
      provider: row.provider,
      total: 0,
      exact: 0,
      inferred: 0,
      signalCount: signalCounts.get(row.provider) ?? 0,
    }
    current.total += row.cost
    if (row.attribution === "inferred") {
      current.inferred += row.cost
    } else {
      current.exact += row.cost
    }
    acc.set(row.provider, current)
    return acc
  }, new Map<Provider, ProviderBreakdown>())

  return [...rows.values()]
    .map((row) => ({
      ...row,
      total: Number(row.total.toFixed(2)),
      exact: Number(row.exact.toFixed(2)),
      inferred: Number(row.inferred.toFixed(2)),
    }))
    .sort((a, b) => b.total - a.total)
}

export async function buildAnalysis(
  repoScan: ReturnType<typeof import("./repoScanner").scanRepositoryFiles>,
  env: NodeJS.ProcessEnv,
  userId = "usr_test"
): Promise<AnalysisResult> {
  const workspace = await readWorkspace(userId)
  return finalizeAnalysis(repoScan, env, workspace, [], [], [], [])
}

/**
 * When a connected provider's live pull ERRORS and returns nothing, don't let
 * the empty result overwrite the usage we already showed. Reconstruct that
 * provider's last-known-good rows/usage from the previous snapshot so a
 * transient provider-API failure can't blank the dashboard until the next good
 * refresh. Measured free-tier rows round-trip back into usage samples (the
 * analysis doesn't persist raw samples), which finalizeAnalysis re-derives into
 * the same free-tier lines.
 *
 * Never carries across a month boundary: a snapshot computed for a previous
 * billing month must not leak its rows into the new month's totals — a fresh
 * month legitimately starts at $0 until providers report new spend.
 */
export function carryForwardOnError(
  result: LiveResult,
  previous: AnalysisResult | undefined,
  currentPeriodFrom: string = period().from
): LiveResult {
  if (!previous) return result
  if (previous.period?.from && previous.period.from !== currentPeriodFrom) return result
  const provider = result.sync.provider
  const failedEmpty = result.sync.status === "error" && result.rows.length === 0 && result.usage.length === 0
  if (!failedEmpty) return result

  const prevRows = previous.costRows.filter((row) => row.provider === provider)
  const prevUsage: ProviderUsageSample[] = previous.freeTier
    .filter((row) => row.provider === provider && row.source === "measured" && row.used != null)
    .map((row) => ({ provider, service: row.service, quantity: row.used as number, unit: row.unit }))
  const prevResources = (previous.resourceItems ?? []).filter((item) => item.provider === provider)
  if (prevRows.length === 0 && prevUsage.length === 0) return result

  return {
    rows: prevRows,
    usage: prevUsage,
    resources: prevResources,
    sync: {
      ...result.sync,
      status: "success",
      message: `${result.sync.message} Showing last-known-good usage from the previous refresh.`,
    },
  }
}

export async function buildAnalysisWithLiveData(
  repoScan: ReturnType<typeof import("./repoScanner").scanRepositoryFiles>,
  env: NodeJS.ProcessEnv,
  userId: string,
  options?: { skipCostExplorer?: boolean; forceCostExplorer?: boolean; previousAnalysis?: AnalysisResult }
): Promise<AnalysisResult> {
  const workspace = await readWorkspace(userId)
  const previous = options?.previousAnalysis
  const [vercel, cloudflare, gcp, motherduck, anthropic, openai, cursor, custom, awsRaw] = await Promise.all([
    loadVercelLive(workspace, repoScan),
    loadCloudflareLive(workspace),
    loadGcpLive(workspace),
    loadMotherDuckLive(workspace),
    loadAiLive(workspace, "anthropic"),
    loadAiLive(workspace, "openai"),
    loadAiLive(workspace, "cursor"),
    loadCustomProvidersLive(workspace),
    loadAwsLive(workspace, userId, options),
  ])
  // Carry-forward (reuse last-known-good on a failed-empty pull) keys by
  // provider, so it only covers the single-connection built-ins. Custom
  // providers (all share provider "custom") are appended as-is.
  const standard = [vercel, cloudflare, gcp, motherduck, anthropic, openai, cursor].map((result) =>
    carryForwardOnError(result, previous)
  )

  // AWS carries its own free-tier rows, so guard it separately against the same
  // failed-and-empty case rather than through the shared usage path above.
  // Same month gate as carryForwardOnError: never resurrect a previous month.
  const previousSameMonth = !previous?.period?.from || previous.period.from === period().from
  let aws = awsRaw
  if (previous && previousSameMonth && awsRaw.sync.status === "error" && awsRaw.rows.length === 0 && awsRaw.freeTier.length === 0) {
    const prevRows = previous.costRows.filter((row) => row.provider === "aws")
    const prevFree = previous.freeTier.filter((row) => row.provider === "aws")
    if (prevRows.length > 0 || prevFree.length > 0) {
      aws = {
        ...awsRaw,
        rows: prevRows,
        freeTier: prevFree,
        sync: {
          ...awsRaw.sync,
          status: "success",
          message: `${awsRaw.sync.message} Showing last-known-good usage from the previous refresh.`,
        },
      }
    }
  }

  const costRows = [...standard.flatMap((result) => result.rows), ...custom.flatMap((result) => result.rows), ...aws.rows]
  const usage = [...standard.flatMap((result) => result.usage), ...custom.flatMap((result) => result.usage), ...aws.usage]
  const liveSync = [...standard.map((result) => result.sync), ...custom.map((result) => result.sync), aws.sync]
  const resourceItems = [...standard, ...custom, aws].flatMap((result) => result.resources ?? [])
  return finalizeAnalysis(repoScan, env, workspace, costRows, usage, liveSync, aws.freeTier, resourceItems)
}

function finalizeAnalysis(
  repoScan: ReturnType<typeof import("./repoScanner").scanRepositoryFiles>,
  env: NodeJS.ProcessEnv,
  workspace: WorkspaceStore,
  costRows: NormalizedCostRow[],
  usage: ProviderUsageSample[],
  liveSync: AnalysisResult["liveSync"],
  providerFreeTier: FreeTierUsageRow[],
  resourceItems: ResourceUsageItem[] = []
): AnalysisResult {
  // Attribute each account-wide row to a repo within its account (Vercel
  // project→repo link, or a resource named after a repo) so the repo view can
  // split "this project" from "rest of the account".
  const syncedRepos = workspace.githubRepos.filter((repo) => workspace.syncedRepoFullNames.includes(repo.fullName))
  const repoShortNames = [
    repoScan.repo.name,
    ...(syncedRepos.length ? syncedRepos : workspace.githubRepos).map((repo) => repo.name),
  ]
  const vercelProjects = ((workspace.connections.vercel?.metadata as { linkedProjects?: VercelProjectLink[] } | undefined)
    ?.linkedProjects ?? []) as VercelProjectLink[]
  costRows = attributeCostRows(costRows, { repoShortNames, vercelProjects })
  const attributedResources = resourceItems.map((item) => ({
    ...item,
    attributedRepo: attributeRepoForName(item.name, repoShortNames),
  }))
  const providerBreakdown = summarizeByProvider(costRows, repoScan.signals)
  const exactCost = costRows
    .filter((row) => row.attribution !== "inferred")
    .reduce((sum, row) => sum + row.cost, 0)
  const totalCost = costRows.reduce((sum, row) => sum + row.cost, 0)
  const averageConfidence =
    repoScan.signals.length === 0
      ? 0
      : repoScan.signals.reduce((sum, signal) => sum + signal.confidence, 0) / repoScan.signals.length

  const actions = buildActions(repoScan.signals, costRows)
  const providerConnections = buildProviderConnections(repoScan.signals, env, workspace)
  // Custom providers aren't in the built-in connection catalog, so their usage
  // samples are turned into measured usage rows here (no published free-tier
  // limit), tagged so the dashboard groups them under the right custom provider.
  const customUsage = buildCustomUsageRows(usage)
  return {
    repo: repoScan.repo,
    period: period(),
    summary: {
      totalCost: Number(totalCost.toFixed(2)),
      exactCost: Number(exactCost.toFixed(2)),
      inferredCost: Number((totalCost - exactCost).toFixed(2)),
      detectedProviders: new Set(repoScan.signals.map((signal) => signal.provider).filter((provider) => provider !== "docker")).size,
      signals: repoScan.signals.length,
      confidence: Number((averageConfidence * 100).toFixed(0)),
    },
    signals: repoScan.signals,
    providerConnections,
    providerBreakdown,
    costRows,
    freeTier: [...computeFreeTierUsage(costRows, usage, providerConnections), ...providerFreeTier, ...customUsage],
    resourceItems: attributedResources,
    actions,
    liveSync,
  }
}

type LiveResult = {
  rows: NormalizedCostRow[]
  usage: ProviderUsageSample[]
  sync: AnalysisResult["liveSync"][number]
  resources?: ResourceUsageItem[]
}

/** Aggregates custom-provider usage samples into measured free-tier usage rows. */
function buildCustomUsageRows(usage: ProviderUsageSample[]): FreeTierUsageRow[] {
  const byKey = new Map<string, FreeTierUsageRow>()
  for (const sample of usage) {
    if (sample.provider !== "custom" || !Number.isFinite(sample.quantity) || sample.quantity <= 0) continue
    const key = `${sample.customProviderId ?? ""}|${sample.service}|${sample.unit}`
    const existing = byKey.get(key)
    if (existing) {
      existing.used = Number(((existing.used ?? 0) + sample.quantity).toFixed(2))
    } else {
      byKey.set(key, {
        provider: "custom",
        planName: sample.customLabel ?? "Custom provider",
        service: sample.service,
        used: Number(sample.quantity.toFixed(2)),
        limit: null,
        unit: sample.unit,
        remaining: null,
        percentUsed: null,
        source: "measured",
        note: `Live usage reported by the custom "${sample.customLabel ?? "provider"}" connector.`,
        customProviderId: sample.customProviderId,
        customLabel: sample.customLabel,
      })
    }
  }
  return [...byKey.values()]
}

function notConnected(provider: Provider, message: string): LiveResult {
  return {
    rows: [],
    usage: [],
    sync: { provider, status: "not_connected", message, rows: 0, syncedAt: null },
  }
}

async function loadVercelLive(
  workspace: WorkspaceStore,
  repoScan: ReturnType<typeof import("./repoScanner").scanRepositoryFiles>
): Promise<LiveResult> {
  const vercel = workspace.connections.vercel
  if (!vercel?.accessToken || vercel.status !== "connected") {
    return notConnected("vercel", "Connect Vercel to pull live FOCUS billing rows.")
  }

  const currentPeriod = period()
  const metadata = vercel.metadata as { teamId?: string | null; slug?: string | null; teams?: Array<{ id: string; slug: string }> }
  const scopes = buildVercelBillingScopes(metadata)
  const token = vercel.accessToken
  const syncedAt = new Date().toISOString()

  const allCharges = []
  const usage: ProviderUsageSample[] = []
  const resources: ResourceUsageItem[] = []
  const billingErrors: string[] = []
  const usageErrors: string[] = []

  for (const scope of scopes) {
    // FOCUS billing charges produce dollar amounts but only exist on paid plans;
    // on the free Hobby tier this 404s, which is expected and must NOT block the
    // usage pull below.
    try {
      allCharges.push(...(await listVercelBillingCharges(token, { ...currentPeriod, ...scope })))
    } catch (error) {
      billingErrors.push(error instanceof Error ? error.message : "Unknown Vercel billing error.")
    }

    // Account usage works on every tier (including free), so free-tier accounts
    // still see real consumption against their allowances.
    const accountUsage = await fetchVercelAccountUsage(token, { ...currentPeriod, teamId: scope.teamId })
    for (const metric of accountUsage.metrics) {
      usage.push({ provider: "vercel", service: metric.service, quantity: metric.quantity, unit: metric.unit })
    }
    for (const project of accountUsage.projects) {
      if (project.requests <= 0 && project.bandwidthBytes <= 0) continue
      resources.push({
        provider: "vercel",
        itemKey: `vercel::project::${project.id}`.toLowerCase(),
        kind: "Vercel Project",
        name: project.name,
        quantity: Math.round(project.requests),
        unit: "requests",
      })
    }
    if (accountUsage.error) usageErrors.push(accountUsage.error)
  }

  const rows = normalizeVercelCharges(allCharges, repoScan, currentPeriod)
  const haveData = rows.length > 0 || usage.length > 0 || resources.length > 0

  if (!haveData) {
    // Nothing from billing OR usage. Surface a usage error first (billing 404 on
    // free tier is normal and not worth showing as the failure).
    const reason = usageErrors[0] ?? billingErrors[0]
    return {
      rows: [],
      usage,
      resources,
      sync: {
        provider: "vercel",
        status: reason ? "error" : "empty",
        message: reason ?? "Vercel returned no billing or usage for the current month.",
        rows: 0,
        syncedAt,
      },
    }
  }

  const message =
    rows.length > 0
      ? `Loaded ${rows.length} live Vercel billing row${rows.length === 1 ? "" : "s"} and ${usage.length} usage metric${usage.length === 1 ? "" : "s"}.`
      : `On the Vercel free tier — loaded ${usage.length} live usage metric${usage.length === 1 ? "" : "s"} (no billed cost this period).`

  return {
    rows,
    usage,
    resources,
    sync: {
      provider: "vercel",
      status: "success",
      message,
      rows: rows.length,
      syncedAt,
    },
  }
}

const CLOUDFLARE_MONTHLY_FACTOR: Record<string, number> = {
  weekly: 4.345,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
}

export function normalizeCloudflareSubscriptions(
  subscriptions: CloudflareSubscription[],
  account: CloudflareAccount,
  currentPeriod: { from: string; to: string }
): NormalizedCostRow[] {
  return subscriptions
    .map((subscription, index): NormalizedCostRow | null => {
      const price = typeof subscription.price === "number" ? subscription.price : Number.parseFloat(String(subscription.price ?? ""))
      if (!Number.isFinite(price) || price <= 0) return null
      const factor = CLOUDFLARE_MONTHLY_FACTOR[subscription.frequency?.toLowerCase() ?? "monthly"] ?? 1
      const planName =
        subscription.rate_plan?.public_name ||
        subscription.product?.public_name ||
        subscription.product?.name ||
        "Cloudflare subscription"
      return {
        provider: "cloudflare",
        serviceName: planName,
        resourceId: subscription.id ? `cloudflare/${account.id}/${subscription.id}` : null,
        resourceName: account.name,
        billingPeriodStart: currentPeriod.from,
        billingPeriodEnd: currentPeriod.to,
        cost: Number((price * factor).toFixed(4)),
        currency: subscription.currency ?? "USD",
        attribution: "verified",
        attributionReason:
          "Live Cloudflare subscription price for this account, normalized to a monthly amount. Usage-based overage is not included.",
        signalId: `cloudflare-live:${account.id}:${subscription.id ?? index}`,
        source: "live",
      }
    })
    .filter((row): row is NormalizedCostRow => Boolean(row))
}

async function loadCloudflareLive(workspace: WorkspaceStore): Promise<LiveResult> {
  const cloudflare = workspace.connections.cloudflare
  if (!cloudflare?.accessToken || cloudflare.status !== "connected") {
    return notConnected("cloudflare", "Connect Cloudflare to pull live subscription costs.")
  }

  const currentPeriod = period()
  try {
    const metadata = cloudflare.metadata as { accounts?: Array<{ id: string; name: string }> }
    let accounts: CloudflareAccount[] = metadata.accounts ?? []
    if (accounts.length === 0) {
      accounts = await listCloudflareAccounts(cloudflare.accessToken)
    }
    if (accounts.length === 0) {
      return {
        rows: [],
        usage: [],
        sync: {
          provider: "cloudflare",
          status: "empty",
          message: "Token verified but no accounts are readable. Grant the token Account Settings: Read and reconnect.",
          rows: 0,
          syncedAt: new Date().toISOString(),
        },
      }
    }

    const rows: NormalizedCostRow[] = []
    const usage: ProviderUsageSample[] = []
    const resources: ResourceUsageItem[] = []
    const errors: string[] = []
    const usageErrors: string[] = []
    for (const account of accounts.slice(0, 5)) {
      try {
        const subscriptions = await listCloudflareSubscriptions(cloudflare.accessToken, account.id)
        rows.push(...normalizeCloudflareSubscriptions(subscriptions, account, currentPeriod))
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Unknown Cloudflare subscriptions error.")
      }
      // Account usage is best-effort and never fails the sync, but we surface
      // why it was empty (usually a token without Account Analytics: Read).
      const accountUsage = await getCloudflareAccountUsage(cloudflare.accessToken, account.id, currentPeriod)
      usage.push(
        ...accountUsage.usage.map((sample) => ({ provider: "cloudflare" as const, service: sample.service, quantity: sample.quantity, unit: sample.unit }))
      )
      if (accountUsage.error) usageErrors.push(accountUsage.error)
      // Per-resource breakdown (Workers per script, domains) so the user can
      // assign individual infra to a repo for drilled-down usage.
      const accountResources = await getCloudflareAccountResources(cloudflare.accessToken, account.id, currentPeriod)
      for (const resource of accountResources) {
        resources.push({
          provider: "cloudflare",
          itemKey: `cloudflare::${resource.kind}::${resource.name}`.toLowerCase(),
          kind: resource.kind,
          name: resource.name,
          quantity: resource.quantity,
          unit: resource.unit,
        })
      }
    }

    // Only fail when we got nothing at all. Free-tier accounts have no paid
    // subscriptions, and a token without billing scope still returns usage — in
    // both cases we keep the measured usage instead of throwing it away.
    if (rows.length === 0 && usage.length === 0 && errors.length > 0) {
      throw new Error(errors[0])
    }
    if (rows.length === 0) {
      const usageNote = usageErrors.length > 0 ? ` ${usageErrors[0]}` : ""
      return {
        rows: [],
        usage,
        resources,
        sync: {
          provider: "cloudflare",
          status: usage.length > 0 || resources.length > 0 ? "success" : usageErrors.length > 0 ? "error" : "empty",
          message:
            usage.length > 0 || resources.length > 0
              ? `No paid subscriptions; loaded ${usage.length} usage metric(s) and ${resources.length} resource(s).`
              : `Cloudflare returned no paid subscriptions for this account.${usageNote}`,
          rows: 0,
          syncedAt: new Date().toISOString(),
        },
      }
    }

    return {
      rows,
      usage,
      resources,
      sync: {
        provider: "cloudflare",
        status: "success",
        message:
          `Loaded ${rows.length} live Cloudflare subscription rows.` +
          (usage.length > 0 ? ` Usage tracked.` : usageErrors.length > 0 ? ` ${usageErrors[0]}` : ""),
        rows: rows.length,
        syncedAt: new Date().toISOString(),
      },
    }
  } catch (error) {
    return {
      rows: [],
      usage: [],
      sync: {
        provider: "cloudflare",
        status: "error",
        message: error instanceof Error ? error.message : "Failed to sync Cloudflare subscriptions.",
        rows: 0,
        syncedAt: new Date().toISOString(),
      },
    }
  }
}

async function loadGcpLive(workspace: WorkspaceStore): Promise<LiveResult> {
  const gcp = workspace.connections.gcp
  if (!gcp?.accessToken || gcp.status !== "connected") {
    return notConnected("gcp", "Connect Google Cloud to pull exact cost rows from the billing export.")
  }

  const metadata = gcp.metadata as { billingExportDataset?: string | null; billingExportTable?: string | null }
  const tableId = metadata.billingExportTable
  if (!tableId) {
    const dataset = metadata.billingExportDataset
    return notConnected(
      "gcp",
      dataset
        ? `Google Cloud is connected and BigQuery dataset ${dataset} is ready. Enable Cloud Billing export to that dataset, then the billing table will be used for exact cost rows.`
        : "Google Cloud is connected. Add your BigQuery billing export table to pull exact cost rows."
    )
  }

  const currentPeriod = period()
  try {
    const exportRows = await queryGcpBillingExportCosts(gcp.accessToken, tableId, currentPeriod)
    const usage: ProviderUsageSample[] = exportRows
      .filter((row) => row.usageAmount !== null && row.usageUnit && row.usageAmount > 0)
      .map((row) => ({
        provider: "gcp" as const,
        service: row.serviceName,
        quantity: row.usageAmount as number,
        unit: row.usageUnit as string,
      }))
    const rows = exportRows
      .filter((row) => Number.isFinite(row.cost) && Math.abs(row.cost) >= 0.005)
      .map(
        (row, index): NormalizedCostRow => ({
          provider: "gcp",
          serviceName: row.serviceName,
          resourceId: row.projectId ? `gcp/${row.projectId}/${row.serviceName}` : null,
          resourceName: row.projectId ?? row.serviceName,
          billingPeriodStart: currentPeriod.from,
          billingPeriodEnd: currentPeriod.to,
          cost: Number(row.cost.toFixed(4)),
          currency: row.currency,
          attribution: "verified",
          attributionReason: "Live row aggregated from the Cloud Billing BigQuery export, net of credits.",
          signalId: `gcp-live:${index}`,
          source: "live",
        })
      )

    if (rows.length === 0) {
      return {
        rows: [],
        usage,
        sync: {
          provider: "gcp",
          status: "empty",
          message: "The billing export has no cost rows for the current month yet.",
          rows: 0,
          syncedAt: new Date().toISOString(),
        },
      }
    }

    return {
      rows,
      usage,
      sync: {
        provider: "gcp",
        status: "success",
        message: `Loaded ${rows.length} live Google Cloud cost rows from the billing export.`,
        rows: rows.length,
        syncedAt: new Date().toISOString(),
      },
    }
  } catch (error) {
    return {
      rows: [],
      usage: [],
      sync: {
        provider: "gcp",
        status: "error",
        message: error instanceof Error ? error.message : "Failed to query the GCP billing export.",
        rows: 0,
        syncedAt: new Date().toISOString(),
      },
    }
  }
}

async function loadMotherDuckLive(workspace: WorkspaceStore): Promise<LiveResult> {
  const connection = workspace.connections.motherduck
  if (!connection?.accessToken || connection.status !== "connected") {
    return notConnected("motherduck", "Connect MotherDuck to track database storage usage.")
  }

  try {
    const metadata = connection.metadata as { plan?: MotherDuckPlan; region?: string }
    const plan = metadata.plan ?? "free"
    const result = await fetchMotherDuckUsage(connection.accessToken)
    const totalGb = result.totalBytes / 1_000_000_000
    const rows: NormalizedCostRow[] = []

    return {
      rows,
      usage: [{
        provider: "motherduck",
        service: `${plan === "free" ? "Free" : plan === "lite" ? "Lite" : "Business"} plan storage`,
        quantity: Number(totalGb.toFixed(3)),
        unit: "GB",
      }],
      resources: result.databases.map((database) => ({
        provider: "motherduck",
        itemKey: `motherduck::database::${database.name}`.toLowerCase(),
        kind: "Database",
        name: database.name,
        quantity: Number((database.bytes / 1_000_000_000).toFixed(3)),
        unit: "GB",
      })),
      sync: {
        provider: "motherduck",
        status: "success",
        message: `Loaded storage usage for ${result.databases.length} MotherDuck database(s). Actual cost remains hidden because MotherDuck exposes invoices only in its Billing page.`,
        rows: rows.length,
        syncedAt: new Date().toISOString(),
      },
    }
  } catch (error) {
    return {
      rows: [],
      usage: [],
      resources: [],
      sync: {
        provider: "motherduck",
        status: "error",
        message: error instanceof Error ? error.message : "Failed to sync MotherDuck usage.",
        rows: 0,
        syncedAt: new Date().toISOString(),
      },
    }
  }
}

const AI_PROVIDER_LABEL: Record<"anthropic" | "openai" | "cursor", string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  cursor: "Cursor",
}

// Usage pushed by the companion CLI from local Claude Code / Codex logs, for
// users on flat personal subscriptions whose vendors expose no cost API.
interface AiLocalUsagePayload {
  month: string
  subscriptionUsd: number
  planLabel: string | null
  toolLabel?: string
  limits?: Array<{
    label: string
    used: number | null
    limit: number | null
    unit: string
    period: "session" | "daily" | "weekly" | "monthly" | string
    resetsAt?: string | null
  }>
  models: Array<{
    model: string
    inputTokens: number
    cacheTokens: number
    outputTokens: number
    estimatedApiUsd: number
    inputUsd?: number
    cacheUsd?: number
    outputUsd?: number
    rates?: {
      inputPerMillion?: number
      cachePerMillion?: number
      cacheReadPerMillion?: number | null
      outputPerMillion?: number
    }
  }>
  totals: {
    inputTokens: number
    cacheTokens: number
    outputTokens: number
    estimatedApiUsd: number
    inputUsd?: number
    cacheUsd?: number
    outputUsd?: number
  }
}

function buildLocalAiResult(provider: "anthropic" | "openai" | "cursor", label: string, payload: AiLocalUsagePayload): LiveResult {
  const currentPeriod = period()
  const rows: NormalizedCostRow[] = []
  if (payload.subscriptionUsd > 0) {
    rows.push({
      provider,
      serviceName: `${payload.planLabel ? `${payload.planLabel} ` : ""}subscription`,
      resourceId: null,
      resourceName: label,
      billingPeriodStart: currentPeriod.from,
      billingPeriodEnd: currentPeriod.to,
      cost: Number(payload.subscriptionUsd.toFixed(2)),
      currency: "USD",
      attribution: "user_confirmed",
      attributionReason: `Flat ${label} subscription price. Local usage this month is worth ~$${payload.totals.estimatedApiUsd.toFixed(2)} at API rates (${payload.toolLabel ?? "local logs"}).`,
      signalId: `${provider}-local:sub`,
      source: "live",
    })
  }
  const usage: ProviderUsageSample[] = []
  if (payload.totals.inputTokens > 0) usage.push({ provider, service: "Input tokens", quantity: payload.totals.inputTokens, unit: "tokens" })
  if (payload.totals.cacheTokens > 0) usage.push({ provider, service: "Cache tokens", quantity: payload.totals.cacheTokens, unit: "tokens" })
  if (payload.totals.outputTokens > 0) usage.push({ provider, service: "Output tokens", quantity: payload.totals.outputTokens, unit: "tokens" })
  if (payload.totals.estimatedApiUsd > 0) usage.push({ provider, service: "Value at API rates", quantity: Number(payload.totals.estimatedApiUsd.toFixed(2)), unit: "USD est." })

  return {
    rows,
    usage,
    sync: {
      provider,
      status: "success",
      message: `Loaded local ${payload.toolLabel ?? label} usage for ${payload.month}: ${payload.totals.inputTokens + payload.totals.outputTokens} tokens, ~$${payload.totals.estimatedApiUsd.toFixed(2)} at API rates.`,
      rows: rows.length,
      syncedAt: new Date().toISOString(),
    },
  }
}

// Live org/team API cost + usage (the path for real API/Team accounts). Throws on
// failure so the caller can fold the error into a combined sync message.
async function fetchAiApi(provider: "anthropic" | "openai" | "cursor", token: string): Promise<{ rows: NormalizedCostRow[]; usage: ProviderUsageSample[] }> {
  const label = AI_PROVIDER_LABEL[provider]
  const currentPeriod = period()
  const fetcher = provider === "anthropic" ? fetchAnthropicCostUsage : provider === "openai" ? fetchOpenAiCostUsage : fetchCursorCostUsage
  const result: AiCostUsage = await fetcher(token, currentPeriod)
  const rows: NormalizedCostRow[] = result.costRows.map((row, index) => ({
    provider,
    serviceName: `${row.service} (API)`,
    resourceId: null,
    resourceName: `${label} API`,
    billingPeriodStart: currentPeriod.from,
    billingPeriodEnd: currentPeriod.to,
    cost: Number(row.cost.toFixed(4)),
    currency: row.currency,
    attribution: "verified",
    attributionReason: `Live ${label} pay-per-use cost from the organization usage & cost API.`,
    signalId: `${provider}-api:${index}`,
    source: "live",
  }))
  const usage: ProviderUsageSample[] = result.usage.map((sample) => ({
    provider,
    service: `${sample.service} (API)`,
    quantity: sample.quantity,
    unit: sample.unit,
  }))
  return { rows, usage }
}

/**
 * Loads an AI coding tool, composing up to two independent sources that can
 * coexist on one connection:
 *   • local — flat subscription cost + token usage pushed from local logs
 *     (Claude Pro/Max, ChatGPT Plus/Pro). The monthly price can be overridden by
 *     the user (e.g. $200 Max) via metadata.subscriptionUsdOverride.
 *   • api — real pay-per-use cost + usage from the org/team API, shown when an
 *     admin key is connected and not toggled off (metadata.showApi).
 * Both are genuinely different bills, so when both exist they're summed.
 */
async function loadAiLive(workspace: WorkspaceStore, provider: "anthropic" | "openai" | "cursor"): Promise<LiveResult> {
  const connection = workspace.connections[provider]
  const label = AI_PROVIDER_LABEL[provider]
  if (!connection || connection.status !== "connected") {
    return notConnected(provider, `Connect ${label} to pull subscription cost and token usage.`)
  }
  const meta = (connection.metadata ?? {}) as {
    localUsage?: AiLocalUsagePayload
    subscriptionUsdOverride?: number
    planLabelOverride?: string
    showApi?: boolean
  }
  const hasLocal = Boolean(meta.localUsage)
  const hasKey = Boolean(connection.accessToken && connection.accessToken !== "local")
  const showApi = hasKey && meta.showApi !== false
  if (!hasLocal && !hasKey) {
    return notConnected(provider, `Connect ${label} to pull subscription cost and token usage.`)
  }

  const rows: NormalizedCostRow[] = []
  const usage: ProviderUsageSample[] = []
  const messages: string[] = []
  let errored = false
  const syncedAt = new Date().toISOString()

  if (hasLocal && meta.localUsage) {
    // Apply the user's plan-price / label override to the pushed payload.
    const payload: AiLocalUsagePayload = {
      ...meta.localUsage,
      subscriptionUsd:
        typeof meta.subscriptionUsdOverride === "number" && Number.isFinite(meta.subscriptionUsdOverride)
          ? meta.subscriptionUsdOverride
          : meta.localUsage.subscriptionUsd,
      planLabel: meta.planLabelOverride ?? meta.localUsage.planLabel,
    }
    const local = buildLocalAiResult(provider, label, payload)
    rows.push(...local.rows)
    usage.push(...local.usage)
    messages.push(local.sync.message)
  }

  if (showApi && connection.accessToken) {
    try {
      const api = await fetchAiApi(provider, connection.accessToken)
      rows.push(...api.rows)
      usage.push(...api.usage)
      messages.push(`Loaded ${api.rows.length} live API cost row${api.rows.length === 1 ? "" : "s"} from the ${label} org API.`)
    } catch (error) {
      errored = true
      messages.push(error instanceof Error ? error.message : `Failed to pull ${label} API cost.`)
    }
  }

  const status = rows.length > 0 || usage.length > 0 ? "success" : errored ? "error" : "empty"
  return {
    rows,
    usage,
    sync: {
      provider,
      status,
      message: messages.join(" ") || `${label} reported no cost or usage for the current month.`,
      rows: rows.length,
      syncedAt,
    },
  }
}

/**
 * Runs every user-defined custom provider that has a saved secret, mapping each
 * one's HTTP/JSON response into the same cost rows + usage the built-ins emit.
 * Returns one LiveResult per custom provider (each tagged with customProviderId
 * so the dashboard shows them distinctly).
 */
async function loadCustomProvidersLive(workspace: WorkspaceStore): Promise<LiveResult[]> {
  const defs = Object.values(workspace.customProviders ?? {})
  if (defs.length === 0) return []
  const results = await Promise.all(
    defs.map(async (def): Promise<LiveResult> => {
      const connection = workspace.customConnections?.[def.id]
      const syncedAt = new Date().toISOString()
      if (!connection?.accessToken || connection.status !== "connected") {
        return {
          rows: [],
          usage: [],
          sync: { provider: "custom", status: "not_connected", message: `Add a secret for ${def.name} to pull its data.`, rows: 0, syncedAt: null },
        }
      }
      try {
        const out = await runCustomProvider(def, connection.accessToken, period())
        const rows: NormalizedCostRow[] = out.costRows.map((row, index) => ({
          provider: "custom",
          serviceName: row.service,
          resourceId: null,
          resourceName: def.name,
          billingPeriodStart: period().from,
          billingPeriodEnd: period().to,
          cost: Number(row.cost.toFixed(4)),
          currency: row.currency,
          attribution: "verified",
          attributionReason: `Live cost from the custom "${def.name}" connector.`,
          signalId: `custom-${def.id}:${index}`,
          source: "live",
          customProviderId: def.id,
          customLabel: def.name,
        }))
        const usage: ProviderUsageSample[] = out.usage.map((sample) => ({
          provider: "custom",
          service: sample.service,
          quantity: sample.quantity,
          unit: sample.unit,
          customProviderId: def.id,
          customLabel: def.name,
        }))
        if (rows.length === 0 && usage.length === 0) {
          return {
            rows,
            usage,
            sync: { provider: "custom", status: "empty", message: `${def.name} returned no cost or usage rows.`, rows: 0, syncedAt },
          }
        }
        return {
          rows,
          usage,
          sync: {
            provider: "custom",
            status: "success",
            message: `Loaded ${rows.length} cost row${rows.length === 1 ? "" : "s"} from ${def.name}.`,
            rows: rows.length,
            syncedAt,
          },
        }
      } catch (error) {
        return {
          rows: [],
          usage: [],
          sync: {
            provider: "custom",
            status: "error",
            message: error instanceof Error ? `${def.name}: ${error.message}` : `Failed to sync ${def.name}.`,
            rows: 0,
            syncedAt,
          },
        }
      }
    })
  )
  return results
}

type AwsLiveResult = LiveResult & { freeTier: FreeTierUsageRow[] }

export type CostExplorerInterval = "manual" | "daily" | "weekly" | "monthly"
type AwsCostCache = { fetchedAt: string; rows: AwsCostRow[] }

const COST_EXPLORER_INTERVAL_MS: Record<string, number> = {
  daily: 86_400_000,
  weekly: 604_800_000,
  monthly: 2_592_000_000, // ~30 days
}

/**
 * Whether a fresh Cost Explorer call is due, given when it last ran and the
 * chosen cadence. "manual" never auto-fetches (the user pulls on demand); each
 * billed $0.01 call is gated by this so a page refresh can't keep hitting it.
 * A cache from a previous calendar month is always due (except in manual mode):
 * its rows describe LAST month's spend and must never be re-labelled as this
 * month's.
 */
export function costExplorerDue(fetchedAt: string | undefined, interval: string, now: Date = new Date()): boolean {
  if (interval === "manual") return false
  if (!fetchedAt) return true
  if (!sameUtcMonth(fetchedAt, now)) return true
  const ms = COST_EXPLORER_INTERVAL_MS[interval] ?? COST_EXPLORER_INTERVAL_MS.daily
  const last = new Date(fetchedAt).getTime()
  if (Number.isNaN(last)) return true
  return now.getTime() - last >= ms
}

/**
 * A cached Cost Explorer result may only be shown when it was fetched in the
 * current calendar month — the cached rows get stamped with the current billing
 * period, so serving an older cache would present last month's spend as this
 * month's (the exact leak this guards against).
 */
export function costExplorerCacheUsable(cache: { fetchedAt: string } | undefined, now: Date = new Date()): boolean {
  return Boolean(cache?.fetchedAt) && sameUtcMonth(cache!.fetchedAt, now)
}

function awsPeriod(currentPeriod: { from: string; to: string }) {
  // Cost Explorer's End date is exclusive, so cover the month by ending on the
  // first day of the next month.
  const end = new Date(`${currentPeriod.from}T00:00:00Z`)
  end.setUTCMonth(end.getUTCMonth() + 1)
  return { from: currentPeriod.from, to: end.toISOString().slice(0, 10) }
}

function awsFreeTierRows(usage: Awaited<ReturnType<typeof getAwsFreeTierUsage>>): FreeTierUsageRow[] {
  return usage.map((item): FreeTierUsageRow => {
    const used = Number(item.actualUsageAmount.toFixed(2))
    const limit = Number(item.limit.toFixed(2))
    const remaining = Number(Math.max(limit - used, 0).toFixed(2))
    const percentUsed = limit > 0 ? Number(Math.min((used / limit) * 100, 100).toFixed(1)) : 0
    return {
      provider: "aws",
      planName: "AWS Free Tier",
      service: item.service,
      used,
      limit,
      unit: item.unit,
      remaining,
      percentUsed,
      source: "measured",
      // The description carries the specific free-tier metric (e.g. which API).
      note: `${item.freeTierType} · ${item.description}`,
    }
  })
}

/**
 * Pulls live AWS data: actual cost + usage from Cost Explorer (GetCostAndUsage)
 * and free-tier consumption from the Free Tier Usage API. Credentials are stored
 * as JSON in the connection's accessToken by the AWS connector. Each source is
 * best-effort and independent, so a missing permission on one does not hide the
 * other.
 */
async function loadAwsLive(
  workspace: WorkspaceStore,
  userId: string,
  options?: { skipCostExplorer?: boolean; forceCostExplorer?: boolean }
): Promise<AwsLiveResult> {
  const aws = workspace.connections.aws
  const notConnectedResult: AwsLiveResult = {
    ...notConnected("aws", "Connect AWS (CLI credentials or access keys) to pull live cost and free-tier usage."),
    freeTier: [],
  }
  if (!aws?.accessToken || aws.status !== "connected") return notConnectedResult

  let credentials: AwsCredentials | null
  try {
    // Stored value is either a role ref ({roleArn, externalId}) — assumed via STS
    // to short-lived creds — or legacy access keys. resolveAwsCredentials handles both.
    credentials = await resolveAwsCredentials(JSON.parse(aws.accessToken))
  } catch {
    return notConnectedResult
  }
  if (!credentials?.accessKeyId || !credentials.secretAccessKey) return notConnectedResult

  // Cost Explorer GetCostAndUsage bills $0.01/request, so only call it when the
  // user opted in — and never on a background cron (skipCostExplorer) so a
  // schedule can't silently rack up charges. Free Tier usage is always free.
  const meta = aws.metadata as {
    costExplorer?: boolean
    costExplorerInterval?: string
    costExplorerCache?: AwsCostCache
  }
  const costExplorerEnabled = !options?.skipCostExplorer && meta.costExplorer === true
  const interval = meta.costExplorerInterval ?? "daily"
  const cache = meta.costExplorerCache
  // Honour the cadence: only actually hit the billed API when forced or due;
  // otherwise reuse the last cached result so refreshes cost nothing.
  const fetchCostExplorer =
    costExplorerEnabled && (options?.forceCostExplorer === true || costExplorerDue(cache?.fetchedAt, interval))

  const currentPeriod = period()
  // A cache written in a previous month must not be served: its rows would be
  // stamped with the current period below. In manual mode this means "no rows
  // until the user pulls again", which is correct for a new month.
  const usableCacheRows = costExplorerCacheUsable(cache) ? (cache?.rows ?? []) : []
  const [costResult, freeTierResult] = await Promise.allSettled([
    fetchCostExplorer
      ? getAwsCostAndUsage(credentials, awsPeriod(currentPeriod))
      : Promise.resolve(usableCacheRows as AwsCostRow[]),
    getAwsFreeTierUsage(credentials),
  ])

  // Persist the fresh result so future loads can reuse it without re-billing.
  if (fetchCostExplorer && costResult.status === "fulfilled") {
    try {
      await upsertConnection(userId, {
        ...aws,
        metadata: { ...meta, costExplorerCache: { fetchedAt: new Date().toISOString(), rows: costResult.value } },
      })
    } catch {
      // Caching is best-effort; a write failure shouldn't break the analysis.
    }
  }
  const usedCache = costExplorerEnabled && !fetchCostExplorer && usableCacheRows.length > 0

  const rows: NormalizedCostRow[] = []
  const usage: ProviderUsageSample[] = []
  if (costResult.status === "fulfilled") {
    for (const [index, costRow] of costResult.value.entries()) {
      if (Number.isFinite(costRow.cost) && Math.abs(costRow.cost) >= 0.005) {
        rows.push({
          provider: "aws",
          serviceName: costRow.service,
          resourceId: null,
          resourceName: costRow.service,
          billingPeriodStart: currentPeriod.from,
          billingPeriodEnd: currentPeriod.to,
          cost: Number(costRow.cost.toFixed(4)),
          currency: costRow.currency,
          attribution: "verified",
          attributionReason: "Live unblended cost from AWS Cost Explorer, grouped by service.",
          signalId: `aws-live:${index}`,
          source: "live",
        })
      }
      if (costRow.usageQuantity !== null && costRow.usageUnit && costRow.usageQuantity > 0) {
        usage.push({ provider: "aws", service: costRow.service, quantity: costRow.usageQuantity, unit: costRow.usageUnit })
      }
    }
  }

  const freeTier = freeTierResult.status === "fulfilled" ? awsFreeTierRows(freeTierResult.value) : []

  const failures: string[] = []
  if (fetchCostExplorer && costResult.status === "rejected") {
    failures.push(costResult.reason instanceof Error ? costResult.reason.message : "AWS Cost Explorer query failed.")
  }
  if (freeTierResult.status === "rejected") {
    failures.push(freeTierResult.reason instanceof Error ? freeTierResult.reason.message : "AWS Free Tier query failed.")
  }

  let sync: AnalysisResult["liveSync"][number]
  if (rows.length === 0 && freeTier.length === 0) {
    sync = {
      provider: "aws",
      status: failures.length > 0 ? "error" : "empty",
      message:
        failures.length > 0
          ? failures[0]
          : costExplorerEnabled
            ? "AWS connected, but Cost Explorer and Free Tier returned no rows for the current month."
            : "AWS connected, but the Free Tier API reported no usage this month.",
      rows: 0,
      syncedAt: new Date().toISOString(),
    }
  } else {
    const costNote = !costExplorerEnabled
      ? "cost data off"
      : fetchCostExplorer
        ? `${rows.length} cost rows (fresh)`
        : usedCache
          ? `${rows.length} cost rows (cached)`
          : "no cached cost yet"
    sync = {
      provider: "aws",
      status: "success",
      message: `Loaded ${costNote} and ${freeTier.length} free-tier rows.${failures.length > 0 ? ` (${failures[0]})` : ""}`,
      rows: rows.length,
      syncedAt: new Date().toISOString(),
    }
  }

  return { rows, usage, freeTier, sync }
}

function buildVercelBillingScopes(metadata: { teamId?: string | null; slug?: string | null; teams?: Array<{ id: string; slug: string }> }) {
  if (metadata.teamId || metadata.slug) {
    return [{ teamId: metadata.teamId ?? null, slug: metadata.slug ?? null }]
  }
  if (metadata.teams?.length) {
    return metadata.teams.slice(0, 5).map((team) => ({ teamId: team.id, slug: null }))
  }
  return [{ teamId: null, slug: null }]
}

function normalizeVercelCharges(
  charges: Array<Awaited<ReturnType<typeof listVercelBillingCharges>>[number]>,
  repoScan: ReturnType<typeof import("./repoScanner").scanRepositoryFiles>,
  currentPeriod: { from: string; to: string }
): NormalizedCostRow[] {
  const repoTerms = new Set([
    repoScan.repo.name.toLowerCase(),
    `${repoScan.repo.owner}/${repoScan.repo.name}`.toLowerCase(),
    repoScan.repo.owner.toLowerCase(),
  ])

  return charges
    .map((charge, index): NormalizedCostRow | null => {
      const cost = numberValue(charge.EffectiveCost ?? charge.BilledCost ?? charge.ListCost)
      if (!Number.isFinite(cost) || cost === 0) return null
      const resourceName = stringValue(charge.ResourceName) ?? stringValue(charge.ResourceId) ?? "Vercel billing charge"
      const haystack = `${resourceName} ${charge.ResourceId ?? ""} ${charge.ServiceName ?? ""} ${JSON.stringify(charge.Tags ?? {})}`.toLowerCase()
      const repoMatched = [...repoTerms].some((term) => term.length > 2 && haystack.includes(term))
      return {
        provider: "vercel",
        serviceName: stringValue(charge.ServiceName) ?? "Vercel billing charge",
        resourceId: stringValue(charge.ResourceId),
        resourceName,
        billingPeriodStart: dateOnly(stringValue(charge.ChargePeriodStart)) ?? currentPeriod.from,
        billingPeriodEnd: dateOnly(stringValue(charge.ChargePeriodEnd)) ?? currentPeriod.to,
        cost: Number(cost.toFixed(4)),
        currency: stringValue(charge.BillingCurrency) ?? "USD",
        attribution: repoMatched ? "verified" : "user_confirmed",
        attributionReason: repoMatched
          ? "Live Vercel FOCUS billing row matched the selected repository or linked project metadata."
          : "Live Vercel FOCUS billing row from the connected account. Confirm mapping if Vercel did not expose repo-specific fields.",
        signalId: `vercel-live:${index}`,
        source: "live",
      }
    })
    .filter((row): row is NormalizedCostRow => Boolean(row))
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "string") return Number.parseFloat(value)
  return Number.NaN
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function dateOnly(value: string | null): string | null {
  if (!value) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

function buildActions(signals: RepoSignal[], costRows: NormalizedCostRow[]): string[] {
  const providers = [...new Set(signals.map((signal) => signal.provider).filter((provider) => provider !== "docker"))]
  const inferred = costRows.filter((row) => row.attribution === "inferred")
  const actions = [
    "Install the GitHub App in production so scans come from repository permissions instead of local filesystem access.",
  ]

  for (const provider of providers) {
    actions.push(`Connect ${provider.toUpperCase()} billing access to show live provider costs.`)
  }
  if (inferred.length > 0) {
    actions.push(`Review ${inferred.length} inferred mappings and confirm or ignore them before using these numbers for chargeback.`)
  }
  return [...new Set(actions)].slice(0, 6)
}
