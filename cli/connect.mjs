#!/usr/bin/env node
// Ambrium companion CLI — pair once, then auto-connect AWS, Google Cloud, and
// Cloudflare using your already-authenticated cloud CLIs. Least-privilege,
// read-only; no long-lived AWS keys ever leave your account.
//
// Usage:  node cli/connect.mjs            (defaults to http://localhost:3000)
//         AMBRIUM_API=https://ambrium.io node cli/connect.mjs
//
// Per provider it needs the matching CLI authenticated:
//   AWS    -> `aws sts get-caller-identity`
//   GCP    -> `gcloud config get-value project`
//   Cloudflare -> a scoped API token (env CLOUDFLARE_API_TOKEN, or you paste one)

import { execFileSync } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { connectedProviderMap } from "./provider-state.mjs"

const API_BASE = (process.env.AMBRIUM_API || "http://localhost:3000").replace(/\/+$/, "")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => process.stdout.write(`${m}\n`)

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}
function has(cmd) {
  try {
    run(cmd, ["--version"])
    return true
  } catch {
    return false
  }
}

async function api(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : `${path} failed (${response.status})`)
  }
  return payload
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
  try {
    execFileSync(cmd, [url], { stdio: "ignore" })
  } catch {
    /* best effort */
  }
}

// ---- pairing (device-code flow) ----
async function pair() {
  const start = await api("/api/cli/pair/start", { method: "POST" })
  const url = `${start.verificationUrl}?code=${encodeURIComponent(start.userCode)}`
  log(`\n◇ Pair with Ambrium`)
  log(`   Open: ${url}`)
  log(`   Code: ${start.userCode}`)
  openBrowser(url)
  const deadline = Date.now() + start.expiresIn * 1000
  while (Date.now() < deadline) {
    await sleep(start.interval * 1000)
    const poll = await api("/api/cli/pair/poll", { method: "POST", body: { deviceCode: start.deviceCode } })
    if (poll.status === "authorized") return poll.cliToken
    if (poll.status === "denied") throw new Error("Pairing was denied.")
    if (poll.status === "expired") throw new Error("Pairing code expired. Re-run the CLI.")
  }
  throw new Error("Timed out waiting for approval.")
}

// ---- AWS ----
function awsAccount() {
  return JSON.parse(run("aws", ["sts", "get-caller-identity", "--output", "json"])).Account
}

