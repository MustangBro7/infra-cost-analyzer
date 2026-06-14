"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Boxes, Loader2, MinusCircle, PlusCircle } from "lucide-react"
import type { ResourceUsageItem } from "@/lib/types"
import { ACCOUNT_SENTINEL, isKeyAssignedHere, manualTargetForKey } from "@/lib/costAttribution"

function quantity(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
}

/**
 * Lists an account's infra resources (e.g. Cloudflare Workers per script,
 * domains) split into "this project" vs "account resources", with Assign / Move
 * here / Remove controls — so the user can attribute individual resources to a
 * repo for drilled-down usage visibility.
 */
export function ProviderResourcePanel({
  items,
  repoFullName,
  selectedShort,
  assignments,
  repoLabels,
}: {
  items: ResourceUsageItem[]
  repoFullName: string
  selectedShort: string
  assignments: Record<string, string>
  repoLabels: Record<string, string>
}) {
  const router = useRouter()
  const [busyKey, setBusyKey] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function assign(itemKey: string, target: string | null) {
    setBusyKey(itemKey)
    setError(null)
    try {
      const response = await fetch("/api/repos/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemKey, target }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(payload.error ?? "Could not update assignment.")
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update assignment.")
    } finally {
      setBusyKey(null)
    }
  }

  const here = items.filter((item) => isKeyAssignedHere(item.itemKey, item.attributedRepo, assignments, repoFullName, selectedShort))
  const rest = items.filter((item) => !isKeyAssignedHere(item.itemKey, item.attributedRepo, assignments, repoFullName, selectedShort))

  function Row({ item, mode }: { item: ResourceUsageItem; mode: "here" | "rest" }) {
    const target = manualTargetForKey(item.itemKey, assignments)
    const auto = !target && (item.attributedRepo ?? null) !== null
    const elsewhere = mode === "rest" && target && target !== repoFullName ? repoLabels[target] ?? target : null
    return (
      <article className="resource-row assignable">
        <div>
          <strong>
            <span className="resource-kind">{item.kind}</span> {item.name}
          </strong>
          <span>{quantity(item.quantity)} {item.unit}</span>
          <small>{mode === "here" && auto ? "Auto-matched to this repo" : mode === "here" ? "Assigned to this repo" : elsewhere ? `Assigned to ${elsewhere}` : "Not assigned"}</small>
        </div>
        {mode === "here" ? (
          <button type="button" className="assign-btn remove" disabled={busyKey === item.itemKey} onClick={() => assign(item.itemKey, ACCOUNT_SENTINEL)}>
            {busyKey === item.itemKey ? <Loader2 className="spin" aria-hidden /> : <MinusCircle aria-hidden />}
            Remove
          </button>
        ) : (
          <button type="button" className="assign-btn add" disabled={busyKey === item.itemKey} onClick={() => assign(item.itemKey, repoFullName)}>
            {busyKey === item.itemKey ? <Loader2 className="spin" aria-hidden /> : <PlusCircle aria-hidden />}
            {elsewhere ? "Move here" : "Assign"}
          </button>
        )}
      </article>
    )
  }

  return (
    <div className="provider-resource-panel">
      <h4 className="resource-panel-head">
        <Boxes aria-hidden /> Infrastructure resources
      </h4>
      {here.length ? (
        <div className="cost-group">
          <h4 className="cost-group-label project">This project</h4>
          <div className="resource-list">
            {here.map((item) => (
              <Row key={item.itemKey} item={item} mode="here" />
            ))}
          </div>
        </div>
      ) : null}
      {rest.length ? (
        <div className="cost-group">
          <h4 className="cost-group-label rest">Account resources</h4>
          <p className="cost-group-note">Assign any resource to this repo to track its usage here.</p>
          <div className="resource-list">
            {rest.map((item) => (
              <Row key={item.itemKey} item={item} mode="rest" />
            ))}
          </div>
        </div>
      ) : null}
      {error ? <p className="repo-accounts-error">{error}</p> : null}
    </div>
  )
}
