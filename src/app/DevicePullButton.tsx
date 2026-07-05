"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Check, HardDriveDownload, Loader2, TerminalSquare, X } from "lucide-react"
import { CopyButton } from "./dashboard/CopyButton"

const AGENT_URL = "http://127.0.0.1:41414"
const REMOTE_BASE = "https://ambrium.io"
const RUNNER = "npx --yes github:MustangBro7/infra-cost-analyzer"

/**
 * "Pull from this device" (AI page): asks the local Ambrium usage agent
 * (`ambrium-connect serve`, loopback-only) to read this machine's Claude Code /
 * Codex logs + plan limits and push them, then re-renders the page. Local AI
 * data only exists on the device it was created on, so availability is
 * detected live — the probe only succeeds in a browser running on the machine
 * where the agent is listening. When no agent answers, the button degrades to
 * copyable setup commands instead of hiding.
 */
export function DevicePullButton() {
  const router = useRouter()
  const [state, setState] = React.useState<"idle" | "pulling" | "done" | "empty" | "agent-missing" | "failed">("idle")
  const [detail, setDetail] = React.useState<string | null>(null)

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

  return (
    <div className="amb-device-pull">
      <div className="amb-device-pull-row">
        <button type="button" className="amb-btn-sm" disabled={state === "pulling"} onClick={() => void pull()}>
          {state === "pulling" ? <Loader2 className="amb-link-spin" aria-hidden /> : <HardDriveDownload size={13} aria-hidden />}
          {state === "pulling" ? "Pulling from this device…" : "Pull from this device"}
        </button>
        {state === "done" ? (
          <span className="amb-device-pull-note ok">
            <Check size={12} aria-hidden /> Synced {detail} · updating…
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
            Claude Code / Codex usage only exists on the machine it was created on — run either command there:
          </p>
          <div className="amb-device-pull-cmd">
            <span>One-off push</span>
            <code>{`AMBRIUM_API=${REMOTE_BASE} ${RUNNER} --ai-only`}</code>
            <CopyButton text={`AMBRIUM_API=${REMOTE_BASE} ${RUNNER} --ai-only`} />
          </div>
          <div className="amb-device-pull-cmd">
            <span>Enable this button</span>
            <code>{`AMBRIUM_API=${REMOTE_BASE} ${RUNNER} serve`}</code>
            <CopyButton text={`AMBRIUM_API=${REMOTE_BASE} ${RUNNER} serve`} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
