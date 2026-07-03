import test from "node:test"
import assert from "node:assert/strict"
import type { StoredConnection, WorkspaceStore } from "../src/lib/types"

/**
 * A small in-memory stand-in for Cloudflare D1, sufficient for the statement
 * shapes the scoped per-user store helpers emit: CREATE TABLE (noop), INSERT
 * [OR IGNORE], DELETE FROM t [WHERE col = ?1], and SELECT <cols|*> FROM t
 * [WHERE col = ?1] [ORDER BY col]. It lets the tests prove per-user isolation
 * and round-trip fidelity of loadWorkspaceFromD1 / persistWorkspaceToD1 without
 * a real Worker runtime.
 */
class FakeD1 {
  tables = new Map<string, Record<string, unknown>[]>()

  prepare(sql: string) {
    return new FakeStatement(this, sql.replace(/\s+/g, " ").trim())
  }

  async batch(statements: FakeStatement[]) {
    for (const statement of statements) await statement.run()
  }

  rows(table: string) {
    let rows = this.tables.get(table)
    if (!rows) {
      rows = []
      this.tables.set(table, rows)
    }
    return rows
  }
}

class FakeStatement {
  private args: unknown[] = []
  constructor(
    private db: FakeD1,
    private sql: string
  ) {}

  bind(...values: unknown[]) {
    this.args = values
    return this
  }

  private exec(): Record<string, unknown>[] {
    const sql = this.sql

    if (/^CREATE TABLE/i.test(sql) || /^ALTER TABLE/i.test(sql)) return []

    let match: RegExpMatchArray | null

    if ((match = sql.match(/^DELETE FROM (\w+)(?: WHERE (\w+) = \?(\d+))?$/i))) {
      const [, table, whereCol, argIdx] = match
      const rows = this.db.rows(table)
      if (!whereCol) {
        rows.length = 0
        return []
      }
      const value = this.args[Number(argIdx) - 1]
      this.db.tables.set(
        table,
        rows.filter((row) => row[whereCol] !== value)
      )
      return []
    }

    if ((match = sql.match(/^INSERT(?: OR IGNORE)?\s+INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/i))) {
      const [, table, colList, valueList] = match
      const cols = colList.split(",").map((c) => c.trim())
      const placeholders = valueList.split(",").map((v) => v.trim())
      const row: Record<string, unknown> = {}
      cols.forEach((col, i) => {
        const ph = placeholders[i]
        row[col] = ph.startsWith("?") ? this.args[Number(ph.slice(1)) - 1] : ph
      })
      const rows = this.db.rows(table)
      if (/OR IGNORE/i.test(sql)) {
        // Honor the single-column primary key used by app_billing_webhooks.
        const pk = cols[0]
        if (rows.some((existing) => existing[pk] === row[pk])) return []
      }
      rows.push(row)
      return []
    }

    if ((match = sql.match(/^SELECT (.+?) FROM (\w+)(?: WHERE (\w+) = \?(\d+))?(?: ORDER BY (\w+))?$/i))) {
      const [, , table, whereCol, argIdx, orderBy] = match
      let rows = [...this.db.rows(table)]
      if (whereCol) {
        const value = this.args[Number(argIdx) - 1]
        rows = rows.filter((row) => row[whereCol] === value)
      }
      if (orderBy) {
        rows.sort((a, b) => Number(a[orderBy]) - Number(b[orderBy]))
      }
      return rows
    }

    throw new Error(`FakeD1: unsupported SQL: ${sql}`)
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const rows = this.exec()
    const row = rows[0]
    if (!row) return null
    return (column ? (row[column] as T) : (row as T)) ?? null
  }

  async all<T = unknown>(): Promise<{ results?: T[] }> {
    return { results: this.exec() as T[] }
  }

  async run(): Promise<unknown> {
    this.exec()
    return {}
  }
}

