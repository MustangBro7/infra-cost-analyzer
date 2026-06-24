"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Activity, CalendarClock, Check, Pencil, Target, TrendingUp, Wallet } from "lucide-react"

function money(value: number) {
  const abs = Math.abs(value)
  const digits = abs > 0 && abs < 1000 ? 2 : 0
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
}

export function BudgetForecast({
  spent,
  projected,
  dailyRate,
  elapsedDays,
  totalDays,
  budget,
  monthLabel,
}: {
  spent: number
  projected: number
  dailyRate: number
  elapsedDays: number
  totalDays: number
  budget: number | null
  monthLabel: string
}) {
  const router = useRouter()
  const [editing, setEditing] = React.useState(false)
  const [value, setValue] = React.useState(budget != null ? String(budget) : "")
  const [busy, setBusy] = React.useState(false)
  const daysLeft = Math.max(totalDays - elapsedDays, 0)

  async function save(amount: number | null) {
    setBusy(true)
    try {
      await fetch("/api/budget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount }) })
      setEditing(false)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  const spentPct = budget && budget > 0 ? Math.min((spent / budget) * 100, 100) : 0
  const projPct = budget && budget > 0 ? Math.min((projected / budget) * 100, 100) : 0
  const overBudget = budget != null && projected > budget
  const remaining = budget != null ? budget - projected : 0
  const usedPctRaw = budget && budget > 0 ? Math.round((spent / budget) * 100) : 0

  return (
    <section className="budget-card" aria-label="Budget and forecast">
      <div className="budget-head">
        <div>
          <p>Budget &amp; forecast · {monthLabel}</p>
          <h2>
            {money(spent)} <span className="hero-sub">spent · {money(projected)} projected</span>
          </h2>
        </div>
        <span className="budget-icon">
          <Wallet aria-hidden />
        </span>
      </div>

      {budget != null && !editing ? (
        <>
          <div className="budget-track" role="img" aria-label={`Spent ${money(spent)} of ${money(budget)} budget`}>
            <span className={`budget-fill ${spent > budget ? "over" : ""}`} style={{ width: `${Math.max(spentPct, 1)}%` }} />
            <span className="budget-marker" style={{ left: `${projPct}%` }} title={`Projected ${money(projected)}`} />
          </div>
          <div className="budget-scale">
            <span>{money(spent)} spent ({usedPctRaw}%)</span>
            <span>{money(budget)} budget</span>
          </div>
          <div className={`budget-status ${overBudget ? "over" : "ok"}`}>
            <Target aria-hidden />
            <span>
              {overBudget ? (
                <>Projected <strong>{money(projected - budget)}</strong> over budget ({Math.round(((projected - budget) / budget) * 100)}%)</>
              ) : (
                <>On track — <strong>{money(Math.max(remaining, 0))}</strong> projected headroom</>
              )}
            </span>
            <button type="button" className="budget-edit" onClick={() => setEditing(true)}>
              <Pencil aria-hidden /> Edit
            </button>
          </div>
        </>
      ) : (
        <form
          className="budget-set"
          onSubmit={(event) => {
            event.preventDefault()
            const amount = Number(value)
            void save(Number.isFinite(amount) && amount > 0 ? amount : null)
          }}
        >
          <Target aria-hidden />
          <label>
            Monthly budget
            <span className="budget-input">
              $
              <input type="number" min="0" step="10" value={value} onChange={(e) => setValue(e.target.value)} placeholder="500" autoFocus={editing} />
            </span>
          </label>
          <button type="submit" className="command-button" disabled={busy}>
            <Check aria-hidden /> Save
          </button>
          {budget != null ? (
            <button type="button" className="ghost-button" disabled={busy} onClick={() => save(null)}>
              Clear
            </button>
          ) : null}
        </form>
      )}

      <div className="budget-stats">
        <article>
          <Activity aria-hidden />
          <span>Daily run rate</span>
          <strong>{money(dailyRate)}</strong>
          <small>avg per day so far</small>
        </article>
        <article>
          <TrendingUp aria-hidden />
          <span>Projected month-end</span>
          <strong>{money(projected)}</strong>
          <small>at current run rate</small>
        </article>
        <article>
          <CalendarClock aria-hidden />
          <span>Days left</span>
          <strong>{daysLeft}</strong>
          <small>{elapsedDays} of {totalDays} billed</small>
        </article>
      </div>
    </section>
  )
}
