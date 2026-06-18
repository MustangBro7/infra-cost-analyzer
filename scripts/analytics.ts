import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { AnalysisSnapshot, AppStore, Provider } from "../src/lib/types"
import { deterministicSyncRunId, observationId } from "../src/lib/analytics/keys"
import { analyticsPayloadFromSnapshot } from "../src/lib/analytics/payload"
import type { AnalyticsPayload } from "../src/lib/analytics/types"
import { withAnalyticsClient } from "../src/lib/analytics/connection"
import { writeAnalyticsPayload } from "../src/lib/analytics/writer"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const command = process.argv[2] ?? "status"
const args = new Map(process.argv.slice(3).map((value) => {
  const [key, ...rest] = value.split("=")
  return [key.replace(/^--/, ""), rest.join("=") || "true"]
}))

function requireDatabaseUrl() {
  if (!process.env.MOTHERDUCK_DATABASE_URL) {
    throw new Error("Set MOTHERDUCK_DATABASE_URL to the target MotherDuck PostgreSQL endpoint.")
  }
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function writePayloadWithRetry(payload: AnalyticsPayload, attempts = 5) {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await writeAnalyticsPayload(payload)
      return
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1))
    }
  }
  throw lastError
}

async function migrationFiles() {
  const directory = path.join(root, "analytics", "migrations")
  return (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort()
    .map((file) => ({ file, path: path.join(directory, file) }))
}

async function appliedVersions(): Promise<Set<string>> {
  return withAnalyticsClient(async (client) => {
    try {
      const result = await client.query("SELECT version FROM analytics_schema_migrations")
      return new Set(result.rows.map((row) => String(row.version)))
    } catch {
      return new Set()
    }
  })
}

async function migrate() {
  requireDatabaseUrl()
  const applied = await appliedVersions()
  for (const migration of await migrationFiles()) {
    const version = migration.file.split("_")[0]
    if (applied.has(version)) continue
    const statements = (await readFile(migration.path, "utf8"))
      .split(/\n-- statement\s*\n/).map((statement) => statement.trim()).filter(Boolean)
    await withAnalyticsClient(async (client) => {
      await client.query("BEGIN")
      try {
        for (const statement of statements) await client.query(statement)
        await client.query(
          "INSERT INTO analytics_schema_migrations (version, description) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [version, migration.file.replace(/^\d+_/, "").replace(/\.sql$/, "").replaceAll("_", " ")]
        )
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined)
        throw error
      }
    })
    console.log(`Applied analytics migration ${migration.file}`)
  }
}

async function status() {
  requireDatabaseUrl()
  const applied = await appliedVersions()
  for (const migration of await migrationFiles()) {
    const version = migration.file.split("_")[0]
    console.log(`${applied.has(version) ? "[applied]" : "[pending]"} ${migration.file}`)
  }
}

function addMonths(month: string, offset: number): string {
  const [year, value] = month.split("-").map(Number)
  return new Date(Date.UTC(year, value - 1 + offset, 1)).toISOString().slice(0, 7)
}

function seededPayload(userId: string, month: string, index: number): AnalyticsPayload {
  const computedAt = `${month}-20T12:00:00.000Z`
  const syncRunId = deterministicSyncRunId(userId, "__overview__", computedAt)
  const periodEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)
  const providers: Array<{ provider: Provider; service: string; cost: number }> = [
    { provider: "aws", service: "EC2", cost: 18 + index * 1.8 },
    { provider: "vercel", service: "Functions", cost: 7 + index * 0.7 },
    { provider: "cloudflare", service: "Workers Paid", cost: 5 },
  ]
  return {
    syncRunId, userId, snapshotKey: "__overview__", repoFullName: null,
    periodStart: `${month}-01`, periodEnd, computedAt, source: "d1_backfill",
    costs: providers.map((entry) => {
      const factKey = `seed:${entry.provider}:${entry.service.toLowerCase().replaceAll(" ", "-")}`
      return {
        observationId: observationId(syncRunId, factKey), factKey, providerAccountId: null,
        provider: entry.provider, serviceName: entry.service, resourceId: null, resourceName: null,
        billingPeriodStart: `${month}-01`, billingPeriodEnd: periodEnd, cost: Number(entry.cost.toFixed(2)),
        currency: "USD", attribution: "verified", attributionReason: "Deterministic local analytics seed.",
        signalId: null, attributedRepo: null, itemKey: `${entry.provider}::${entry.service.toLowerCase()}::seed`,
      }
    }),
    usage: [],
    resources: [],
  }
}

