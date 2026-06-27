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
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { connectedProviderMap } from "./provider-state.mjs"
import { collectAiUsage } from "./ai-usage.mjs"

const API_BASE = (process.env.AMBRIUM_API || "http://localhost:3000").replace(/\/+$/, "")
const args = process.argv.slice(2)
const command = args.find((arg) => !arg.startsWith("-")) ?? "connect"
const AI_ONLY = args.includes("--ai-only")
const JSON_OUTPUT = args.includes("--json")
const QUIET = args.includes("--quiet")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => {
  if (!QUIET && !JSON_OUTPUT) process.stdout.write(`${m}\n`)
}

// Persist the minted cliToken so re-runs (and scheduled --ai-only jobs) reuse it
// until it expires instead of re-prompting for browser approval every time.
const CRED_PATH = join(homedir(), ".ambrium", "credentials.json")
function saveToken(cliToken, expiresIn) {
  try {
    mkdirSync(join(homedir(), ".ambrium"), { recursive: true })
    writeFileSync(
      CRED_PATH,
      JSON.stringify({ api: API_BASE, cliToken, expiresAt: Date.now() + (expiresIn ?? 0) * 1000 }, null, 2)
    )
    chmodSync(CRED_PATH, 0o600)
  } catch {
    /* best effort — fall back to re-pairing next time */
  }
}
function loadToken() {
  try {
    const saved = JSON.parse(readFileSync(CRED_PATH, "utf8"))
    if (saved.api === API_BASE && saved.cliToken && saved.expiresAt > Date.now() + 30_000) return saved.cliToken
  } catch {
    /* none / unreadable */
  }
  return null
}

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

