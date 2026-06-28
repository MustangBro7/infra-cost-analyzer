import { analyticsRuntimeFlags, withAnalyticsClient } from "./connection"
import { devPreviewAnalyticsDashboard, devPreviewTrends, isDevPreview } from "../devPreview"
import type { AnalyticsDashboardResult, AnalyticsServicesResult, AnalyticsTrendsResult } from "./types"

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

/**
 * Real monthly cost totals per repo over a window, in one query, for the
 * Projects table sparklines. Returns {} when historical reads are disabled or
 * unavailable so the caller renders no trend rather than fabricating one.
 */
export async function getMonthlyTotalsByRepo(input: {
  userId: string
  from: string
  to: string
}): Promise<Record<string, Array<{ month: string; total: number }>>> {
  validateMonthRange(input.from, input.to)
  if (isDevPreview()) return devPreviewTrends()
  const flags = await analyticsRuntimeFlags()
  if (!flags.reads) return {}
  return withAnalyticsClient(async (client) => {
    const result = await client.query(
      `SELECT repo_full_name AS repo, strftime(month, '%Y-%m') AS month, SUM(total)::DOUBLE AS total
       FROM monthly_cost_summary
       WHERE user_id = $1 AND month >= $2::DATE AND month <= $3::DATE AND repo_full_name IS NOT NULL
       GROUP BY repo_full_name, month
       ORDER BY month`,
      [input.userId, `${input.from}-01`, `${input.to}-01`]
    )
    const out: Record<string, Array<{ month: string; total: number }>> = {}
    for (const row of result.rows) {
      const repo = String(row.repo)
      ;(out[repo] ??= []).push({ month: String(row.month), total: Number(row.total) })
    }
    return out
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

/**
 * Loads all dashboard analytics over one authenticated request and one database
 * connection. The client previously opened two API requests, each of which
 * repeated authentication and established its own MotherDuck connection.
 */
export async function getAnalyticsDashboard(input: {
  userId: string
  from: string
  to: string
  month: string
  repo: string | null
}): Promise<AnalyticsDashboardResult> {
  validateMonthRange(input.from, input.to)
  validateMonth(input.month)
  if (isDevPreview()) return devPreviewAnalyticsDashboard({ from: input.from, to: input.to, month: input.month })
  const flags = await analyticsRuntimeFlags()
  if (!flags.reads) throw new Error("Historical analytics are disabled.")

  const trendScope = scopeClause(input.repo, 4)
  const serviceScope = scopeClause(input.repo, 3)
  return withAnalyticsClient(async (client) => {
    const trendValues = [input.userId, `${input.from}-01`, `${input.to}-01`, ...trendScope.values]
    const serviceValues = [input.userId, `${input.month}-01`, ...serviceScope.values]
    const [trends, providers, services] = await Promise.all([
      client.query(
        `SELECT strftime(month, '%Y-%m') AS month, currency, total::DOUBLE AS total,
                last_observed_at::VARCHAR AS last_observed_at
         FROM monthly_cost_summary
         WHERE user_id = $1 AND month >= $2::DATE AND month <= $3::DATE AND ${trendScope.sql}
         ORDER BY month, currency`,
        trendValues
      ),
      client.query(
        `SELECT strftime(month, '%Y-%m') AS month, provider, currency, total::DOUBLE AS total,
                last_observed_at::VARCHAR AS last_observed_at
         FROM provider_monthly_summary
         WHERE user_id = $1 AND month >= $2::DATE AND month <= $3::DATE AND ${trendScope.sql}
         ORDER BY month, total DESC`,
        trendValues
      ),
      client.query(
        `SELECT provider, service_name, currency, total::DOUBLE AS total,
                last_observed_at::VARCHAR AS last_observed_at
         FROM service_monthly_summary
         WHERE user_id = $1 AND month = $2::DATE AND ${serviceScope.sql}
         ORDER BY total DESC`,
        serviceValues
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
    const serviceRows = services.rows.map((row) => ({
      provider: String(row.provider),
      serviceName: String(row.service_name),
      currency: String(row.currency),
      total: Number(row.total),
      lastObservedAt: String(row.last_observed_at),
    }))

    return {
      trends: {
        from: input.from,
        to: input.to,
        repo: input.repo,
        trends: trendRows,
        providers: providerRows,
        lastObservedAt: [...trendRows, ...providerRows].map((row) => row.lastObservedAt).sort().at(-1) ?? null,
      },
      services: {
        month: input.month,
        repo: input.repo,
        services: serviceRows,
        lastObservedAt: serviceRows.map((row) => row.lastObservedAt).sort().at(-1) ?? null,
      },
    }
  })
}
