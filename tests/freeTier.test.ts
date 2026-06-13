import test from "node:test"
import assert from "node:assert/strict"
import { computeFreeTierUsage } from "../src/lib/freeTier"
import type { NormalizedCostRow, ProviderConnection, ProviderUsageSample } from "../src/lib/types"

function connection(provider: ProviderConnection["provider"], status: ProviderConnection["status"]): ProviderConnection {
  return {
    provider,
    label: provider,
    status,
    authMode: "api_token",
    detected: true,
    requiredSecrets: [],
    setupNotes: "",
  }
}

test("connected provider with zero cost surfaces measured free-tier remaining", () => {
  const usage: ProviderUsageSample[] = [
    { provider: "gcp", service: "Cloud Run", quantity: 500_000, unit: "requests" },
  ]
  const rows = computeFreeTierUsage([], usage, [connection("gcp", "connected")])
  const cloudRun = rows.find((row) => row.service === "Cloud Run Requests")
  assert.ok(cloudRun)
  assert.equal(cloudRun.used, 500_000)
  assert.equal(cloudRun.limit, 2_000_000)
  assert.equal(cloudRun.remaining, 1_500_000)
  assert.equal(cloudRun.source, "measured")
  assert.equal(cloudRun.percentUsed, 25)
})

test("allowance without reported usage is returned with null usage", () => {
  const rows = computeFreeTierUsage([], [], [connection("cloudflare", "connected")])
  assert.ok(rows.length > 0)
  assert.equal(rows.every((row) => row.provider === "cloudflare"), true)
  const workers = rows.find((row) => row.service === "Workers Requests")
  assert.ok(workers)
  assert.equal(workers.used, null)
  assert.equal(workers.remaining, null)
  assert.equal(workers.source, "allowance")
})

test("provider with billed cost is not treated as free tier", () => {
  const costRows: NormalizedCostRow[] = [
    {
      provider: "vercel",
      serviceName: "Vercel Functions",
      resourceId: null,
      resourceName: "repo",
      billingPeriodStart: "2026-06-01",
      billingPeriodEnd: "2026-06-30",
      cost: 12,
      currency: "USD",
      attribution: "verified",
      attributionReason: "live",
      signalId: null,
      source: "live",
    },
  ]
  const rows = computeFreeTierUsage(costRows, [], [connection("vercel", "connected")])
  assert.equal(rows.length, 0)
})

test("disconnected providers are ignored", () => {
  const rows = computeFreeTierUsage([], [], [connection("gcp", "setup_required")])
  assert.equal(rows.length, 0)
})
