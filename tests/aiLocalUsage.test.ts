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
  } finally {
    setStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
