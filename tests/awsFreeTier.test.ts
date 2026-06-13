import test from "node:test"
import assert from "node:assert/strict"

const repo = {
  owner: "acme",
  name: "repo",
  path: "/tmp/repo",
  remoteUrl: null,
  scannedAt: new Date().toISOString(),
}

test("buildAnalysisWithLiveData surfaces live AWS Free Tier usage rows", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const dir = mkdtempSync(path.join(tmpdir(), "infra-store-"))
  const originalFetch = globalThis.fetch
  try {
    const { setStorePathForTests, upsertConnection } = await import("../src/lib/localStore")
    const { buildAnalysisWithLiveData } = await import("../src/lib/costEngine")
    setStorePathForTests(path.join(dir, "connections.json"))

    await upsertConnection("usr_aws", {
      provider: "aws",
      status: "connected",
      accountLabel: "AWS 123456789012",
      accessToken: JSON.stringify({ accessKeyId: "AKID", secretAccessKey: "secret" }),
      connectedAt: "2026-06-12T00:00:00.000Z",
      lastVerifiedAt: "2026-06-12T00:00:00.000Z",
      lastError: null,
      metadata: { accountId: "123456789012" },
    })

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes("ce.us-east-1.amazonaws.com")) {
        return Response.json({
          ResultsByTime: [
            {
              Groups: [
                {
                  Keys: ["Amazon EC2"],
                  Metrics: { UnblendedCost: { Amount: "8.50", Unit: "USD" }, UsageQuantity: { Amount: "120", Unit: "Hrs" } },
                },
              ],
            },
          ],
        })
      }
      if (url.includes("freetier.us-east-1.amazonaws.com")) {
        return Response.json({
          freeTierUsages: [
            {
              service: "AWS Lambda",
              description: "Lambda requests",
              actualUsageAmount: 250000,
              limit: 1000000,
              unit: "Requests",
              freeTierType: "Always Free",
            },
            {
              service: "Amazon S3",
              description: "S3 storage",
              actualUsageAmount: 1,
              limit: 5,
              unit: "GB-Mo",
              freeTierType: "12 Months Free",
            },
          ],
        })
      }
      throw new Error(`Unexpected fetch in test: ${url}`)
    }) as typeof fetch

    const analysis = await buildAnalysisWithLiveData({ repo, signals: [] }, {} as unknown as NodeJS.ProcessEnv, "usr_aws")

    const awsCost = analysis.costRows.filter((row) => row.provider === "aws")
    assert.equal(awsCost.length, 1)
    assert.equal(awsCost[0].serviceName, "Amazon EC2")
    assert.equal(awsCost[0].cost, 8.5)
    assert.equal(awsCost[0].source, "live")

    const awsRows = analysis.freeTier.filter((row) => row.provider === "aws")
    assert.equal(awsRows.length, 2)

    const lambda = awsRows.find((row) => row.service === "Lambda requests")
    assert.ok(lambda)
    assert.equal(lambda.used, 250000)
    assert.equal(lambda.limit, 1000000)
    assert.equal(lambda.remaining, 750000)
    assert.equal(lambda.percentUsed, 25)
    assert.equal(lambda.source, "measured")
  } finally {
    globalThis.fetch = originalFetch
    const { setStorePathForTests } = await import("../src/lib/localStore")
    setStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
