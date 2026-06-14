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
import { getAwsCostAndUsage, getAwsFreeTierUsage, type AwsCostRow, type AwsCredentials } from "./awsClient"
import { fetchVercelAccountUsage, listVercelBillingCharges } from "./vercelClient"
import { getCloudflareAccountResources, getCloudflareAccountUsage, listCloudflareAccounts, listCloudflareSubscriptions, type CloudflareAccount, type CloudflareSubscription } from "./cloudflareClient"
import { queryGcpBillingExportCosts } from "./gcpClient"

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
  repoScan: ReturnType<typeof import("./repoScanner").scanRepository>,
  env: NodeJS.ProcessEnv,
  userId = "usr_test"
): Promise<AnalysisResult> {
  const workspace = await readWorkspace(userId)
  return finalizeAnalysis(repoScan, env, workspace, [], [], [], [])
}

export async function buildAnalysisWithLiveData(
  repoScan: ReturnType<typeof import("./repoScanner").scanRepository>,
  env: NodeJS.ProcessEnv,
  userId: string,
  options?: { skipCostExplorer?: boolean; forceCostExplorer?: boolean }
): Promise<AnalysisResult> {
  const workspace = await readWorkspace(userId)
  const [vercel, cloudflare, gcp, aws] = await Promise.all([
    loadVercelLive(workspace, repoScan),
    loadCloudflareLive(workspace),
    loadGcpLive(workspace),
    loadAwsLive(workspace, userId, options),
  ])
  const standard = [vercel, cloudflare, gcp]
  const costRows = [...standard.flatMap((result) => result.rows), ...aws.rows]
  const usage = [...standard.flatMap((result) => result.usage), ...aws.usage]
  const liveSync = [...standard.map((result) => result.sync), aws.sync]
  const resourceItems = [vercel, cloudflare, gcp, aws].flatMap((result) => result.resources ?? [])
  return finalizeAnalysis(repoScan, env, workspace, costRows, usage, liveSync, aws.freeTier, resourceItems)
}

function finalizeAnalysis(
  repoScan: ReturnType<typeof import("./repoScanner").scanRepository>,
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
    freeTier: [...computeFreeTierUsage(costRows, usage, providerConnections), ...providerFreeTier],
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

function notConnected(provider: Provider, message: string): LiveResult {
  return {
    rows: [],
    usage: [],
    sync: { provider, status: "not_connected", message, rows: 0, syncedAt: null },
  }
}

async function loadVercelLive(
  workspace: WorkspaceStore,
  repoScan: ReturnType<typeof import("./repoScanner").scanRepository>
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
 */
export function costExplorerDue(fetchedAt: string | undefined, interval: string): boolean {
  if (interval === "manual") return false
  if (!fetchedAt) return true
  const ms = COST_EXPLORER_INTERVAL_MS[interval] ?? COST_EXPLORER_INTERVAL_MS.daily
  const last = new Date(fetchedAt).getTime()
  if (Number.isNaN(last)) return true
  return Date.now() - last >= ms
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

  let credentials: AwsCredentials
  try {
    credentials = JSON.parse(aws.accessToken) as AwsCredentials
  } catch {
    return notConnectedResult
  }
  if (!credentials.accessKeyId || !credentials.secretAccessKey) return notConnectedResult

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
  const [costResult, freeTierResult] = await Promise.allSettled([
    fetchCostExplorer
      ? getAwsCostAndUsage(credentials, awsPeriod(currentPeriod))
      : Promise.resolve((cache?.rows ?? []) as AwsCostRow[]),
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
  const usedCache = costExplorerEnabled && !fetchCostExplorer && (cache?.rows.length ?? 0) > 0

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
  repoScan: ReturnType<typeof import("./repoScanner").scanRepository>,
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
