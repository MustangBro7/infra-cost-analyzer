"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  CheckCircle2,
  ChevronDown,
  ClipboardCopy,
  Cloud,
  CloudCog,
  DatabaseZap,
  ExternalLink,
  Github,
  KeyRound,
  Loader2,
  PlugZap,
  ShieldCheck,
  Unplug,
} from "lucide-react"
import type { ConnectionEvent, GitHubRepoSummary, Provider } from "@/lib/types"

interface PublicState {
  selectedRepoFullName: string | null
  githubRepos: GitHubRepoSummary[]
  events: ConnectionEvent[]
  connections: Record<string, {
    provider: Provider
    status: string
    accountLabel: string | null
    connectedAt: string
    lastVerifiedAt: string | null
    lastError: string | null
    metadata: Record<string, unknown>
  } | null>
}

interface VercelOAuthStatus {
  configured: boolean
  hasClientId: boolean
  redirectUri: string
  missingEnv: string[]
}

const STEPS: Array<{
  id: Provider
  title: string
  primary: string
  description: string
  icon: React.ComponentType<{ "aria-hidden"?: boolean; className?: string }>
}> = [
  {
    id: "github",
    title: "Connect GitHub",
    primary: "Repository source",
    description: "Install the GitHub App or use local mode while developing.",
    icon: Github,
  },
  {
    id: "vercel",
    title: "Connect Vercel",
    primary: "Live billing data",
    description: "Use provider authorization when configured; token fallback is advanced.",
    icon: KeyRound,
  },
  {
    id: "cloudflare",
    title: "Connect Cloudflare",
    primary: "Workers, Pages, D1, R2",
    description: "Paste a scoped API token to read account usage. No other provider is required first.",
    icon: CloudCog,
  },
  {
    id: "gcp",
    title: "Connect Google Cloud",
    primary: "Billing export",
    description: "Paste a service account key for account/project discovery; detailed cost needs Billing export.",
    icon: Cloud,
  },
]

