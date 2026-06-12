import test from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { buildAnalysisWithLiveData, normalizeCloudflareSubscriptions } from "../src/lib/costEngine"
import { normalizeBillingExportTableId } from "../src/lib/gcpClient"
import type { RepoSignal } from "../src/lib/types"

const signals: RepoSignal[] = [
  {
    id: "cloudflare:wrangler.toml:0",
    provider: "cloudflare",
    signalType: "deployment",
    sourcePath: "wrangler.toml",
    title: "Cloudflare Workers configuration",
    evidence: "wrangler.toml",
    confidence: 0.97,
    matchedResource: "worker",
  },
  {
    id: "gcp:app.yaml:1",
    provider: "gcp",
    signalType: "deployment",
    sourcePath: "app.yaml",
    title: "Google Cloud deployment",
    evidence: "app.yaml",
    confidence: 0.92,
  },
]

const repo = {
  owner: "acme",
  name: "repo",
  path: "/tmp/repo",
  remoteUrl: null,
  scannedAt: new Date().toISOString(),
}

test("normalizeCloudflareSubscriptions converts subscription prices to monthly rows", () => {
  const rows = normalizeCloudflareSubscriptions(
    [
      { id: "sub_monthly", price: 5, currency: "USD", frequency: "monthly", rate_plan: { public_name: "Workers Paid" } },
      { id: "sub_yearly", price: 60, currency: "USD", frequency: "yearly", product: { public_name: "Annual plan" } },
      { id: "sub_free", price: 0, currency: "USD", frequency: "monthly", rate_plan: { public_name: "Free" } },
    ],
    { id: "acc1", name: "Acme Account" },
    { from: "2026-06-01", to: "2026-06-30" }
  )
  assert.equal(rows.length, 2)
  assert.equal(rows[0].serviceName, "Workers Paid")
  assert.equal(rows[0].cost, 5)
  assert.equal(rows[1].cost, 5)
  assert.equal(rows.every((row) => row.source === "live" && row.provider === "cloudflare"), true)
})

test("normalizeBillingExportTableId accepts valid ids and rejects malformed ones", () => {
  assert.equal(
    normalizeBillingExportTableId("`my-proj.billing.gcp_billing_export_v1_ABC123`"),
    "my-proj.billing.gcp_billing_export_v1_ABC123"
  )
  assert.equal(
    normalizeBillingExportTableId("my-proj:billing.gcp_billing_export_v1_ABC123"),
    "my-proj.billing.gcp_billing_export_v1_ABC123"
  )
  assert.throws(() => normalizeBillingExportTableId("not a table"))
  assert.throws(() => normalizeBillingExportTableId("missing.dataset"))
  assert.throws(() => normalizeBillingExportTableId("proj.data set.table; DROP"))
})

test("buildAnalysisWithLiveData pulls live Cloudflare subscriptions and GCP billing export rows", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const dir = mkdtempSync(path.join(tmpdir(), "infra-store-"))
  const originalFetch = globalThis.fetch
  try {
    const { setStorePathForTests, upsertConnection } = await import("../src/lib/localStore")
    setStorePathForTests(path.join(dir, "connections.json"))

    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    })
    const serviceAccountKey = JSON.stringify({
      type: "service_account",
      project_id: "my-proj",
      client_email: "analyzer@my-proj.iam.gserviceaccount.com",
      private_key: privateKey,
    })

    await upsertConnection("usr_a", {
      provider: "cloudflare",
      status: "connected",
      accountLabel: "Acme Account",
      accessToken: "cf-token",
      connectedAt: "2026-06-12T00:00:00.000Z",
      lastVerifiedAt: "2026-06-12T00:00:00.000Z",
      lastError: null,
      metadata: { accounts: [{ id: "acc1", name: "Acme Account" }] },
    })
    await upsertConnection("usr_a", {
      provider: "gcp",
      status: "connected",
      accountLabel: "analyzer@my-proj.iam.gserviceaccount.com",
      accessToken: serviceAccountKey,
      connectedAt: "2026-06-12T00:00:00.000Z",
      lastVerifiedAt: "2026-06-12T00:00:00.000Z",
      lastError: null,
      metadata: { billingExportTable: "my-proj.billing.gcp_billing_export_v1_ABC123" },
    })

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes("api.cloudflare.com") && url.includes("/subscriptions")) {
        return Response.json({
          success: true,
          errors: [],
          result: [
            { id: "sub1", price: 5, currency: "USD", frequency: "monthly", rate_plan: { public_name: "Workers Paid" } },
          ],
        })
      }
      if (url.includes("oauth2.googleapis.com/token")) {
        return Response.json({ access_token: "gcp-access-token" })
      }
      if (url.includes("bigquery.googleapis.com")) {
        return Response.json({
          jobComplete: true,
          rows: [{ f: [{ v: "Cloud Run" }, { v: "my-proj" }, { v: "12.5" }, { v: "USD" }] }],
        })
      }
      throw new Error(`Unexpected fetch in test: ${url}`)
    }) as typeof fetch

    const analysis = await buildAnalysisWithLiveData(
      { repo, signals },
      {} as unknown as NodeJS.ProcessEnv,
      "usr_a"
    )

    const cloudflareRows = analysis.costRows.filter((row) => row.provider === "cloudflare")
    assert.equal(cloudflareRows.length, 1)
    assert.equal(cloudflareRows[0].source, "live")
    assert.equal(cloudflareRows[0].cost, 5)

    const gcpRows = analysis.costRows.filter((row) => row.provider === "gcp")
    assert.equal(gcpRows.length, 1)
    assert.equal(gcpRows[0].source, "live")
    assert.equal(gcpRows[0].cost, 12.5)
    assert.equal(gcpRows[0].serviceName, "Cloud Run")

    const syncByProvider = new Map(analysis.liveSync.map((sync) => [sync.provider, sync.status]))
    assert.equal(syncByProvider.get("vercel"), "not_connected")
    assert.equal(syncByProvider.get("cloudflare"), "success")
    assert.equal(syncByProvider.get("gcp"), "success")
  } finally {
    globalThis.fetch = originalFetch
    const { setStorePathForTests } = await import("../src/lib/localStore")
    setStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
