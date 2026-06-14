"use client"

import * as React from "react"
import { CloudCog, Loader2, LogIn } from "lucide-react"
import { ThemeToggle } from "./ThemeToggle"

async function signIn(email: string, name: string, accessCode: string) {
  const response = await fetch("/api/auth/sign-in", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name, accessCode: accessCode || undefined }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Failed to sign in.")
  }
}

export function SignInForm() {
  const [email, setEmail] = React.useState("")
  const [name, setName] = React.useState("")
  const [accessCode, setAccessCode] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  return (
    <main className="signin-shell">
      <div className="theme-toggle-floating">
        <ThemeToggle />
      </div>
      <section className="signin-panel">
        <div className="signin-mark">
          <CloudCog aria-hidden />
        </div>
        <p>Local Multi-Tenant Replica</p>
        <h1>Sign in to your isolated workspace</h1>
        <span>
          Each email gets separate repos, provider credentials, connection logs, and cost snapshots. This mirrors the deployed SaaS tenant boundary.
        </span>
        <form
          className="signin-form"
          onSubmit={async (event) => {
            event.preventDefault()
            setBusy(true)
            setError(null)
            try {
              await signIn(email, name, accessCode)
              window.location.href = "/"
            } catch (err) {
              setError(err instanceof Error ? err.message : "Failed to sign in.")
            } finally {
              setBusy(false)
            }
          }}
        >
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            autoComplete="email"
            required
          />
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="workspace name"
            autoComplete="name"
          />
          <input
            type="password"
            value={accessCode}
            onChange={(event) => setAccessCode(event.target.value)}
            placeholder="access code (if this deployment requires one)"
            autoComplete="off"
          />
          <button type="submit" className="command-button" disabled={busy}>
            {busy ? <Loader2 className="spin" aria-hidden /> : <LogIn aria-hidden />}
            Sign in locally
          </button>
        </form>
        {error ? <div className="flow-message error">{error}</div> : null}
      </section>
    </main>
  )
}
