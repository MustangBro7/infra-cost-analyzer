import { analyticsRuntimeFlags, withAnalyticsClient } from "./connection"
import { devPreviewAnalyticsDashboard, devPreviewRangeCostRows, devPreviewTrends, isDevPreview } from "../devPreview"
import type { NormalizedCostRow } from "../types"
import type { AnalyticsDashboardResult, AnalyticsServicesResult, AnalyticsTrendsResult, RangeCostRowsResult } from "./types"

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

/**
 * Maps a latest_cost_facts_compat row back into the NormalizedCostRow shape the
 * dashboard renders. The fields round-trip exactly (they were written from a
 * NormalizedCostRow by the analytics payload), so costItemKey(row) reproduces
 * the stored item_key and the user's manual assignments/splits keep applying.
 */
export function mapFactToCostRow(fact: Record<string, unknown>): NormalizedCostRow {
  return {
    provider: String(fact.provider) as NormalizedCostRow["provider"],
    serviceName: String(fact.service_name),
    resourceId: fact.resource_id == null ? null : String(fact.resource_id),
    resourceName: fact.resource_name == null ? null : String(fact.resource_name),
    billingPeriodStart: String(fact.billing_period_start).slice(0, 10),
    billingPeriodEnd: String(fact.billing_period_end).slice(0, 10),
    cost: Number(fact.cost),
    currency: String(fact.currency ?? "USD"),
    attribution: (fact.attribution ?? "verified") as NormalizedCostRow["attribution"],
    attributionReason: String(fact.attribution_reason ?? "Historical row from the analytics store."),
    signalId: fact.signal_id == null ? null : String(fact.signal_id),
    attributedRepo: fact.attributed_repo == null ? null : String(fact.attributed_repo),
  }
}

/**
 * Full historical cost rows for a contiguous set of past months (YYYY-MM,
 * oldest first), reconstructed from the latest observation of every account-
 * level fact. Overview scope only (repo_full_name IS NULL): those rows carry
 * attributed_repo + stable item keys, and per-repo slicing happens at display
 * time through the same assignment machinery as the live month — so nothing is
 * double-counted against repo-scoped observations. Months in the current
 * billing month must NOT be passed here; the live snapshot owns the current
 * month.
 */
export async function getRangeCostRows(input: {
  userId: string
  months: string[]
}): Promise<RangeCostRowsResult> {
  if (input.months.length === 0) return { available: true, rows: [] }
  const from = input.months[0]
  const to = input.months[input.months.length - 1]
  validateMonthRange(from, to)

  if (isDevPreview()) {
    return { available: true, rows: devPreviewRangeCostRows(input.months) }
  }

  const flags = await analyticsRuntimeFlags()
  if (!flags.reads) return { available: false, rows: [] }
  return withAnalyticsClient(async (client) => {
    const result = await client.query(
      `SELECT provider, service_name, resource_id, resource_name,
              billing_period_start::VARCHAR AS billing_period_start,
              billing_period_end::VARCHAR AS billing_period_end,
              cost::DOUBLE AS cost, currency, attribution, attribution_reason,
              signal_id, attributed_repo
       FROM latest_cost_facts_compat
       WHERE user_id = $1 AND repo_full_name IS NULL
         AND date_trunc('month', billing_period_start) >= $2::DATE
         AND date_trunc('month', billing_period_start) <= $3::DATE
       ORDER BY billing_period_start, cost DESC`,
      [input.userId, `${from}-01`, `${to}-01`]
    )
    const monthSet = new Set(input.months)
    const rows = result.rows
      .map((row) => mapFactToCostRow(row as Record<string, unknown>))
      .filter((row) => monthSet.has(row.billingPeriodStart.slice(0, 7)))
      .filter((row) => Number.isFinite(row.cost) && Math.abs(row.cost) >= 0.005)
    return { available: true, rows }
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
