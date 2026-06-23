"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import { Gauge, X } from "lucide-react"
import { ProviderLogo, PROVIDER_LABELS } from "./ProviderLogo"
import type { FreeTierUsageRow, Provider } from "@/lib/types"

function quantity(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
}

const tone = (pct: number) => (pct >= 90 ? "crit" : pct >= 80 ? "warn" : "ok")

// Order within a provider: metered allowances first (closest to limit on top),
// then measured metrics with no published limit, then unreported allowances.
function rank(row: FreeTierUsageRow): [number, number] {
  if (row.source === "measured" && row.limit !== null) return [0, -(row.percentUsed ?? 0)]
  if (row.source === "measured") return [1, 0]
  return [2, 0]
}

function groupByProvider(rows: FreeTierUsageRow[]) {
  const groups = new Map<Provider, FreeTierUsageRow[]>()
  for (const row of rows) {
    const list = groups.get(row.provider) ?? []
    list.push(row)
    groups.set(row.provider, list)
  }
  return [...groups.entries()].map(([provider, list]) => ({
    provider,
    planName: list[0]?.planName ?? PROVIDER_LABELS[provider],
    rows: list.sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)]
      return ra[0] - rb[0] || ra[1] - rb[1] || a.service.localeCompare(b.service)
    }),
  }))
}

// A single line in the modal: metered bar when there's a known limit, otherwise
// a measured-without-limit reading or an unreported published allowance.
function DetailRow({ row }: { row: FreeTierUsageRow }) {
  const pct = row.percentUsed ?? 0
  const metered = row.source === "measured" && row.limit !== null
  const unmetered = row.source === "measured" && row.limit === null

  return (
    <div className="usage-detail-row" title={row.note}>
      <div className="usage-detail-head">
        <strong>{row.service}</strong>
        {metered ? (
          <span className={`usage-detail-pct ${tone(pct)}`}>{Math.round(pct)}%</span>
        ) : unmetered ? (
          <span className="usage-detail-tag measured">measured</span>
        ) : (
          <span className="usage-detail-tag allowance">included</span>
        )}
      </div>
      <div className="usage-detail-bar" aria-hidden>
        <span
          className={metered ? `usage-detail-fill ${tone(pct)}` : "usage-detail-fill unknown"}
          style={{ width: `${metered ? Math.min(Math.max(pct, 2), 100) : unmetered ? 100 : 0}%` }}
        />
      </div>
      <small>
        {metered
          ? `${quantity(row.used ?? 0)} of ${quantity(row.limit ?? 0)} ${row.unit} used · ${quantity(row.remaining ?? 0)} ${row.unit} left`
          : unmetered
            ? `${quantity(row.used ?? 0)} ${row.unit} used · no published free-tier limit`
            : `Not reported this period · ${quantity(row.limit ?? 0)} ${row.unit} free`}
      </small>
    </div>
  )
}

function UsageDetailModal({ rows, onClose }: { rows: FreeTierUsageRow[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    // Lock background scroll, and reserve the scrollbar's width so removing it
    // doesn't shift the (viewport-centered) overlay sideways.
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
    const prevOverflow = document.body.style.overflow
    const prevPaddingRight = document.body.style.paddingRight
    document.body.style.overflow = "hidden"
    if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
      document.body.style.paddingRight = prevPaddingRight
    }
  }, [onClose])

  const groups = groupByProvider(rows)

  return (
    <div className="usage-modal-overlay" role="presentation" onClick={onClose}>
      <div
        className="usage-modal"
        role="dialog"
        aria-modal="true"
        aria-label="All free-tier usage"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="usage-modal-head">
          <div>
            <p>Usage</p>
            <h2>All free-tier usage</h2>
            <span>Every metric each connected provider reports for the current period — not only those near a limit.</span>
          </div>
          <button type="button" className="usage-modal-close" onClick={onClose} aria-label="Close">
            <X aria-hidden />
          </button>
        </div>
        <div className="usage-modal-body">
          {groups.length ? (
            groups.map((group) => (
              <section className="usage-detail-group" key={group.provider}>
                <header className="usage-detail-group-head">
                  <ProviderLogo provider={group.provider} />
                  <div>
                    <strong>{PROVIDER_LABELS[group.provider]}</strong>
                    <span>{group.planName} · {group.rows.length} metric{group.rows.length === 1 ? "" : "s"}</span>
                  </div>
                </header>
                <div className="usage-detail-list">
                  {group.rows.map((row) => (
                    <DetailRow key={`${row.provider}-${row.service}`} row={row} />
                  ))}
                </div>
              </section>
            ))
          ) : (
            <div className="insight-panel-empty">
              <Gauge aria-hidden />
              <span>No usage reported yet. Metrics appear after a successful provider refresh.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Usage widget: account-wide free-tier consumption with a known allowance,
// ranked by how close each metric is to its limit so risk is obvious at a glance.
// The whole panel opens a modal listing every reported metric, with no cap.
export function UsageHeadroomPanel({ rows }: { rows: FreeTierUsageRow[] }) {
  const [open, setOpen] = useState(false)

  const metered = rows
    .filter((row) => row.source === "measured" && row.percentUsed !== null && row.limit !== null)
    .sort((a, b) => (b.percentUsed ?? 0) - (a.percentUsed ?? 0))
    .slice(0, 6)
  const approaching = metered.filter((row) => (row.percentUsed ?? 0) >= 80).length
  const totalMetrics = rows.length

  return (
    <>
      <section className="insight-panel usage-headroom" aria-label="Free-tier headroom">
        <button
          type="button"
          className="usage-headroom-trigger"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          disabled={!totalMetrics}
        >
          <div className="insight-panel-head">
            <div>
              <p>Usage</p>
              <h2>Free-tier headroom</h2>
            </div>
            <span className={approaching ? "headroom-flag warn" : "headroom-flag ok"}>
              {approaching ? `${approaching} near limit` : "All healthy"}
            </span>
          </div>
          {metered.length ? (
            <div className="headroom-list">
              {metered.map((row) => {
                const pct = Math.round(row.percentUsed ?? 0)
                return (
                  <div className="headroom-row" key={`${row.provider}-${row.service}`} title={row.note}>
                    <div className="headroom-label">
                      <ProviderLogo provider={row.provider} />
                      <strong>{row.service}</strong>
                      <small>{quantity(row.used ?? 0)} / {quantity(row.limit ?? 0)} {row.unit}</small>
                    </div>
                    <div className="headroom-bar" aria-hidden>
                      <span className={`headroom-fill ${tone(pct)}`} style={{ width: `${Math.min(Math.max(pct, 2), 100)}%` }} />
                    </div>
                    <b className={`headroom-pct ${tone(pct)}`}>{pct}%</b>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="insight-panel-empty">
              <Gauge aria-hidden />
              <span>No metered free-tier allowances reported yet. Usage appears after a successful provider refresh.</span>
            </div>
          )}
          {totalMetrics ? (
            <span className="usage-headroom-more">
              View all {totalMetrics} metric{totalMetrics === 1 ? "" : "s"} →
            </span>
          ) : null}
        </button>
      </section>
      {open ? createPortal(<UsageDetailModal rows={rows} onClose={() => setOpen(false)} />, document.body) : null}
    </>
  )
}
