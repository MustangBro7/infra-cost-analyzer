"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  Boxes,
  CheckCircle2,
  ClipboardCopy,
  ExternalLink,
  KeyRound,
  Loader2,
  Plus,
  Sparkles,
  TerminalSquare,
  Trash2,
} from "lucide-react"

type CustomProviderView = {
  id: string
  name: string
  shortLabel?: string | null
  color?: string | null
  homepage?: string | null
  connected?: boolean
  accountLabel?: string | null
}

interface PublicState {
  customProviders?: CustomProviderView[]
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : "Request failed."
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = (await response.json().catch(() => ({}))) as { error?: unknown }
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : `Request failed with ${response.status}`)
  }
  return payload as T
}

const STARTER_DEFINITION = `{
  "name": "My Provider",
  "auth": { "type": "bearer" },
  "request": {
    "method": "GET",
    "url": "https://api.example.com/v1/billing?from={{periodStart}}&to={{periodEnd}}"
  },
  "cost": {
    "itemsPath": "data.charges",
    "amountField": "amount",
    "serviceField": "service_name",
    "currency": "USD"
  },
  "usage": {
    "itemsPath": "data.charges",
    "quantityField": "quantity",
    "serviceField": "service_name",
    "unitField": "unit"
  }
}`

export function CustomProviderPanel({ initialState }: { initialState: PublicState }) {
  const router = useRouter()
  const providers = initialState.customProviders ?? []
  const [busy, setBusy] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [secrets, setSecrets] = React.useState<Record<string, string>>({})
  const [showAdd, setShowAdd] = React.useState(false)
  const [definition, setDefinition] = React.useState(STARTER_DEFINITION)
  const [newSecret, setNewSecret] = React.useState("")
  const [testResult, setTestResult] = React.useState<string | null>(null)
  const [origin, setOrigin] = React.useState("https://ambrium.io")

  React.useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin)
  }, [])

  const agentPrompt = `Add my hosting provider to Ambrium so its cost and usage show on my dashboard. Read the machine-readable guide at ${origin}/api/extend/spec and follow it exactly: (1) pair to my account with the device-code flow, (2) build a custom-provider connector for <PROVIDER NAME> using its billing/usage REST API, (3) dry-run it with POST /api/cli/custom-providers/test until the rows look right, (4) save it and attach my API token. Ask me for the provider name and any API token it needs.`

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label)
    setMessage(null)
    setError(null)
    try {
      await task()
      router.refresh()
    } catch (err) {
      setError(formatError(err))
    } finally {
      setBusy(null)
    }
  }

  function parseDefinition(): unknown {
    try {
      return JSON.parse(definition)
    } catch {
      throw new Error("Definition is not valid JSON.")
    }
  }

  return (
    <section className="provider-connect-panel custom-provider-panel" aria-label="Custom providers">
      <div className="provider-connect-head">
        <div>
          <p>Extend the platform</p>
          <h2>Add a provider with your AI agent</h2>
        </div>
        <Sparkles aria-hidden />
      </div>

      <div className="custom-agent-guide">
        <p>
          Using a hosting provider we don&apos;t support yet? Hand this to your AI coding agent (Claude Code, Codex, or
          Cursor). It reads the machine-readable spec, builds a connector for your provider&apos;s billing API, tests it,
          and wires it into your dashboard — no code deploy.
        </p>
        <div className="cli-command">
          <span>Paste into your agent</span>
          <code>{agentPrompt}</code>
        </div>
        <div className="custom-agent-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => navigator.clipboard.writeText(agentPrompt).then(() => setMessage("Agent prompt copied."))}
          >
            <ClipboardCopy aria-hidden />
            Copy agent prompt
          </button>
          <a className="ghost-button" href={`${origin}/api/extend/spec`} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden />
            View extension spec
          </a>
        </div>
      </div>

      {providers.length > 0 ? (
        <div className="provider-connect-grid">
          {providers.map((provider) => (
            <article
              key={provider.id}
              className={provider.connected ? "provider-connect-card connected" : "provider-connect-card"}
            >
              <div className="provider-connect-title">
                <span className="provider-logo provider-custom" style={provider.color ? { background: provider.color } : undefined}>
                  <Boxes aria-hidden />
                </span>
                <strong>{provider.name}</strong>
                {provider.connected ? <span className="plan-badge">Connected</span> : null}
              </div>
              {provider.connected ? (
                <div className="connected-provider-state">
                  <CheckCircle2 aria-hidden />
                  <div>
                    <strong>Pulling live data</strong>
                    <span>This connector refreshes with the rest of your accounts.</span>
                  </div>
                </div>
              ) : (
                <p>Add the API token for {provider.name} to start pulling its cost and usage.</p>
              )}
              <form
                className="provider-token-form single"
                onSubmit={(event) => {
                  event.preventDefault()
                  run(`secret-${provider.id}`, async () => {
                    await jsonRequest("/api/custom-providers/secret", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: provider.id, secret: secrets[provider.id] ?? "" }),
                    })
                    setSecrets((prev) => ({ ...prev, [provider.id]: "" }))
                    await jsonRequest("/api/analyze/refresh", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ repo: new URLSearchParams(window.location.search).get("repo") }),
                    }).catch(() => {})
                    setMessage(`${provider.name} secret saved.`)
                  })
                }}
              >
                <input
                  type="password"
                  value={secrets[provider.id] ?? ""}
                  onChange={(event) => setSecrets((prev) => ({ ...prev, [provider.id]: event.target.value }))}
                  placeholder={provider.connected ? "Replace token" : "API token / secret"}
                  autoComplete="off"
                />
                <button type="submit" className="command-button" disabled={Boolean(busy) || !(secrets[provider.id] ?? "").trim()}>
                  {busy === `secret-${provider.id}` ? <Loader2 className="spin" aria-hidden /> : <KeyRound aria-hidden />}
                  Save
                </button>
              </form>
              <button
                type="button"
                className="ghost-button danger"
                disabled={Boolean(busy)}
                onClick={() =>
                  run(`delete-${provider.id}`, async () => {
                    await jsonRequest("/api/custom-providers/delete", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: provider.id }),
                    })
                    setMessage(`${provider.name} removed.`)
                  })
                }
              >
                <Trash2 aria-hidden />
                Remove
              </button>
            </article>
          ))}
        </div>
      ) : null}

      <details className="provider-connect-more" open={showAdd} onToggle={(event) => setShowAdd((event.target as HTMLDetailsElement).open)}>
        <summary>
          <TerminalSquare aria-hidden /> Add a connector manually (advanced)
        </summary>
        <div className="custom-manual-form">
          <p>
            Paste a connector definition (JSON). See the{" "}
            <a href={`${origin}/api/extend/spec`} target="_blank" rel="noreferrer">
              extension spec
            </a>{" "}
            for the schema. Test it with a token before saving.
          </p>
          <textarea
            value={definition}
            onChange={(event) => setDefinition(event.target.value)}
            rows={14}
            spellCheck={false}
            className="custom-definition-input"
          />
          <input
            type="password"
            value={newSecret}
            onChange={(event) => setNewSecret(event.target.value)}
            placeholder="API token / secret (for testing + saving)"
            autoComplete="off"
          />
          {testResult ? <pre className="custom-test-output">{testResult}</pre> : null}
          <div className="custom-agent-actions">
            <button
              type="button"
              className="ghost-button"
              disabled={Boolean(busy)}
              onClick={() =>
                run("test", async () => {
                  setTestResult(null)
                  const result = await jsonRequest<{ ok: boolean; costRows: unknown[]; usage: unknown[]; sampleResponse: string; error?: string }>(
                    "/api/custom-providers/test",
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ definition: parseDefinition(), secret: newSecret }),
                    }
                  )
                  setTestResult(
                    result.ok
                      ? `✓ ${result.costRows.length} cost row(s), ${result.usage.length} usage row(s)\n\ncostRows: ${JSON.stringify(result.costRows, null, 2)}\n\nusage: ${JSON.stringify(result.usage, null, 2)}\n\nsample: ${result.sampleResponse}`
                      : `✗ ${result.error}\n\nsample: ${result.sampleResponse}`
                  )
                })
              }
            >
              {busy === "test" ? <Loader2 className="spin" aria-hidden /> : <Sparkles aria-hidden />}
              Test connector
            </button>
            <button
              type="button"
              className="command-button"
              disabled={Boolean(busy)}
              onClick={() =>
                run("create", async () => {
                  const created = await jsonRequest<{ provider: { id: string; name: string } }>("/api/custom-providers", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(parseDefinition()),
                  })
                  if (newSecret.trim()) {
                    await jsonRequest("/api/custom-providers/secret", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: created.provider.id, secret: newSecret }),
                    })
                    await jsonRequest("/api/analyze/refresh", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ repo: new URLSearchParams(window.location.search).get("repo") }),
                    }).catch(() => {})
                  }
                  setNewSecret("")
                  setTestResult(null)
                  setMessage(`${created.provider.name} created.`)
                })
              }
            >
              {busy === "create" ? <Loader2 className="spin" aria-hidden /> : <Plus aria-hidden />}
              Save connector
            </button>
          </div>
        </div>
      </details>

      {message ? <div className="flow-message success">{message}</div> : null}
      {error ? <div className="flow-message error">{error}</div> : null}
    </section>
  )
}