function provisionAwsRole({ account, trustedAccountId, externalId, roleName, permissions }) {
  const trust = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${trustedAccountId}:root` },
        Action: "sts:AssumeRole",
        Condition: { StringEquals: { "sts:ExternalId": externalId } },
      },
    ],
  })
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: permissions, Resource: "*" }],
  })
  let exists = true
  try {
    run("aws", ["iam", "get-role", "--role-name", roleName])
  } catch {
    exists = false
  }
  if (exists) {
    run("aws", ["iam", "update-assume-role-policy", "--role-name", roleName, "--policy-document", trust])
  } else {
    run("aws", ["iam", "create-role", "--role-name", roleName, "--assume-role-policy-document", trust, "--description", "Read-only cost/usage access for Ambrium"])
  }
  run("aws", ["iam", "put-role-policy", "--role-name", roleName, "--policy-name", "cost-read", "--policy-document", policy])
  return `arn:aws:iam::${account}:role/${roleName}`
}

async function connectAws(cliToken) {
  const account = awsAccount()
  log(`\n◇ AWS (${account}) — provisioning read-only role…`)
  const params = await api("/api/cli/aws/params", { token: cliToken })
  const roleArn = provisionAwsRole({
    account,
    trustedAccountId: params.trustedAccountId,
    externalId: params.externalId,
    roleName: params.roleName || "ambrium-cost-readonly",
    permissions: params.permissions,
  })
  // A freshly created/updated role takes a few seconds to propagate in IAM, so
  // retry the connect (which assumes the role server-side) until it sticks.
  let lastError
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const result = await api("/api/cli/connect/aws", { method: "POST", token: cliToken, body: { roleArn, externalId: params.externalId } })
      return result.accountLabel
    } catch (error) {
      lastError = error
      if (!/AccessDenied|not authorized|cannot be found|NoSuchEntity|InvalidClientToken|propagat/i.test(String(error))) throw error
      if (attempt === 0) log(`   waiting for IAM to propagate the new role…`)
      await sleep(5000)
    }
  }
  throw lastError
}

// ---- Google Cloud ----
function gcloudProject() {
  return run("gcloud", ["config", "get-value", "project"]).trim()
}

async function connectGcp(cliToken) {
  const project = gcloudProject()
  if (!project || project === "(unset)") throw new Error("No gcloud project set (`gcloud config set project <id>`).")
  log(`\n◇ Google Cloud (${project}) — provisioning read-only service account…`)
  const sa = `ambrium-cost@${project}.iam.gserviceaccount.com`
  const member = `serviceAccount:${sa}`
  const ignore = (fn) => {
    try {
      fn()
    } catch {
      /* idempotent: already exists / already bound */
    }
  }
  ignore(() => run("gcloud", ["services", "enable", "cloudbilling.googleapis.com", "bigquery.googleapis.com", "--project", project, "--quiet"]))
  ignore(() => run("gcloud", ["iam", "service-accounts", "create", "ambrium-cost", "--display-name=Ambrium Cost Analyzer", "--project", project, "--quiet"]))
  // Only BigQuery roles are project-level and are what read the billing export.
  // (billing.viewer is a billing-account role, not grantable on a project.)
  for (const role of ["roles/bigquery.jobUser", "roles/bigquery.dataViewer"]) {
    ignore(() => run("gcloud", ["projects", "add-iam-policy-binding", project, `--member=${member}`, `--role=${role}`, "--quiet", "--no-user-output-enabled"]))
  }
  const keyPath = `/tmp/ambrium-gcp-key-${Date.now()}.json`
  run("gcloud", ["iam", "service-accounts", "keys", "create", keyPath, "--iam-account", sa, "--quiet"])
  let keyJson
  try {
    keyJson = readFileSync(keyPath, "utf8")
  } finally {
    rmSync(keyPath, { force: true })
  }
  const result = await api("/api/cli/connect/gcp", { method: "POST", token: cliToken, body: { keyJson } })
  return result.accountLabel
}

// ---- Cloudflare ----
async function connectCloudflare(cliToken) {
  log(`\n◇ Cloudflare`)
  let token = process.env.CLOUDFLARE_API_TOKEN
  if (token) {
    log(`   using CLOUDFLARE_API_TOKEN from env`)
  } else {
    const url =
      "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=" +
      encodeURIComponent(JSON.stringify([{ key: "account_settings", type: "read" }, { key: "billing", type: "read" }, { key: "account_analytics", type: "read" }])) +
      "&name=" +
      encodeURIComponent("Ambrium Cost Analyzer")
    log(`   Cloudflare has no CLI token-minting, so create one (scopes pre-selected):`)
    log(`   ${url}`)
    openBrowser(url)
    const rl = createInterface({ input: stdin, output: stdout })
    token = (await rl.question("   Paste the Cloudflare API token (or leave blank to skip): ")).trim()
    rl.close()
    if (!token) throw new Error("skipped (no token provided)")
  }
  const result = await api("/api/cli/connect/cloudflare", { method: "POST", token: cliToken, body: { token } })
  return result.accountLabel
}

// ---- MotherDuck ----
async function connectMotherDuck(cliToken) {
  log(`\n◇ MotherDuck`)
  let connectionString = process.env.MOTHERDUCK_DATABASE_URL
  const rl = createInterface({ input: stdin, output: stdout })
  if (!connectionString) {
    connectionString = (await rl.question("   Paste the MotherDuck PostgreSQL endpoint (or leave blank to skip): ")).trim()
  } else {
    log(`   using MOTHERDUCK_DATABASE_URL from env`)
  }
  if (!connectionString) {
    rl.close()
    throw new Error("skipped (no PostgreSQL endpoint provided)")
  }
  const selected = (process.env.MOTHERDUCK_PLAN || await rl.question("   Plan [free/lite/business] (free): ")).trim().toLowerCase()
  rl.close()
  const plan = ["free", "lite", "business"].includes(selected) ? selected : "free"
  const result = await api("/api/cli/connect/motherduck", {
    method: "POST",
    token: cliToken,
    body: { connectionString, plan },
  })
  return result.accountLabel
}

// ---- orchestration ----
async function main() {
  log(`Ambrium connect → ${API_BASE}`)
  const cliToken = await pair()
  log(`   ✓ paired`)

  const state = await api("/api/cli/status", { token: cliToken })
  const connected = connectedProviderMap(state)
  const connectedEntries = Object.entries(connected)
  if (connectedEntries.length > 0) {
    log(`\n◇ Existing connections`)
    for (const [provider, connection] of connectedEntries) {
      const name = {
        aws: "AWS",
        gcp: "Google Cloud",
        cloudflare: "Cloudflare",
        motherduck: "MotherDuck",
      }[provider]
      log(`   ↷ ${name} already connected${connection.accountLabel ? ` (${connection.accountLabel})` : ""} — skipping`)
    }
  }

  log(`\n◇ Detecting cloud CLIs…`)
  const providers = []
  if (!connected.aws && has("aws")) {
    try {
      log(`   ✓ aws     account ${awsAccount()}`)
      providers.push(["aws", "AWS", connectAws])
    } catch {
      log(`   • aws found but not authenticated — skipping`)
    }
  }
  if (!connected.gcp && has("gcloud")) {
    log(`   ✓ gcloud  project ${gcloudProject() || "(unset)"}`)
    providers.push(["gcp", "Google Cloud", connectGcp])
  }
  // Cloudflare is always offered (token paste), even without a CLI.
  if (!connected.cloudflare) providers.push(["cloudflare", "Cloudflare", connectCloudflare])
  // MotherDuck uses the PostgreSQL endpoint generated in account settings.
  if (!connected.motherduck) providers.push(["motherduck", "MotherDuck", connectMotherDuck])

  if (providers.length === 0) {
    if (connectedEntries.length > 0) {
      log(`\nAll available cloud providers are already connected. Dashboard: ${API_BASE}`)
      return
    }
    log(`\nNo cloud CLIs detected. Install/authenticate aws or gcloud and re-run.`)
    process.exit(1)
  }

  const results = []
  for (const [, name, connect] of providers) {
    try {
      const label = await connect(cliToken)
      log(`   ✓ ${name} connected (${label})`)
      results.push([name, true, label])
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log(`   ✗ ${name}: ${msg}`)
      results.push([name, false, msg])
    }
  }

  const ok = results.filter(([, success]) => success).length
  log(`\n${ok}/${results.length} new providers connected; ${connectedEntries.length} already connected. Dashboard: ${API_BASE}`)
  if (providers.some(([provider]) => provider === "gcp")) {
    log(`Note: detailed GCP cost needs the BigQuery billing export enabled once in the console.`)
  }
}

main().catch((error) => {
  process.stderr.write(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
