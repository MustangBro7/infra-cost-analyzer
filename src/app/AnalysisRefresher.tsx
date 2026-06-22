"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, Check, Loader2, RefreshCw } from "lucide-react"

// The cron job refreshes snapshots independently. Avoid launching several slow
// provider APIs on virtually every visit; an interactive background refresh is
// only a fallback for data that has genuinely gone stale.
const STALE_AFTER_MS = 15 * 60_000
const IDLE_FALLBACK_MS = 2_000

function relativeTime(iso: string | null): string {
  if (!iso) return "never"
  const diff = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(diff)) return "unknown"
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export function AnalysisRefresher({
  repo,
  computedAt,
}: {
  repo: string | null
  computedAt: string | null
}) {
  const router = useRouter()
  const [status, setStatus] = React.useState<"idle" | "refreshing" | "done" | "error">("idle")
  const [error, setError] = React.useState<string | null>(null)
  const [lastSynced, setLastSynced] = React.useState<string | null>(computedAt)
  const startedRef = React.useRef(false)

  const runRefresh = React.useCallback(async () => {
    setStatus("refreshing")
    setError(null)
    try {
      const response = await fetch("/api/analyze/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo }),
      })
      const payload = (await response.json().catch(() => ({}))) as { computedAt?: string; error?: string }
      if (!response.ok) throw new Error(payload.error ?? `Refresh failed (${response.status})`)
      setLastSynced(payload.computedAt ?? new Date().toISOString())
      setStatus("done")
      router.refresh()
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : "Refresh failed")
    }
  }, [repo, router])

  React.useEffect(() => {
    if (startedRef.current) return
    const age = computedAt ? Date.now() - new Date(computedAt).getTime() : Infinity
    if (age < STALE_AFTER_MS) return

    startedRef.current = true
    const start = () => {
      if (document.visibilityState === "visible") void runRefresh()
    }
    const timeoutId = window.setTimeout(start, IDLE_FALLBACK_MS)
    return () => window.clearTimeout(timeoutId)
  }, [computedAt, runRefresh])

  return (
    <div className="analysis-refresher" role="status">
      {status === "refreshing" ? (
        <>
          <Loader2 className="spin" aria-hidden />
          <span>Updating live costs…</span>
        </>
      ) : status === "error" ? (
        <>
          <AlertTriangle aria-hidden />
          <span>Live update failed: {error}</span>
          <button type="button" className="refresher-retry" onClick={() => void runRefresh()}>
            Retry
          </button>
        </>
      ) : (
        <>
          {status === "done" ? <Check aria-hidden /> : <RefreshCw aria-hidden />}
          <span>Live costs synced {relativeTime(lastSynced)}</span>
          <button type="button" className="refresher-retry" onClick={() => void runRefresh()}>
            Refresh now
          </button>
        </>
      )}
    </div>
  )
}
