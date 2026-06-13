"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2, ClipboardCopy, Cloud, CloudCog, ExternalLink, KeyRound, Loader2, PlugZap, ShieldAlert, Unplug } from "lucide-react"
import type { Provider, ProviderConnection } from "@/lib/types"
import { ProviderLogo } from "./ProviderLogo"

type PublicConnection = {
  provider: Provider
  status: string
  accountLabel: string | null
  connectedAt: string
  lastVerifiedAt: string | null
  lastError: string | null
  metadata: Record<string, unknown>
}

interface PublicState {
  connections: Record<string, PublicConnection | null>
}

interface VercelOAuthStatus {
  configured: boolean
  redirectUri: string
  missingEnv: string[]
}

const VERCEL_TOKEN_URL = "https://vercel.com/account/settings/tokens"
const CLOUDFLARE_TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
  JSON.stringify([
    { key: "account_settings", type: "read" },
    { key: "billing", type: "read" },
  ])
)}&name=${encodeURIComponent("Infra Cost Analyzer")}`

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

function providerLabel(provider: Provider) {
  if (provider === "gcp") return "Google Cloud"
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      type="button"
      className="copy-button"
      onClick={() => {
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        })
      }}
    >
      <ClipboardCopy aria-hidden />
      {copied ? "Copied" : "Copy"}
    </button>
  )
}

function ProviderBadge({ provider }: { provider: Provider }) {
  return <ProviderLogo provider={provider} />
}

function ConnectedProviderState({
  provider,
  connection,
  detail,
}: {
  provider: Provider
  connection: PublicConnection
  detail?: string | null
}) {
  return (
    <div className="connected-provider-state">
      <CheckCircle2 aria-hidden />
      <div>
        <strong>Connected to {connection.accountLabel || providerLabel(provider)}</strong>
        <span>{detail || "Live billing connection is saved for this workspace."}</span>
        {connection.lastVerifiedAt ? <small>Verified {new Date(connection.lastVerifiedAt).toLocaleString()}</small> : null}
      </div>
    </div>
  )
}

export function ProviderConnectPanel({
  providerConnections,
  initialState,
}: {
  providerConnections: ProviderConnection[]
  initialState: PublicState
}) {
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
  const [awsAccessKeyId, setAwsAccessKeyId] = React.useState("")
  const [awsSecretAccessKey, setAwsSecretAccessKey] = React.useState("")
  const [awsSessionToken, setAwsSessionToken] = React.useState("")
  const [vercelOAuthStatus, setVercelOAuthStatus] = React.useState<VercelOAuthStatus | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    jsonRequest<VercelOAuthStatus>("/api/vercel/oauth/status").then(setVercelOAuthStatus).catch(() => setVercelOAuthStatus(null))
  }, [])

  async function refresh() {
    const next = await jsonRequest<PublicState>("/api/state")
    setState(next)
    router.refresh()
  }

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label)
    setMessage(null)
    setError(null)
    try {
      await task()
      await refresh()
    } catch (err) {
      setError(formatError(err))
    } finally {
      setBusy(null)
    }
  }

  const relevant = providerConnections.filter((connection) => {
    return connection.detected || ["vercel", "cloudflare", "gcp", "aws"].includes(connection.provider)
  })

  return (
    <section className="provider-connect-panel" aria-label="Live billing connections">
      <div className="provider-connect-head">
        <div>
          <p>Live Billing Connections</p>
          <h2>Connect providers to show actual costs</h2>
        </div>
        <PlugZap aria-hidden />
      </div>

      <div className="provider-connect-grid">
        {relevant.map((connection) => {
          const saved = state.connections[connection.provider]
          const connected = saved?.status === "connected"

          if (connection.provider === "vercel") {
            return (
              <article key={connection.provider} className={connected ? "provider-connect-card connected" : "provider-connect-card"}>
                <div className="provider-connect-title">
                  <ProviderBadge provider="vercel" />
                  <strong>{connected ? saved?.accountLabel : "Connect Vercel billing"}</strong>
                </div>
                {connected && saved ? (
                  <ConnectedProviderState provider="vercel" connection={saved} detail="Vercel billing will be used when Vercel returns matching charge rows." />
                ) : (
                  <>
                    <p>Use Vercel billing charges to show live Vercel cost rows.</p>
                    {vercelOAuthStatus?.configured ? (
                      <button type="button" className="command-button" disabled={Boolean(busy)} onClick={() => { window.location.href = "/api/vercel/oauth/start" }}>
                        <KeyRound aria-hidden />
                        Connect Vercel
                      </button>
                    ) : (
                      <div className="mini-setup-box">
                        <span>Vercel OAuth is not configured. Use a token for now.</span>
                        {vercelOAuthStatus?.redirectUri ? <code>{vercelOAuthStatus.redirectUri}</code> : null}
                      </div>
                    )}
                    <form
                      className="provider-token-form"
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
                          setMessage("Vercel connected. Refreshing live billing rows.")
                        })
                      }}
                    >
                      <input type="password" value={vercelToken} onChange={(event) => setVercelToken(event.target.value)} placeholder="Vercel token" autoComplete="off" />
                      <input type="text" value={vercelScope} onChange={(event) => setVercelScope(event.target.value)} placeholder="team id or slug, optional" autoComplete="off" />
                      <button type="submit" className="command-button" disabled={Boolean(busy) || !vercelToken.trim()}>
                        {busy === "vercel-connect" ? <Loader2 className="spin" aria-hidden /> : <KeyRound aria-hidden />}
                        Verify
                      </button>
                    </form>
                    <a className="ghost-button" href={VERCEL_TOKEN_URL} target="_blank" rel="noreferrer">
                      <ExternalLink aria-hidden />
                      Create Vercel token
                    </a>
                  </>
                )}
              </article>
            )
          }

          if (connection.provider === "cloudflare") {
            return (
              <article key={connection.provider} className={connected ? "provider-connect-card connected" : "provider-connect-card"}>
                <div className="provider-connect-title">
                  <ProviderBadge provider="cloudflare" />
                  <strong>{connected ? saved?.accountLabel : "Connect Cloudflare billing"}</strong>
                </div>
                {connected && saved ? (
                  <ConnectedProviderState provider="cloudflare" connection={saved} detail="Cloudflare subscriptions are available when the token has billing access." />
                ) : (
                  <>
                    <p>Create a scoped token, paste it here, and Cloudflare rows will show actual subscription costs.</p>
                    <a className="command-button" href={CLOUDFLARE_TOKEN_URL} target="_blank" rel="noreferrer">
                      <ExternalLink aria-hidden />
                      Create Cloudflare token
                    </a>
                    <form
                      className="provider-token-form single"
                      onSubmit={(event) => {
                        event.preventDefault()
                        run("cloudflare-connect", async () => {
                          await jsonRequest("/api/cloudflare/connect", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ token: cloudflareToken }),
                          })
                          setCloudflareToken("")
                          setMessage("Cloudflare connected. Refreshing live billing rows.")
                        })
                      }}
                    >
                      <input type="password" value={cloudflareToken} onChange={(event) => setCloudflareToken(event.target.value)} placeholder="Cloudflare API token" autoComplete="off" />
                      <button type="submit" className="command-button" disabled={Boolean(busy) || !cloudflareToken.trim()}>
                        {busy === "cloudflare-connect" ? <Loader2 className="spin" aria-hidden /> : <CloudCog aria-hidden />}
                        Verify
                      </button>
                    </form>
                  </>
                )}
              </article>
            )
          }

          if (connection.provider === "gcp") {
            return (
              <article key={connection.provider} className={connected ? "provider-connect-card connected" : "provider-connect-card"}>
                <div className="provider-connect-title">
                  <ProviderBadge provider="gcp" />
                  <strong>{connected ? saved?.accountLabel : "Connect Google Cloud billing"}</strong>
                </div>
                {connected && saved ? (
                  <ConnectedProviderState
                    provider="gcp"
                    connection={saved}
                    detail={(saved.metadata as { billingExportTable?: string | null }).billingExportTable ? "Billing export table is saved for live GCP cost rows." : "Project access is connected. Add a Billing Export table later to pull actual GCP costs."}
                  />
                ) : (
                  <>
                    <p>Use a read-only service account and optional Billing Export table for actual GCP costs.</p>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => navigator.clipboard.writeText(GCP_SETUP_SCRIPT).then(() => setMessage("gcloud setup script copied."))}
                    >
                      <ClipboardCopy aria-hidden />
                      Copy gcloud setup script
                    </button>
                    <form
                      className="provider-token-form stacked"
                      onSubmit={(event) => {
                        event.preventDefault()
                        run("gcp-connect", async () => {
                          await jsonRequest("/api/gcp/connect", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ keyJson: gcpKeyJson, billingExportTable: gcpExportTable }),
                          })
                          setGcpKeyJson("")
                          setMessage("Google Cloud connected. Refreshing live billing rows.")
                        })
                      }}
                    >
                      <textarea value={gcpKeyJson} onChange={(event) => setGcpKeyJson(event.target.value)} placeholder='{"type":"service_account","project_id":"..."}' rows={4} spellCheck={false} />
                      <input type="text" value={gcpExportTable} onChange={(event) => setGcpExportTable(event.target.value)} placeholder="billing export table, optional: project.dataset.gcp_billing_export_resource_v1_..." />
                      <button type="submit" className="command-button" disabled={Boolean(busy) || !gcpKeyJson.trim()}>
                        {busy === "gcp-connect" ? <Loader2 className="spin" aria-hidden /> : <Cloud aria-hidden />}
                        Verify
                      </button>
                    </form>
                  </>
                )}
              </article>
            )
          }

          if (connection.provider === "aws") {
            return (
              <article key={connection.provider} className={connected ? "provider-connect-card connected" : "provider-connect-card"}>
                <div className="provider-connect-title">
                  <ProviderBadge provider="aws" />
                  <strong>{connected ? saved?.accountLabel : "Connect AWS billing"}</strong>
                </div>
                {connected && saved ? (
                  <ConnectedProviderState
                    provider="aws"
                    connection={saved}
                    detail="Live AWS cost (Cost Explorer) and free-tier usage are pulled for this account."
                  />
                ) : (
                  <>
                    <p>Use your AWS CLI credentials for the lowest-friction connection, or paste an access key. Read-only: needs ce:GetCostAndUsage and freetier:GetFreeTierUsage.</p>
                    <button
                      type="button"
                      className="command-button"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        run("aws-local", async () => {
                          await jsonRequest("/api/aws/local-connect", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({}),
                          })
                          setMessage("AWS connected from local CLI credentials. Refreshing live cost and usage.")
                        })
                      }
                    >
                      {busy === "aws-local" ? <Loader2 className="spin" aria-hidden /> : <KeyRound aria-hidden />}
                      Use local AWS CLI
                    </button>
                    <div className="mini-setup-box">
                      <ShieldAlert aria-hidden />
                      <span>Local CLI works when ~/.aws/credentials exists on the server (run `aws configure`). On a remote deployment, paste an access key instead.</span>
                    </div>
                    <form
                      className="provider-token-form stacked"
                      onSubmit={(event) => {
                        event.preventDefault()
                        run("aws-connect", async () => {
                          await jsonRequest("/api/aws/connect", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              accessKeyId: awsAccessKeyId,
                              secretAccessKey: awsSecretAccessKey,
                              sessionToken: awsSessionToken || null,
                            }),
                          })
                          setAwsAccessKeyId("")
                          setAwsSecretAccessKey("")
                          setAwsSessionToken("")
                          setMessage("AWS connected. Refreshing live cost and usage.")
                        })
                      }}
                    >
                      <input type="text" value={awsAccessKeyId} onChange={(event) => setAwsAccessKeyId(event.target.value)} placeholder="AWS_ACCESS_KEY_ID" autoComplete="off" spellCheck={false} />
                      <input type="password" value={awsSecretAccessKey} onChange={(event) => setAwsSecretAccessKey(event.target.value)} placeholder="AWS_SECRET_ACCESS_KEY" autoComplete="off" />
                      <input type="password" value={awsSessionToken} onChange={(event) => setAwsSessionToken(event.target.value)} placeholder="AWS_SESSION_TOKEN (optional, for temporary credentials)" autoComplete="off" />
                      <button type="submit" className="command-button" disabled={Boolean(busy) || !awsAccessKeyId.trim() || !awsSecretAccessKey.trim()}>
                        {busy === "aws-connect" ? <Loader2 className="spin" aria-hidden /> : <Cloud aria-hidden />}
                        Verify
                      </button>
                    </form>
                  </>
                )}
              </article>
            )
          }

          return null
        })}
      </div>

      <div className="provider-connect-footer">
        <span>Connected providers</span>
        <strong>{Object.values(state.connections).filter((connection) => connection?.status === "connected").length}</strong>
        {Object.entries(state.connections).map(([provider, connection]) =>
          connection?.status === "connected" && provider !== "github" ? (
            <button
              key={provider}
              type="button"
              className="ghost-button danger"
              disabled={Boolean(busy)}
              onClick={() =>
                run(`${provider}-disconnect`, async () => {
                  await jsonRequest("/api/providers/disconnect", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ provider }),
                  })
                })
              }
            >
              <Unplug aria-hidden />
              Disconnect {providerLabel(provider as Provider)}
            </button>
          ) : null
        )}
      </div>

      {message ? <div className="flow-message success">{message}</div> : null}
      {error ? <div className="flow-message error">{error}</div> : null}
    </section>
  )
}
