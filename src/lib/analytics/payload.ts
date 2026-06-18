import type { AnalysisSnapshot, NormalizedCostRow } from "../types"
import { isAssignedHere, isKeyAssignedHere } from "../costAttribution"
import { costFactKey, costItemKey, observationId, resourceFactKey, usageFactKey } from "./keys"
import type { AnalyticsCostObservation, AnalyticsPayload, AnalyticsSource } from "./types"

function aggregateCostRows(rows: NormalizedCostRow[]): Array<Omit<AnalyticsCostObservation, "observationId">> {
  const aggregated = new Map<string, Omit<AnalyticsCostObservation, "observationId">>()
  for (const row of rows) {
    const factKey = costFactKey(row)
    const existing = aggregated.get(factKey)
    if (existing) {
      existing.cost = Number((existing.cost + row.cost).toFixed(6))
      continue
    }
    aggregated.set(factKey, {
      factKey,
      providerAccountId: null,
      provider: row.provider,
      serviceName: row.serviceName,
      resourceId: row.resourceId,
      resourceName: row.resourceName,
      billingPeriodStart: row.billingPeriodStart,
      billingPeriodEnd: row.billingPeriodEnd,
      cost: Number(row.cost.toFixed(6)),
      currency: row.currency.toUpperCase(),
      attribution: row.attribution,
      attributionReason: row.attributionReason,
      signalId: row.signalId,
      attributedRepo: row.attributedRepo ?? null,
      itemKey: costItemKey(row),
    })
  }
  return [...aggregated.values()]
}

export function analyticsPayloadFromSnapshot(input: {
  userId: string
  snapshot: AnalysisSnapshot
  syncRunId: string
  source?: AnalyticsSource
  costAssignments?: Record<string, string>
}): AnalyticsPayload {
  const { snapshot, syncRunId } = input
  const repoFullName = snapshot.key.startsWith("__") ? null : snapshot.key
  const assignments = input.costAssignments ?? {}
  const repoShortName = snapshot.analysis.repo.name.toLowerCase()
  const costRows = repoFullName
    ? snapshot.analysis.costRows.filter((row) =>
        isAssignedHere(row, assignments, repoFullName, repoShortName)
      )
    : snapshot.analysis.costRows
  const resourceRows = repoFullName
    ? snapshot.analysis.resourceItems.filter((row) =>
        isKeyAssignedHere(row.itemKey, row.attributedRepo, assignments, repoFullName, repoShortName)
      )
    : snapshot.analysis.resourceItems
  return {
    syncRunId,
    userId: input.userId,
    snapshotKey: snapshot.key,
    repoFullName,
    periodStart: snapshot.analysis.period.from,
    periodEnd: snapshot.analysis.period.to,
    computedAt: snapshot.computedAt,
    source: input.source ?? "live",
    costs: aggregateCostRows(costRows).map((row) => ({
      ...row,
      observationId: observationId(syncRunId, row.factKey),
    })),
    usage: snapshot.analysis.freeTier.map((row) => {
      const factKey = usageFactKey(row)
      return {
        observationId: observationId(syncRunId, factKey),
        factKey,
        provider: row.provider,
        planName: row.planName,
        service: row.service,
        used: row.used,
        limit: row.limit,
        unit: row.unit,
        remaining: row.remaining,
        percentUsed: row.percentUsed,
        source: row.source,
        note: row.note,
      }
    }),
    resources: resourceRows.map((row) => {
      const factKey = resourceFactKey(row)
      return {
        observationId: observationId(syncRunId, factKey),
        factKey,
        provider: row.provider,
        itemKey: row.itemKey,
        kind: row.kind,
        name: row.name,
        quantity: row.quantity,
        unit: row.unit,
        attributedRepo: row.attributedRepo ?? null,
      }
    }),
  }
}
