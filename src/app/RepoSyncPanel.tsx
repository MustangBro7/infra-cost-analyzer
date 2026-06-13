"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CheckSquare, ExternalLink, FolderGit2, Github, Info, Loader2, Plus, Square, Unplug } from "lucide-react"
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
  url: string | null
  requiredEnv: string[]
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
        ) : (
          <div className="github-disabled-action" role="status">
            <Info aria-hidden />
            <div>
              <strong>GitHub App is not configured on this deployment</strong>
              <span>Only the local repo can be synced until `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_SLUG` are set in the Worker environment.</span>
            </div>
          </div>
        )}
        <button
          type="button"
          className="ghost-button"
          disabled={Boolean(busy)}
          onClick={() =>
            run("github-local", async () => {
              await jsonRequest("/api/github/local-connect", { method: "POST" })
              setMessage("Local repository synced.")
            })
          }
        >
          {busy === "github-local" ? <Loader2 className="spin" aria-hidden /> : <Plus aria-hidden />}
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
            Disconnect GitHub
          </button>
        ) : null}
      </div>

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
          <span>{connectStatus?.configured ? "Choose GitHub repos or use the local repository to start." : "Use the local repository for now. Configure the GitHub App to select multiple GitHub repos."}</span>
        </div>
      )}

      {message ? <div className="flow-message success">{message}</div> : null}
      {error ? <div className="flow-message error">{error}</div> : null}
    </section>
  )
}
