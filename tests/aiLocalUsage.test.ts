import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repo = { owner: "acme", name: "repo", path: "/tmp/repo", remoteUrl: null, scannedAt: new Date().toISOString() }

// Locally-pushed AI usage (no org API) renders as a flat subscription cost row
// plus token + estimated-value usage, without any network call.
test("local AI usage records and surfaces a subscription cost + token usage", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "infra-ai-"))
  const { setStorePathForTests } = await import("../src/lib/localStore")
  const { recordAiLocalUsage } = await import("../src/lib/connectors")
  const { buildAnalysisWithLiveData } = await import("../src/lib/costEngine")
  setStorePathForTests(path.join(dir, "store.json"))
  try {
    await recordAiLocalUsage("usr_ai", "anthropic", {
      month: "2026-06",
      subscriptionUsd: 20,
      planLabel: "Pro",
      toolLabel: "Claude Code",
      models: [{ model: "claude-opus-4-8", inputTokens: 100000, cacheTokens: 500000, outputTokens: 20000, estimatedApiUsd: 42.5 }],
      totals: { inputTokens: 100000, cacheTokens: 500000, outputTokens: 20000, estimatedApiUsd: 42.5 },
    })

    const analysis = await buildAnalysisWithLiveData({ repo, signals: [] }, {} as unknown as NodeJS.ProcessEnv, "usr_ai")

    const rows = analysis.costRows.filter((row) => row.provider === "anthropic")
    assert.equal(rows.length, 1)
    assert.equal(rows[0].cost, 20)
    assert.match(rows[0].serviceName, /subscription/)

    const usage = analysis.freeTier.filter((row) => row.provider === "anthropic" && row.source === "measured")
    assert.ok(usage.find((row) => row.service === "Input tokens" && row.used === 100000))
    assert.ok(usage.find((row) => row.service === "Output tokens" && row.used === 20000))
    assert.ok(usage.find((row) => row.service === "Value at API rates"))

    const sync = analysis.liveSync.find((entry) => entry.provider === "anthropic")
    assert.equal(sync?.status, "success")

    // Plan-cost override (e.g. $200 Claude Max) replaces the pushed subscription price.
    const { setAiSettings } = await import("../src/lib/connectors")
    await setAiSettings("usr_ai", "anthropic", { subscriptionUsd: 200, planLabel: "Max" })
    const after = await buildAnalysisWithLiveData({ repo, signals: [] }, {} as unknown as NodeJS.ProcessEnv, "usr_ai")
    const overridden = after.costRows.find((row) => row.provider === "anthropic")
    assert.equal(overridden?.cost, 200)
    assert.match(overridden?.serviceName ?? "", /Max/)
  } finally {
    setStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("codexRateLimitRows maps primary/secondary percent windows", async () => {
  const { codexRateLimitRows } = await import("../cli/ai-usage.mjs")
  const rows = codexRateLimitRows({
    limit_id: "codex",
    primary: { used_percent: 3.0, window_minutes: 300, resets_at: 1783109310 },
    secondary: { used_percent: 16.0, window_minutes: 10080, resets_at: 1783435000 },
    credits: null,
    plan_type: "plus",
  })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    label: "5-hour limit",
    used: 3,
    limit: 100,
    unit: "%",
    period: "session",
    resetsAt: new Date(1783109310 * 1000).toISOString(),
  })
  assert.equal(rows[1].label, "Weekly limit")
  assert.equal(rows[1].period, "weekly")
  assert.equal(rows[1].used, 16)
  // Unknown shape falls back to the generic normalizer instead of dropping data.
  const legacy = codexRateLimitRows({ weekly: { used: 584, limit: 1000, unit: "turns" } })
  assert.equal(legacy[0].label, "Weekly limit")
  assert.equal(legacy[0].limit, 1000)
})

test("codexUsageLimitRows maps the live backend-api/codex/usage response", async () => {
  const { codexUsageLimitRows } = await import("../cli/ai-usage.mjs")
  const rows = codexUsageLimitRows({
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 18000, reset_at: 1783291672 },
      secondary_window: { used_percent: 24, limit_window_seconds: 604800, reset_after_seconds: 161329, reset_at: 1783435001 },
    },
    credits: { has_credits: false, unlimited: false, balance: "0" },
  })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    label: "5-hour limit",
    used: 1,
    limit: 100,
    unit: "%",
    period: "session",
    resetsAt: new Date(1783291672 * 1000).toISOString(),
  })
  assert.equal(rows[1].label, "Weekly limit")
  assert.equal(rows[1].period, "weekly")
  assert.equal(rows[1].used, 24)

  // A positive credit balance surfaces as its own row; zero balance does not.
  const withCredits = codexUsageLimitRows({
    rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: 1783291672 } },
    credits: { has_credits: true, balance: "250" },
  })
  assert.equal(withCredits.length, 2)
  assert.equal(withCredits[1].label, "Credits remaining")
  assert.equal(withCredits[1].used, 250)

  // Missing/garbage input yields no rows instead of throwing.
  assert.deepEqual(codexUsageLimitRows(null), [])
  assert.deepEqual(codexUsageLimitRows({ detail: "Unauthorized" }), [])
})

test("claudeLimitRows maps the oauth usage limits array with model scopes", async () => {
  const { claudeLimitRows } = await import("../cli/ai-usage.mjs")
  const rows = claudeLimitRows({
    limits: [
      { kind: "session", group: "session", percent: 52, resets_at: "2026-07-05T09:30:00Z", scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 6, resets_at: "2026-07-11T23:00:00Z", scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 11, resets_at: "2026-07-11T23:00:00Z", scope: { model: { id: null, display_name: "Fable" } }, is_active: false },
    ],
  })
  assert.deepEqual(rows.map((r: { label: string }) => r.label), ["Current session", "Weekly · all models", "Weekly · Fable"])
  assert.deepEqual(rows.map((r: { used: number | null }) => r.used), [52, 6, 11])
  assert.ok(rows.every((r: { unit: string; limit: number | null }) => r.unit === "%" && r.limit === 100))
  assert.equal(rows[0].period, "session")
  assert.equal(rows[2].period, "weekly")

  // Older shape: top-level five_hour/seven_day utilization.
  const fallback = claudeLimitRows({
    five_hour: { utilization: 52, resets_at: "2026-07-05T09:30:00Z" },
    seven_day: { utilization: 6, resets_at: "2026-07-11T23:00:00Z" },
  })
  assert.equal(fallback.length, 2)
  assert.equal(fallback[0].label, "Current session")
  assert.equal(fallback[1].used, 6)
})
