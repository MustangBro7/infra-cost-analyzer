"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2, ClipboardCopy, Cloud, CloudCog, ExternalLink, KeyRound, Loader2, PlugZap, Radar, Unplug } from "lucide-react"
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
  // Connectable providers detected in the user's synced repos but not yet
  // connected, ranked by detection strength. Drives the "we found these" UX.
  suggestedProviders?: Provider[]
}

const VERCEL_TOKEN_URL = "https://vercel.com/account/settings/tokens"
const CLOUDFLARE_TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
  JSON.stringify([
    { key: "account_settings", type: "read" },
    { key: "billing", type: "read" },
    // Account Analytics: Read is required for live Workers usage metrics.
    { key: "account_analytics", type: "read" },
  ])
)}&name=${encodeURIComponent("Ambrium")}`

const GCP_SETUP_SCRIPT = `PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
gcloud iam service-accounts create infra-cost-analyzer --display-name="Ambrium" 2>/dev/null
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
  const payload = await response.json().catch(() => ({})) as { error?: unknown }
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : `Request failed with ${response.status}`)
  }
  return payload as T
}

function providerLabel(provider: Provider) {
  if (provider === "gcp") return "Google Cloud"
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

/** Turns a raw Vercel plan ("hobby", "pro", …) into a card label. */
function vercelPlanLabel(plan: unknown): string | null {
  if (typeof plan !== "string" || !plan.trim()) return null
  const normalized = plan.trim()
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} plan`
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
  const [awsRoleArn, setAwsRoleArn] = React.useState("")
  const [awsExternalId, setAwsExternalId] = React.useState("")
  const [awsAccessKeyId, setAwsAccessKeyId] = React.useState("")
  const [awsSecretAccessKey, setAwsSecretAccessKey] = React.useState("")
  const [awsSessionToken, setAwsSessionToken] = React.useState("")
  const [awsCostExplorer, setAwsCostExplorer] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    const next = await jsonRequest<PublicState>("/api/state")
    setState(next)
    router.refresh()
  }, [router])

  async function run(label: string, task: () => Promise<void>) {
    setBusy(label)
    setMessage(null)
    setError(null)
    try {
      await task()
      // After connecting a provider, recompute the current snapshot so live cost
      // rows appear immediately instead of waiting for the next background pull.
      if (label.endsWith("-connect")) {
        const repo = new URLSearchParams(window.location.search).get("repo")
        await jsonRequest("/api/analyze/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo }),
        }).catch(() => {})
      }
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

  const suggestedSet = new Set<Provider>(state.suggestedProviders ?? [])
  const isConnected = (provider: Provider) => state.connections[provider]?.status === "connected"
  const detectionRank = (connection: ProviderConnection) =>
    suggestedSet.has(connection.provider) && !isConnected(connection.provider) ? 0 : 1
  // Promote providers detected in the synced repos (and ones already connected);
  // tuck the rest behind a disclosure so the user sees what they actually use.
  const promoted = relevant
    .filter((connection) => suggestedSet.has(connection.provider) || isConnected(connection.provider))
    .sort((a, b) => detectionRank(a) - detectionRank(b))
  const others = relevant.filter((connection) => !promoted.includes(connection))

  const renderCard = (connection: ProviderConnection) => {
          const saved = state.connections[connection.provider]
          const connected = saved?.status === "connected"
          const detected = suggestedSet.has(connection.provider) && !connected

          if (connection.provider === "vercel") {
            const vercelPlan = vercelPlanLabel((saved?.metadata as { plan?: unknown } | undefined)?.plan)
            const isHobby = vercelPlan?.toLowerCase().startsWith("hobby")
            return (
              <article key={connection.provider} className={connected ? "provider-connect-card connected" : "provider-connect-card"}>
                <div className="provider-connect-title">
                  <ProviderBadge provider="vercel" />
                  <strong>{connected ? saved?.accountLabel : "Connect Vercel billing"}</strong>
                  {detected ? <span className="detected-chip">Detected</span> : null}
                  {connected && vercelPlan ? <span className="plan-badge">{vercelPlan}</span> : null}
                </div>
                {connected && saved ? (
                  <ConnectedProviderState
                    provider="vercel"
                    connection={saved}
                    detail={
                      isHobby
                        ? "On the Hobby plan Vercel doesn't expose billing data, so no cost rows will appear."
                        : "Vercel billing will be used when Vercel returns matching charge rows."
                    }
                  />
                ) : (
                  <>
                    <p>Create a read-only Vercel token (opens Vercel in a new tab), then paste it here. Live cost rows appear on Pro/Team plans.</p>
                    <a className="ghost-button" href={VERCEL_TOKEN_URL} target="_blank" rel="noreferrer">
                      <ExternalLink aria-hidden />
                      Create Vercel token
                    </a>
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
                  {detected ? <span className="detected-chip">Detected</span> : null}
                </div>
                {connected && saved ? (
                  <ConnectedProviderState provider="cloudflare" connection={saved} detail="Cloudflare subscriptions are available when the token has billing access." />
                ) : (
                  <>
                    <p>Paste a scoped Cloudflare API token to pull live Workers usage, free-tier remaining, and billing.</p>
                    <a className="ghost-button" href={CLOUDFLARE_TOKEN_URL} target="_blank" rel="noreferrer">
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
                  {detected ? <span className="detected-chip">Detected</span> : null}
                </div>
                {connected && saved ? (
                  <ConnectedProviderState
                    provider="gcp"
                    connection={saved}
                    detail={(() => {
                      const metadata = saved.metadata as {
                        billingExportDataset?: string | null
                        billingExportTable?: string | null
                      }
                      if (metadata.billingExportTable) return "Billing export table is saved for live GCP cost rows."
                      if (metadata.billingExportDataset) {
                        return `BigQuery dataset ${metadata.billingExportDataset} is ready. Enable Cloud Billing export to populate the cost table.`
                      }
                      return "Project access is connected. Add a Billing Export table later to pull actual GCP costs."
                    })()}
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
                  {detected ? <span className="detected-chip">Detected</span> : null}
                </div>
                {connected && saved ? (
                  <>
                    <ConnectedProviderState
                      provider="aws"
                      connection={saved}
                      detail={
                        (saved.metadata as { costExplorer?: boolean }).costExplorer
                          ? "Live AWS cost (Cost Explorer) and free-tier usage are pulled. Cost Explorer bills ~$0.01 per refresh."
                          : "Free-tier usage is pulled (free). Cost data is off."
                      }
                    />
                    <button
                      type="button"
                      className={(saved.metadata as { costExplorer?: boolean }).costExplorer ? "ghost-button danger" : "command-button"}
                      disabled={Boolean(busy)}
                      onClick={() =>
                        run("aws-cost-toggle", async () => {
                          const enabled = !(saved.metadata as { costExplorer?: boolean }).costExplorer
                          await jsonRequest("/api/aws/cost-explorer", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ enabled }),
                          })
                          // Re-pull the current repo's snapshot so the change shows immediately.
                          const repo = new URLSearchParams(window.location.search).get("repo")
                          await jsonRequest("/api/analyze/refresh", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ repo }),
                          }).catch(() => {})
                          setMessage(enabled ? "Cost data on — pulling AWS spend (~$0.01)." : "Cost data off — free-tier usage only.")
                        })
                      }
                    >
                      {busy === "aws-cost-toggle" ? (
                        <Loader2 className="spin" aria-hidden />
                      ) : (saved.metadata as { costExplorer?: boolean }).costExplorer ? (
                        <Unplug aria-hidden />
                      ) : (
                        <Cloud aria-hidden />
                      )}
                      {(saved.metadata as { costExplorer?: boolean }).costExplorer ? "Turn off cost data" : "Pull cost data ($0.01/refresh)"}
                    </button>
                    {(saved.metadata as { costExplorer?: boolean }).costExplorer ? (
                      <div className="aws-cadence">
                        <label>
                          <span>Auto-refresh cost</span>
                          <select
                            value={(saved.metadata as { costExplorerInterval?: string }).costExplorerInterval ?? "daily"}
                            disabled={Boolean(busy)}
                            onChange={(event) =>
                              run("aws-cadence", async () => {
                                await jsonRequest("/api/aws/cost-explorer", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ interval: event.target.value }),
                                })
                                setMessage(`Cost Explorer auto-refresh set to ${event.target.value}.`)
                              })
                            }
                          >
                            <option value="manual">Manual only</option>
                            <option value="daily">Once a day</option>
                            <option value="weekly">Once a week</option>
                            <option value="monthly">Once a month</option>
                          </select>
                        </label>
                        <button
                          type="button"
                          className="command-button"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            run("aws-cost-now", async () => {
                              const repo = new URLSearchParams(window.location.search).get("repo")
                              await jsonRequest("/api/aws/cost-refresh", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ repo }),
                              })
                              setMessage("Pulled fresh AWS cost (~$0.01).")
                            })
                          }
                        >
                          {busy === "aws-cost-now" ? <Loader2 className="spin" aria-hidden /> : <Cloud aria-hidden />}
                          Pull cost now ($0.01)
                        </button>
                        <small className="aws-cadence-note">
                          {(() => {
                            const last = (saved.metadata as { costExplorerLastFetchedAt?: string | null }).costExplorerLastFetchedAt
                            return last
                              ? `Last pulled ${new Date(last).toLocaleString()}. Refreshes reuse this until the next scheduled pull.`
                              : "Not pulled yet — set a cadence or pull now. Between pulls, refreshes are free."
                          })()}
                        </small>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <p>Connect a read-only IAM role — no access keys stored. Launch the CloudFormation stack, then paste the role ARN and external ID it uses.</p>
                    <label className="aws-cost-optin">
                      <input type="checkbox" checked={awsCostExplorer} onChange={(event) => setAwsCostExplorer(event.target.checked)} />
                      <span>Also pull cost data via Cost Explorer (AWS bills $0.01 per refresh). Leave off for free-tier usage only ($0).</span>
                    </label>
                    <form
                      className="provider-token-form stacked"
                      onSubmit={(event) => {
                        event.preventDefault()
                        run("aws-connect", async () => {
                          await jsonRequest("/api/aws/connect", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              roleArn: awsRoleArn,
                              externalId: awsExternalId,
                              costExplorer: awsCostExplorer,
                            }),
                          })
                          setAwsRoleArn("")
                          setAwsExternalId("")
                          setMessage("AWS connected via IAM role. Refreshing live usage.")
                        })
                      }}
                    >
                      <input type="text" value={awsRoleArn} onChange={(event) => setAwsRoleArn(event.target.value)} placeholder="arn:aws:iam::<account>:role/infra-cost-analyzer-readonly" autoComplete="off" spellCheck={false} />
                      <input type="text" value={awsExternalId} onChange={(event) => setAwsExternalId(event.target.value)} placeholder="external id (from the stack)" autoComplete="off" spellCheck={false} />
                      <button type="submit" className="command-button" disabled={Boolean(busy) || !awsRoleArn.trim() || !awsExternalId.trim()}>
                        {busy === "aws-connect" ? <Loader2 className="spin" aria-hidden /> : <Cloud aria-hidden />}
                        Verify role
                      </button>
                    </form>
                    <details className="provider-advanced">
                      <summary>Advanced: use access keys instead</summary>
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
                                costExplorer: awsCostExplorer,
                              }),
                            })
                            setAwsAccessKeyId("")
                            setAwsSecretAccessKey("")
                            setAwsSessionToken("")
                            setMessage("AWS connected. Refreshing live usage.")
                          })
                        }}
                      >
                        <input type="text" value={awsAccessKeyId} onChange={(event) => setAwsAccessKeyId(event.target.value)} placeholder="AWS_ACCESS_KEY_ID" autoComplete="off" spellCheck={false} />
                        <input type="password" value={awsSecretAccessKey} onChange={(event) => setAwsSecretAccessKey(event.target.value)} placeholder="AWS_SECRET_ACCESS_KEY" autoComplete="off" />
                        <input type="password" value={awsSessionToken} onChange={(event) => setAwsSessionToken(event.target.value)} placeholder="AWS_SESSION_TOKEN (optional, for temporary credentials)" autoComplete="off" />
                        <button type="submit" className="command-button" disabled={Boolean(busy) || !awsAccessKeyId.trim() || !awsSecretAccessKey.trim()}>
                          {busy === "aws-connect" ? <Loader2 className="spin" aria-hidden /> : <Cloud aria-hidden />}
                          Verify keys
                        </button>
                      </form>
                    </details>
                  </>
                )}
              </article>
            )
          }

          return null
  }

  return (
    <section className="provider-connect-panel" aria-label="Live billing connections">
      <div className="provider-connect-head">
        <div>
          <p>Live Billing Connections</p>
          <h2>Connect providers to show actual costs</h2>
        </div>
        <PlugZap aria-hidden />
      </div>

      {suggestedSet.size > 0 ? (
        <div className="detected-banner" role="status">
          <Radar aria-hidden />
          <p>
            Detected in your synced repos:{" "}
            <strong>{[...suggestedSet].map((provider) => providerLabel(provider)).join(", ")}</strong>. Connect{" "}
            {suggestedSet.size === 1 ? "it" : "them"} below to pull live cost.
          </p>
        </div>
      ) : null}

      <div className="provider-connect-grid">
        {promoted.map((connection) => renderCard(connection))}
      </div>

      {others.length > 0 ? (
        <details className="provider-connect-more">
          <summary>Connect another provider</summary>
          <div className="provider-connect-grid">{others.map((connection) => renderCard(connection))}</div>
        </details>
      ) : null}

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
