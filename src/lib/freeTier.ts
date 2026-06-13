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
    // Workers free tier is 100k requests/day; expressed monthly (~30 days) so it
    // compares against the monthly request total from the Analytics API.
    allowances: [
      { service: "Workers Requests", limit: 3_000_000, unit: "requests/mo", match: /worker|request/i },
      { service: "R2 Storage", limit: 10, unit: "GB", match: /r2|storage|bucket/i },
      { service: "D1 Rows Read", limit: 5_000_000, unit: "rows/day", match: /d1|database|rows?/i },
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

/**
 * Builds free-tier usage lines for every connected provider whose measured cost
 * is $0 (i.e. it is operating inside the free tier for this period). Measured
 * usage samples are attributed to allowances by service/unit keyword; when no
 * sample matches an allowance, the line is returned with `used: null` so the UI
 * can show the limit without inventing a consumption figure.
 */
export function computeFreeTierUsage(
  costRows: NormalizedCostRow[],
  usage: ProviderUsageSample[],
  connections: ProviderConnection[]
): FreeTierUsageRow[] {
  const rows: FreeTierUsageRow[] = []

  for (const connection of connections) {
    if (connection.status !== "connected") continue
    const plan = FREE_TIER_PLANS[connection.provider]
    if (!plan) continue

    // A provider with no billed cost is "on the free tier"; one with cost has
    // moved into paid usage. We surface allowance usage in BOTH cases so usage
    // is shown married with cost, not only when the bill is $0.
    const providerCost = costRows
      .filter((row) => row.provider === connection.provider)
      .reduce((sum, row) => sum + row.cost, 0)
    const onFreeTier = providerCost <= 0.005

    const providerUsage = usage.filter((sample) => sample.provider === connection.provider)

    for (const allowance of plan.allowances) {
      const matched = providerUsage.filter(
        (sample) => allowance.match.test(sample.service) || allowance.match.test(sample.unit)
      )
      const used = matched.length ? roundTo(matched.reduce((sum, sample) => sum + sample.quantity, 0)) : null

      // When the provider is already billing, an allowance line we can't measure
      // adds noise — skip it. On the free tier we still show it so the user sees
      // the full set of free limits available.
      if (used === null && !onFreeTier) continue

      const remaining = used === null ? null : roundTo(Math.max(allowance.limit - used, 0))
      const percentUsed = used === null ? null : roundTo(Math.min((used / allowance.limit) * 100, 100), 1)

      rows.push({
        provider: connection.provider,
        planName: plan.planName,
        service: allowance.service,
        used,
        limit: allowance.limit,
        unit: allowance.unit,
        remaining,
        percentUsed,
        source: used === null ? "allowance" : "measured",
        note:
          used === null
            ? `${plan.planName} published allowance. This provider did not report live ${allowance.unit} usage for the current period.`
            : `Measured against the ${plan.planName} allowance from live provider usage for the current period.`,
      })
    }
  }

  return rows
}
