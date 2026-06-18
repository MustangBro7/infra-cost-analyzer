"use client"

import * as React from "react"
import { AlertTriangle, BarChart3, Loader2 } from "lucide-react"
import type { AnalyticsServicesResult, AnalyticsTrendsResult } from "@/lib/analytics/types"

function monthOffset(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number)
  const value = new Date(Date.UTC(year, monthNumber - 1 + offset, 1))
  return value.toISOString().slice(0, 7)
}

function monthName(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  })
}

function currency(value: number, code: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value)
}

function isStale(value: string | null): boolean {
  return Boolean(value && Date.now() - new Date(value).getTime() > 24 * 60 * 60 * 1000)
}

export function HistoricalAnalyticsPanel({
  repo,
  currentMonth,
}: {
  repo: string | null
  currentMonth: string
}) {
  const [trends, setTrends] = React.useState<AnalyticsTrendsResult | null>(null)
  const [services, setServices] = React.useState<AnalyticsServicesResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const controller = new AbortController()
    const query = repo ? `&repo=${encodeURIComponent(repo)}` : ""
    Promise.all([
      fetch(`/api/analytics/trends?from=${monthOffset(currentMonth, -11)}&to=${currentMonth}${query}`, {
        signal: controller.signal,
      }),
      fetch(`/api/analytics/services?month=${currentMonth}${query}`, { signal: controller.signal }),
    ])
      .then(async ([trendResponse, serviceResponse]) => {
        const trendBody = await trendResponse.json() as AnalyticsTrendsResult & { error?: string }
        const serviceBody = await serviceResponse.json() as AnalyticsServicesResult & { error?: string }
        if (!trendResponse.ok) throw new Error(trendBody.error ?? "Historical trends are unavailable.")
        if (!serviceResponse.ok) throw new Error(serviceBody.error ?? "Service analytics are unavailable.")
        setTrends(trendBody as AnalyticsTrendsResult)
        setServices(serviceBody as AnalyticsServicesResult)
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Analytics are unavailable.")
      })
    return () => controller.abort()
  }, [currentMonth, repo])

  if (error) {
    return (
      <section className="analytics-state analytics-unavailable" aria-label="Historical cost analytics unavailable">
        <AlertTriangle aria-hidden />
        <div>
          <strong>Historical analytics unavailable</strong>
          <span>{error}</span>
        </div>
      </section>
    )
  }

  if (!trends || !services) {
    return (
      <section className="analytics-state" aria-label="Loading historical cost analytics">
        <Loader2 className="spin" aria-hidden />
        <div>
          <strong>Loading cost history</strong>
          <span>Querying monthly observations.</span>
        </div>
      </section>
    )
  }

  if (trends.trends.length === 0) {
    return (
      <section className="analytics-state" aria-label="No historical cost analytics">
        <BarChart3 aria-hidden />
        <div>
          <strong>No historical observations yet</strong>
          <span>History will appear after a successful provider refresh.</span>
        </div>
      </section>
    )
  }

  const currencies = [...new Set(trends.trends.map((row) => row.currency))]
  const months = Array.from({ length: 12 }, (_, index) => monthOffset(currentMonth, index - 11))
  const latestProviders = trends.providers.filter((row) => row.month === currentMonth)

  return (
    <section className="analytics-dashboard" aria-label="Historical cost analytics">
      <div className="analytics-heading">
        <div>
          <p>Cost history</p>
          <h2>12-month spend trend</h2>
        </div>
        <span className={isStale(trends.lastObservedAt) ? "analytics-freshness stale" : "analytics-freshness"}>
          {isStale(trends.lastObservedAt) ? "Data is over 24h old" : "Current"}
        </span>
      </div>

      <div className="analytics-currency-groups">
        {currencies.map((code) => {
          const byMonth = new Map(
            trends.trends.filter((row) => row.currency === code).map((row) => [row.month, row.total])
          )
          const max = Math.max(...byMonth.values(), 0.01)
          return (
            <div className="analytics-chart" key={code}>
              <div className="analytics-chart-title">
                <strong>{code}</strong>
                <span>{currency([...byMonth.values()].reduce((sum, value) => sum + value, 0), code)} observed</span>
              </div>
              <div className="analytics-bars">
                {months.map((month) => {
                  const total = byMonth.get(month) ?? 0
                  return (
                    <div className="analytics-bar-column" key={month} title={`${month}: ${currency(total, code)}`}>
                      <span className="analytics-bar-value">{total > 0 ? currency(total, code) : ""}</span>
                      <span className="analytics-bar-track">
                        <span style={{ height: `${Math.max((total / max) * 100, total > 0 ? 4 : 0)}%` }} />
                      </span>
                      <small>{monthName(month)}</small>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <div className="analytics-breakdowns">
        <div>
          <h3>Providers · {monthName(currentMonth)}</h3>
          {latestProviders.length ? latestProviders.map((row) => (
            <div className="analytics-breakdown-row" key={`${row.provider}-${row.currency}`}>
              <span>{row.provider}</span>
              <strong>{currency(row.total, row.currency)}</strong>
            </div>
          )) : <span className="analytics-empty-copy">No provider cost this month.</span>}
        </div>
        <div>
          <h3>Services · {monthName(currentMonth)}</h3>
          {services.services.length ? services.services.slice(0, 8).map((row) => (
            <div className="analytics-breakdown-row" key={`${row.provider}-${row.serviceName}-${row.currency}`}>
              <span>{row.serviceName} <small>{row.provider}</small></span>
              <strong>{currency(row.total, row.currency)}</strong>
            </div>
          )) : <span className="analytics-empty-copy">No service cost this month.</span>}
        </div>
      </div>
    </section>
  )
}
