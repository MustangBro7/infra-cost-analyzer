import { analyticsRuntimeFlags, withAnalyticsClient } from "./connection"
import type { AnalyticsServicesResult, AnalyticsTrendsResult } from "./types"

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

export function validateMonth(value: string): string {
  if (!MONTH_PATTERN.test(value)) throw new Error("Month must use YYYY-MM format.")
  return value
}

function monthIndex(value: string): number {
  const [year, month] = value.split("-").map(Number)
  return year * 12 + month - 1
}

export function validateMonthRange(from: string, to: string): void {
  validateMonth(from)
  validateMonth(to)
  const span = monthIndex(to) - monthIndex(from) + 1
  if (span < 1) throw new Error("The from month must not be after the to month.")
  if (span > 24) throw new Error("Analytics date ranges are limited to 24 months.")
}

function scopeClause(repo: string | null, startIndex: number): { sql: string; values: unknown[] } {
  return repo
    ? { sql: `repo_full_name = $${startIndex}`, values: [repo] }
    : { sql: "repo_full_name IS NULL", values: [] }
}

export async function getAnalyticsTrends(input: {
  userId: string
  from: string
  to: string
  repo: string | null
}): Promise<AnalyticsTrendsResult> {
  validateMonthRange(input.from, input.to)
  const flags = await analyticsRuntimeFlags()
  if (!flags.reads) throw new Error("Historical analytics are disabled.")
  const scope = scopeClause(input.repo, 4)
  return withAnalyticsClient(async (client) => {
    const values = [input.userId, `${input.from}-01`, `${input.to}-01`, ...scope.values]
    const [trends, providers] = await Promise.all([
      client.query(
        `SELECT strftime(month, '%Y-%m') AS month, currency, total::DOUBLE AS total,
                last_observed_at::VARCHAR AS last_observed_at
         FROM monthly_cost_summary
         WHERE user_id = $1 AND month >= $2::DATE AND month <= $3::DATE AND ${scope.sql}
         ORDER BY month, currency`,
        values
      ),
      client.query(
        `SELECT strftime(month, '%Y-%m') AS month, provider, currency, total::DOUBLE AS total,
                last_observed_at::VARCHAR AS last_observed_at
         FROM provider_monthly_summary
         WHERE user_id = $1 AND month >= $2::DATE AND month <= $3::DATE AND ${scope.sql}
         ORDER BY month, total DESC`,
        values
      ),
    ])
    const trendRows = trends.rows.map((row) => ({
      month: String(row.month),
      currency: String(row.currency),
      total: Number(row.total),
      lastObservedAt: String(row.last_observed_at),
    }))
    const providerRows = providers.rows.map((row) => ({
      month: String(row.month),
      provider: String(row.provider),
      currency: String(row.currency),
      total: Number(row.total),
      lastObservedAt: String(row.last_observed_at),
    }))
    const timestamps = [...trendRows, ...providerRows].map((row) => row.lastObservedAt).sort()
    return {
      from: input.from,
      to: input.to,
      repo: input.repo,
      trends: trendRows,
      providers: providerRows,
      lastObservedAt: timestamps.at(-1) ?? null,
    }
  })
}

export async function getAnalyticsServices(input: {
  userId: string
  month: string
  repo: string | null
}): Promise<AnalyticsServicesResult> {
  validateMonth(input.month)
  const flags = await analyticsRuntimeFlags()
  if (!flags.reads) throw new Error("Historical analytics are disabled.")
  const scope = scopeClause(input.repo, 3)
  return withAnalyticsClient(async (client) => {
    const result = await client.query(
      `SELECT provider, service_name, currency, total::DOUBLE AS total,
              last_observed_at::VARCHAR AS last_observed_at
       FROM service_monthly_summary
       WHERE user_id = $1 AND month = $2::DATE AND ${scope.sql}
       ORDER BY total DESC`,
      [input.userId, `${input.month}-01`, ...scope.values]
    )
    const services = result.rows.map((row) => ({
      provider: String(row.provider),
      serviceName: String(row.service_name),
      currency: String(row.currency),
      total: Number(row.total),
      lastObservedAt: String(row.last_observed_at),
    }))
    return {
      month: input.month,
      repo: input.repo,
      services,
      lastObservedAt: services.map((row) => row.lastObservedAt).sort().at(-1) ?? null,
    }
  })
}
