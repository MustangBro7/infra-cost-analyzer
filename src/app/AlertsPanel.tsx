"use client"

import * as React from "react"
import Link from "next/link"
import { BellRing, Mail, Send } from "lucide-react"
import type { AlertSettings } from "@/lib/types"

/**
 * Email alert preferences (Insights view): master switch for threshold alerts,
 * weekly digest toggle, and a test-send button. Free plan sees the controls
 * disabled with an upgrade prompt — delivery is an Indie feature.
 */
export function AlertsPanel({
  plan,
  initialSettings,
}: {
  plan: "free" | "indie"
  initialSettings: AlertSettings | null
}) {
  const [settings, setSettings] = React.useState<AlertSettings>(
    initialSettings ?? { enabled: true, digest: "weekly" }
  )
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const indie = plan === "indie"

  async function save(next: AlertSettings) {
    const previous = settings
    setSettings(next)
    setBusy(true)
    setNotice(null)
    try {
      const response = await fetch("/api/alerts/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(payload.error ?? "Failed to save alert settings.")
      }
    } catch (error) {
      setSettings(previous)
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Failed to save." })
    } finally {
      setBusy(false)
    }
  }

  async function sendTest() {
    setBusy(true)
    setNotice(null)
    try {
      const response = await fetch("/api/alerts/test", { method: "POST" })
      const payload = (await response.json().catch(() => ({}))) as { error?: string; to?: string }
      if (!response.ok) throw new Error(payload.error ?? "Test email failed.")
      setNotice({ kind: "ok", text: `Test email sent to ${payload.to ?? "your account email"}.` })
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Test email failed." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="amb-card amb-alerts" aria-label="Email alerts">
      <div className="amb-alerts-head">
        <span className="amb-alerts-icon" aria-hidden>
          <BellRing size={17} />
        </span>
        <div>
          <p className="amb-alerts-title">Email alerts</p>
          <p className="amb-alerts-sub">
            Budget thresholds (50 / 80 / 100%), forecast-over-budget, and free-tier runway ≥ 80% — sent to your
            account email as they trip, once per month each.
          </p>
        </div>
      </div>

      {!indie ? (
        <div className="amb-alerts-upsell">
          <strong>Alerts are an Indie feature.</strong>
          <span>Upgrade for automatic refresh, threshold alerts, and the weekly digest.</span>
          <Link href="/pricing" prefetch={false} className="amb-btn-sm-dark">
            Upgrade — $5/month
          </Link>
        </div>
      ) : null}

      <div className="amb-alerts-controls">
        <label className={`amb-alerts-toggle${!indie ? " disabled" : ""}`}>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={busy || !indie}
            onChange={(event) => void save({ ...settings, enabled: event.target.checked })}
          />
          <span>Threshold alerts</span>
        </label>
        <label className={`amb-alerts-toggle${!indie ? " disabled" : ""}`}>
          <input
            type="checkbox"
            checked={settings.digest === "weekly"}
            disabled={busy || !indie}
            onChange={(event) => void save({ ...settings, digest: event.target.checked ? "weekly" : "off" })}
          />
          <span>
            <Mail size={13} aria-hidden /> Weekly digest
          </span>
        </label>
        <button type="button" className="amb-btn-sm" disabled={busy || !indie} onClick={() => void sendTest()}>
          <Send size={13} aria-hidden /> Send test email
        </button>
      </div>

      {notice ? <p className={`amb-alerts-notice ${notice.kind}`}>{notice.text}</p> : null}
    </section>
  )
}
