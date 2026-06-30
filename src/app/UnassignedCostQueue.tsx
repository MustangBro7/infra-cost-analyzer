"use client"

import * as React from "react"
import { CheckCircle2, FolderGit2, GitBranchPlus, ShieldAlert } from "lucide-react"
import { ACCOUNT_SENTINEL, SPLIT_EQUAL_SENTINEL } from "@/lib/costAttribution"

export interface AssignmentCandidate {
  fullName: string
  name: string
}

export interface AssignmentQueueItem {
  itemKey: string
  providerLabel: string
  serviceName: string
  resourceName: string
  cost: number
  currency: string
  reason: string
  confidence: "unassigned" | "inferred" | "manual"
  suggestedRepos: AssignmentCandidate[]
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
    minimumFractionDigits: Math.abs(value) > 0 && Math.abs(value) < 1000 ? 2 : 0,
    maximumFractionDigits: Math.abs(value) > 0 && Math.abs(value) < 1000 ? 2 : 0,
  }).format(value)
}

export function UnassignedCostQueue({
  items,
  repos,
}: {
  items: AssignmentQueueItem[]
  repos: AssignmentCandidate[]
}) {
  const [busy, setBusy] = React.useState<string | null>(null)
  const [done, setDone] = React.useState<Record<string, string>>({})
  const [error, setError] = React.useState<string | null>(null)
  const visible = items.filter((item) => !done[item.itemKey])

  async function assign(itemKey: string, target: string) {
    setBusy(itemKey)
    setError(null)
    try {
      const response = await fetch("/api/repos/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemKey, target }),
      })
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) throw new Error(payload.error ?? "Could not save assignment.")
      setDone((current) => ({ ...current, [itemKey]: target }))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save assignment.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="assignment-queue" aria-label="Unassigned and inferred costs">
      <div className="insight-panel-head">
        <div>
          <p>Attribution queue</p>
          <h2>{visible.length ? `${visible.length} cost ${visible.length === 1 ? "item" : "items"} to confirm` : "Costs are mapped"}</h2>
          <span>Fix account-level and inferred spend so each project total stays trustworthy.</span>
        </div>
        <FolderGit2 aria-hidden />
      </div>

      {error ? <div className="queue-error">{error}</div> : null}

      {visible.length === 0 ? (
        <div className="attention-clear">
          <CheckCircle2 aria-hidden />
          <span>No unassigned or inferred cost rows need review right now.</span>
        </div>
      ) : (
        <div className="assignment-list">
          {visible.slice(0, 12).map((item) => {
            const suggested = item.suggestedRepos.slice(0, 2)
            return (
              <article key={item.itemKey} className={`assignment-row ${item.confidence}`}>
                <div className="assignment-main">
                  <span className="attention-icon" aria-hidden>
                    <ShieldAlert />
                  </span>
                  <div>
                    <strong>{item.serviceName}</strong>
                    <span>{item.providerLabel} · {item.resourceName}</span>
                    <small>{item.reason}</small>
                  </div>
                </div>
                <div className="assignment-amount">
                  <b>{money(item.cost, item.currency)}</b>
                  <span>{item.confidence === "inferred" ? "confirm mapping" : "unassigned"}</span>
                </div>
                <div className="assignment-actions">
                  {repos.length > 1 ? (
                    <button type="button" disabled={busy === item.itemKey} onClick={() => assign(item.itemKey, SPLIT_EQUAL_SENTINEL)} title="Split evenly across all synced projects">
                      <GitBranchPlus aria-hidden />
                      Split equally
                    </button>
                  ) : null}
                  {suggested.map((repo) => (
                    <button key={repo.fullName} type="button" disabled={busy === item.itemKey} onClick={() => assign(item.itemKey, repo.fullName)}>
                      <FolderGit2 aria-hidden />
                      {repo.name}
                    </button>
                  ))}
                  <select
                    aria-label={`Assign ${item.serviceName}`}
                    disabled={busy === item.itemKey}
                    defaultValue=""
                    onChange={(event) => {
                      if (event.target.value) void assign(item.itemKey, event.target.value)
                    }}
                  >
                    <option value="">Assign to...</option>
                    {repos.map((repo) => (
                      <option key={repo.fullName} value={repo.fullName}>{repo.fullName}</option>
                    ))}
                    {repos.length > 1 ? <option value={SPLIT_EQUAL_SENTINEL}>Split equally across projects</option> : null}
                    <option value={ACCOUNT_SENTINEL}>Shared / account-level</option>
                  </select>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
