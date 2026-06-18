"use client"

import * as React from "react"
import { CheckCircle2, Loader2, TerminalSquare } from "lucide-react"

// Device-code approval page. The companion CLI prints a userCode; the signed-in
// user lands here (Clerk-protected by middleware) and approves it, binding the
// pairing to their account so the CLI can connect providers on their behalf.
export default function PairPage() {
  const [code, setCode] = React.useState("")
  const [status, setStatus] = React.useState<"idle" | "working" | "done">("idle")
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const prefill = new URLSearchParams(window.location.search).get("code")
    if (prefill) setCode(prefill.toUpperCase())
  }, [])

  async function approve(event: React.FormEvent) {
    event.preventDefault()
    setStatus("working")
    setError(null)
    try {
      const response = await fetch("/api/cli/pair/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode: code }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "Approval failed.")
      setStatus("done")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval failed.")
      setStatus("idle")
    }
  }

  return (
    <main className="pair-page">
      <section className="panel pair-panel" aria-label="Approve CLI pairing">
        <div className="section-heading">
          <div>
            <p>Companion CLI</p>
            <h2>Approve device pairing</h2>
          </div>
          <TerminalSquare aria-hidden />
        </div>

        {status === "done" ? (
          <div className="connected-provider-state">
            <CheckCircle2 aria-hidden />
            <div>
              <strong>Device approved</strong>
              <span>Return to your terminal — the CLI will continue automatically.</span>
            </div>
          </div>
        ) : (
          <>
            <p>Enter the code shown in your terminal to authorize the CLI to connect providers to your account.</p>
            <form className="token-form single" onSubmit={approve}>
              <input
                type="text"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="WXYZ-1234"
                autoComplete="off"
                spellCheck={false}
                aria-label="Pairing code"
              />
              <button type="submit" className="command-button" disabled={status === "working" || !code.trim()}>
                {status === "working" ? <Loader2 className="spin" aria-hidden /> : <CheckCircle2 aria-hidden />}
                Approve
              </button>
            </form>
          </>
        )}
        {error ? <div className="flow-message error">{error}</div> : null}
      </section>
    </main>
  )
}
