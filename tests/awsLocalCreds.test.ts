import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseIni, readLocalAwsCredentials } from "../src/lib/awsLocalCreds"
import { parseCostExplorerResponse } from "../src/lib/awsClient"

test("parseIni reads sections, keys, and ignores comments", () => {
  const ini = parseIni(`
# a comment
[default]
aws_access_key_id = AKIA123
aws_secret_access_key = secret/value+abc   ; inline comment

[profile work]
region = eu-west-1
`)
  assert.equal(ini.default.aws_access_key_id, "AKIA123")
  assert.equal(ini.default.aws_secret_access_key, "secret/value+abc")
  assert.equal(ini["profile work"].region, "eu-west-1")
})

test("readLocalAwsCredentials merges credentials + config for a profile", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aws-creds-"))
  const credentialsPath = path.join(dir, "credentials")
  const configPath = path.join(dir, "config")
  writeFileSync(
    credentialsPath,
    "[default]\naws_access_key_id = AKIADEFAULT\naws_secret_access_key = defaultsecret\n[work]\naws_access_key_id = AKIAWORK\naws_secret_access_key = worksecret\naws_session_token = tok123\n"
  )
  writeFileSync(configPath, "[default]\nregion = us-east-1\n[profile work]\nregion = ap-south-1\n")
  const original = { creds: process.env.AWS_SHARED_CREDENTIALS_FILE, config: process.env.AWS_CONFIG_FILE }
  process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath
  process.env.AWS_CONFIG_FILE = configPath
  try {
    const def = readLocalAwsCredentials()
    assert.ok(def)
    assert.equal(def.accessKeyId, "AKIADEFAULT")
    assert.equal(def.region, "us-east-1")

    const work = readLocalAwsCredentials("work")
    assert.ok(work)
    assert.equal(work.accessKeyId, "AKIAWORK")
    assert.equal(work.sessionToken, "tok123")
    assert.equal(work.region, "ap-south-1")

    assert.equal(readLocalAwsCredentials("nonexistent"), null)
  } finally {
    process.env.AWS_SHARED_CREDENTIALS_FILE = original.creds
    process.env.AWS_CONFIG_FILE = original.config
    rmSync(dir, { recursive: true, force: true })
  }
})

test("parseCostExplorerResponse extracts per-service cost and usage", () => {
  const rows = parseCostExplorerResponse({
    ResultsByTime: [
      {
        Groups: [
          {
            Keys: ["Amazon EC2"],
            Metrics: {
              UnblendedCost: { Amount: "12.3400", Unit: "USD" },
              UsageQuantity: { Amount: "100.5", Unit: "Hrs" },
            },
          },
          {
            Keys: ["AWS Lambda"],
            Metrics: {
              UnblendedCost: { Amount: "0", Unit: "USD" },
              UsageQuantity: { Amount: "250000", Unit: "Requests" },
            },
          },
        ],
      },
    ],
  })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].service, "Amazon EC2")
  assert.equal(rows[0].cost, 12.34)
  assert.equal(rows[0].usageQuantity, 100.5)
  assert.equal(rows[0].usageUnit, "Hrs")
  assert.equal(rows[1].cost, 0)
  assert.equal(rows[1].usageQuantity, 250000)
})