async function seed() {
  requireDatabaseUrl()
  const userId = args.get("user") ?? process.env.ANALYTICS_SEED_USER_ID
  if (!userId) throw new Error("Pass --user=<Clerk user id> or set ANALYTICS_SEED_USER_ID.")
  const currentMonth = new Date().toISOString().slice(0, 7)
  for (let index = 0; index < 12; index += 1) {
    await writePayloadWithRetry(seededPayload(userId, addMonths(currentMonth, index - 11), index))
  }
  console.log(`Seeded 12 months of analytics for ${userId}`)
}

async function resetDev() {
  requireDatabaseUrl()
  if (!process.env.MOTHERDUCK_DATABASE_URL?.toLowerCase().includes("_dev")) {
    throw new Error("Refusing to reset a database URL that does not contain _dev.")
  }
  await withAnalyticsClient(async (client) => {
    for (const view of [
      "latest_usage_observations", "repo_monthly_summary", "service_monthly_summary",
      "provider_monthly_summary", "monthly_cost_summary", "latest_cost_facts_compat",
      "latest_resource_observations", "latest_cost_observations",
    ]) await client.query(`DROP VIEW IF EXISTS ${view}`)
    for (const table of [
      "resource_observations", "usage_observations", "cost_observations",
      "analytics_sync_runs", "analytics_schema_migrations",
    ]) await client.query(`DROP TABLE IF EXISTS ${table}`)
  })
  console.log("Reset development analytics schema.")
}

async function readD1Store(): Promise<AppStore> {
  const file = args.get("file")
  if (file) return JSON.parse(await readFile(path.resolve(file), "utf8")) as AppStore
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const databaseId = process.env.D1_DATABASE_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!accountId || !databaseId || !token) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, and CLOUDFLARE_API_TOKEN, or pass --file=.data/tenant-store.json.")
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql: "SELECT value FROM app_kv WHERE key = ?1", params: ["infra-cost-analyzer:app-store"] }),
  })
  const body = await response.json() as {
    success?: boolean
    errors?: Array<{ message?: string }>
    result?: Array<{ results?: Array<{ value?: string }> }>
  }
  if (!response.ok || !body.success) throw new Error(body.errors?.[0]?.message ?? `Cloudflare D1 query failed (${response.status}).`)
  const value = body.result?.[0]?.results?.[0]?.value
  if (!value) throw new Error("The production D1 app store row was not found.")
  return JSON.parse(value) as AppStore
}

async function backfillD1() {
  requireDatabaseUrl()
  const store = await readD1Store()
  const payloads: AnalyticsPayload[] = []
  for (const [userId, workspace] of Object.entries(store.workspaces ?? {})) {
    for (const snapshot of Object.values(workspace.analysisSnapshots ?? {}) as AnalysisSnapshot[]) {
      payloads.push(analyticsPayloadFromSnapshot({
        userId, snapshot,
        syncRunId: deterministicSyncRunId(userId, snapshot.key, snapshot.computedAt),
        source: "d1_backfill",
        costAssignments: workspace.costAssignments,
      }))
    }
  }
  const counts = payloads.reduce((sum, payload) => ({
    costs: sum.costs + payload.costs.length,
    usage: sum.usage + payload.usage.length,
    resources: sum.resources + payload.resources.length,
  }), { costs: 0, usage: 0, resources: 0 })
  console.log(`Found ${payloads.length} snapshots: ${counts.costs} costs, ${counts.usage} usage, ${counts.resources} resources.`)
  if (args.has("dry-run")) return
  for (const payload of payloads) await writePayloadWithRetry(payload)
  console.log("D1 snapshot backfill complete.")
}

async function validate() {
  requireDatabaseUrl()
  await withAnalyticsClient(async (client) => {
    const result = await client.query(`SELECT
      (SELECT count(*) FROM analytics_sync_runs) AS sync_runs,
      (SELECT count(*) FROM cost_observations) AS costs,
      (SELECT count(*) FROM usage_observations) AS usage,
      (SELECT count(*) FROM resource_observations) AS resources,
      (SELECT count(*) FROM monthly_cost_summary) AS monthly_summaries`)
    console.table(result.rows)
  })
}

const commands: Record<string, () => Promise<void>> = {
  migrate, status, seed, "reset-dev": resetDev, "backfill-d1": backfillD1, validate,
}

async function main() {
  const run = commands[command]
  if (!run) throw new Error(`Unknown analytics command: ${command}`)
  await run()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
