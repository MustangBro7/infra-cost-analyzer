"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2, MinusCircle, PlusCircle } from "lucide-react"
import type { NormalizedCostRow } from "@/lib/types"
import { ACCOUNT_SENTINEL, costItemKey, isAssignedHere, manualTarget } from "@/lib/costAttribution"

function money(value: number) {
  const abs = Math.abs(value)
  const fractionDigits = abs > 0 && (abs < 1000 || value % 1 !== 0) ? 2 : 0
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(value)
}

/**
 * Renders an account's billing line items split into "this project" (assigned
 * here, manually or auto) and "rest of this account", with controls to assign or
 * remove each item by hand — so the user can split an account's cost across repos.
 */
export function ProviderCostPanel({
  rows,
  repoFullName,
  selectedShort,
  assignments,
  repoLabels,
}: {
  rows: NormalizedCostRow[]
  repoFullName: string
  selectedShort: string
  assignments: Record<string, string>
  repoLabels: Record<string, string>
}) {
  const router = useRouter()
  const [busyKey, setBusyKey] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function assign(row: NormalizedCostRow, target: string | null) {
    const key = costItemKey(row)
    setBusyKey(key)
    setError(null)
    try {
      const response = await fetch("/api/repos/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemKey: key, target }),
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

  const here = rows.filter((row) => isAssignedHere(row, assignments, repoFullName, selectedShort))
  const rest = rows.filter((row) => !isAssignedHere(row, assignments, repoFullName, selectedShort))

  function Row({ row, mode }: { row: NormalizedCostRow; mode: "here" | "rest" }) {
    const key = costItemKey(row)
    const target = manualTarget(row, assignments)
    const auto = !target && (row.attributedRepo ?? null) !== null
    const elsewhere = mode === "rest" && target && target !== repoFullName ? repoLabels[target] ?? target : null
    return (
      <article className="resource-row assignable">
        <div>
          <strong>{row.serviceName}</strong>
          <span>{row.resourceName ?? row.resourceId ?? "Unmapped resource"}</span>
          <small>
            {mode === "here" && auto ? "Auto-matched to this repo" : mode === "here" ? "Assigned to this repo" : elsewhere ? `Assigned to ${elsewhere}` : "Not assigned"}
          </small>
        </div>
        <b>{money(row.cost)}</b>
        {mode === "here" ? (
          <button type="button" className="assign-btn remove" disabled={busyKey === key} onClick={() => assign(row, ACCOUNT_SENTINEL)} title="Remove from this repo">
            {busyKey === key ? <Loader2 className="spin" aria-hidden /> : <MinusCircle aria-hidden />}
            Remove
          </button>
        ) : (
          <button type="button" className="assign-btn add" disabled={busyKey === key} onClick={() => assign(row, repoFullName)} title="Assign to this repo">
            {busyKey === key ? <Loader2 className="spin" aria-hidden /> : <PlusCircle aria-hidden />}
            {elsewhere ? "Move here" : "Assign"}
          </button>
        )}
      </article>
    )
  }

  return (
    <div className="provider-cost-panel">
      {here.length ? (
        <div className="cost-group">
          <h4 className="cost-group-label project">This project</h4>
          <div className="resource-list">
            {here.map((row) => (
              <Row key={costItemKey(row)} row={row} mode="here" />
            ))}
          </div>
        </div>
      ) : null}
      {rest.length ? (
        <div className="cost-group">
          <h4 className="cost-group-label rest">Rest of this account</h4>
          <p className="cost-group-note">Billed to this account. Assign any line item to this repo to count it here.</p>
          <div className="resource-list">
            {rest.map((row) => (
              <Row key={costItemKey(row)} row={row} mode="rest" />
            ))}
          </div>
        </div>
      ) : null}
      {error ? <p className="repo-accounts-error">{error}</p> : null}
    </div>
  )
}
