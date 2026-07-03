import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import type { AnalysisResult, FreeTierUsageRow, NormalizedCostRow } from "../src/lib/types"

const PERIOD = { from: "2026-07-01", to: "2026-08-01" }

function usageRow(cost: number, service = "Compute"): NormalizedCostRow {
  return {
    provider: "aws",
    serviceName: service,
    resourceId: null,
    resourceName: null,
    billingPeriodStart: PERIOD.from,
    billingPeriodEnd: PERIOD.to,
    cost,
    currency: "USD",
    attribution: "verified",
    attributionReason: "test",
    signalId: null,
  }
}

function freeTierRow(percentUsed: number | null, overrides?: Partial<FreeTierUsageRow>): FreeTierUsageRow {
  return {
    provider: "cloudflare",
    planName: "Workers Free",
    service: "Workers requests",
    used: percentUsed != null ? percentUsed * 1000 : null,
    limit: 100000,
    unit: "requests",
    remaining: null,
    percentUsed,
    source: "measured",
    note: "",
    ...overrides,
  }
}

function analysis(costRows: NormalizedCostRow[], freeTier: FreeTierUsageRow[] = []) {
  return { costRows, freeTier, period: PERIOD }
}

test("budget alerts fire only the highest crossed threshold", async () => {
  const { evaluateThresholdAlerts } = await import("../src/lib/alerts")
  const at = (spend: number) =>
    evaluateThresholdAlerts({
      analysis: analysis([usageRow(spend)]),
      monthlyBudgetUsd: 300,
      // End of month so run-rate forecasting doesn't add alerts.
      now: new Date("2026-07-31T12:00:00Z"),
    }).filter((item) => item.key.includes(":budget:"))

  assert.equal(at(100).length, 0)
  assert.deepEqual(at(160).map((i) => i.key), ["2026-07:budget:50"])
  assert.deepEqual(at(250).map((i) => i.key), ["2026-07:budget:80"])
  const exceeded = at(320)
  assert.deepEqual(exceeded.map((i) => i.key), ["2026-07:budget:100"])
  assert.equal(exceeded[0].severity, "critical")
})

test("forecast-over-budget alert extrapolates usage but not flat subscriptions", async () => {
  const { evaluateThresholdAlerts } = await import("../src/lib/alerts")
  // Day 10 of 31: $150 usage → ~$465 projected against a $300 budget.
  const items = evaluateThresholdAlerts({
    analysis: analysis([usageRow(150)]),
    monthlyBudgetUsd: 300,
    now: new Date("2026-07-10T12:00:00Z"),
  })
  assert.ok(items.some((item) => item.key === "2026-07:budget:forecast"))

  // A $150 flat subscription is counted once — projected $150, no alert.
  const subscription = { ...usageRow(150, "Claude Max subscription") }
  const flatOnly = evaluateThresholdAlerts({
    analysis: analysis([subscription]),
    monthlyBudgetUsd: 300,
    now: new Date("2026-07-10T12:00:00Z"),
  })
  assert.equal(flatOnly.some((item) => item.key === "2026-07:budget:forecast"), false)
})

test("no budget set means no budget alerts", async () => {
  const { evaluateThresholdAlerts } = await import("../src/lib/alerts")
  const items = evaluateThresholdAlerts({
    analysis: analysis([usageRow(500)]),
    monthlyBudgetUsd: null,
    now: new Date("2026-07-10T12:00:00Z"),
  })
  assert.equal(items.length, 0)
})

