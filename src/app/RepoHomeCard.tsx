"use client"

import * as React from "react"
import { Github, Loader2, Trash2 } from "lucide-react"
import { useRouter } from "next/navigation"

export function RepoHomeCard({
  fullName,
  isPrivate,
  defaultBranch,
  active,
  headline,
  detail,
}: {
  fullName: string
  isPrivate: boolean
  defaultBranch: string
  active: boolean
  headline: string
  detail: string
}) {
  const router = useRouter()
  const [removing, setRemoving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function remove() {
    setRemoving(true)
    setError(null)
    try {
      const response = await fetch("/api/github/select-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, action: "unsync" }),
      })
      const body = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(body.error ?? "Could not remove repository.")
      router.refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove repository.")
      setRemoving(false)
    }
  }

  return (
    <article className={active ? "repo-home-card active" : "repo-home-card"}>
      <a href={`/dashboard?repo=${encodeURIComponent(fullName)}`} className="repo-home-card-link">
        <div className="repo-home-card-head">
          <Github aria-hidden />
          <span>{isPrivate ? "Private" : "Public"}</span>
        </div>
        <h2>{fullName}</h2>
        <p>{defaultBranch}</p>
        <div className="repo-card-metrics">
          <strong>{headline}</strong>
          <span>{detail}</span>
        </div>
      </a>
      <button type="button" className="repo-card-remove" disabled={removing} onClick={remove}>
        {removing ? <Loader2 className="spin" aria-hidden /> : <Trash2 aria-hidden />}
        Remove repo
      </button>
      {error ? <small className="repo-card-error">{error}</small> : null}
    </article>
  )
}
