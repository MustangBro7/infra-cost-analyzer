import type { NormalizedCostRow } from "./types"

/**
 * Whether a billing row is a FLAT periodic charge (a subscription) rather than
 * usage that accrues day by day. Flat charges hit the bill in full on day one
 * — a $40 Claude/ChatGPT subscription on July 1st is $40 for July, not
 * "$40 in one day" to be run-rated into $1,200 — so forecasts must count them
 * once at face value and only extrapolate the usage-based remainder.
 *
 * Detection:
 *  • AI tool subscriptions (Claude Pro/Max, ChatGPT Plus, Cursor) are written
 *    with "subscription" in the service name (see buildLocalAiResult and the
 *    AI connect flows) — the same marker buildAiTools already keys on.
 *  • Cloudflare cost rows are plan subscription prices normalized to a monthly
 *    amount (normalizeCloudflareSubscriptions), never metered usage.
 */
export function isFlatMonthlyCost(row: Pick<NormalizedCostRow, "provider" | "serviceName">): boolean {
  if (/subscription/i.test(row.serviceName)) return true
  if (row.provider === "cloudflare") return true
  return false
}

export interface SpendForecast {
  /** Flat subscription spend in the rows (counted once, never extrapolated). */
  flatTotal: number
  /** Usage-based spend in the rows (extrapolated on the daily run rate). */
  usageTotal: number
  /** Daily run rate of the usage-based portion only. */
  dailyRate: number
  /** flatTotal + usage run-rated across the full period. */
  projected: number
}

/**
 * Period-end projection that never inflates flat subscriptions: usage rows are
 * extrapolated from days elapsed to the full period; flat rows are added once
 * at their billed amount. With elapsed == total (a finished period) this
 * degrades to the actual observed total.
 */
export function projectedSpend(
  rows: Array<Pick<NormalizedCostRow, "provider" | "serviceName" | "cost">>,
  elapsedDays: number,
  totalDays: number
): SpendForecast {
  let flatTotal = 0
  let usageTotal = 0
  for (const row of rows) {
    if (isFlatMonthlyCost(row)) flatTotal += row.cost
    else usageTotal += row.cost
  }
  const dailyRate = elapsedDays > 0 ? usageTotal / elapsedDays : 0
  return {
    flatTotal,
    usageTotal,
    dailyRate,
    projected: flatTotal + dailyRate * Math.max(totalDays, elapsedDays),
  }
}
