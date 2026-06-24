"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { ArrowUpRight, Clock, ClipboardCopy, Loader2, RefreshCw, TerminalSquare } from "lucide-react"
import type { Provider } from "@/lib/types"
import { ProviderLogo } from "./ProviderLogo"

const USAGE_URL: Partial<Record<Provider, string>> = {
  anthropic: "https://claude.ai/new#settings/usage",
  openai: "https://chatgpt.com/codex/cloud/settings/analytics#usage",
  cursor: "https://cursor.com/dashboard",
}

type PublicConnection = {
  provider: Provider
  status: string
  accountLabel: string | null
  lastVerifiedAt: string | null
  metadata: Record<string, unknown>
}

interface PublicState {
  connections: Record<string, PublicConnection | null>
}

const AI_TOOLS: Array<{ provider: Provider; label: string; local: boolean }> = [
  { provider: "anthropic", label: "Claude", local: true },
  { provider: "openai", label: "OpenAI / Codex", local: true },
  { provider: "cursor", label: "Cursor", local: false },
]

function timeAgo(iso: string | null): string {
  if (!iso) return "never"
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return "never"
  const mins = Math.round(ms / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

async function jsonRequest(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  const payload = (await res.json().catch(() => ({}))) as { error?: unknown }
  if (!res.ok) throw new Error(typeof payload.error === "string" ? payload.error : `Request failed with ${res.status}`)
  return payload
}

export function AiSyncPanel({ initialState }: { initialState: PublicState }) {
  const router = useRouter()
  const [origin, setOrigin] = React.useState("https://ambrium.io")
  const [copied, setCopied] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin)
  }, [])

  const tools = AI_TOOLS.map(({ provider, label, local }) => {
    const conn = initialState.connections[provider]
    const meta = (conn?.metadata ?? {}) as {
      source?: string
      showApi?: boolean
      subscriptionUsdOverride?: number
      localUsage?: { subscriptionUsd?: number }
    }
    return {
      provider,
      label,
      local,
      connected: conn?.status === "connected",
      source: meta.source ?? null,
      hasLocal: meta.source === "local" || meta.source === "both",
      hasApi: meta.source === "api" || meta.source === "both",
      showApi: meta.showApi !== false,
      planCost: meta.subscriptionUsdOverride ?? meta.localUsage?.subscriptionUsd ?? null,
      lastVerifiedAt: conn?.lastVerifiedAt ?? null,
    }
  })
  const connectedTools = tools.filter((tool) => tool.connected)
  const localConnected = connectedTools.filter((tool) => tool.hasLocal)

  const [planCostInput, setPlanCostInput] = React.useState<Record<string, string>>({})
  const costValue = (provider: string, fallback: number | null) =>
    planCostInput[provider] ?? (fallback != null ? String(fallback) : "")

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label)
    setMessage(null)
    setError(null)
    try {
      await task()
      await jsonRequest("/api/analyze/refresh", { repo: new URLSearchParams(window.location.search).get("repo") }).catch(() => {})
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.")
    } finally {
      setBusy(null)
    }
  }

  const connectCmd = `AMBRIUM_API=${origin} npx --yes github:MustangBro7/infra-cost-analyzer --ai-only`
  const macInstall = `NPX="$(command -v npx)"; ND="$(dirname "$(command -v node)")"; P="$HOME/Library/LaunchAgents/io.ambrium.ai-usage.plist"; mkdir -p "$HOME/Library/LaunchAgents"; cat > "$P" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.ambrium.ai-usage</string>
<key>EnvironmentVariables</key><dict><key>AMBRIUM_API</key><string>${origin}</string><key>PATH</key><string>$ND:/usr/bin:/bin</string></dict>
<key>ProgramArguments</key><array><string>$NPX</string><string>--yes</string><string>github:MustangBro7/infra-cost-analyzer</string><string>--ai-only</string></array>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>21600</integer>
<key>StandardOutPath</key><string>/tmp/ambrium-ai-usage.log</string><key>StandardErrorPath</key><string>/tmp/ambrium-ai-usage.log</string>
</dict></plist>
EOF
launchctl unload "$P" 2>/dev/null; launchctl load "$P" && echo "Ambrium auto-sync installed (every 6h)"`
  const linuxInstall = `( crontab -l 2>/dev/null | grep -v ambrium-ai-usage; echo "0 */6 * * * AMBRIUM_API=${origin} \\$(command -v npx) --yes github:MustangBro7/infra-cost-analyzer --ai-only >> /tmp/ambrium-ai-usage.log 2>&1 # ambrium-ai-usage" ) | crontab - && echo "Ambrium auto-sync installed (every 6h)"`

  function copy(key: string, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500)
    })
  }

  return (
    <section className="provider-connect-panel ai-sync-panel" aria-label="AI usage settings and sync">
      <div className="provider-connect-head">
        <div>
          <p>AI usage · settings &amp; sync</p>
          <h2>AI cost &amp; auto-sync</h2>
        </div>
        <RefreshCw aria-hidden />
      </div>

      {/* Per-tool cost settings: plan price (e.g. $200 Max/Pro) + show-API toggle. */}
      {connectedTools.length > 0 ? (
        <div className="ai-settings-list">
          {connectedTools.map((tool) => (
            <div key={tool.provider} className="ai-settings-row">
              <div className="ai-settings-id">
                <ProviderLogo provider={tool.provider} />
                <div>
                  <strong>{tool.label}</strong>
                  <small>
                    {tool.source === "both" ? "Subscription + live API" : tool.hasApi ? "Live API" : "Subscription (local)"} ·{" "}
                    <Clock aria-hidden /> {timeAgo(tool.lastVerifiedAt)}
                    {USAGE_URL[tool.provider] ? (
                      <>
                        {" · "}
                        <a className="ai-usage-link" href={USAGE_URL[tool.provider]} target="_blank" rel="noreferrer">
                          official usage <ArrowUpRight aria-hidden />
                        </a>
                      </>
                    ) : null}
                  </small>
                </div>
              </div>
              {tool.hasLocal ? (
                <form
                  className="ai-settings-cost"
                  onSubmit={(event) => {
                    event.preventDefault()
                    run(`cost-${tool.provider}`, async () => {
                      await jsonRequest("/api/ai/settings", {
                        provider: tool.provider,
                        subscriptionUsd: Number(costValue(tool.provider, tool.planCost)) || 0,
                      })
                      setMessage(`${tool.label} monthly plan cost saved.`)
                    })
                  }}
                >
                  <label>
                    Monthly plan
                    <span className="ai-cost-input">
                      $
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={costValue(tool.provider, tool.planCost)}
                        onChange={(e) => setPlanCostInput((p) => ({ ...p, [tool.provider]: e.target.value }))}
                        placeholder="20"
                      />
                    </span>
                  </label>
                  <button type="submit" className="command-button" disabled={Boolean(busy)}>
                    {busy === `cost-${tool.provider}` ? <Loader2 className="spin" aria-hidden /> : null}
                    Save
                  </button>
                </form>
              ) : null}
              {tool.source === "both" ? (
                <label className="ai-settings-toggle">
                  <input
                    type="checkbox"
                    checked={tool.showApi}
                    disabled={Boolean(busy)}
                    onChange={(e) =>
                      run(`api-${tool.provider}`, async () => {
                        await jsonRequest("/api/ai/settings", { provider: tool.provider, showApi: e.target.checked })
                        setMessage(`${tool.label} live API usage ${e.target.checked ? "shown" : "hidden"}.`)
                      })
                    }
                  />
                  Also show live API usage
                </label>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <p className="ai-sync-intro">
        Personal Claude/ChatGPT/Cursor plans expose no cost API, so Ambrium reads usage from your local Claude Code &amp;
        Codex logs. Set the monthly plan price above (e.g. $200 for Max/Pro). If you also have an API org, paste an Admin
        key on the cards above and tick &quot;show live API usage&quot; to add your real pay-per-use spend too. The
        dashboard re-renders your last push every ~6h; picking up <strong>new</strong> usage needs a quick job on your
        machine — set it up once, it runs browser-free after the first pairing.
      </p>

      {localConnected.length > 0 ? (
        <div className="ai-sync-status">
          {localConnected.map((tool) => (
            <div key={tool.provider} className="ai-sync-status-row">
              <ProviderLogo provider={tool.provider} />
              <strong>{tool.label}</strong>
              <span className="ai-sync-ago">
                <Clock aria-hidden /> last synced {timeAgo(tool.lastVerifiedAt)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <ol className="ai-sync-steps">
        <li>
          <div className="ai-sync-step-head">
            <span className="ai-sync-num">1</span>
            <strong>Pair once</strong>
            <small>Opens your browser to approve. Saves the pairing for 30 days.</small>
          </div>
          <div className="cli-command">
            <span>Run in your terminal</span>
            <code>{connectCmd}</code>
          </div>
          <button type="button" className="ghost-button" onClick={() => copy("connect", connectCmd)}>
            <ClipboardCopy aria-hidden /> {copied === "connect" ? "Copied" : "Copy command"}
          </button>
        </li>
        <li>
          <div className="ai-sync-step-head">
            <span className="ai-sync-num">2</span>
            <strong>Turn on auto-sync</strong>
            <small>Installs a background job that re-reads &amp; pushes your usage every 6 hours.</small>
          </div>
          <div className="cli-command">
            <span>macOS — paste &amp; run</span>
            <code>{macInstall}</code>
          </div>
          <div className="custom-agent-actions">
            <button type="button" className="ghost-button" onClick={() => copy("mac", macInstall)}>
              <ClipboardCopy aria-hidden /> {copied === "mac" ? "Copied" : "Copy macOS installer"}
            </button>
            <button type="button" className="ghost-button" onClick={() => copy("linux", linuxInstall)}>
              <TerminalSquare aria-hidden /> {copied === "linux" ? "Copied" : "Copy Linux (cron)"}
            </button>
          </div>
        </li>
      </ol>

      <p className="ai-sync-foot">
        To stop it later: <code>launchctl unload ~/Library/LaunchAgents/io.ambrium.ai-usage.plist</code> (macOS) or remove
        the <code>ambrium-ai-usage</code> crontab line (Linux).
      </p>

      {message ? <div className="flow-message success">{message}</div> : null}
      {error ? <div className="flow-message error">{error}</div> : null}
    </section>
  )
}
