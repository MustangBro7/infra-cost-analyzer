import test from "node:test"
import assert from "node:assert/strict"
import { carryForwardOnError } from "../src/lib/costEngine"
import type { AnalysisResult, FreeTierUsageRow, NormalizedCostRow } from "../src/lib/types"

function liveResult(status: "success" | "error" | "empty", overrides: Partial<{ rows: NormalizedCostRow[]; usage: { provider: string; service: string; quantity: number; unit: string }[] }> = {}) {
  return {
    rows: overrides.rows ?? [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    usage: (overrides.usage ?? []) as any,
    sync: { provider: "cloudflare" as const, status, message: "Cloudflare usage query failed.", rows: 0, syncedAt: "2026-06-24T00:00:00Z" },
  }
}

function previousWith(measured: Partial<FreeTierUsageRow>[]): AnalysisResult {
  const freeTier = measured.map((m) => ({ provider: "cloudflare", planName: "Cloudflare Free", service: "Workers Requests", used: 1000, limit: 3_000_000, unit: "requests/mo", remaining: 0, percentUsed: 0, source: "measured", note: "", ...m })) as FreeTierUsageRow[]
  return { costRows: [], freeTier, resourceItems: [] } as unknown as AnalysisResult
}

test("carries forward last-known-good usage when a connected provider errors with nothing", () => {
  const previous = previousWith([{ service: "Workers Requests", used: 19_256 }])
  const out = carryForwardOnError(liveResult("error"), previous)
  assert.equal(out.usage.length, 1)
  assert.equal(out.usage[0].quantity, 19_256)
  assert.equal(out.sync.status, "success")
  assert.match(out.sync.message, /last-known-good/)
})

test("does not touch a successful pull", () => {
  const previous = previousWith([{ service: "Workers Requests", used: 19_256 }])
  const out = carryForwardOnError(liveResult("success"), previous)
  assert.equal(out.usage.length, 0)
  assert.equal(out.sync.status, "success")
  assert.doesNotMatch(out.sync.message, /last-known-good/)
})

test("does nothing without a previous snapshot", () => {
  const out = carryForwardOnError(liveResult("error"), undefined)
  assert.equal(out.usage.length, 0)
  assert.equal(out.sync.status, "error")
})

test("does nothing when the previous snapshot has no data for the provider", () => {
  const previous = { costRows: [], freeTier: [], resourceItems: [] } as unknown as AnalysisResult
  const out = carryForwardOnError(liveResult("error"), previous)
  assert.equal(out.usage.length, 0)
  assert.equal(out.sync.status, "error")
})

test("skips allowance-only previous rows (only measured usage is carried)", () => {
  const previous = previousWith([{ service: "Workers Requests", used: null, source: "allowance" }])
  const out = carryForwardOnError(liveResult("error"), previous)
  assert.equal(out.usage.length, 0)
  assert.equal(out.sync.status, "error")
})

test("never carries a previous month's snapshot into the new month", () => {
  // June snapshot with real usage + cost, but the refresh is running in July:
  // the error must surface as an error with $0, not resurrect June's numbers.
  const previous = previousWith([{ service: "Workers Requests", used: 19_256 }])
  previous.period = { from: "2026-06-01", to: "2026-06-30" }
  previous.costRows = [
    {
      provider: "cloudflare",
      serviceName: "Workers Paid",
      resourceId: null,
      resourceName: "acct",
      billingPeriodStart: "2026-06-01",
      billingPeriodEnd: "2026-06-30",
      cost: 5,
      currency: "USD",
      attribution: "verified",
      attributionReason: "",
      signalId: null,
    } as NormalizedCostRow,
  ]
  const out = carryForwardOnError(liveResult("error"), previous, "2026-07-01")
  assert.equal(out.rows.length, 0)
  assert.equal(out.usage.length, 0)
  assert.equal(out.sync.status, "error")
})

test("carries forward within the same billing month", () => {
  const previous = previousWith([{ service: "Workers Requests", used: 19_256 }])
  previous.period = { from: "2026-07-01", to: "2026-07-31" }
  const out = carryForwardOnError(liveResult("error"), previous, "2026-07-01")
  assert.equal(out.usage.length, 1)
  assert.equal(out.sync.status, "success")
})
