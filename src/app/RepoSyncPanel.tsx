"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CheckSquare, ClipboardCopy, ExternalLink, FolderGit2, Github, Info, Square, Unplug } from "lucide-react"
import type { ConnectionEvent, GitHubRepoSummary, Provider } from "@/lib/types"

interface PublicState {
  selectedRepoFullName: string | null
  syncedRepoFullNames: string[]
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

interface GitHubConnectStatus {
  configured: boolean
  setupMode: "owner_setup_required" | "user_authorization"
  url: string | null
  requiredEnv: string[]
  callbackUrl: string
  setupUrl: string
  setupLinks: {
    createGitHubApp: string
    githubAppsSettings: string
    cloudflareWorkerVariables: string
  }
  setupCommands: string[]
  message: string
}

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

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      type="button"
      className="copy-button"
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1400)
          })
          .catch(() => setCopied(false))
      }}
    >
      <ClipboardCopy aria-hidden />
      {copied ? "Copied" : label}
    </button>
  )
}

function GitHubSetupGuide({ status }: { status: GitHubConnectStatus | null }) {
  const callbackUrl = status?.callbackUrl ?? `${typeof window === "undefined" ? "" : window.location.origin}/api/github/callback`
  const setupUrl = status?.setupUrl ?? callbackUrl
  const commands = status?.setupCommands ?? [
    "npx wrangler secret put GITHUB_APP_ID",
    "npx wrangler secret put GITHUB_APP_PRIVATE_KEY",
    "npx wrangler secret put GITHUB_APP_SLUG",
    "npm run deploy",
  ]

  return (
    <details className="github-setup-guide" open>
      <summary>
        <Info aria-hidden />
        <div>
          <strong>Owner setup required once</strong>
          <span>You configure the GitHub App one time for this deployment. After that, every signed-in user only clicks “Choose GitHub repos” and authorizes their own repositories.</span>
        </div>
      </summary>
      <div className="setup-steps">
        <article>
          <span>1</span>
          <div>
            <h3>You create one GitHub App</h3>
            <p>This belongs to your product/deployment, not to each user. GitHub will use it to ask users which repos they want to authorize.</p>
            <div className="setup-links">
              <a className="command-button" href={status?.setupLinks.createGitHubApp ?? "https://github.com/settings/apps/new"} target="_blank" rel="noreferrer">
                <Github aria-hidden />
                Create GitHub App
              </a>
              <a className="ghost-button" href={status?.setupLinks.githubAppsSettings ?? "https://github.com/settings/apps"} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden />
                Existing GitHub Apps
              </a>
            </div>
            <div className="setup-value">
              <label>Callback URL</label>
              <code>{callbackUrl}</code>
              <CopyButton value={callbackUrl} />
            </div>
            <div className="setup-value">
              <label>Setup URL</label>
              <code>{setupUrl}</code>
              <CopyButton value={setupUrl} />
            </div>
          </div>
        </article>

        <article>
          <span>2</span>
          <div>
            <h3>Set repository permissions</h3>
            <p>Use read-only permissions. Users see these permissions during authorization.</p>
            <div className="permission-grid">
              <b>Metadata: Read-only</b>
              <b>Contents: Read-only</b>
              <b>Actions: Read-only</b>
              <b>Deployments: Read-only</b>
            </div>
          </div>
        </article>

        <article>
          <span>3</span>
          <div>
            <h3>Enable return after repo changes</h3>
            <p>In Post installation, paste the same URL into Setup URL and check Redirect on update. This sends users back here after install or repository changes.</p>
            <div className="permission-grid">
              <b>Setup URL: same as callback</b>
              <b>Redirect on update: checked</b>
              <b>Webhook Active: unchecked</b>
              <b>Subscribe to events: none</b>
            </div>
          </div>
        </article>

        <article>
          <span>4</span>
          <div>
            <h3>You add the app credentials to this deployment</h3>
            <p>Copy the App ID, generate a private key, copy the app slug from the GitHub App URL, then add them as Cloudflare Worker secrets.</p>
            <div className="setup-links">
              <a className="command-button" href={status?.setupLinks.cloudflareWorkerVariables ?? "https://dash.cloudflare.com"} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden />
                Open Worker variables
              </a>
            </div>
            <div className="command-list">
              {commands.map((command) => (
                <div key={command} className="setup-value">
                  <code>{command}</code>
                  <CopyButton value={command} />
                </div>
              ))}
            </div>
          </div>
        </article>

        <article>
          <span>5</span>
          <div>
            <h3>After redeploy, users authorize repos themselves</h3>
            <p>This panel changes to “Choose GitHub repos”. Each user clicks it, selects their repositories on GitHub, returns here, and sees only their own synced repos.</p>
          </div>
        </article>
      </div>
    </details>
  )
}

