"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { ChevronDown } from "lucide-react"
import { LinkSpinner } from "../LinkSpinner"

// View-model for one project row. Built server-side from real cost/usage data
// (see buildIndieProjects) and passed in pre-formatted so this stays a thin,
// purely-presentational interactive layer (expand + sort).
export interface ProjectRowVM {
  id: string
  repo: string
  href: string
  free: boolean
  mtdValue: number
  mtdLabel: string
  mtdColor: string
  projDisplay: string
  confLabel: string
  confColor: string
  dots: Array<{ color: string; monogram: string; name: string }>
  segments: Array<{ color: string; width: string }>
  projMarker: string
  // Real 60×18 sparkline polyline points, or null when there's no history.
  sparkPoints: string | null
  sparkColor: string
  runwayLabel: string
  runwayPctLabel: string
  runwayFill: string
  runwayColor: string
  desc: string
  evidence: string
  breakdown: Array<{ name: string; color: string; monogram: string; cost: string; width: string }>
}

type SortKey = "cost" | "name"

const COLS = "amb-trow"

export function ProjectsTable({
  projects,
  totalLabel,
  defaultExpanded,
  costHeader = "Month to date",
}: {
  projects: ProjectRowVM[]
  totalLabel: string
  defaultExpanded?: string | null
  // Header of the cost column — "Month to date" by default, or the selected
  // date-range label (e.g. "Q2 2026") when the report is range-filtered.
  costHeader?: string
}) {
  const [sortBy, setSortBy] = useState<SortKey>("cost")
  const [expanded, setExpanded] = useState<string | null>(defaultExpanded ?? null)

  const sorted = useMemo(() => {
    const list = projects.slice()
    if (sortBy === "name") {
      list.sort((a, b) => a.id.localeCompare(b.id))
    } else {
      // Free/quiet projects float to the top (they need attention before they
      // start billing), then the rest by month-to-date spend descending.
      list.sort((a, b) => {
        const af = a.free ? 1 : 0
        const bf = b.free ? 1 : 0
        if (af !== bf) return bf - af
        return b.mtdValue - a.mtdValue || a.id.localeCompare(b.id)
      })
    }
    return list
  }, [projects, sortBy])

  return (
    <div>
      <div className="amb-list-toolbar">
        <div className="amb-list-title">
          All projects <span>{projects.length}</span>
        </div>
        <div className="amb-sort">
          <span>Sort</span>
          <div className="amb-seg">
            <button type="button" className={sortBy === "cost" ? "on" : ""} onClick={() => setSortBy("cost")}>
              Cost
            </button>
            <button type="button" className={sortBy === "name" ? "on" : ""} onClick={() => setSortBy("name")}>
              Name
            </button>
          </div>
        </div>
      </div>

      <div className="amb-table">
        <div className={`${COLS} amb-thead`}>
          <div>Project</div>
          <div>Stack</div>
          <div>Spend &amp; projection</div>
          <div>Trend</div>
          <div className="amb-tr-right">{costHeader}</div>
          <div />
        </div>

        {sorted.length === 0 ? (
          <div className="amb-empty">No projects yet. Connect GitHub and a provider to map repos to running infrastructure.</div>
        ) : (
          sorted.map((p) => {
            const open = expanded === p.id
            return (
              <div key={p.repo} className="amb-project-entry">
                <div
                  className={`${COLS} body${p.free ? " free" : ""}${open ? " open" : ""}`}
                  onClick={() => setExpanded(open ? null : p.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      setExpanded(open ? null : p.id)
                    }
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="amb-proj-id">
                      <span className="amb-proj-name">{p.id}</span>
                      <span className="amb-conf" style={{ color: p.confColor }}>
                        {p.confLabel}
                      </span>
                    </div>
                    <div className="amb-proj-repo">{p.repo}</div>
                  </div>

                  <div className="amb-dots">
                    {p.dots.map((d, i) => (
                      <span key={i} className="amb-mono-badge" style={{ background: d.color }} title={d.name}>
                        {d.monogram}
                      </span>
                    ))}
                  </div>

                  <div>
                    {p.free ? (
                      <div>
                        <div className="amb-runway-head">
                          <span>{p.runwayLabel}</span>
                          {p.runwayPctLabel ? <span style={{ color: p.runwayColor }}>{p.runwayPctLabel}</span> : null}
                        </div>
                        {p.runwayPctLabel ? (
                          <div className="amb-runway-track">
                            <div className="amb-runway-fill" style={{ width: p.runwayFill, background: p.runwayColor }} />
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="amb-spendbar">
                        <div className="amb-spendbar-track">
                          {p.segments.map((s, i) => (
                            <div key={i} className="amb-spendbar-seg" style={{ width: s.width, background: s.color }} />
                          ))}
                        </div>
                        <div className="amb-spendbar-marker" style={{ left: p.projMarker }} title="projected" />
                      </div>
                    )}
                  </div>

                  <div className="amb-trend">
                    {p.sparkPoints ? (
                      <svg width="58" height="18" viewBox="0 0 60 18" className="amb-spark" style={{ overflow: "visible" }}>
                        <polyline
                          points={p.sparkPoints}
                          fill="none"
                          stroke={p.sparkColor}
                          strokeWidth="1.6"
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      </svg>
                    ) : (
                      <span className="amb-trend-empty">—</span>
                    )}
                  </div>

                  <div className="amb-tr-mtd">
                    <strong style={{ color: p.mtdColor }}>{p.mtdLabel}</strong>
                    <small>{p.projDisplay}</small>
                  </div>

                  <div className={`amb-chev${open ? " open" : ""}`}>
                    <ChevronDown aria-hidden />
                  </div>
                </div>

                {open ? (
                  <div className="amb-expand">
                    <div>
                      <div className="amb-expand-label">Cost by provider</div>
                      {p.breakdown.length === 0 ? (
                        <div className="amb-expand-desc">No billed provider cost is assigned to this project yet.</div>
                      ) : (
                        p.breakdown.map((b, i) => (
                          <div key={i} className="amb-break-row">
                            <span className="amb-mono-badge" style={{ background: b.color }}>
                              {b.monogram}
                            </span>
                            <span className="amb-break-name">{b.name}</span>
                            <div className="amb-break-bar">
                              <i style={{ width: b.width, background: b.color }} />
                            </div>
                            <span className="amb-break-cost">{b.cost}</span>
                          </div>
                        ))
                      )}
                    </div>
                    <div>
                      <div className="amb-expand-label">Mapping</div>
                      <div className="amb-expand-desc">{p.desc}</div>
                      <div className="amb-expand-ev">{p.evidence}</div>
                      <div className="amb-btn-row">
                        <Link href={p.href} prefetch={false} className="amb-btn-sm-dark">
                          Open project <LinkSpinner />
                        </Link>
                        <Link href={`${p.href}#accounts`} prefetch={false} className="amb-btn-sm">
                          Link accounts <LinkSpinner />
                        </Link>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            )
          })
        )}

        <div className="amb-table-total">
          <div className="lbl">Total</div>
          <div />
          <div />
          <div />
          <div className="val">{totalLabel}</div>
          <div />
        </div>
      </div>
    </div>
  )
}
