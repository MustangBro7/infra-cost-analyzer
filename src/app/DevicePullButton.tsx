"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, Check, Cloud, HardDriveDownload, Loader2, Radio, TerminalSquare, X } from "lucide-react"
import { aiAgentCommands, diagnoseAiAgent, type AiAgentRecovery } from "@/lib/aiAgentSetup"
import { CopyButton } from "./dashboard/CopyButton"

const AGENT_URL = "http://127.0.0.1:41414"
const SERVER_POLL_MS = 15_000

interface LocalAgentStatus {
  autoSync?: boolean
  lastSync?: { error?: string } | null
}

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
  const [recovery, setRecovery] = React.useState<AiAgentRecovery | null>(null)
  const [origin, setOrigin] = React.useState("https://ambrium.io")
  const [serverUpdatedAt, setServerUpdatedAt] = React.useState<string | null>(initialServerUpdatedAt)
  const [serverState, setServerState] = React.useState<"live" | "checking" | "offline">("checking")
  const revisionRef = React.useRef<string | null>(null)
  const pulledOnArrivalRef = React.useRef(false)
  const commands = React.useMemo(() => aiAgentCommands(origin), [origin])

  React.useEffect(() => setOrigin(window.location.origin), [])

  async function localAgentRequest(path: string, method: "GET" | "POST") {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 8_000)
    const request: RequestInit = { method, signal: controller.signal, cache: "no-store" }
    try {
      try {
        return await fetch(`${AGENT_URL}${path}`, request)
      } catch (firstError) {
        if (!(firstError instanceof TypeError)) throw firstError
        return await fetch(`${AGENT_URL}${path}`, {
          ...request,
          ...({ targetAddressSpace: "loopback" } as RequestInit),
        })
      }
    } finally {
      window.clearTimeout(timer)
    }
  }

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
    setRecovery(null)
    try {
      let agentStatus: LocalAgentStatus | null = null
      try {
        const statusResponse = await localAgentRequest("/v1/status", "GET")
        if (statusResponse.ok) {
          agentStatus = (await statusResponse.json().catch(() => ({}))) as LocalAgentStatus
        }
      } catch {
        setState("agent-missing")
        setRecovery(diagnoseAiAgent({ reachable: false }))
        return
      }

      const response = await localAgentRequest("/v1/refresh", "POST")
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean
        pushed?: Array<{ label: string; limits: number }>
        errors?: Array<{ label: string; error: string }>
        note?: string
        error?: string
      }
      if (!response.ok && !payload.ok) {
        const reason = payload.error ?? payload.errors?.map((entry) => entry.error).filter(Boolean).join(" · ") ?? `Agent refresh failed (${response.status}).`
        setRecovery(diagnoseAiAgent({ reachable: true, autoSync: agentStatus?.autoSync, error: reason }))
        throw new Error(reason)
      }
      if ((payload.pushed?.length ?? 0) === 0) {
        setState("empty")
        setDetail(payload.note ?? payload.errors?.[0]?.error ?? "Nothing to push from this device.")
        setRecovery(diagnoseAiAgent({ reachable: true, autoSync: agentStatus?.autoSync, error: agentStatus?.lastSync?.error }))
        return
      }
      setState("done")
      setDetail(payload.pushed!.map((tool) => tool.label).join(" + "))
      setRecovery(diagnoseAiAgent({ reachable: true, autoSync: agentStatus?.autoSync }))
      await pollServer()
      router.refresh()
    } catch (error) {
      // A network-level failure means nothing answered on the loopback port —
      // this device isn't running the agent. Anything else is a real error.
      if (error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")) {
        setState("agent-missing")
        setRecovery(diagnoseAiAgent({ reachable: false }))
      } else {
        setState("failed")
        setDetail(error instanceof Error ? error.message : "Pull failed.")
        setRecovery((current) => current ?? diagnoseAiAgent({ reachable: true, error: error instanceof Error ? error.message : "Pull failed." }))
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
    const lastUpdate = initialServerUpdatedAt ? new Date(initialServerUpdatedAt).getTime() : 0
    // A just-finished agent push is already current. Otherwise ask the local
    // loopback agent immediately, so opening the page does not wait for its next
    // one-minute scheduled pass.
    if (Number.isFinite(lastUpdate) && Date.now() - lastUpdate < SERVER_POLL_MS) return
    const timeout = window.setTimeout(() => {
      if (document.visibilityState === "visible" && !pulledOnArrivalRef.current) {
        pulledOnArrivalRef.current = true
        void pull()
      }
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
        {state === "empty" || (state === "failed" && !recovery) ? (
          <span className="amb-device-pull-note err">
            <X size={12} aria-hidden /> {detail}
          </span>
        ) : null}
      </div>

      {recovery ? (
        <div className={`amb-device-pull-help ${recovery.kind}`} role="alert">
          <p>
            <AlertTriangle size={14} aria-hidden /> <strong>{recovery.title}</strong> {recovery.detail}
          </p>
          {recovery.showPairCommand ? (
            <div className="amb-device-pull-cmd">
              <span>1 · Pair again</span>
              <code>{commands.pair}</code>
              <CopyButton text={commands.pair} copyLabel="Copy" />
            </div>
          ) : null}
          <div className="amb-device-pull-cmd">
            <span>{recovery.showPairCommand ? "2 · macOS job" : "macOS job"}</span>
            <code>{commands.macInstall}</code>
            <CopyButton text={commands.macInstall} copyLabel="Copy setup" copiedLabel="Copied" />
          </div>
          <div className="amb-device-pull-cmd">
            <span>{recovery.showPairCommand ? "2 · Linux job" : "Linux job"}</span>
            <code>{commands.linuxInstall}</code>
            <CopyButton text={commands.linuxInstall} copyLabel="Copy setup" copiedLabel="Copied" />
          </div>
          <details className="amb-device-pull-manual">
            <summary><TerminalSquare size={13} aria-hidden /> Run without installing a job</summary>
            <div className="amb-device-pull-cmd">
              <span>Foreground</span>
              <code>{commands.serve}</code>
              <CopyButton text={commands.serve} />
            </div>
          </details>
        </div>
      ) : null}
    </div>
  )
}
