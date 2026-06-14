import type {
  FreeTierUsageRow,
  NormalizedCostRow,
  Provider,
  ProviderConnection,
  ProviderUsageSample,
} from "./types"

/**
 * Published free-tier allowances for the providers we pull live data from.
 * These are the headline monthly limits of each provider's free plan. When the
 * provider reports real consumption we overlay it to compute the remaining
 * amount; otherwise we surface the allowance so the user still sees the limit.
 *
 * `match` is tested against a usage sample's service/unit string so measured
 * consumption can be attributed to the right allowance line.
 */
interface Allowance {
  service: string
  limit: number
  unit: string
  match: RegExp
}

interface FreeTierPlan {
  planName: string
  allowances: Allowance[]
}

const FREE_TIER_PLANS: Partial<Record<Provider, FreeTierPlan>> = {
  vercel: {
    planName: "Vercel Hobby",
    allowances: [
      { service: "Fast Data Transfer", limit: 100, unit: "GB", match: /data\s*transfer|bandwidth|egress/i },
      { service: "Edge Requests", limit: 1_000_000, unit: "requests", match: /edge\s*request|invocation|function/i },
      { service: "Image Optimization", limit: 5_000, unit: "source images", match: /image/i },
    ],
  },
  cloudflare: {
    planName: "Cloudflare Free",
    // Free-tier limits expressed monthly (~30 days) so they compare against the
    // monthly totals returned by the GraphQL Analytics API. Daily limits are
    // multiplied out: Workers 100k/day, D1 5M read/day & 100k written/day.
    allowances: [
      { service: "Workers Requests", limit: 3_000_000, unit: "requests/mo", match: /workers requests/i },
      { service: "R2 Storage", limit: 10, unit: "GB", match: /r2 storage/i },
      { service: "D1 Rows Read", limit: 150_000_000, unit: "rows/mo", match: /d1 rows read|rows read/i },
      { service: "D1 Rows Written", limit: 3_000_000, unit: "rows/mo", match: /d1 rows written|rows written/i },
    ],
  },
  gcp: {
    planName: "Google Cloud Always Free",
    allowances: [
      { service: "Cloud Run Requests", limit: 2_000_000, unit: "requests", match: /run/i },
      { service: "Cloud Functions Invocations", limit: 2_000_000, unit: "invocations", match: /function/i },
      { service: "Cloud Storage", limit: 5, unit: "GB", match: /storage/i },
    ],
  },
}

function roundTo(value: number, digits = 2) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function providerDisplay(provider: Provider): string {
  if (provider === "gcp") return "Google Cloud"
  if (provider === "aws") return "AWS"
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

/**
 * Maps a resource kind (e.g. a Cloudflare "Worker") to the free-tier metric its
 * usage rolls up into, so usage can be re-derived from just the resources a repo
 * is assigned. Kinds with no published limit (e.g. domains) show usage only.
 */
const RESOURCE_METRICS: Record<string, { service: string; limit: number | null; unit: string }> = {
  Worker: { service: "Workers Requests", limit: 3_000_000, unit: "requests/mo" },
  Domain: { service: "Domain Requests", limit: null, unit: "requests" },
}

/** The free-tier metric service a resource kind contributes to (for de-duping). */
export function resourceMetricService(kind: string): string | null {
  return RESOURCE_METRICS[kind]?.service ?? null
}

/**
 * Builds usage rows from a set of resources (e.g. the Cloudflare Workers a repo
 * is assigned), aggregated per metric and compared to the free allowance — so a
 * repo's usage reflects only the resources assigned to it.
 */
export function resourceUsageRows(
  provider: Provider,
  items: { kind: string; quantity: number; unit: string }[]
): FreeTierUsageRow[] {
  const planName = FREE_TIER_PLANS[provider]?.planName ?? `${providerDisplay(provider)} usage`
  const byKind = new Map<string, number>()
  for (const item of items) {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) continue
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + item.quantity)
  }
  const rows: FreeTierUsageRow[] = []
  for (const [kind, quantity] of byKind) {
    const metric = RESOURCE_METRICS[kind] ?? {
      service: `${kind} usage`,
      limit: null,
      unit: items.find((item) => item.kind === kind)?.unit ?? "",
    }
    const used = roundTo(quantity)
    const limit = metric.limit
    rows.push({
      provider,
      planName,
      service: metric.service,
      used,
      limit,
      unit: metric.unit,
      remaining: limit != null ? roundTo(Math.max(limit - used, 0)) : null,
      percentUsed: limit ? roundTo(Math.min((used / limit) * 100, 100), 1) : null,
      source: "measured",
      note: `Filtered to the ${kind.toLowerCase()} resource(s) assigned to this repo.`,
    })
  }
  return rows
}

