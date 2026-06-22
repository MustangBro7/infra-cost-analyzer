import type { AnalyticsPayload } from "./types"
import { writeAnalyticsPayload } from "./writer"

interface D1ResultLike<T = unknown> {
  results?: T[]
}

interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  first<T = unknown>(column?: string): Promise<T | null>
  all<T = unknown>(): Promise<D1ResultLike<T>>
  run(): Promise<unknown>
}

interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike
}

interface OutboxRow {
  id: string
  payload: string
  attempt_count: number
}

let testDatabase: D1DatabaseLike | null | undefined
let testWriter: ((payload: AnalyticsPayload) => Promise<void>) | null = null
const memoryOutbox = new Map<string, { payload: AnalyticsPayload; attempts: number; nextAttemptAt: number }>()

export function setAnalyticsOutboxDatabaseForTests(database: D1DatabaseLike | null | undefined) {
  testDatabase = database
  memoryOutbox.clear()
}

export function setAnalyticsOutboxWriterForTests(writer: ((payload: AnalyticsPayload) => Promise<void>) | null) {
  testWriter = writer
}

async function deliver(payload: AnalyticsPayload) {
  return (testWriter ?? writeAnalyticsPayload)(payload)
}

async function database(): Promise<D1DatabaseLike | null> {
  if (testDatabase !== undefined) return testDatabase
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare/cloudflare-context")
    return ((getCloudflareContext().env as { DB?: D1DatabaseLike }).DB ?? null)
  } catch {
    return null
  }
}

async function ensureTable(db: D1DatabaseLike): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS analytics_outbox (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT
    )`
  ).run()
}

function retryDelayMs(attempt: number): number {
  return Math.min(6 * 60 * 60 * 1000, 30_000 * 2 ** Math.min(attempt, 10))
}

export async function enqueueAnalyticsPayload(payload: AnalyticsPayload, error: unknown): Promise<void> {
  const db = await database()
  const message = error instanceof Error ? error.message : String(error)
  if (!db) {
    memoryOutbox.set(payload.syncRunId, {
      payload,
      attempts: 0,
      nextAttemptAt: testDatabase !== undefined ? Date.now() : Date.now() + retryDelayMs(0),
    })
    return
  }
  await ensureTable(db)
  const now = new Date()
  await db.prepare(
    `INSERT INTO analytics_outbox (
      id, payload, attempt_count, next_attempt_at, last_error, created_at, delivered_at
    ) VALUES (?1, ?2, 0, ?3, ?4, ?5, NULL)
    ON CONFLICT(id) DO UPDATE SET
      payload = excluded.payload,
      next_attempt_at = excluded.next_attempt_at,
      last_error = excluded.last_error,
      delivered_at = NULL`
  )
    .bind(
      payload.syncRunId,
      JSON.stringify(payload),
      new Date(now.getTime() + retryDelayMs(0)).toISOString(),
      message.slice(0, 2000),
      now.toISOString()
    )
    .run()
}

export async function drainAnalyticsOutbox(limit = 25): Promise<{ delivered: number; failed: number }> {
  const db = await database()
  if (!db) {
    let delivered = 0
    let failed = 0
    for (const [id, entry] of [...memoryOutbox.entries()].slice(0, limit)) {
      if (entry.nextAttemptAt > Date.now()) continue
      try {
        await deliver({ ...entry.payload, source: "retry" })
        memoryOutbox.delete(id)
        delivered += 1
      } catch {
        entry.attempts += 1
        entry.nextAttemptAt = Date.now() + retryDelayMs(entry.attempts)
        failed += 1
      }
    }
    return { delivered, failed }
  }

  await ensureTable(db)
  const result = await db.prepare(
    `SELECT id, payload, attempt_count
     FROM analytics_outbox
     WHERE delivered_at IS NULL AND next_attempt_at <= ?1
     ORDER BY created_at
     LIMIT ?2`
  )
    .bind(new Date().toISOString(), limit)
    .all<OutboxRow>()

  let delivered = 0
  let failed = 0
  for (const row of result.results ?? []) {
    try {
      const payload = JSON.parse(row.payload) as AnalyticsPayload
      await deliver({ ...payload, source: "retry" })
      await db.prepare("UPDATE analytics_outbox SET delivered_at = ?1, last_error = NULL WHERE id = ?2")
        .bind(new Date().toISOString(), row.id)
        .run()
      delivered += 1
    } catch (error) {
      const attempts = row.attempt_count + 1
      await db.prepare(
        `UPDATE analytics_outbox
         SET attempt_count = ?1, next_attempt_at = ?2, last_error = ?3
         WHERE id = ?4`
      )
        .bind(
          attempts,
          new Date(Date.now() + retryDelayMs(attempts)).toISOString(),
          (error instanceof Error ? error.message : String(error)).slice(0, 2000),
          row.id
        )
        .run()
      failed += 1
    }
  }
  return { delivered, failed }
}

export async function analyticsOutboxPendingCount(): Promise<number> {
  const db = await database()
  if (!db) return memoryOutbox.size
  await ensureTable(db)
  return (await db.prepare(
    "SELECT count(*) AS count FROM analytics_outbox WHERE delivered_at IS NULL"
  ).first<number>("count")) ?? 0
}
