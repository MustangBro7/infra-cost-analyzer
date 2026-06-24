import type { AnalysisResult, Provider, StoredConnection } from "./types"

export type CloudCoverageTone = "complete" | "partial" | "usage" | "error"

export interface CloudProviderReport {
  provider: Provider
  cost: number
  share: number
  projected: number
  topService: string | null
  topServiceCost: number
  measuredMetrics: number
  highestUsagePercent: number | null
  resourceCount: number
  syncStatus: AnalysisResult["liveSync"][number]["status"] | "unknown"
  syncedAt: string | null
  coverageTone: CloudCoverageTone
  coverageLabel: string
  coverageDetail: string
}

const CLOUD_PROVIDERS: Provider[] = ["aws", "vercel", "cloudflare", "gcp", "motherduck"]

function coverage(
  provider: Provider,
  connection: Pick<StoredConnection, "metadata"> | null,
  syncStatus: CloudProviderReport["syncStatus"]
): Pick<CloudProviderReport, "coverageTone" | "coverageLabel" | "coverageDetail"> {
  if (syncStatus === "error") {
    return {
      coverageTone: "error",
      coverageLabel: "Sync needs attention",
      coverageDetail: "The latest provider refresh failed. Re-check the credential and refresh again.",
    }
  }

  const metadata = connection?.metadata ?? {}
  if (provider === "aws" && metadata.costExplorer !== true) {
    return {
      coverageTone: "usage",
      coverageLabel: "Usage only",
      coverageDetail: "Free-tier usage is live. Enable Cost Explorer to add actual AWS spend.",
    }
  }
  if (provider === "gcp" && !metadata.billingExportTable) {
    return {
      coverageTone: "partial",
      coverageLabel: "Cost setup incomplete",
      coverageDetail: "Project access is connected. Add a BigQuery Billing Export table for actual cost.",
    }
  }
  if (provider === "vercel" && String(metadata.plan ?? "").toLowerCase() === "hobby") {
    return {
      coverageTone: "usage",
      coverageLabel: "Provider limitation",
      coverageDetail: "Vercel Hobby does not expose billing rows through its API.",
    }
  }
  if (provider === "motherduck") {
    return {
      coverageTone: "partial",
      coverageLabel: "Usage verified",
      coverageDetail: "Storage usage is live; the full invoice remains available only in MotherDuck Billing.",
    }
  }
  return {
    coverageTone: "complete",
    coverageLabel: "Cost + usage live",
    coverageDetail: "The provider connection can report its available billing and usage data.",
  }
}

export function buildCloudProviderReports(input: {
  analysis: AnalysisResult
  connections: Partial<Record<Provider, Pick<StoredConnection, "status" | "metadata"> | null>>
  elapsedDays: number
  totalDays: number
}): CloudProviderReport[] {
  const connected = CLOUD_PROVIDERS.filter((provider) => input.connections[provider]?.status === "connected")
  const cloudRows = input.analysis.costRows.filter((row) => connected.includes(row.provider))
  const totalCost = cloudRows.reduce((sum, row) => sum + row.cost, 0)

  return connected.map((provider) => {
    const rows = cloudRows.filter((row) => row.provider === provider)
    const cost = rows.reduce((sum, row) => sum + row.cost, 0)
    const byService = new Map<string, number>()
    for (const row of rows) byService.set(row.serviceName, (byService.get(row.serviceName) ?? 0) + row.cost)
    const topEntry = [...byService.entries()].sort((a, b) => b[1] - a[1])[0]
    const topService = topEntry?.[0] ?? null
    const topServiceCost = topEntry?.[1] ?? 0
    const usage = input.analysis.freeTier.filter((row) => row.provider === provider && row.source === "measured")
    const percentages = usage
      .map((row) => row.percentUsed)
      .filter((value): value is number => value !== null && Number.isFinite(value))
    const sync = input.analysis.liveSync.find((entry) => entry.provider === provider)

    const syncStatus: CloudProviderReport["syncStatus"] = sync?.status ?? "unknown"
    return {
      provider,
      cost,
      share: totalCost > 0 ? (cost / totalCost) * 100 : 0,
      projected: input.elapsedDays > 0 ? (cost / input.elapsedDays) * input.totalDays : 0,
      topService,
      topServiceCost,
      measuredMetrics: usage.length,
      highestUsagePercent: percentages.length ? Math.max(...percentages) : null,
      resourceCount: input.analysis.resourceItems.filter((item) => item.provider === provider).length,
      syncStatus,
      syncedAt: sync?.syncedAt ?? null,
      ...coverage(provider, input.connections[provider] ?? null, syncStatus),
    }
  }).sort((a, b) => b.cost - a.cost || a.provider.localeCompare(b.provider))
}
