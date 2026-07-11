"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Check, Cloud, HardDriveDownload, Loader2, Radio, TerminalSquare, X } from "lucide-react"
import { CopyButton } from "./dashboard/CopyButton"

const AGENT_URL = "http://127.0.0.1:41414"
const REMOTE_BASE = "https://ambrium.io"
const RUNNER = "npx --yes github:MustangBro7/infra-cost-analyzer"
const SERVER_POLL_MS = 15_000

function relativeTime(iso: string | null): string {
  if (!iso) return "waiting for first sync"
  const diff = Math.max(Date.now() - new Date(iso).getTime(), 0)
  if (!Number.isFinite(diff)) return "sync time unavailable"
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

/**
 * "Pull from this device" (AI page): asks the local Ambrium usage agent
 * (`ambrium-connect serve`, loopback-only) to read this machine's Claude Code /
 * Codex logs + plan limits and push them, then re-renders the page. Local AI
 * data only exists on the device it was created on, so availability is
 * detected live — the probe only succeeds in a browser running on the machine
 * where the agent is listening. When no agent answers, the button degrades to
 * copyable setup commands instead of hiding.
 */
export function DevicePullButton({
  initialServerUpdatedAt = null,
  autoPull = false,
}: {
  initialServerUpdatedAt?: string | null
  autoPull?: boolean
}) {
  const router = useRouter()
  const [state, setState] = React.useState<"idle" | "pulling" | "done" | "empty" | "agent-missing" | "failed">("idle")
  const [detail, setDetail] = React.useState<string | null>(null)
  const [serverUpdatedAt, setServerUpdatedAt] = React.useState<string | null>(initialServerUpdatedAt)
  const [serverState, setServerState] = React.useState<"live" | "checking" | "offline">("checking")
  const revisionRef = React.useRef<string | null>(null)
  const pulledOnArrivalRef = React.useRef(false)

  const pollServer = React.useCallback(async () => {
    if (document.visibilityState !== "visible") return
    setServerState((current) => (revisionRef.current === null ? "checking" : current))
    try {
      const response = await fetch("/api/ai/live", { cache: "no-store" })
      const payload = (await response.json().catch(() => ({}))) as {
        revision?: string
        updatedAt?: string | null
        error?: string
      }
      if (!response.ok || typeof payload.revision !== "string") {
        throw new Error(payload.error ?? `Live check failed (${response.status})`)
      }
      const previousRevision = revisionRef.current
      revisionRef.current = payload.revision
      setServerUpdatedAt(payload.updatedAt ?? null)
      setServerState("live")
      if (previousRevision !== null && previousRevision !== payload.revision) router.refresh()
    } catch {
      setServerState("offline")
    }
  }, [router])

  async function pull() {
    setState("pulling")
    setDetail(null)
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 20_000)
      const request: RequestInit = { method: "POST", signal: controller.signal }
      let response: Response
      try {
        response = await fetch(`${AGENT_URL}/v1/refresh`, request)
      } catch (firstError) {
        if (!(firstError instanceof TypeError)) throw firstError
        // Chrome Local Network Access: an https page needs the loopback hint
        // (and may show a one-time permission prompt). Plain fetch is tried
        // first because the hint itself hard-fails on browsers/pages where the
        // request is already same-space (e.g. localhost dev).
        response = await fetch(`${AGENT_URL}/v1/refresh`, {
          ...request,
          ...({ targetAddressSpace: "loopback" } as RequestInit),
        })
      }
      clearTimeout(timer)
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        pushed?: Array<{ label: string; limits: number }>
        errors?: Array<{ label: string; error: string }>
        note?: string
        error?: string
      }
      if (!response.ok && !payload.ok) throw Object.assign(new Error(payload.error ?? "Agent refresh failed."), { agent: true })
      if ((payload.pushed?.length ?? 0) === 0) {
        setState("empty")
        setDetail(payload.note ?? payload.errors?.[0]?.error ?? "Nothing to push from this device.")
        return
      }
      setState("done")
      setDetail(payload.pushed!.map((tool) => tool.label).join(" + "))
      await pollServer()
      router.refresh()
    } catch (error) {
      // A network-level failure means nothing answered on the loopback port —
      // this device isn't running the agent. Anything else is a real error.
      if (error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")) {
        setState("agent-missing")
      } else {
        setState("failed")
        setDetail(error instanceof Error ? error.message : "Pull failed.")
      }
    }
  }

  React.useEffect(() => {
    void pollServer()
    const interval = window.setInterval(() => void pollServer(), SERVER_POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === "visible") void pollServer()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [pollServer])

  React.useEffect(() => {
    if (!autoPull || pulledOnArrivalRef.current) return
    pulledOnArrivalRef.current = true
    const lastUpdate = initialServerUpdatedAt ? new Date(initialServerUpdatedAt).getTime() : 0
    // A just-finished agent push is already current. Otherwise ask the local
    // loopback agent immediately, so opening the page does not wait for its next
    // one-minute scheduled pass.
    if (Number.isFinite(lastUpdate) && Date.now() - lastUpdate < SERVER_POLL_MS) return
    const timeout = window.setTimeout(() => {
      if (document.visibilityState === "visible") void pull()
    }, 350)
    return () => window.clearTimeout(timeout)
    // pull deliberately runs once per mount; its dependencies are stable page state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPull, initialServerUpdatedAt])

  return (
    <div className="amb-device-pull">
      <div className={`amb-live-sync-state ${serverState}`} role="status" aria-live="polite">
        <span className="amb-live-sync-icon" aria-hidden>
          {serverState === "checking" ? <Loader2 className="amb-link-spin" /> : serverState === "live" ? <Radio /> : <Cloud />}
        </span>
        <span>
          <strong>{serverState === "offline" ? "Live check interrupted" : "Live usage"}</strong>
          <small>
            {serverState === "offline"
              ? "Retrying when this tab is visible"
              : `Server updated ${relativeTime(serverUpdatedAt)} · checking every 15s`}
          </small>
        </span>
      </div>
      <div className="amb-device-pull-row">
        <button type="button" className="amb-btn-sm" disabled={state === "pulling"} onClick={() => void pull()}>
          {state === "pulling" ? <Loader2 className="amb-link-spin" aria-hidden /> : <HardDriveDownload size={13} aria-hidden />}
          {state === "pulling" ? "Syncing this device…" : "Sync this device now"}
        </button>
        {state === "done" ? (
          <span className="amb-device-pull-note ok">
            <Check size={12} aria-hidden /> Synced {detail} to the server
          </span>
        ) : null}
        {state === "empty" || state === "failed" ? (
          <span className="amb-device-pull-note err">
            <X size={12} aria-hidden /> {detail}
          </span>
        ) : null}
      </div>

      {state === "agent-missing" ? (
        <div className="amb-device-pull-help">
          <p>
            <TerminalSquare size={13} aria-hidden /> <strong>No Ambrium agent is running on this device.</strong> Local
            Claude Code / Codex usage only exists on the machine it was created on. Start the continuous agent there;
            it checks for changes every minute and the page picks them up automatically:
          </p>
          <div className="amb-device-pull-cmd">
            <span>Continuous sync</span>
            <code>{`AMBRIUM_API=${REMOTE_BASE} ${RUNNER} serve`}</code>
            <CopyButton text={`AMBRIUM_API=${REMOTE_BASE} ${RUNNER} serve`} />
          </div>
          <div className="amb-device-pull-cmd">
            <span>One-off push</span>
            <code>{`AMBRIUM_API=${REMOTE_BASE} ${RUNNER} --ai-only`}</code>
            <CopyButton text={`AMBRIUM_API=${REMOTE_BASE} ${RUNNER} --ai-only`} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
