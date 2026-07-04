import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { LinkSpinner } from "../LinkSpinner"

function money(value: number) {
  const abs = Math.abs(value)
  const digits = abs > 0 && abs < 1000 ? 2 : 0
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

/** Clean y-axis ceiling: 1/2/2.5/5 × 10^k just above `value`. */
function niceCeil(value: number): number {
  if (value <= 0) return 10
  const exp = Math.floor(Math.log10(value))
  const base = Math.pow(10, exp)
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (value <= m * base) return m * base
  }
  return 10 * base
}

export interface SpendHeroProps {
  monthName: string // "July"
  totalCost: number
  projected: number
  dailyRate: number
  flatTotal: number
  elapsedDays: number
  totalDays: number
  budget: number | null
  projectCount: number
  pacePct: number
  recoverable: number
  leakCount: number
}

/**
 * Projects-view hero: stat column (month to date, projection, budget +
 * breach estimate, recoverable link) beside a cumulative-spend chart for the
 * current month. Server-rendered inline SVG — actual spend as a solid line
 * with a light area wash, the run-rate projection as a dashed continuation,
 * and the budget as a dashed reference line with the breach point marked.
 */
export function SpendHero(props: SpendHeroProps) {
  const { totalCost, projected, elapsedDays, totalDays, budget, monthName } = props

  // ---- chart geometry ----
  const W = 640
  const H = 232
  const padL = 44
  const padR = 16
  const padT = 12
  const padB = 26
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const yMax = niceCeil(Math.max(projected, budget ?? 0, totalCost, 1) * 1.08)
  const x = (day: number) => padL + (Math.min(Math.max(day, 0), totalDays) / totalDays) * plotW
  const y = (usd: number) => padT + plotH - (Math.min(Math.max(usd, 0), yMax) / yMax) * plotH

  const todayX = x(elapsedDays)
  const actualPath = `M ${x(0)} ${y(0)} L ${todayX} ${y(totalCost)}`
  const areaPath = `M ${x(0)} ${y(0)} L ${todayX} ${y(totalCost)} L ${todayX} ${y(0)} Z`
  const monthDone = elapsedDays >= totalDays
  const projectedPath = monthDone ? null : `M ${todayX} ${y(totalCost)} L ${x(totalDays)} ${y(projected)}`

  // Day the projection crosses the budget (flat spend counted up-front).
  let breachDay: number | null = null
  if (budget != null && budget > 0 && projected > budget) {
    if (totalCost >= budget) breachDay = elapsedDays
    else if (props.dailyRate > 0) {
      breachDay = Math.min(Math.ceil((budget - props.flatTotal) / props.dailyRate), totalDays)
    }
  }
  const breachLabel =
    budget == null
      ? null
      : totalCost >= budget
        ? "over budget"
        : breachDay != null
          ? `breach ~${monthName.slice(0, 3)} ${breachDay}`
          : "on track"

  // Clean y ticks (quarters of the max, skipping 0).
  const ticks = [0.25, 0.5, 0.75, 1].map((f) => yMax * f)

  const showBudgetLine = budget != null && budget > 0 && budget <= yMax

  return (
    <section className="amb-hero" aria-label={`Cumulative spend for ${monthName}`}>
      <div className="amb-hero-stats">
        <div className="amb-hero-stat">
          <span className="amb-hero-label">Month to date</span>
          <strong className="amb-hero-value">{money(totalCost)}</strong>
          <span className="amb-hero-sub">
            day {elapsedDays} of {totalDays} · {props.projectCount} {props.projectCount === 1 ? "project" : "projects"}
          </span>
        </div>
        <div className="amb-hero-stat">
          <span className="amb-hero-label">Projected · {monthName}</span>
          <strong className="amb-hero-value accent">
            {money(projected)}
            {props.pacePct > 0 ? <em className="amb-hero-delta">▲ {props.pacePct}%</em> : null}
          </strong>
        </div>
        <div className="amb-hero-stat">
          <span className="amb-hero-label">Budget</span>
          {budget != null ? (
            <strong className="amb-hero-value">
              {money(budget)}
              <em className={`amb-hero-breach${totalCost >= budget || breachDay != null ? " bad" : " ok"}`}>{breachLabel}</em>
            </strong>
          ) : (
            <Link href="/dashboard?view=insights" prefetch={false} className="amb-hero-setbudget">
              Set a budget <LinkSpinner />
            </Link>
          )}
        </div>
        {props.recoverable > 0.005 ? (
          <Link href="/dashboard?view=leaks" prefetch={false} className="amb-hero-recoverable">
            <span>
              {money(props.recoverable)} recoverable
              <small>
                {props.leakCount} {props.leakCount === 1 ? "issue" : "issues"}
              </small>
            </span>
            <ArrowRight size={14} aria-hidden />
            <LinkSpinner />
          </Link>
        ) : null}
      </div>

      <div className="amb-hero-chart">
        <div className="amb-hero-chart-head">
          <span className="amb-hero-label">Cumulative spend · {monthName}</span>
          <div className="amb-hero-legend" aria-hidden>
            <span className="key actual" />
            <span>actual</span>
            {projectedPath ? (
              <>
                <span className="key projected" />
                <span>projected</span>
              </>
            ) : null}
            {showBudgetLine ? (
              <>
                <span className="key budget" />
                <span>budget</span>
              </>
            ) : null}
          </div>
        </div>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="amb-hero-svg"
          role="img"
          aria-label={`Spend so far ${money(totalCost)}; projected ${money(projected)} by month end${budget != null ? `; budget ${money(budget)}` : ""}`}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={padL} x2={W - padR} y1={y(tick)} y2={y(tick)} className="amb-hero-grid" />
              <text x={padL - 7} y={y(tick) + 3.5} textAnchor="end" className="amb-hero-tick">
                ${tick >= 1000 ? `${(tick / 1000).toLocaleString("en-US")}k` : tick.toLocaleString("en-US")}
              </text>
            </g>
          ))}
          <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} className="amb-hero-axis" />

          {showBudgetLine ? (
            <>
              <line x1={padL} x2={W - padR} y1={y(budget!)} y2={y(budget!)} className="amb-hero-budget" />
              <text x={W - padR} y={y(budget!) - 6} textAnchor="end" className="amb-hero-linelabel budget">
                budget {money(budget!)}
              </text>
            </>
          ) : null}

          <path d={areaPath} className="amb-hero-area" />
          <path d={actualPath} className="amb-hero-actual" />
          {projectedPath ? <path d={projectedPath} className="amb-hero-projected" /> : null}
          {projectedPath ? (
            <text
              x={x(totalDays)}
              y={Math.max(y(projected) - 8, 11)}
              textAnchor="end"
              className="amb-hero-linelabel projected"
            >
              proj {money(projected)}
            </text>
          ) : null}

          {showBudgetLine && breachDay != null && breachDay > elapsedDays ? (
            <circle cx={x(breachDay)} cy={y(budget!)} r={4} className="amb-hero-breachdot" />
          ) : null}

          <line x1={todayX} x2={todayX} y1={padT} y2={y(0)} className="amb-hero-today" />
          <circle cx={todayX} cy={y(totalCost)} r={4.5} className="amb-hero-dot" />

          <text x={padL} y={H - 8} className="amb-hero-tick">
            {monthName.slice(0, 3)} 1
          </text>
          {!monthDone && elapsedDays / totalDays > 0.12 && elapsedDays / totalDays < 0.88 ? (
            <text x={todayX} y={H - 8} textAnchor="middle" className="amb-hero-tick today">
              today
            </text>
          ) : null}
          <text x={W - padR} y={H - 8} textAnchor="end" className="amb-hero-tick">
            {monthName.slice(0, 3)} {totalDays}
          </text>
        </svg>
      </div>
    </section>
  )
}