export function RepoSyncPanel({ initialState }: { initialState: PublicState }) {
  const router = useRouter()
  const [state, setState] = React.useState(initialState)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [connectStatus, setConnectStatus] = React.useState<GitHubConnectStatus | null>(null)
  const synced = React.useMemo(() => new Set(state.syncedRepoFullNames), [state.syncedRepoFullNames])
  const github = state.connections.github

  React.useEffect(() => {
    jsonRequest<GitHubConnectStatus>("/api/github/connect-url")
      .then(setConnectStatus)
      .catch((err) => setError(formatError(err)))
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

  return (
    <section className="repo-sync-panel" aria-label="Repository sync">
      <div className="repo-sync-head">
        <div>
          <p>GitHub Repositories</p>
          <h2>Sync more repos</h2>
        </div>
        <span>{state.syncedRepoFullNames.length}/{state.githubRepos.length || 1} synced</span>
      </div>

      <div className="repo-sync-actions">
        {connectStatus?.configured ? (
          <>
            <button
              type="button"
              className="command-button"
              disabled={Boolean(busy)}
              onClick={() =>
                run("github-app", async () => {
                  const payload = await jsonRequest<GitHubConnectStatus>("/api/github/connect-url")
                  if (!payload.configured || !payload.url) throw new Error(payload.message)
                  window.location.href = payload.url
                })
              }
            >
              <Github aria-hidden />
              Choose GitHub repos
            </button>
            <div className="github-user-action-ready" role="status">
              <Info aria-hidden />
              <span>Users authorize their own repos with your GitHub App. Repo access is scoped to each signed-in workspace.</span>
            </div>
          </>
        ) : (
          <div className="github-disabled-action" role="status">
            <Info aria-hidden />
            <div>
              <strong>GitHub App is not configured on this deployment</strong>
              <span>This is a one-time owner setup. After these credentials are added, every user can authorize their own GitHub repos without seeing these setup steps.</span>
            </div>
          </div>
        )}
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
            Disconnect GitHub
          </button>
        ) : null}
      </div>

      {!connectStatus?.configured ? <GitHubSetupGuide status={connectStatus} /> : null}

      {state.githubRepos.length ? (
        <div className="sync-repo-list">
          {state.githubRepos.map((repo) => {
            const isSynced = synced.has(repo.fullName)
            return (
              <article key={repo.fullName} className={isSynced ? "sync-repo-row synced" : "sync-repo-row"}>
                <button
                  type="button"
                  className={isSynced ? "repo-sync-toggle on" : "repo-sync-toggle"}
                  disabled={Boolean(busy)}
                  aria-pressed={isSynced}
                  aria-label={`${isSynced ? "Stop syncing" : "Sync"} ${repo.fullName}`}
                  onClick={() =>
                    run(`repo-${isSynced ? "unsync" : "sync"}`, async () => {
                      await jsonRequest("/api/github/select-repo", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ fullName: repo.fullName, action: isSynced ? "unsync" : "sync" }),
                      })
                      setMessage(`${isSynced ? "Removed" : "Synced"} ${repo.fullName}.`)
                    })
                  }
                >
                  {isSynced ? <CheckSquare aria-hidden /> : <Square aria-hidden />}
                </button>
                <div>
                  <strong>{repo.fullName}</strong>
                  <span>{repo.private ? "Private" : "Public"} · {repo.defaultBranch}</span>
                </div>
                <button
                  type="button"
                  className="repo-open-link"
                  disabled={Boolean(busy) || !isSynced}
                  onClick={() =>
                    run("repo-open", async () => {
                      await jsonRequest("/api/github/select-repo", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ fullName: repo.fullName, action: "select" }),
                      })
                      router.push(`/?repo=${encodeURIComponent(repo.fullName)}`)
                    })
                  }
                >
                  <FolderGit2 aria-hidden />
                  Open
                </button>
                <a className="repo-external-link" href={repo.htmlUrl} target="_blank" rel="noreferrer" aria-label={`Open ${repo.fullName} on GitHub`}>
                  <ExternalLink aria-hidden />
                </a>
              </article>
            )
          })}
        </div>
      ) : (
        <div className="empty-repo-state">
          <Github aria-hidden />
          <strong>No GitHub repositories synced yet</strong>
          <span>{connectStatus?.configured ? "Authorize the GitHub App and choose repositories to analyze." : "Configure the GitHub App to let users authorize and select their GitHub repos."}</span>
        </div>
      )}

      {message ? <div className="flow-message success">{message}</div> : null}
      {error ? <div className="flow-message error">{error}</div> : null}
    </section>
  )
}