function tryRun(cmd, args) {
  try {
    return { ok: true, output: run(cmd, args).trim() }
  } catch (error) {
    return {
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function providerDisplayName(provider) {
  return {
    aws: "AWS",
    gcp: "Google Cloud",
    cloudflare: "Cloudflare",
    motherduck: "MotherDuck",
    anthropic: "Claude",
    openai: "OpenAI",
    cursor: "Cursor",
    vercel: "Vercel",
    github: "GitHub",
  }[provider] || provider
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

function detectLocalEnvironment() {
  const awsVersion = tryRun("aws", ["--version"])
  const awsIdentity = awsVersion.ok ? tryRun("aws", ["sts", "get-caller-identity", "--output", "json"]) : { ok: false }
  const awsPayload = awsIdentity.ok ? JSON.parse(awsIdentity.output) : null

  const gcloudVersion = tryRun("gcloud", ["--version"])
  const gcloudProject = gcloudVersion.ok ? tryRun("gcloud", ["config", "get-value", "project"]) : { ok: false }
  const gcloudToken = gcloudVersion.ok ? tryRun("gcloud", ["auth", "print-access-token"]) : { ok: false }

  const wranglerVersion = tryRun("wrangler", ["--version"])
  const wranglerWhoami = wranglerVersion.ok ? tryRun("wrangler", ["whoami"]) : { ok: false }
  const cfToken = Boolean(process.env.CLOUDFLARE_API_TOKEN)

  const vercelVersion = tryRun("vercel", ["--version"])
  const vercelWhoami = vercelVersion.ok ? tryRun("vercel", ["whoami"]) : { ok: false }

  const gitRemote = tryRun("git", ["remote", "get-url", "origin"])
  const gitRoot = tryRun("git", ["rev-parse", "--show-toplevel"])

  const ambriumCreds = readJsonFile(CRED_PATH)
  const aiUsage = (() => {
    try {
      const payloads = collectAiUsage()
      return {
        ok: payloads.length > 0,
        tools: payloads.map((payload) => ({
          provider: payload.provider,
          label: payload.toolLabel,
          models: payload.models.length,
          estimatedApiUsd: Number(payload.models.reduce((sum, model) => sum + model.estimatedApiUsd, 0).toFixed(2)),
        })),
      }
    } catch (error) {
      return { ok: false, tools: [], error: error instanceof Error ? error.message : String(error) }
    }
  })()

  return {
    api: API_BASE,
    paired: Boolean(ambriumCreds?.api === API_BASE && ambriumCreds?.cliToken && ambriumCreds?.expiresAt > Date.now() + 30_000),
    git: {
      installed: has("git"),
      repo: gitRoot.ok ? gitRoot.output : null,
      remote: gitRemote.ok ? gitRemote.output : null,
    },
    providers: {
      aws: {
        cliInstalled: awsVersion.ok,
        authenticated: awsIdentity.ok,
        account: awsPayload?.Account ?? null,
        arn: awsPayload?.Arn ?? null,
        connectMode: awsIdentity.ok ? "automatic read-only IAM role" : "install/authenticate aws CLI first",
      },
      gcp: {
        cliInstalled: gcloudVersion.ok,
        authenticated: gcloudToken.ok,
        project: gcloudProject.ok ? gcloudProject.output : null,
        connectMode: gcloudToken.ok ? "automatic service account; billing export still needs approval" : "install/authenticate gcloud first",
      },
      cloudflare: {
        cliInstalled: wranglerVersion.ok,
        authenticated: wranglerWhoami.ok || cfToken,
        tokenFromEnv: cfToken,
        connectMode: cfToken ? "automatic from CLOUDFLARE_API_TOKEN" : "paste-assisted token with prefilled scopes",
      },
      vercel: {
        cliInstalled: vercelVersion.ok,
        authenticated: vercelWhoami.ok,
        account: vercelWhoami.ok ? vercelWhoami.output.split("\n").at(-1) : null,
        connectMode: "manual token today; agent can open token page",
      },
      motherduck: {
        cliInstalled: false,
        authenticated: Boolean(process.env.MOTHERDUCK_DATABASE_URL),
        connectMode: process.env.MOTHERDUCK_DATABASE_URL ? "automatic from MOTHERDUCK_DATABASE_URL" : "paste PostgreSQL endpoint",
      },
    },
    aiUsage,
  }
}

function printDetection(detection) {
  log(`\n◇ Local setup`)
  log(`   Ambrium pairing: ${detection.paired ? "saved token found" : "not paired yet"}`)
  log(`   Git repo: ${detection.git.repo ? detection.git.repo : "not detected"}`)
  if (detection.git.remote) log(`   Git remote: ${detection.git.remote}`)

  log(`\n◇ Provider readiness`)
  for (const [provider, info] of Object.entries(detection.providers)) {
    const ready = info.authenticated ? "✓" : info.cliInstalled ? "•" : "×"
    const detail =
      provider === "aws" && info.account
        ? `account ${info.account}`
        : provider === "gcp" && info.project
          ? `project ${info.project}`
          : provider === "vercel" && info.account
            ? info.account
            : info.connectMode
    log(`   ${ready} ${providerDisplayName(provider).padEnd(13)} ${detail}`)
  }

  log(`\n◇ AI usage`)
  if (detection.aiUsage.ok) {
    for (const tool of detection.aiUsage.tools) {
      log(`   ✓ ${tool.label}: ${tool.models} model${tool.models === 1 ? "" : "s"}, ~$${tool.estimatedApiUsd.toFixed(2)} API-equivalent`)
    }
  } else {
    log(`   • no local Claude Code / Codex usage found for this month`)
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
    if (poll.status === "authorized") {
      saveToken(poll.cliToken, poll.expiresIn)
      return poll.cliToken
    }
    if (poll.status === "denied") throw new Error("Pairing was denied.")
    if (poll.status === "expired") throw new Error("Pairing code expired. Re-run the CLI.")
  }
  throw new Error("Timed out waiting for approval.")
}

// Reuse a saved cliToken when still valid (no browser), else pair fresh.
async function getToken() {
  const saved = loadToken()
  if (saved) {
    try {
      await api("/api/cli/status", { token: saved })
      log(`\n◇ Reusing saved Ambrium pairing`)
      return saved
    } catch {
      /* expired/invalid — pair again */
    }
  }
  return pair()
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

// ---- AI coding tools (local usage) ----
async function pushAiUsage(cliToken) {
  log(`\n◇ AI coding tools (local usage)`)
  let payloads = []
  try {
    payloads = collectAiUsage()
  } catch (error) {
    log(`   • could not read local logs: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (payloads.length === 0) {
    log(`   • no Claude Code / Codex usage found for this month`)
    return
  }
  let pushed = 0
  for (const payload of payloads) {
    const tokens = payload.models.reduce((sum, m) => sum + m.inputTokens + m.outputTokens, 0)
    const est = payload.models.reduce((sum, m) => sum + m.estimatedApiUsd, 0)
    try {
      await api("/api/cli/ai-usage", { method: "POST", token: cliToken, body: payload })
      log(`   ✓ ${payload.toolLabel}: ${tokens.toLocaleString()} tokens this month, ~$${est.toFixed(2)} at API rates`)
      pushed += 1
    } catch (error) {
      log(`   ✗ ${payload.toolLabel}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (pushed > 0 && !AI_ONLY) {
    log(`   tip: keep these fresh automatically — schedule "ambrium-connect --ai-only" (see docs/local-ai-usage.md)`)
  }
}

// ---- orchestration ----
async function printRemoteStatus({ pairIfNeeded = false } = {}) {
  const saved = loadToken()
  if (!saved && !pairIfNeeded) {
    return { paired: false, connections: {} }
  }
  const cliToken = pairIfNeeded ? await getToken() : saved
  if (!cliToken) return { paired: false, connections: {} }
  const state = await api("/api/cli/status", { token: cliToken })
  return { paired: true, connections: connectedProviderMap(state) }
}

async function statusCommand() {
  const detection = detectLocalEnvironment()
  let remote = { paired: false, connections: {} }
  try {
    remote = await printRemoteStatus()
  } catch {
    remote = { paired: false, connections: {} }
  }
  if (JSON_OUTPUT) {
    process.stdout.write(JSON.stringify({ detection, remote }, null, 2) + "\n")
    return
  }
  log(`Ambrium status → ${API_BASE}`)
  printDetection(detection)
  log(`\n◇ Ambrium workspace`)
  if (!remote.paired) {
    log(`   • not paired or saved token expired; run "ambrium-connect" to pair`)
  } else {
    const entries = Object.entries(remote.connections)
    if (!entries.length) {
      log(`   • paired, no providers connected yet`)
    } else {
      for (const [provider, connection] of entries) {
        log(`   ✓ ${providerDisplayName(provider)}${connection.accountLabel ? ` (${connection.accountLabel})` : ""}`)
      }
    }
  }
}

async function doctorCommand() {
  const detection = detectLocalEnvironment()
  let remote = { paired: false, connections: {} }
  try {
    remote = await printRemoteStatus()
  } catch (error) {
    remote = { paired: false, connections: {}, error: error instanceof Error ? error.message : String(error) }
  }
  const findings = []
  if (!detection.paired) findings.push({ severity: "info", message: "No active Ambrium pairing token found. Run ambrium-connect to pair this machine." })
  if (!detection.git.repo) findings.push({ severity: "warn", message: "No Git repository detected in the current directory. Run from a project repo for best attribution." })
  if (!detection.providers.aws.authenticated) findings.push({ severity: "info", message: "AWS is not ready. Install/authenticate aws CLI if this project uses AWS." })
  if (!detection.providers.gcp.authenticated) findings.push({ severity: "info", message: "Google Cloud is not ready. Install/authenticate gcloud if this project uses GCP." })
  if (!detection.providers.cloudflare.authenticated) findings.push({ severity: "info", message: "Cloudflare needs either CLOUDFLARE_API_TOKEN or a pasted scoped token during connect." })
  if (remote.error) findings.push({ severity: "warn", message: `Could not read Ambrium workspace status: ${remote.error}` })
  if (remote.paired && Object.keys(remote.connections).length === 0) findings.push({ severity: "warn", message: "Ambrium is paired but no providers are connected yet." })

  if (JSON_OUTPUT) {
    process.stdout.write(JSON.stringify({ detection, remote, findings }, null, 2) + "\n")
    return
  }

  log(`Ambrium doctor → ${API_BASE}`)
  printDetection(detection)
  log(`\n◇ Diagnosis`)
  if (!findings.length) {
    log(`   ✓ Local setup looks ready. Run "ambrium-connect" to refresh provider connections.`)
  } else {
    for (const finding of findings) {
      const mark = finding.severity === "warn" ? "!" : "•"
      log(`   ${mark} ${finding.message}`)
    }
  }
  log(`\n◇ Useful commands`)
  log(`   ambrium-connect                  Pair and connect available providers`)
  log(`   ambrium-connect status           Show local/provider status`)
  log(`   ambrium-connect --ai-only         Push local AI usage only`)
  log(`   AMBRIUM_API=${API_BASE} ambrium-connect spec`)
}

async function specCommand() {
  const spec = await api("/api/extend/spec")
  if (JSON_OUTPUT) {
    process.stdout.write(JSON.stringify(spec, null, 2) + "\n")
    return
  }
  log(`Ambrium agent setup spec → ${API_BASE}/api/extend/spec`)
  log(`\n${spec.agentSetup?.prompt ?? spec.summary}`)
}

function helpCommand() {
  process.stdout.write(`Ambrium companion CLI

Usage:
  ambrium-connect                 Pair and connect available providers
  ambrium-connect status          Show local and Ambrium workspace status
  ambrium-connect doctor          Diagnose local setup and missing provider prerequisites
  ambrium-connect spec            Print the agent-readable setup prompt/spec summary
  ambrium-connect --ai-only       Push local Claude Code / Codex usage only

Options:
  --json                          Machine-readable output for status/doctor/spec
  --quiet                         Reduce logs during connect

Environment:
  AMBRIUM_API                     Ambrium base URL, defaults to http://localhost:3000
  CLOUDFLARE_API_TOKEN            Optional Cloudflare token for non-interactive connect
  MOTHERDUCK_DATABASE_URL         Optional MotherDuck PostgreSQL endpoint

`)
}

async function connectCommand() {
  log(`Ambrium connect → ${API_BASE}`)
  const cliToken = await getToken()
  log(`   ✓ paired`)

  // --ai-only: skip cloud provisioning entirely; just push local AI usage. This
  // is the lightweight command to schedule (launchd/cron) for periodic refresh.
  if (AI_ONLY) {
    await pushAiUsage(cliToken)
    log(`\nDashboard: ${API_BASE}`)
    return
  }

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
      log(`\nAll available cloud providers are already connected.`)
    } else {
      log(`\nNo cloud CLIs detected. Install/authenticate aws or gcloud to add cloud accounts.`)
    }
    // Still push local AI usage — it's independent of the cloud CLIs.
    await pushAiUsage(cliToken)
    log(`\nDashboard: ${API_BASE}`)
    return
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

  // AI coding-tool usage from local logs (Claude Code, Codex). This is the only
  // source for flat personal subscriptions, whose vendors expose no cost API.
  await pushAiUsage(cliToken)

  const ok = results.filter(([, success]) => success).length
  log(`\n${ok}/${results.length} new providers connected; ${connectedEntries.length} already connected. Dashboard: ${API_BASE}`)
  if (providers.some(([provider]) => provider === "gcp")) {
    log(`Note: detailed GCP cost needs the BigQuery billing export enabled once in the console.`)
  }
}

async function main() {
  if (command === "help" || args.includes("--help") || args.includes("-h")) {
    helpCommand()
    return
  }
  if (command === "status") {
    await statusCommand()
    return
  }
  if (command === "doctor") {
    await doctorCommand()
    return
  }
  if (command === "spec") {
    await specCommand()
    return
  }
  if (command !== "connect") {
    // Backwards compatible: flags-only invocation still means connect, but an
    // unknown positional command should fail clearly.
    throw new Error(`Unknown command "${command}". Run "ambrium-connect help".`)
  }
  await connectCommand()
}

main().catch((error) => {
  process.stderr.write(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
