import type {
  AnalysisResult,
  FreeTierUsageRow,
  NormalizedCostRow,
  Provider,
  ProviderBreakdown,
  ProviderUsageSample,
  RepoSignal,
  WorkspaceStore,
} from "./types"
import { buildProviderConnections } from "./providerCatalog"
import { computeFreeTierUsage } from "./freeTier"
import { readWorkspace } from "./localStore"
import { getAwsCostAndUsage, getAwsFreeTierUsage, type AwsCredentials } from "./awsClient"
import { listVercelBillingCharges } from "./vercelClient"
import { getCloudflareAccountUsage, listCloudflareAccounts, listCloudflareSubscriptions, type CloudflareAccount, type CloudflareSubscription } from "./cloudflareClient"
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
  userId: string
): Promise<AnalysisResult> {
  const workspace = await readWorkspace(userId)
  const [vercel, cloudflare, gcp, aws] = await Promise.all([
    loadVercelLive(workspace, repoScan),
    loadCloudflareLive(workspace),
    loadGcpLive(workspace),
    loadAwsLive(workspace),
  ])
  const standard = [vercel, cloudflare, gcp]
  const costRows = [...standard.flatMap((result) => result.rows), ...aws.rows]
  const usage = [...standard.flatMap((result) => result.usage), ...aws.usage]
  const liveSync = [...standard.map((result) => result.sync), aws.sync]
  return finalizeAnalysis(repoScan, env, workspace, costRows, usage, liveSync, aws.freeTier)
}

function finalizeAnalysis(
  repoScan: ReturnType<typeof import("./repoScanner").scanRepository>,
  env: NodeJS.ProcessEnv,
  workspace: WorkspaceStore,
  costRows: NormalizedCostRow[],
  usage: ProviderUsageSample[],
  liveSync: AnalysisResult["liveSync"],
  providerFreeTier: FreeTierUsageRow[]
): AnalysisResult {
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
    actions,
    liveSync,
  }
}

type LiveResult = { rows: NormalizedCostRow[]; usage: ProviderUsageSample[]; sync: AnalysisResult["liveSync"][number] }

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

  try {
    const allCharges = []
    const errors: string[] = []
    for (const scope of scopes) {
      try {
        allCharges.push(...(await listVercelBillingCharges(vercel.accessToken, { ...currentPeriod, ...scope })))
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Unknown Vercel billing error.")
      }
    }

    if (allCharges.length === 0 && errors.length > 0) {
      throw new Error(errors[0])
    }

    // Usage is captured from every charge, including $0 free-tier lines, so the
    // dashboard can show free-tier consumption even when there is no cost.
    const usage = normalizeVercelUsage(allCharges)
    const rows = normalizeVercelCharges(allCharges, repoScan, currentPeriod)
    if (rows.length === 0) {
      return {
        rows: [],
        usage,
        sync: {
          provider: "vercel",
          status: "empty",
          message: "Vercel billing returned no charge rows for the current month.",
          rows: 0,
          syncedAt: new Date().toISOString(),
        },
      }
    }

    return {
      rows,
      usage,
      sync: {
        provider: "vercel",
        status: "success",
        message: `Loaded ${rows.length} live Vercel billing rows.`,
        rows: rows.length,
        syncedAt: new Date().toISOString(),
      },
    }
  } catch (error) {
    return {
      rows: [],
      usage: [],
      sync: {
        provider: "vercel",
        status: "error",
        message: error instanceof Error ? error.message : "Failed to sync Vercel billing.",
        rows: 0,
        syncedAt: new Date().toISOString(),
      },
    }
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
    const errors: string[] = []
    for (const account of accounts.slice(0, 5)) {
      try {
        const subscriptions = await listCloudflareSubscriptions(cloudflare.accessToken, account.id)
        rows.push(...normalizeCloudflareSubscriptions(subscriptions, account, currentPeriod))
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Unknown Cloudflare subscriptions error.")
      }
      // Account usage is best-effort and never fails the sync.
      const accountUsage = await getCloudflareAccountUsage(cloudflare.accessToken, account.id, currentPeriod)
      usage.push(
        ...accountUsage.map((sample) => ({ provider: "cloudflare" as const, service: sample.service, quantity: sample.quantity, unit: sample.unit }))
      )
    }

    if (rows.length === 0 && errors.length > 0) {
      throw new Error(errors[0])
    }
    if (rows.length === 0) {
      return {
        rows: [],
        usage,
        sync: {
          provider: "cloudflare",
          status: "empty",
          message: "Cloudflare returned no paid subscriptions for this account.",
          rows: 0,
          syncedAt: new Date().toISOString(),
        },
      }
    }

    return {
      rows,
      usage,
      sync: {
        provider: "cloudflare",
        status: "success",
        message: `Loaded ${rows.length} live Cloudflare subscription rows.`,
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

  const metadata = gcp.metadata as { billingExportTable?: string | null }
  const tableId = metadata.billingExportTable
  if (!tableId) {
    return notConnected(
      "gcp",
      "Google Cloud is connected. Add your BigQuery billing export table to pull exact cost rows."
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
      service: item.description || item.service,
      used,
      limit,
      unit: item.unit,
      remaining,
      percentUsed,
      source: "measured",
      note: `Live AWS Free Tier usage (${item.freeTierType}) reported for ${item.service}.`,
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
async function loadAwsLive(workspace: WorkspaceStore): Promise<AwsLiveResult> {
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

  const currentPeriod = period()
  const [costResult, freeTierResult] = await Promise.allSettled([
    getAwsCostAndUsage(credentials, awsPeriod(currentPeriod)),
    getAwsFreeTierUsage(credentials),
  ])

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

  let sync: AnalysisResult["liveSync"][number]
  if (costResult.status === "rejected" && freeTierResult.status === "rejected") {
    sync = {
      provider: "aws",
      status: "error",
      message: costResult.reason instanceof Error ? costResult.reason.message : "Failed to query AWS Cost Explorer.",
      rows: 0,
      syncedAt: new Date().toISOString(),
    }
  } else if (rows.length === 0 && freeTier.length === 0) {
    sync = {
      provider: "aws",
      status: "empty",
      message: "AWS connected, but Cost Explorer and Free Tier returned no rows for the current month.",
      rows: 0,
      syncedAt: new Date().toISOString(),
    }
  } else {
    sync = {
      provider: "aws",
      status: "success",
      message: `Loaded ${rows.length} AWS cost rows and ${freeTier.length} free-tier rows.`,
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

function normalizeVercelUsage(
  charges: Array<Awaited<ReturnType<typeof listVercelBillingCharges>>[number]>
): ProviderUsageSample[] {
  return charges
    .map((charge): ProviderUsageSample | null => {
      const quantity = numberValue(charge.ConsumedQuantity ?? charge.PricingQuantity)
      const unit = stringValue(charge.ConsumedUnit) ?? stringValue(charge.PricingUnit)
      if (!Number.isFinite(quantity) || quantity <= 0 || !unit) return null
      return {
        provider: "vercel",
        service: stringValue(charge.ServiceName) ?? "Vercel usage",
        quantity,
        unit,
      }
    })
    .filter((sample): sample is ProviderUsageSample => Boolean(sample))
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