/** Collapses repeated usage samples of the same service+unit into one total. */
function aggregateUsage(samples: ProviderUsageSample[]): ProviderUsageSample[] {
  const map = new Map<string, ProviderUsageSample>()
  for (const sample of samples) {
    if (!Number.isFinite(sample.quantity) || sample.quantity <= 0) continue
    const key = `${sample.service}|||${sample.unit}`
    const existing = map.get(key)
    if (existing) existing.quantity += sample.quantity
    else map.set(key, { ...sample })
  }
  return [...map.values()]
}

/**
 * Builds usage lines for every connected provider. Three kinds of line:
 *  1. Measured usage attributed to a published free allowance (used + limit).
 *  2. Measured usage with no published allowance — shown with `limit: null` so
 *     nothing the provider actually reports is ever hidden, in free OR paid tier
 *     (this mirrors how AWS surfaces every reported metric).
 *  3. Published allowances with no reported usage (`used: null`) — shown only
 *     while the provider is still on the free tier, so paid accounts aren't
 *     padded with empty allowance lines.
 */
export function computeFreeTierUsage(
  costRows: NormalizedCostRow[],
  usage: ProviderUsageSample[],
  connections: ProviderConnection[]
): FreeTierUsageRow[] {
  const rows: FreeTierUsageRow[] = []

  for (const connection of connections) {
    if (connection.status !== "connected") continue
    // AWS gets its usage from the dedicated Free Tier API (appended separately as
    // FreeTierUsageRows), so skip it here to avoid duplicate lines.
    if (connection.provider === "aws") continue
    const plan = FREE_TIER_PLANS[connection.provider]
    const planName = plan?.planName ?? `${providerDisplay(connection.provider)} usage`

    // A provider with no billed cost is "on the free tier"; one with cost has
    // moved into paid usage. We surface usage in BOTH cases so consumption is
    // shown married with cost, not only when the bill is $0.
    const providerCost = costRows
      .filter((row) => row.provider === connection.provider)
      .reduce((sum, row) => sum + row.cost, 0)
    const onFreeTier = providerCost <= 0.005

    const providerUsage = aggregateUsage(usage.filter((sample) => sample.provider === connection.provider))
    const attributed = new Set<ProviderUsageSample>()

    for (const allowance of plan?.allowances ?? []) {
      const matched = providerUsage.filter(
        (sample) => allowance.match.test(sample.service) || allowance.match.test(sample.unit)
      )
      matched.forEach((sample) => attributed.add(sample))
      const used = matched.length ? roundTo(matched.reduce((sum, sample) => sum + sample.quantity, 0)) : null

      // When the provider is already billing, an allowance line we can't measure
      // adds noise — skip it. On the free tier we still show it so the user sees
      // the full set of free limits available.
      if (used === null && !onFreeTier) continue

      const remaining = used === null ? null : roundTo(Math.max(allowance.limit - used, 0))
      const percentUsed = used === null ? null : roundTo(Math.min((used / allowance.limit) * 100, 100), 1)

      rows.push({
        provider: connection.provider,
        planName,
        service: allowance.service,
        used,
        limit: allowance.limit,
        unit: allowance.unit,
        remaining,
        percentUsed,
        source: used === null ? "allowance" : "measured",
        note:
          used === null
            ? `${planName} published allowance. This provider did not report live ${allowance.unit} usage for the current period.`
            : `Measured against the ${planName} allowance from live provider usage for the current period.`,
      })
    }

    // Every reported metric that didn't map to a known allowance is still shown
    // (limit unknown), so no live usage is hidden regardless of tier.
    for (const sample of providerUsage) {
      if (attributed.has(sample)) continue
      const used = roundTo(sample.quantity)
      rows.push({
        provider: connection.provider,
        planName,
        service: sample.service,
        used,
        limit: null,
        unit: sample.unit,
        remaining: null,
        percentUsed: null,
        source: "measured",
        note: `Live ${sample.unit} reported by ${providerDisplay(connection.provider)} for the current period. No published free-tier limit is tracked for this metric.`,
      })
    }
  }

  return rows
}
