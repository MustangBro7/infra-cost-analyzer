"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Check, Loader2, PlugZap, Plus } from "lucide-react"
import type { Provider } from "@/lib/types"
import { ProviderLogo } from "./ProviderLogo"

function providerName(provider: Provider) {
  if (provider === "gcp") return "Google Cloud"
  if (provider === "aws") return "AWS"
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

/**
 * Lets a repo pick which already-connected provider accounts it uses. Toggling a
 * chip saves the link and refreshes so the repo's cost re-filters to those
 * accounts. New accounts are connected on the Overview (the single place that
 * holds general account credentials).
 */
export function RepoAccountPicker({
  repo,
  connected,
  detectedNotConnected,
  linked,
}: {
  repo: string
  connected: { provider: Provider; accountLabel: string | null }[]
  detectedNotConnected: Provider[]
  linked: Provider[]
}) {
  const router = useRouter()
  const [selected, setSelected] = React.useState<Provider[]>(linked)
  const [busy, setBusy] = React.useState<Provider | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => setSelected(linked), [linked])

  async function toggle(provider: Provider) {
    const next = selected.includes(provider) ? selected.filter((p) => p !== provider) : [...selected, provider]
    setSelected(next)
    setBusy(provider)
    setError(null)
    try {
      const response = await fetch("/api/repos/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, providers: next }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(payload.error ?? "Could not update accounts.")
      }
      router.refresh()
    } catch (err) {
      setSelected(selected) // revert
      setError(err instanceof Error ? err.message : "Could not update accounts.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="repo-accounts" aria-label="Accounts for this repo">
      <div className="repo-accounts-head">
        <div>
          <p>Accounts For This Repo</p>
          <h2>Which connected accounts does this repo use?</h2>
          <span>Cost and usage below are filtered to just the accounts you tick here.</span>
        </div>
        <PlugZap aria-hidden />
      </div>

      {connected.length > 0 ? (
        <div className="repo-accounts-chips">
          {connected.map(({ provider, accountLabel }) => {
            const on = selected.includes(provider)
            return (
              <button
                key={provider}
                type="button"
                className={on ? "account-chip on" : "account-chip"}
                disabled={busy === provider}
                aria-pressed={on}
                onClick={() => toggle(provider)}
              >
                <span className="account-chip-check">
                  {busy === provider ? <Loader2 className="spin" aria-hidden /> : on ? <Check aria-hidden /> : null}
                </span>
                <ProviderLogo provider={provider} />
                <span className="account-chip-id">
                  <strong>{providerName(provider)}</strong>
                  <small>{accountLabel ?? "Connected"}</small>
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <p className="repo-accounts-empty">
          No provider accounts are connected yet. Connect one on the Overview, then come back to pick it.
        </p>
      )}

      {detectedNotConnected.length > 0 ? (
        <div className="repo-accounts-detected">
          <Plus aria-hidden />
          <span>
            This repo also uses{" "}
            <strong>{detectedNotConnected.map((provider) => providerName(provider)).join(", ")}</strong>, which{" "}
            {detectedNotConnected.length === 1 ? "isn't" : "aren't"} connected yet.{" "}
            <Link href="/dashboard?view=credentials" prefetch={false}>Connect on Credentials →</Link>
          </span>
        </div>
      ) : null}

      {error ? <p className="repo-accounts-error">{error}</p> : null}
    </section>
  )
}
