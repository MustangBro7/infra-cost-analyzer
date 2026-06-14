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

test("a billing provider shows no allowance-only lines (avoids noise)", () => {
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

test("usage is shown married with cost when measured (provider is billing)", () => {
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
  const usage: ProviderUsageSample[] = [{ provider: "vercel", service: "Fast Data Transfer", quantity: 120, unit: "GB" }]
  const rows = computeFreeTierUsage(costRows, usage, [connection("vercel", "connected")])
  const transfer = rows.find((row) => row.service === "Fast Data Transfer")
  assert.ok(transfer)
  assert.equal(transfer.used, 120)
  assert.equal(transfer.remaining, 0)
  assert.equal(transfer.source, "measured")
})

test("reported usage with no published allowance is still shown (limit unknown)", () => {
  const usage: ProviderUsageSample[] = [
    { provider: "cloudflare", service: "R2 Operations", quantity: 42_000, unit: "operations" },
  ]
  const rows = computeFreeTierUsage([], usage, [connection("cloudflare", "connected")])
  const ops = rows.find((row) => row.service === "R2 Operations")
  assert.ok(ops, "R2 Operations usage must be shown even without a published limit")
  assert.equal(ops.used, 42_000)
  assert.equal(ops.limit, null)
  assert.equal(ops.remaining, null)
  assert.equal(ops.percentUsed, null)
  assert.equal(ops.source, "measured")
})

test("reported usage on a billing provider is shown even with no allowance match", () => {
  const costRows: NormalizedCostRow[] = [
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
      attributionReason: "live",
      signalId: null,
      source: "live",
    },
  ]
  const usage: ProviderUsageSample[] = [
    { provider: "cloudflare", service: "R2 Operations", quantity: 1_000, unit: "operations" },
  ]
  const rows = computeFreeTierUsage(costRows, usage, [connection("cloudflare", "connected")])
  assert.ok(rows.find((row) => row.service === "R2 Operations"))
})

test("duplicate usage samples of the same metric are summed into one line", () => {
  const usage: ProviderUsageSample[] = [
    { provider: "cloudflare", service: "Workers Requests", quantity: 1_000, unit: "requests" },
    { provider: "cloudflare", service: "Workers Requests", quantity: 2_000, unit: "requests" },
  ]
  const rows = computeFreeTierUsage([], usage, [connection("cloudflare", "connected")])
  const workers = rows.filter((row) => row.service === "Workers Requests")
  assert.equal(workers.length, 1)
  assert.equal(workers[0].used, 3_000)
})

test("AWS is skipped here (it has its own Free Tier API path)", () => {
  const usage: ProviderUsageSample[] = [
    { provider: "aws", service: "Amazon EC2", quantity: 100, unit: "Hrs" },
  ]
  const rows = computeFreeTierUsage([], usage, [connection("aws", "connected")])
  assert.equal(rows.length, 0)
})

test("disconnected providers are ignored", () => {
  const rows = computeFreeTierUsage([], [], [connection("gcp", "setup_required")])
  assert.equal(rows.length, 0)
})