test("free-tier alerts fire at 80% and 100% with distinct keys", async () => {
  const { evaluateThresholdAlerts } = await import("../src/lib/alerts")
  const items = evaluateThresholdAlerts({
    analysis: analysis(
      [],
      [
        freeTierRow(85),
        freeTierRow(120, { provider: "vercel", planName: "Hobby", service: "Bandwidth", unit: "GB" }),
        freeTierRow(40), // under threshold
        freeTierRow(null), // no measured usage
        freeTierRow(90, { limit: null }), // no published allowance
      ]
    ),
    monthlyBudgetUsd: null,
    now: new Date("2026-07-10T12:00:00Z"),
  })
  assert.deepEqual(
    items.map((item) => item.key).sort(),
    ["2026-07:freetier:cloudflare::Workers requests:80", "2026-07:freetier:vercel::Bandwidth:100"]
  )
  const critical = items.find((item) => item.key.endsWith(":100"))
  assert.equal(critical?.severity, "critical")
})

test("alert and digest emails render subject, html and text with totals", async () => {
  const { evaluateThresholdAlerts, buildAlertEmail, buildDigestEmail } = await import("../src/lib/alerts")
  const items = evaluateThresholdAlerts({
    analysis: analysis([usageRow(320)], [freeTierRow(85)]),
    monthlyBudgetUsd: 300,
    now: new Date("2026-07-31T12:00:00Z"),
  })
  const alertEmail = buildAlertEmail(items, "July 2026")
  assert.ok(alertEmail.subject.includes("Ambrium"))
  assert.ok(alertEmail.html.includes("Budget exceeded"))
  assert.ok(alertEmail.text.includes("CRITICAL"))

  const digest = buildDigestEmail({
    analysis: analysis([usageRow(120), usageRow(40, "S3")], [freeTierRow(85)]),
    monthlyBudgetUsd: 300,
    syncedRepoCount: 3,
    now: new Date("2026-07-10T12:00:00Z"),
  })
  assert.ok(digest.subject.includes("$160"))
  assert.ok(digest.html.includes("Free-tier runway"))
  assert.ok(digest.text.includes("Projects synced: 3"))
  assert.ok(digest.text.includes("AWS"))
})

test("alert sweep enforces plan gating and survives a missing email binding", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "infra-alerts-"))
  const filePath = path.join(dir, "store.json")
  try {
    const { setStorePathForTests, createOrUpdateUserSession, upsertBillingSubscription, writeAnalysisSnapshot, setMonthlyBudget, readWorkspace } =
      await import("../src/lib/localStore")
    const { runAlertSweepForUser } = await import("../src/lib/alerts")
    setStorePathForTests(filePath)

    const { user } = await createOrUpdateUserSession({ email: "alerts@example.test" })

    // Free plan: alerts are gated off.
    const gated = await runAlertSweepForUser(user.id)
    assert.equal(gated.skipped, "plan")

    // Indie without any snapshot: nothing to evaluate.
    await upsertBillingSubscription(user.id, { plan: "indie", status: "active" })
    const noData = await runAlertSweepForUser(user.id)
    assert.equal(noData.skipped, "no overview snapshot")

    // Indie with firing alerts but no Workers email binding (node test runtime):
    // the sweep must not throw, must send nothing, and must NOT mark keys as
    // sent (so they deliver once email is provisioned).
    await setMonthlyBudget(user.id, 300)
    await writeAnalysisSnapshot(user.id, {
      key: "__overview__",
      computedAt: new Date().toISOString(),
      analysis: {
        ...( {} as AnalysisResult ),
        repo: { name: "", owner: "", path: "", remoteUrl: null, scannedAt: "" },
        period: PERIOD,
        summary: { totalCost: 320, exactCost: 320, inferredCost: 0, detectedProviders: 1, signals: 0, confidence: 1 },
        signals: [],
        providerConnections: [],
        providerBreakdown: [],
        costRows: [usageRow(320)],
        freeTier: [],
        resourceItems: [],
        actions: [],
        liveSync: [],
      },
    })
    const result = await runAlertSweepForUser(user.id)
    assert.equal(result.alertsSent, 0)
    assert.equal(result.digestSent, false)
    const workspace = await readWorkspace(user.id)
    assert.equal(workspace.alertState, null)
  } finally {
    const { setStorePathForTests } = await import("../src/lib/localStore")
    setStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
