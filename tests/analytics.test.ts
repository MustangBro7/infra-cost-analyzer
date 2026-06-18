import test from "node:test"
import assert from "node:assert/strict"
import type { AnalysisSnapshot } from "../src/lib/types"
import { analyticsPayloadFromSnapshot } from "../src/lib/analytics/payload"
import { costFactKey, deterministicSyncRunId, observationId } from "../src/lib/analytics/keys"
import { validateMonth, validateMonthRange } from "../src/lib/analytics/queries"
import { analyticsReadsEnabled, analyticsWritesEnabled, resolveAnalyticsConnectionString } from "../src/lib/analytics/connection"
import {
  analyticsOutboxPendingCount,
  drainAnalyticsOutbox,
  enqueueAnalyticsPayload,
  setAnalyticsOutboxDatabaseForTests,
  setAnalyticsOutboxWriterForTests,
} from "../src/lib/analytics/outbox"

function snapshot(): AnalysisSnapshot {
  return {
    key: "__overview__",
    computedAt: "2026-06-19T10:00:00.000Z",
    analysis: {
      repo: { name: "overview", owner: "account", path: "", remoteUrl: null, scannedAt: "2026-06-19T10:00:00.000Z" },
      period: { from: "2026-06-01", to: "2026-06-30" },
      summary: { totalCost: 5, exactCost: 5, inferredCost: 0, detectedProviders: 1, signals: 0, confidence: 0 },
      signals: [],
      providerConnections: [],
      providerBreakdown: [],
      costRows: [
        {
          provider: "cloudflare",
          serviceName: "Workers Paid",
          resourceId: "sub-1",
          resourceName: "Acme",
          billingPeriodStart: "2026-06-01",
          billingPeriodEnd: "2026-06-30",
          cost: 2,
          currency: "usd",
          attribution: "verified",
          attributionReason: "Live subscription.",
          signalId: "one",
          attributedRepo: null,
        },
        {
          provider: "cloudflare",
          serviceName: "Workers Paid",
          resourceId: "sub-1",
          resourceName: "Acme",
          billingPeriodStart: "2026-06-01",
          billingPeriodEnd: "2026-06-30",
          cost: 3,
          currency: "USD",
          attribution: "verified",
          attributionReason: "Live subscription.",
          signalId: "two",
          attributedRepo: null,
        },
      ],
      freeTier: [],
      resourceItems: [],
      actions: [],
      liveSync: [],
    },
  }
}

test("analytics keys and D1 backfill sync IDs are stable", () => {
  const row = snapshot().analysis.costRows[0]
  assert.equal(costFactKey(row), costFactKey({ ...row }))
  const sync = deterministicSyncRunId("user_1", "__overview__", "2026-06-19T10:00:00.000Z")
  assert.equal(sync, deterministicSyncRunId("user_1", "__overview__", "2026-06-19T10:00:00.000Z"))
  assert.match(sync, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(observationId(sync, "fact"), observationId(sync, "fact"))
})

test("equivalent cost rows aggregate without mixing currencies", () => {
  const source = snapshot()
  source.analysis.costRows.push({ ...source.analysis.costRows[0], cost: 7, currency: "EUR" })
  const payload = analyticsPayloadFromSnapshot({ userId: "user_1", snapshot: source, syncRunId: "run-1" })
  assert.equal(payload.costs.length, 2)
  assert.equal(payload.costs.find((row) => row.currency === "USD")?.cost, 5)
  assert.equal(payload.costs.find((row) => row.currency === "EUR")?.cost, 7)
  assert.equal(payload.repoFullName, null)
})

test("repo analytical payload includes only rows assigned to that repo", () => {
  const source = snapshot()
  source.key = "acme/api"
  source.analysis.repo = { ...source.analysis.repo, owner: "acme", name: "api" }
  source.analysis.costRows = [
    { ...source.analysis.costRows[0], resourceId: "api-worker", attributedRepo: "api", cost: 4 },
    { ...source.analysis.costRows[0], resourceId: "shared-worker", attributedRepo: null, cost: 9 },
  ]
  const payload = analyticsPayloadFromSnapshot({
    userId: "user_1",
    snapshot: source,
    syncRunId: "run-repo",
    costAssignments: {},
  })
  assert.equal(payload.repoFullName, "acme/api")
  assert.equal(payload.costs.length, 1)
  assert.equal(payload.costs[0].cost, 4)
})

test("analytics month validation enforces format, order, and 24-month limit", () => {
  assert.equal(validateMonth("2026-06"), "2026-06")
  assert.doesNotThrow(() => validateMonthRange("2025-07", "2026-06"))
  assert.throws(() => validateMonth("2026-6"))
  assert.throws(() => validateMonthRange("2026-07", "2026-06"))
  assert.throws(() => validateMonthRange("2024-06", "2026-06"))
})

test("analytics connection flags and direct local connection resolution", async () => {
  assert.equal(analyticsWritesEnabled({ MOTHERDUCK_DATABASE_URL: "postgres://dev" }), true)
  assert.equal(analyticsWritesEnabled({ MOTHERDUCK_DATABASE_URL: "postgres://dev", ANALYTICS_ENABLED: "false" }), false)
  assert.equal(analyticsReadsEnabled({ MOTHERDUCK_DATABASE_URL: "postgres://dev", ANALYTICS_READS_ENABLED: "false" }), false)
  assert.equal(
    await resolveAnalyticsConnectionString({ ANALYTICS_DB: { connectionString: "postgres://hyperdrive" } }),
    "postgres://hyperdrive"
  )
})

test("analytics outbox retries idempotently and marks successful delivery", async () => {
  const payload = analyticsPayloadFromSnapshot({ userId: "user_1", snapshot: snapshot(), syncRunId: "run-outbox" })
  setAnalyticsOutboxDatabaseForTests(null)
  let attempts = 0
  setAnalyticsOutboxWriterForTests(async () => {
    attempts += 1
    if (attempts === 1) throw new Error("temporary outage")
  })
  try {
    await enqueueAnalyticsPayload(payload, new Error("initial outage"))
    assert.equal(await analyticsOutboxPendingCount(), 1)
    assert.deepEqual(await drainAnalyticsOutbox(), { delivered: 0, failed: 1 })
    assert.equal(await analyticsOutboxPendingCount(), 1)
    setAnalyticsOutboxDatabaseForTests(null)
    await enqueueAnalyticsPayload(payload, new Error("initial outage"))
    assert.deepEqual(await drainAnalyticsOutbox(), { delivered: 1, failed: 0 })
    assert.equal(await analyticsOutboxPendingCount(), 0)
  } finally {
    setAnalyticsOutboxWriterForTests(null)
    setAnalyticsOutboxDatabaseForTests(undefined)
  }
})
