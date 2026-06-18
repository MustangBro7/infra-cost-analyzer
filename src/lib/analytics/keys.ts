import { createHash } from "node:crypto"
import type { FreeTierUsageRow, NormalizedCostRow, ResourceUsageItem } from "../types"

function digest(parts: Array<string | null | undefined>): string {
  return createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\u001f"))
    .digest("hex")
}

export function costItemKey(row: NormalizedCostRow): string {
  return `${row.provider}::${row.serviceName}::${row.resourceId ?? row.resourceName ?? ""}`.toLowerCase()
}

export function costFactKey(row: NormalizedCostRow): string {
  return digest([
    "cost",
    row.provider,
    row.serviceName,
    row.resourceId,
    row.resourceName,
    row.currency.toUpperCase(),
    row.attributedRepo?.toLowerCase(),
  ])
}

export function usageFactKey(row: FreeTierUsageRow): string {
  return digest(["usage", row.provider, row.planName, row.service, row.unit, row.source])
}

export function resourceFactKey(row: ResourceUsageItem): string {
  return digest(["resource", row.provider, row.itemKey, row.kind, row.name, row.unit])
}

export function observationId(syncRunId: string, factKey: string): string {
  return digest([syncRunId, factKey])
}

export function deterministicSyncRunId(userId: string, snapshotKey: string, computedAt: string): string {
  const hex = digest(["sync", userId, snapshotKey, computedAt]).slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
}
