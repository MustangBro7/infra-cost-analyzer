import assert from "node:assert/strict"
import test from "node:test"
import { buildCloudProviderReports } from "../src/lib/cloudReporting"
import type { AnalysisResult } from "../src/lib/types"

function analysis(): AnalysisResult {
  return {
    repo: { name: "app", owner: "acme", path: ".", remoteUrl: null, scannedAt: "2026-06-24T00:00:00Z" },
    period: { from: "2026-06-01", to: "2026-06-30" },
    summary: { totalCost: 120, exactCost: 120, inferredCost: 0, detectedProviders: 2, signals: 0, confidence: 1 },
    signals: [],
    providerConnections: [],
    providerBreakdown: [],
    costRows: [
      { provider: "aws", serviceName: "EC2", resourceId: null, resourceName: null, billingPeriodStart: "2026-06-01", billingPeriodEnd: "2026-06-30", cost: 80, currency: "USD", attribution: "verified", attributionReason: "live", signalId: null },
      { provider: "aws", serviceName: "S3", resourceId: null, resourceName: null, billingPeriodStart: "2026-06-01", billingPeriodEnd: "2026-06-30", cost: 20, currency: "USD", attribution: "verified", attributionReason: "live", signalId: null },
      { provider: "cloudflare", serviceName: "Workers", resourceId: null, resourceName: null, billingPeriodStart: "2026-06-01", billingPeriodEnd: "2026-06-30", cost: 20, currency: "USD", attribution: "verified", attributionReason: "live", signalId: null },
    ],
    freeTier: [
      { provider: "aws", planName: "AWS Free Tier", service: "Lambda", used: 85, limit: 100, unit: "requests", remaining: 15, percentUsed: 85, source: "measured", note: "live" },
      { provider: "cloudflare", planName: "Workers Free", service: "Workers Requests", used: 10, limit: 100, unit: "requests", remaining: 90, percentUsed: 10, source: "measured", note: "live" },
    ],
    resourceItems: [
      { provider: "cloudflare", itemKey: "cf:one", kind: "Worker", name: "one", quantity: 10, unit: "requests" },
    ],
    actions: [],
    liveSync: [
      { provider: "aws", status: "success", message: "ok", rows: 2, syncedAt: "2026-06-24T00:00:00Z" },
      { provider: "cloudflare", status: "success", message: "ok", rows: 1, syncedAt: "2026-06-24T00:00:00Z" },
    ],
  }
}

test("buildCloudProviderReports derives provider spend, projection, usage, resources and coverage", () => {
  const reports = buildCloudProviderReports({
    analysis: analysis(),
    connections: {
      aws: { status: "connected", metadata: { costExplorer: true } },
      cloudflare: { status: "connected", metadata: {} },
    },
    elapsedDays: 15,
    totalDays: 30,
  })

  assert.equal(reports[0].provider, "aws")
  assert.equal(reports[0].cost, 100)
  assert.equal(Math.round(reports[0].share), 83)
  assert.equal(reports[0].projected, 200)
  assert.equal(reports[0].topService, "EC2")
  assert.equal(reports[0].highestUsagePercent, 85)
  assert.equal(reports[0].coverageTone, "complete")
  assert.equal(reports[1].resourceCount, 1)
})

test("buildCloudProviderReports calls out partial AWS and GCP visibility", () => {
  const source = analysis()
  source.costRows = []
  source.liveSync.push({ provider: "gcp", status: "success", message: "connected", rows: 0, syncedAt: "2026-06-24T00:00:00Z" })
  const reports = buildCloudProviderReports({
    analysis: source,
    connections: {
      aws: { status: "connected", metadata: { costExplorer: false } },
      gcp: { status: "connected", metadata: {} },
    },
    elapsedDays: 15,
    totalDays: 30,
  })

  assert.equal(reports.find((row) => row.provider === "aws")?.coverageTone, "usage")
  assert.equal(reports.find((row) => row.provider === "gcp")?.coverageTone, "partial")
})