function sampleWorkspace(overrides: Partial<WorkspaceStore> = {}): WorkspaceStore {
  const connection: StoredConnection = {
    provider: "vercel",
    status: "connected",
    accountLabel: "Acme",
    accessToken: "super-secret-token",
    connectedAt: "2026-06-12T00:00:00.000Z",
    lastVerifiedAt: "2026-06-12T00:00:00.000Z",
    lastError: null,
    metadata: { projectCount: 3 },
  }
  return {
    connections: { vercel: connection },
    githubRepos: [
      {
        id: 1,
        owner: "acme",
        name: "web",
        fullName: "acme/web",
        private: true,
        defaultBranch: "main",
        htmlUrl: "https://github.com/acme/web",
        pushedAt: null,
        updatedAt: null,
      },
    ],
    selectedRepoFullName: "acme/web",
    syncedRepoFullNames: ["acme/web"],
    events: [
      { id: "e1", provider: "system", level: "info", message: "hello", createdAt: "2026-06-12T00:00:00.000Z" },
    ],
    analysisSnapshots: {},
    repoProviderLinks: { "acme/web": ["vercel"] },
    costAssignments: { "vercel:proj": "team-a" },
    customProviders: {},
    customConnections: {},
    billingSubscription: null,
    monthlyBudgetUsd: 200,
    dashboardLayout: [],
    alertSettings: { enabled: true, digest: "weekly" },
    alertState: { sentKeys: { "2026-07:budget:80": "2026-07-10T00:00:00.000Z" }, lastDigestAt: null },
    ...overrides,
  }
}

test("scoped D1: round-trips a workspace and decrypts the access token", async () => {
  process.env.APP_ENCRYPTION_KEY = "test-encryption-key"
  const { __test__ } = await import("../src/lib/localStore")
  const db = new FakeD1()

  await __test__.persistWorkspaceToD1(db as never, "usr_a", sampleWorkspace())
  const loaded = await __test__.loadWorkspaceFromD1(db as never, "usr_a")

  assert.equal(loaded.connections.vercel?.status, "connected")
  assert.equal(loaded.connections.vercel?.accessToken, "super-secret-token")
  assert.equal(loaded.connections.vercel?.metadata.projectCount, 3)
  assert.equal(loaded.selectedRepoFullName, "acme/web")
  assert.equal(loaded.monthlyBudgetUsd, 200)
  assert.deepEqual(loaded.repoProviderLinks["acme/web"], ["vercel"])
  assert.equal(loaded.costAssignments["vercel:proj"], "team-a")
  assert.equal(loaded.githubRepos[0]?.fullName, "acme/web")
  assert.deepEqual(loaded.alertSettings, { enabled: true, digest: "weekly" })
  assert.equal(loaded.alertState?.sentKeys["2026-07:budget:80"], "2026-07-10T00:00:00.000Z")
})

test("scoped D1: writing one user never touches another user's rows", async () => {
  process.env.APP_ENCRYPTION_KEY = "test-encryption-key"
  const { __test__ } = await import("../src/lib/localStore")
  const db = new FakeD1()

  await __test__.persistWorkspaceToD1(db as never, "usr_a", sampleWorkspace({ selectedRepoFullName: "acme/web" }))
  await __test__.persistWorkspaceToD1(db as never, "usr_b", sampleWorkspace({ selectedRepoFullName: "beta/api" }))

  // Re-persist A with a changed field; B must be untouched.
  await __test__.persistWorkspaceToD1(db as never, "usr_a", sampleWorkspace({ selectedRepoFullName: "acme/new" }))

  const a = await __test__.loadWorkspaceFromD1(db as never, "usr_a")
  const b = await __test__.loadWorkspaceFromD1(db as never, "usr_b")

  assert.equal(a.selectedRepoFullName, "acme/new")
  assert.equal(b.selectedRepoFullName, "beta/api")
  // A's rewrite must not have duplicated or dropped B's single connection row.
  assert.equal(b.connections.vercel?.status, "connected")
  assert.equal(db.rows("app_provider_connections").length, 2)
})

test("scoped D1: an empty workspace clears the user's rows without affecting others", async () => {
  process.env.APP_ENCRYPTION_KEY = "test-encryption-key"
  const { __test__ } = await import("../src/lib/localStore")
  const db = new FakeD1()

  await __test__.persistWorkspaceToD1(db as never, "usr_a", sampleWorkspace())
  await __test__.persistWorkspaceToD1(db as never, "usr_b", sampleWorkspace())

  await __test__.persistWorkspaceToD1(db as never, "usr_a", sampleWorkspace({ connections: {}, githubRepos: [] }))

  const a = await __test__.loadWorkspaceFromD1(db as never, "usr_a")
  const b = await __test__.loadWorkspaceFromD1(db as never, "usr_b")

  assert.equal(Object.keys(a.connections).length, 0)
  assert.equal(a.githubRepos.length, 0)
  assert.equal(b.connections.vercel?.status, "connected")
  assert.equal(b.githubRepos.length, 1)
})
