import type { Client } from "pg"
import { withAnalyticsClient } from "./connection"
import type { AnalyticsPayload } from "./types"

async function insertRows(
  client: Client,
  table: string,
  columns: string[],
  rows: unknown[][]
): Promise<void> {
  if (rows.length === 0) return
  const chunkSize = Math.max(1, Math.floor(500 / columns.length))
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize)
    const values: unknown[] = []
    const placeholders = chunk.map((row) => {
      const tuple = row.map((value) => {
        values.push(value)
        return `$${values.length}`
      })
      return `(${tuple.join(", ")})`
    })
    await client.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders.join(", ")} ON CONFLICT DO NOTHING`,
      values
    )
  }
}

export async function writeAnalyticsPayload(payload: AnalyticsPayload): Promise<void> {
  await withAnalyticsClient(async (client) => {
    await client.query("BEGIN")
    try {
      await client.query(
        `INSERT INTO analytics_sync_runs (
          sync_run_id, user_id, snapshot_key, repo_full_name, period_start, period_end,
          computed_at, source, status, cost_row_count, usage_row_count, resource_row_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'complete', $9, $10, $11)
        ON CONFLICT DO NOTHING`,
        [
          payload.syncRunId,
          payload.userId,
          payload.snapshotKey,
          payload.repoFullName,
          payload.periodStart,
          payload.periodEnd,
          payload.computedAt,
          payload.source,
          payload.costs.length,
          payload.usage.length,
          payload.resources.length,
        ]
      )

      await insertRows(
        client,
        "cost_observations",
        [
          "observation_id", "sync_run_id", "user_id", "snapshot_key", "repo_full_name", "fact_key",
          "provider_account_id", "provider", "service_name", "resource_id", "resource_name",
          "billing_period_start", "billing_period_end", "cost", "currency", "attribution",
          "attribution_reason", "signal_id", "attributed_repo", "item_key", "observed_at",
        ],
        payload.costs.map((row) => [
          row.observationId, payload.syncRunId, payload.userId, payload.snapshotKey, payload.repoFullName,
          row.factKey, row.providerAccountId, row.provider, row.serviceName, row.resourceId, row.resourceName,
          row.billingPeriodStart, row.billingPeriodEnd, row.cost, row.currency, row.attribution,
          row.attributionReason, row.signalId, row.attributedRepo, row.itemKey, payload.computedAt,
        ])
      )

      await insertRows(
        client,
        "usage_observations",
        [
          "observation_id", "sync_run_id", "user_id", "snapshot_key", "repo_full_name", "fact_key",
          "provider", "plan_name", "service", "used", "usage_limit", "unit", "remaining",
          "percent_used", "source", "note", "period_start", "period_end", "observed_at",
        ],
        payload.usage.map((row) => [
          row.observationId, payload.syncRunId, payload.userId, payload.snapshotKey, payload.repoFullName,
          row.factKey, row.provider, row.planName, row.service, row.used, row.limit, row.unit, row.remaining,
          row.percentUsed, row.source, row.note, payload.periodStart, payload.periodEnd, payload.computedAt,
        ])
      )

      await insertRows(
        client,
        "resource_observations",
        [
          "observation_id", "sync_run_id", "user_id", "snapshot_key", "repo_full_name", "fact_key",
          "provider", "item_key", "kind", "name", "quantity", "unit", "attributed_repo",
          "period_start", "period_end", "observed_at",
        ],
        payload.resources.map((row) => [
          row.observationId, payload.syncRunId, payload.userId, payload.snapshotKey, payload.repoFullName,
          row.factKey, row.provider, row.itemKey, row.kind, row.name, row.quantity, row.unit,
          row.attributedRepo, payload.periodStart, payload.periodEnd, payload.computedAt,
        ])
      )
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    }
  })
}
