"use client"

import * as React from "react"
import { AlertTriangle, BarChart3, Loader2, TrendingDown, TrendingUp } from "lucide-react"
import type { AnalyticsDashboardResult, AnalyticsServicesResult, AnalyticsTrendsResult } from "@/lib/analytics/types"

function monthOffset(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number)
  const value = new Date(Date.UTC(year, monthNumber - 1 + offset, 1))
  return value.toISOString().slice(0, 7)
}

const PROVIDER_NAMES: Record<string, string> = {
  aws: "AWS",
  gcp: "Google Cloud",
  anthropic: "Claude",
  openai: "OpenAI",
  cloudflare: "Cloudflare",
  vercel: "Vercel",
  motherduck: "MotherDuck",
  cursor: "Cursor",
  digitalocean: "DigitalOcean",
  azure: "Azure",
  custom: "Custom",
}

function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
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
  const rootRef = React.useRef<HTMLElement | null>(null)
  const [enabled, setEnabled] = React.useState(false)
  const [trends, setTrends] = React.useState<AnalyticsTrendsResult | null>(null)
  const [services, setServices] = React.useState<AnalyticsServicesResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const root = rootRef.current
    if (!root || enabled) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setEnabled(true)
        observer.disconnect()
      },
      { rootMargin: "400px" }
    )
    observer.observe(root)
    return () => observer.disconnect()
  }, [enabled])

  React.useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    const query = repo ? `&repo=${encodeURIComponent(repo)}` : ""
    fetch(
      `/api/analytics/dashboard?from=${monthOffset(currentMonth, -11)}&to=${currentMonth}&month=${currentMonth}${query}`,
      { signal: controller.signal }
    )
      .then(async (response) => {
        const body = await response.json() as AnalyticsDashboardResult & { error?: string }
        if (!response.ok) throw new Error(body.error ?? "Historical analytics are unavailable.")
        setTrends(body.trends)
        setServices(body.services)
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Analytics are unavailable.")
      })
    return () => controller.abort()
  }, [currentMonth, enabled, repo])

  if (!enabled) {
    return (
      <section ref={rootRef} className="analytics-state" aria-label="Historical cost analytics">
        <BarChart3 aria-hidden />
        <div>
          <strong>Cost history</strong>
          <span>Loads as this section approaches the viewport.</span>
        </div>
      </section>
    )
  }

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

  // Biggest movers: per-provider delta of this month vs last month.
  const prevMonth = monthOffset(currentMonth, -1)
  const hasPrevMonth = trends.providers.some((row) => row.month === prevMonth)
  const moverMap = new Map<string, { provider: string; currency: string; cur: number; prev: number }>()
  for (const row of trends.providers) {
    if (row.month !== currentMonth && row.month !== prevMonth) continue
    const key = `${row.provider}|${row.currency}`
    const entry = moverMap.get(key) ?? { provider: row.provider, currency: row.currency, cur: 0, prev: 0 }
    if (row.month === currentMonth) entry.cur = row.total
    else entry.prev = row.total
    moverMap.set(key, entry)
  }
  const movers = [...moverMap.values()]
    .map((entry) => ({ ...entry, delta: entry.cur - entry.prev }))
    .filter((entry) => Math.abs(entry.delta) >= 0.01)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5)

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

      {hasPrevMonth && movers.length > 0 ? (
        <div className="analytics-movers">
          <h3>Biggest movers vs {monthName(prevMonth)}</h3>
          {movers.map((mover) => {
            const up = mover.delta > 0
            const pct = mover.prev > 0 ? Math.round((mover.delta / mover.prev) * 100) : null
            return (
              <div className="mover-row" key={`${mover.provider}-${mover.currency}`}>
                <span className="mover-name">{providerName(mover.provider)}</span>
                <span className="mover-vals">
                  {currency(mover.prev, mover.currency)} → {currency(mover.cur, mover.currency)}
                </span>
                <span className={`mover-delta ${up ? "up" : "down"}`}>
                  {up ? <TrendingUp aria-hidden /> : <TrendingDown aria-hidden />}
                  {up ? "+" : "−"}{currency(Math.abs(mover.delta), mover.currency)}
                  {pct != null ? ` (${up ? "+" : "−"}${Math.abs(pct)}%)` : ""}
                </span>
              </div>
            )
          })}
        </div>
      ) : null}

      <div className="analytics-breakdowns">
        <div>
          <h3>Providers · {monthName(currentMonth)}</h3>
          {latestProviders.length ? latestProviders.map((row) => (
            <div className="analytics-breakdown-row" key={`${row.provider}-${row.currency}`}>
              <span>{providerName(row.provider)}</span>
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
