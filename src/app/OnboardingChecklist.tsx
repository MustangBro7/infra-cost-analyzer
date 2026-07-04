"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Check, ChevronRight, Loader2, RefreshCw } from "lucide-react"
import { LinkSpinner } from "./LinkSpinner"

export interface ChecklistState {
  repos: boolean
  provider: boolean
  refresh: boolean
  cost: boolean
}

/**
 * First-run progress card pinned to the top of the Projects view until real
 * data flows (all four steps complete), at which point the server stops
 * rendering it. Steps 1/2 navigate to the Connect view; step 3 triggers a live
 * refresh right here; step 4 resolves on its own once a refresh maps cost or
 * usage.
 */
export function OnboardingChecklist({ steps }: { steps: ChecklistState }) {
  const router = useRouter()
  const [refreshing, setRefreshing] = React.useState(false)
  const [refreshError, setRefreshError] = React.useState<string | null>(null)

  const done = [steps.repos, steps.provider, steps.refresh, steps.cost].filter(Boolean).length

  async function runRefresh() {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const response = await fetch("/api/analyze/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: null }),
      })
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) throw new Error(payload.error ?? `Refresh failed (${response.status})`)
      router.refresh()
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Refresh failed.")
    } finally {
      setRefreshing(false)
    }
  }

  const items: Array<{
    key: keyof ChecklistState
    title: string
    detail: string
    action: React.ReactNode
  }> = [
    {
      key: "repos",
      title: "Choose GitHub repos",
      detail: "Authorize the GitHub App on the repositories you want cost-mapped.",
      action: (
        <Link href="/dashboard?view=connect&connectTab=credentials" prefetch={false} className="amb-btn-sm-dark">
          Choose repos <LinkSpinner />
        </Link>
      ),
    },
    {
      key: "provider",
      title: "Connect a billing provider",
      detail: "Link Vercel, Cloudflare, AWS, GCP, or an AI tool — read-only.",
      action: (
        <Link href="/dashboard?view=connect" prefetch={false} className="amb-btn-sm-dark">
          Connect <LinkSpinner />
        </Link>
      ),
    },
    {
      key: "refresh",
      title: "Run your first refresh",
      detail: "Pull live cost and usage from everything you connected.",
      action: (
        <button type="button" className="amb-btn-sm-dark" disabled={refreshing} onClick={() => void runRefresh()}>
          {refreshing ? <Loader2 className="amb-link-spin" aria-hidden /> : <RefreshCw size={12} aria-hidden />}
          {refreshing ? "Refreshing…" : "Refresh now"}
        </button>
      ),
    },
    {
      key: "cost",
      title: "See your first mapped cost",
      detail: "Costs and free-tier usage appear here, attributed to your projects.",
      action: <span className="amb-check-wait">appears after a refresh finds data</span>,
    },
  ]

  return (
    <section className="amb-card amb-checklist" aria-label="Getting started checklist">
      <div className="amb-checklist-head">
        <div>
          <p className="amb-checklist-title">Get your real numbers flowing</p>
          <p className="amb-checklist-sub">
            {done} of {items.length} done — this card disappears once live data is mapped.
          </p>
        </div>
        <div className="amb-checklist-progress" role="img" aria-label={`${done} of ${items.length} steps complete`}>
          {items.map((item) => (
            <span key={item.key} className={steps[item.key] ? "seg done" : "seg"} />
          ))}
        </div>
      </div>
      <ol className="amb-checklist-steps">
        {items.map((item, index) => {
          const complete = steps[item.key]
          // The first incomplete step is the active one; later steps stay muted.
          const active = !complete && items.slice(0, index).every((prev) => steps[prev.key])
          return (
            <li key={item.key} className={complete ? "done" : active ? "active" : "pending"}>
              <span className="amb-check-mark" aria-hidden>
                {complete ? <Check size={12} /> : index + 1}
              </span>
              <div className="amb-check-body">
                <strong>{item.title}</strong>
                <span>{item.detail}</span>
                {item.key === "refresh" && refreshError ? <em className="amb-check-error">{refreshError}</em> : null}
              </div>
              <div className="amb-check-action">
                {complete ? (
                  <span className="amb-check-done-label">Done</span>
                ) : active ? (
                  item.action
                ) : (
                  <ChevronRight size={13} className="amb-check-later" aria-hidden />
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