// Opens Cloudflare's token-creation page with the two needed permissions preselected.
const CLOUDFLARE_TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
  JSON.stringify([
    { key: "account_settings", type: "read" },
    { key: "billing", type: "read" },
  ])
)}&name=${encodeURIComponent("Infra Cost Analyzer")}`

const VERCEL_TOKEN_URL = "https://vercel.com/account/settings/tokens"

// One-paste terminal script: creates a read-only service account, grants the
// two BigQuery roles needed for billing export queries, and copies the key.
const GCP_SETUP_SCRIPT = `PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
gcloud iam service-accounts create infra-cost-analyzer --display-name="Infra Cost Analyzer" 2>/dev/null
SA="infra-cost-analyzer@$PROJECT_ID.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role="roles/bigquery.jobUser" --quiet >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role="roles/bigquery.dataViewer" --quiet >/dev/null
gcloud iam service-accounts keys create /tmp/ica-key.json --iam-account="$SA"
cat /tmp/ica-key.json | pbcopy && echo "Service account key copied to clipboard. Paste it into the app."`

function formatError(error: unknown) {
  return error instanceof Error ? error.message : "Request failed."
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : `Request failed with ${response.status}`)
  }
  return payload as T
}

function doneLabel(state: PublicState, provider: Provider) {
  const connection = state.connections[provider]
  if (connection?.status === "connected") return "Connected"
  return "Optional"
}

function isDone(state: PublicState, provider: Provider) {
  return state.connections[provider]?.status === "connected"
}

export function ConnectFlow({ initialState }: { initialState: PublicState }) {
  const router = useRouter()
  const [state, setState] = React.useState(initialState)
  const [vercelToken, setVercelToken] = React.useState("")
  const [vercelScope, setVercelScope] = React.useState("")
  const [cloudflareToken, setCloudflareToken] = React.useState("")
  const [gcpKeyJson, setGcpKeyJson] = React.useState("")
  const [gcpExportTable, setGcpExportTable] = React.useState(() => {
    const metadata = initialState.connections.gcp?.metadata as { billingExportTable?: string | null } | undefined
    return metadata?.billingExportTable ?? ""
  })
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = React.useState(false)
  const [vercelOAuthStatus, setVercelOAuthStatus] = React.useState<VercelOAuthStatus | null>(null)

  const refresh = React.useCallback(async () => {
    const next = await jsonRequest<PublicState>("/api/state")
    setState(next)
  }, [])

  React.useEffect(() => {
    jsonRequest<VercelOAuthStatus>("/api/vercel/oauth/status")
      .then(setVercelOAuthStatus)
      .catch(() => {
        setVercelOAuthStatus(null)
      })

    const params = new URLSearchParams(window.location.search)
    if (params.get("connect_error") === "vercel_oauth_not_configured") {
      setError("Vercel OAuth is not configured. Add NEXT_PUBLIC_VERCEL_APP_CLIENT_ID and set the Vercel App callback URL shown below.")
    }
    if (params.get("connect_error") === "vercel_oauth_failed") {
      setError("Vercel OAuth failed. Check the connection log for the exact callback error.")
    }
  }, [])

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label)
    setError(null)
    setMessage(null)
    try {
      await task()
      await refresh()
      // Re-render the server components so live cost rows appear without a manual reload.
      router.refresh()
    } catch (err) {
      setError(formatError(err))
    } finally {
      setBusy(null)
    }
  }

  const github = state.connections.github
  const vercel = state.connections.vercel
  const cloudflare = state.connections.cloudflare
  const gcp = state.connections.gcp

  return (
    <section className="panel connect-panel" aria-label="Connection workflow">
      <div className="section-heading">
        <div>
          <p>Connection Flow</p>
          <h2>Connect any provider, in any order</h2>
        </div>
        <PlugZap aria-hidden />
      </div>

      <div className="step-strip" aria-label="Provider connection status">
        {STEPS.map((step) => {
          const done = isDone(state, step.id)
          const Icon = step.icon
          return (
            <article key={step.id} className={done ? "step-card done" : "step-card"}>
              <div className="step-number">{done ? <CheckCircle2 aria-hidden /> : <Icon aria-hidden />}</div>
              <div>
                <strong>{step.title}</strong>
                <span>{doneLabel(state, step.id)}</span>
              </div>
            </article>
          )
        })}
      </div>

      <div className="flow-grid">
        <article className={github ? "flow-card complete" : "flow-card"}>
          <div className="flow-card-heading">
            <Github aria-hidden />
            <div>
              <h3>GitHub repository</h3>
              <span>{github ? github.accountLabel : "Not connected"}</span>
            </div>
          </div>
          <p>
            Users should install the GitHub App. Local connect only exists so this repo can be tested before a public app is configured.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="command-button"
              disabled={Boolean(busy)}
              onClick={() =>
                run("github-app", async () => {
                  const payload = await jsonRequest<{ configured: boolean; url: string | null; message: string }>("/api/github/connect-url")
                  if (!payload.configured || !payload.url) throw new Error(payload.message)
                  window.location.href = payload.url
                })
              }
            >
              <Github aria-hidden />
              Install GitHub App
            </button>
            <button
              type="button"
              className="ghost-button"
              disabled={Boolean(busy)}
              onClick={() =>
                run("github-local", async () => {
                  await jsonRequest("/api/github/local-connect", { method: "POST" })
                  setMessage("GitHub step completed using the local repository.")
                })
              }
            >
              {busy === "github-local" ? <Loader2 className="spin" aria-hidden /> : <CheckCircle2 aria-hidden />}
              Use local repo
            </button>
            {github ? (
              <button
                type="button"
                className="ghost-button danger"
                disabled={Boolean(busy)}
                onClick={() =>
                  run("github-disconnect", async () => {
                    await jsonRequest("/api/providers/disconnect", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ provider: "github" }),
                    })
                  })
                }
              >
                <Unplug aria-hidden />
                Disconnect
              </button>
            ) : null}
          </div>
          {state.githubRepos.length > 0 ? (
            <label className="field">
              <span>Selected repository</span>
              <select
                value={state.selectedRepoFullName ?? ""}
                onChange={(event) =>
                  run("repo-select", async () => {
                    await jsonRequest("/api/github/select-repo", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ fullName: event.target.value }),
                    })
                  })
                }
              >
                {state.githubRepos.map((repo) => (
                  <option key={repo.fullName} value={repo.fullName}>
                    {repo.fullName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </article>

        <article className={vercel ? "flow-card complete" : "flow-card"}>
          <div className="flow-card-heading">
            <KeyRound aria-hidden />
            <div>
              <h3>Vercel billing</h3>
              <span>{vercel ? vercel.accountLabel : "Not connected"}</span>
            </div>
          </div>
          <p>
            The product path should be provider authorization. Until a Vercel OAuth app is configured, use the advanced token fallback to test live billing.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="command-button"
              disabled={Boolean(busy)}
              onClick={() =>
                run("vercel-oauth-start", async () => {
                  const status = await jsonRequest<VercelOAuthStatus>("/api/vercel/oauth/status")
                  setVercelOAuthStatus(status)
                  if (!status.configured) {
                    throw new Error(
                      `Vercel OAuth is not configured. Missing: ${status.missingEnv.join(", ")}. Callback URL: ${status.redirectUri}`
                    )
                  }
                  window.location.href = "/api/vercel/oauth/start"
                })
              }
            >
              {busy === "vercel-oauth-start" ? <Loader2 className="spin" aria-hidden /> : <ShieldCheck aria-hidden />}
              Connect with Vercel
            </button>
            <button type="button" className="ghost-button" onClick={() => setShowAdvanced((value) => !value)}>
              <ChevronDown aria-hidden />
              Advanced token fallback
            </button>
            <a className="ghost-button" href={VERCEL_TOKEN_URL} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden />
              Create Vercel token
            </a>
            {vercel ? (
              <button
                type="button"
                className="ghost-button danger"
                disabled={Boolean(busy)}
                onClick={() =>
                  run("vercel-disconnect", async () => {
                    await jsonRequest("/api/providers/disconnect", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ provider: "vercel" }),
                    })
                  })
                }
              >
                <Unplug aria-hidden />
                Disconnect
              </button>
            ) : null}
          </div>
          {vercelOAuthStatus && !vercelOAuthStatus.configured ? (
            <div className="setup-callout">
              <strong>Vercel login needs one local setup step</strong>
              <p>Create a Vercel App, add this callback URL, then set the client ID in `.env.local`.</p>
              <code>{vercelOAuthStatus.redirectUri}</code>
              <code>NEXT_PUBLIC_VERCEL_APP_CLIENT_ID=your-client-id</code>
            </div>
          ) : null}
          {showAdvanced ? (
            <form
              className="token-form"
              onSubmit={(event) => {
                event.preventDefault()
                run("vercel-connect", async () => {
                  await jsonRequest("/api/vercel/connect", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      token: vercelToken,
                      teamId: vercelScope.startsWith("team_") ? vercelScope : null,
                      slug: vercelScope && !vercelScope.startsWith("team_") ? vercelScope : null,
                    }),
                  })
                  setVercelToken("")
                  setVercelScope("")
                  setMessage("Vercel step completed. Refresh or wait for live billing sync.")
                })
              }}
            >
              <input
                type="password"
                value={vercelToken}
                onChange={(event) => setVercelToken(event.target.value)}
                placeholder="vercel token"
                autoComplete="off"
              />
              <input
                type="text"
                value={vercelScope}
                onChange={(event) => setVercelScope(event.target.value)}
                placeholder="team id or slug"
                autoComplete="off"
              />
              <button type="submit" className="command-button" disabled={Boolean(busy) || !vercelToken.trim()}>
                {busy === "vercel-connect" ? <Loader2 className="spin" aria-hidden /> : <KeyRound aria-hidden />}
                Verify
              </button>
            </form>
          ) : null}
        </article>

        <article className={cloudflare ? "flow-card complete" : "flow-card"}>
          <div className="flow-card-heading">
            <CloudCog aria-hidden />
            <div>
              <h3>Cloudflare</h3>
              <span>{cloudflare ? cloudflare.accountLabel : "Not connected"}</span>
            </div>
          </div>
          <p>
            Paid subscription costs (Workers, Pages, R2, etc.) are pulled live from your account. The create-token link below opens Cloudflare with the two read permissions already selected — just press Create and paste the token here.
          </p>
          <div className="button-row">
            <a className="ghost-button" href={CLOUDFLARE_TOKEN_URL} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden />
              Create Cloudflare token
            </a>
          </div>
          <form
            className="token-form single"
            onSubmit={(event) => {
              event.preventDefault()
              run("cloudflare-connect", async () => {
                await jsonRequest("/api/cloudflare/connect", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ token: cloudflareToken }),
                })
                setCloudflareToken("")
                setMessage("Cloudflare connected.")
              })
            }}
          >
            <input
              type="password"
              value={cloudflareToken}
              onChange={(event) => setCloudflareToken(event.target.value)}
              placeholder="cloudflare api token"
              autoComplete="off"
            />
            <button type="submit" className="command-button" disabled={Boolean(busy) || !cloudflareToken.trim()}>
              {busy === "cloudflare-connect" ? <Loader2 className="spin" aria-hidden /> : <KeyRound aria-hidden />}
              Verify
            </button>
          </form>
          {cloudflare ? (
            <div className="button-row">
              <button
                type="button"
                className="ghost-button danger"
                disabled={Boolean(busy)}
                onClick={() =>
                  run("cloudflare-disconnect", async () => {
                    await jsonRequest("/api/providers/disconnect", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ provider: "cloudflare" }),
                    })
                  })
                }
              >
                <Unplug aria-hidden />
                Disconnect
              </button>
            </div>
          ) : null}
        </article>

        <article className={gcp ? "flow-card complete" : "flow-card"}>
          <div className="flow-card-heading">
            <Cloud aria-hidden />
            <div>
              <h3>Google Cloud</h3>
              <span>{gcp ? gcp.accountLabel : "Not connected"}</span>
            </div>
          </div>
          <p>
            Copy the setup script, run it in a terminal with gcloud installed, and the service account key lands on your clipboard — paste it below. The billing export table is discovered automatically when one exists.
          </p>
          {!gcp ? (
            <div className="button-row">
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  navigator.clipboard
                    .writeText(GCP_SETUP_SCRIPT)
                    .then(() => setMessage("gcloud setup script copied. Run it in your terminal, then paste the key below."))
                    .catch(() => setError("Could not access the clipboard. Copy the script from the README instead."))
                }}
              >
                <ClipboardCopy aria-hidden />
                Copy gcloud setup script
              </button>
            </div>
          ) : null}
          {!gcp ? (
            <form
              className="token-form stacked"
              onSubmit={(event) => {
                event.preventDefault()
                run("gcp-connect", async () => {
                  await jsonRequest("/api/gcp/connect", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ keyJson: gcpKeyJson, billingExportTable: gcpExportTable }),
                  })
                  setGcpKeyJson("")
                  setMessage(
                    gcpExportTable.trim()
                      ? "Google Cloud connected with a billing export table. Refresh to pull live cost rows."
                      : "Google Cloud connected. Add your billing export table to pull exact cost rows."
                  )
                })
              }}
            >
              <textarea
                value={gcpKeyJson}
                onChange={(event) => setGcpKeyJson(event.target.value)}
                placeholder='{"type":"service_account","project_id":"...","client_email":"...","private_key":"..."}'
                autoComplete="off"
                spellCheck={false}
                rows={4}
              />
              <input
                type="text"
                value={gcpExportTable}
                onChange={(event) => setGcpExportTable(event.target.value)}
                placeholder="billing export table (optional): project.dataset.gcp_billing_export_v1_XXXXXX"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="command-button" disabled={Boolean(busy) || !gcpKeyJson.trim()}>
                {busy === "gcp-connect" ? <Loader2 className="spin" aria-hidden /> : <KeyRound aria-hidden />}
                Verify
              </button>
            </form>
          ) : (
            <form
              className="token-form single"
              onSubmit={(event) => {
                event.preventDefault()
                run("gcp-billing-export", async () => {
                  const result = await jsonRequest<{ table: string; rowCount: number }>("/api/gcp/billing-export", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ table: gcpExportTable }),
                  })
                  setMessage(`Billing export verified: ${result.rowCount} service rows found this month. Refresh to see live costs.`)
                })
              }}
            >
              <input
                type="text"
                value={gcpExportTable}
                onChange={(event) => setGcpExportTable(event.target.value)}
                placeholder="project.dataset.gcp_billing_export_v1_XXXXXX"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="command-button" disabled={Boolean(busy) || !gcpExportTable.trim()}>
                {busy === "gcp-billing-export" ? <Loader2 className="spin" aria-hidden /> : <DatabaseZap aria-hidden />}
                Save export table
              </button>
            </form>
          )}
          {gcp ? (
            <div className="button-row">
              <button
                type="button"
                className="ghost-button danger"
                disabled={Boolean(busy)}
                onClick={() =>
                  run("gcp-disconnect", async () => {
                    await jsonRequest("/api/providers/disconnect", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ provider: "gcp" }),
                    })
                  })
                }
              >
                <Unplug aria-hidden />
                Disconnect
              </button>
            </div>
          ) : null}
        </article>
      </div>

      {message ? <div className="flow-message success">{message}</div> : null}
      {error ? <div className="flow-message error">{error}</div> : null}

      <div className="activity-log" aria-label="Connection activity log">
        <div className="activity-heading">
          <strong>Connection log</strong>
          <span>{state.events.length ? `${state.events.length} events` : "No events yet"}</span>
        </div>
        {state.events.length ? (
          state.events.slice(0, 8).map((event) => (
            <div key={event.id} className={`activity-item event-${event.level}`}>
              <span>{event.createdAt.slice(11, 19)}</span>
              <p>{event.message}</p>
            </div>
          ))
        ) : (
          <div className="activity-item">
            <span>--:--:--</span>
            <p>Complete a connection step to see the audit trail here.</p>
          </div>
        )}
      </div>
    </section>
  )
}
