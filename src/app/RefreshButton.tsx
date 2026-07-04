"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2, RefreshCw } from "lucide-react"

/**
 * Header "Refresh" action. Replaces the old full-page <a href> reload (which
 * gave no feedback and didn't actually recompute anything): POSTs a live
 * snapshot refresh, spins while it runs, then re-renders the server page.
 */
export function RefreshButton({ repo }: { repo: string | null }) {
  const router = useRouter()
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  async function run() {
    setBusy(true)
    setFailed(false)
    document.documentElement.dataset.refreshing = "1"
    try {
      const response = await fetch("/api/analyze/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo }),
      })
      if (!response.ok) throw new Error(String(response.status))
      router.refresh()
    } catch {
      setFailed(true)
    } finally {
      delete document.documentElement.dataset.refreshing
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      className="amb-btn-dark"
      disabled={busy}
      onClick={() => void run()}
      title={failed ? "Refresh failed — try again" : "Pull live costs and usage now"}
    >
      {busy ? <Loader2 className="amb-link-spin" aria-hidden /> : <RefreshCw aria-hidden width={14} height={14} />}
      {busy ? "Refreshing…" : failed ? "Retry refresh" : "Refresh"}
    </button>
  )
}
