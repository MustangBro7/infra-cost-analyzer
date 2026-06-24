"use client"

import * as React from "react"
import { Clock, ClipboardCopy, RefreshCw, TerminalSquare } from "lucide-react"
import type { Provider } from "@/lib/types"
import { ProviderLogo } from "./ProviderLogo"

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

const AI_PROVIDERS: Array<{ provider: Provider; label: string }> = [
  { provider: "anthropic", label: "Claude Code" },
  { provider: "openai", label: "Codex" },
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

export function AiSyncPanel({ initialState }: { initialState: PublicState }) {
  const [origin, setOrigin] = React.useState("https://ambrium.io")
  const [copied, setCopied] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin)
  }, [])

  const localAi = AI_PROVIDERS.map(({ provider, label }) => {
    const conn = initialState.connections[provider]
    const isLocal = conn?.status === "connected" && (conn.metadata as { source?: string })?.source === "local"
    return { provider, label, connected: isLocal, lastVerifiedAt: conn?.lastVerifiedAt ?? null }
  })
  const anyConnected = localAi.some((entry) => entry.connected)

  const connectCmd = `AMBRIUM_API=${origin} npx --yes github:MustangBro7/infra-cost-analyzer --ai-only`

  // One-liner: bakes the absolute npx + node dir into a launchd agent that runs
  // every 6h. Run it in your terminal (where node is on PATH) once you've paired.
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
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500)
    })
  }

  return (
    <section className="provider-connect-panel ai-sync-panel" aria-label="Automatic AI usage sync">
      <div className="provider-connect-head">
        <div>
          <p>AI usage · keep it fresh</p>
          <h2>Automatic AI sync</h2>
        </div>
        <RefreshCw aria-hidden />
      </div>

      <p className="ai-sync-intro">
        Personal Claude/ChatGPT/Cursor plans expose no cost API, so Ambrium reads usage from your local Claude Code &amp;
        Codex logs. The dashboard re-renders your last push every ~6h on its own, but picking up <strong>new</strong> usage
        needs a quick job on your machine (we can&apos;t read your disk from the cloud). Set it up once — it runs
        browser-free after the first pairing.
      </p>

      {anyConnected ? (
        <div className="ai-sync-status">
          {localAi
            .filter((entry) => entry.connected)
            .map((entry) => (
              <div key={entry.provider} className="ai-sync-status-row">
                <ProviderLogo provider={entry.provider} />
                <strong>{entry.label}</strong>
                <span className="ai-sync-ago">
                  <Clock aria-hidden /> last synced {timeAgo(entry.lastVerifiedAt)}
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
    </section>
  )
}
