import test from "node:test"
import assert from "node:assert/strict"
import { buildAnalysis, buildAnalysisWithLiveData, summarizeByProvider } from "../src/lib/costEngine"
import type { NormalizedCostRow, RepoSignal } from "../src/lib/types"

const signals: RepoSignal[] = [
  {
    id: "vercel:vercel.json:0",
    provider: "vercel",
    signalType: "deployment",
    sourcePath: "vercel.json",
    title: "Vercel project configuration",
    evidence: "vercel.json",
    confidence: 0.98,
    matchedResource: "web",
  },
  {
    id: "aws:main.tf:1",
    provider: "aws",
    signalType: "iac",
    sourcePath: "infra/main.tf",
    title: "AWS infrastructure declaration",
    evidence: "provider \"aws\"",
    confidence: 0.88,
  },
  {
    id: "cloudflare:README.md:2",
    provider: "cloudflare",
    signalType: "documentation",
    sourcePath: "README.md",
    title: "Cloudflare service reference",
    evidence: "cloudflare",
    confidence: 0.78,
  },
]

test("summarizeByProvider separates exact and inferred cost from supplied rows", () => {
  const rows: NormalizedCostRow[] = [
    {
      provider: "cloudflare",
      serviceName: "Cloudflare Workers",
      resourceId: null,
      resourceName: "acme",
      billingPeriodStart: "2026-06-01",
      billingPeriodEnd: "2026-06-30",
      cost: 20,
      currency: "USD",
      attribution: "verified",
      attributionReason: "Live billing row",
      signalId: "cloudflare-live:1",
      source: "live",
    },
    {
      provider: "cloudflare",
      serviceName: "Cloudflare usage",
      resourceId: null,
      resourceName: "acme",
      billingPeriodStart: "2026-06-01",
      billingPeriodEnd: "2026-06-30",
      cost: 2,
      currency: "USD",
      attribution: "inferred",
      attributionReason: "Supplied by caller",
      signalId: "cloudflare-live:2",
      source: "live",
    },
  ]
  const breakdown = summarizeByProvider(rows, signals)
  const cloudflare = breakdown.find((row) => row.provider === "cloudflare")
  assert.ok(cloudflare)
  assert.equal(cloudflare.exact, 20)
  assert.equal(cloudflare.inferred, 2)
})

test("buildAnalysis reports provider setup state from env", async () => {
  const analysis = await buildAnalysis(
    {
      repo: {
        owner: "acme",
        name: "repo",
        path: "/tmp/repo",
        remoteUrl: null,
        scannedAt: new Date().toISOString(),
      },
      signals,
    },
    { VERCEL_TOKEN: "token" } as unknown as NodeJS.ProcessEnv
  )
  const vercel = analysis.providerConnections.find((provider) => provider.provider === "vercel")
  const aws = analysis.providerConnections.find((provider) => provider.provider === "aws")
  assert.equal(vercel?.status, "connected")
  assert.equal(aws?.status, "setup_required")
  assert.equal(analysis.summary.totalCost, 0)
  assert.equal(analysis.costRows.length, 0)
  assert.equal(analysis.summary.detectedProviders, 3)
})

test("buildAnalysis prefers saved provider connection state", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const dir = mkdtempSync(path.join(tmpdir(), "infra-store-"))
  try {
    const { setStorePathForTests, upsertConnection } = await import("../src/lib/localStore")
    setStorePathForTests(path.join(dir, "connections.json"))
    await upsertConnection("usr_a", {
      provider: "vercel",
      status: "connected",
      accountLabel: "Acme Vercel",
      connectedAt: "2026-06-12T00:00:00.000Z",
      lastVerifiedAt: "2026-06-12T00:00:00.000Z",
      lastError: null,
      metadata: {},
    })
    const analysis = await buildAnalysis(
      {
        repo: {
          owner: "acme",
          name: "repo",
          path: "/tmp/repo",
          remoteUrl: null,
          scannedAt: new Date().toISOString(),
        },
        signals,
      },
      {} as unknown as NodeJS.ProcessEnv,
      "usr_a"
    )
    const vercel = analysis.providerConnections.find((provider) => provider.provider === "vercel")
    assert.equal(vercel?.status, "connected")
    assert.equal(vercel?.accountLabel, "Acme Vercel")
  } finally {
    const { setStorePathForTests } = await import("../src/lib/localStore")
    setStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("buildAnalysisWithLiveData uses only live Vercel billing rows for cost", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const dir = mkdtempSync(path.join(tmpdir(), "infra-store-"))
  const originalFetch = globalThis.fetch
  try {
    const { setStorePathForTests, upsertConnection } = await import("../src/lib/localStore")
    setStorePathForTests(path.join(dir, "connections.json"))
    await upsertConnection("usr_a", {
      provider: "vercel",
      status: "connected",
      accountLabel: "Acme Vercel",
      accessToken: "token",
      connectedAt: "2026-06-12T00:00:00.000Z",
      lastVerifiedAt: "2026-06-12T00:00:00.000Z",
      lastError: null,
      metadata: { teamId: "team_123" },
    })
    globalThis.fetch = (async (input: string | URL | Request) => {
      assert.equal(String(input).includes("/v1/billing/charges"), true)
      return new Response(
        [
          JSON.stringify({
            ChargePeriodStart: "2026-06-01T00:00:00.000Z",
            ChargePeriodEnd: "2026-06-30T23:59:59.999Z",
            ServiceName: "Vercel Functions",
            ResourceName: "repo-web",
            ResourceId: "prj_123",
            EffectiveCost: 12.34,
            BillingCurrency: "USD",
          }),
        ].join("\n"),
        { status: 200 }
      )
    }) as typeof fetch

    const analysis = await buildAnalysisWithLiveData(
      {
        repo: {
          owner: "acme",
          name: "repo",
          path: "/tmp/repo",
          remoteUrl: null,
          scannedAt: new Date().toISOString(),
        },
        signals,
      },
      {} as unknown as NodeJS.ProcessEnv,
      "usr_a"
    )

    const vercelRows = analysis.costRows.filter((row) => row.provider === "vercel")
    assert.equal(vercelRows.length, 1)
    assert.equal(vercelRows[0].source, "live")
    assert.equal(vercelRows[0].cost, 12.34)
    assert.equal(analysis.liveSync[0].status, "success")
  } finally {
    globalThis.fetch = originalFetch
    const { setStorePathForTests } = await import("../src/lib/localStore")
    setStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
