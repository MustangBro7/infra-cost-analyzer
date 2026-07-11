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
    // Signal a refresh is in flight so empty data widgets can render skeletons
    // (instead of a misleading 0) until the fresh snapshot lands.
    document.documentElement.dataset.refreshing = "1"
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
    } finally {
      delete document.documentElement.dataset.refreshing
    }
  }, [repo, router])

  React.useEffect(() => {
    if (startedRef.current) return
    const age = computedAt ? Date.now() - new Date(computedAt).getTime() : Infinity
    if (age < STALE_AFTER_MS) return

    startedRef.current = true
    // Refresh once the tab is actually visible. The dashboard is often opened in
    // a background tab, so checking visibility only once (and giving up) left
    // stale data on screen until a manual refresh — wait for the tab instead.
    const start = () => {
      if (document.visibilityState !== "visible") return false
      void runRefresh()
      return true
    }
    const onVisible = () => {
      if (start()) document.removeEventListener("visibilitychange", onVisible)
    }
    const timeoutId = window.setTimeout(() => {
      if (!start()) document.addEventListener("visibilitychange", onVisible)
    }, IDLE_FALLBACK_MS)
    return () => {
      window.clearTimeout(timeoutId)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [computedAt, runRefresh])

  const label = status === "refreshing" ? "Updating" : status === "error" ? "Retry" : "Refresh"
  const detail =
    status === "refreshing"
      ? "Pulling latest usage"
      : status === "error"
        ? "Live update failed"
        : `Costs synced ${relativeTime(lastSynced)}`

  return (
    <button
      type="button"
      className={`analysis-refresher ${status}`}
      disabled={status === "refreshing"}
      onClick={() => void runRefresh()}
      aria-label={status === "error" ? `Live update failed: ${error}. Retry refresh` : `${label}. ${detail}`}
      title={status === "error" ? `Live update failed: ${error}` : "Pull live costs and usage now"}
    >
      {status === "refreshing" ? (
        <Loader2 className="spin" aria-hidden />
      ) : status === "error" ? (
        <AlertTriangle aria-hidden />
      ) : status === "done" ? (
        <Check aria-hidden />
      ) : (
        <RefreshCw aria-hidden />
      )}
      <span className="analysis-refresher-copy">
        <strong>{label}</strong>
        <small aria-live="polite">{detail}</small>
      </span>
    </button>
  )
}
