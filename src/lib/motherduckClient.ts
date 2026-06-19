import { Client } from "pg"

export type MotherDuckPlan = "free" | "lite" | "business"

export interface MotherDuckDatabaseUsage {
  name: string
  bytes: number
}

export interface MotherDuckUsage {
  databaseName: string
  username: string
  databases: MotherDuckDatabaseUsage[]
  totalBytes: number
}

const SIZE_PATTERN = /^([\d.]+)\s*(bytes?|ki?b|mi?b|gi?b|ti?b)$/i
const SIZE_MULTIPLIERS: Record<string, number> = {
  byte: 1,
  bytes: 1,
  b: 1,
  kb: 1_000,
  kib: 1024,
  mb: 1_000_000,
  mib: 1024 ** 2,
  gb: 1_000_000_000,
  gib: 1024 ** 3,
  tb: 1_000_000_000_000,
  tib: 1024 ** 4,
}

export function parseMotherDuckSize(value: string): number {
  const match = value.trim().match(SIZE_PATTERN)
  if (!match) return 0
  return Math.round(Number(match[1]) * (SIZE_MULTIPLIERS[match[2].toLowerCase()] ?? 0))
}

export function sanitizeMotherDuckConnectionString(value: string): string {
  const url = new URL(value.trim())
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("MotherDuck must use a PostgreSQL endpoint.")
  }
  if (!url.hostname.endsWith(".motherduck.com")) {
    throw new Error("Use the PostgreSQL endpoint from your MotherDuck account.")
  }
  if (!url.password) throw new Error("The MotherDuck PostgreSQL endpoint must include its token.")
  url.searchParams.set("sslmode", "verify-full")
  return url.toString()
}

export function motherDuckRegion(connectionString: string): string {
  return new URL(connectionString).hostname.match(/^pg\.([^.]+)\./)?.[1] ?? "us-east-1"
}

export async function fetchMotherDuckUsage(connectionString: string): Promise<MotherDuckUsage> {
  const client = new Client({
    connectionString: sanitizeMotherDuckConnectionString(connectionString),
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
  })
  await client.connect()
  try {
    const identity = await client.query("SELECT current_database() AS database_name, current_user AS username")
    const sizes = await client.query("SELECT database_name, database_size FROM pragma_database_size()")
    const databases = sizes.rows
      .map((row) => ({
        name: String(row.database_name),
        bytes: parseMotherDuckSize(String(row.database_size ?? "0 bytes")),
      }))
      .filter((row) => row.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
    return {
      databaseName: String(identity.rows[0]?.database_name ?? "MotherDuck"),
      username: String(identity.rows[0]?.username ?? "MotherDuck user"),
      databases,
      totalBytes: databases.reduce((sum, row) => sum + row.bytes, 0),
    }
  } finally {
    await client.end().catch(() => undefined)
  }
}

export function motherDuckStorageRate(region: string): number {
  return region.startsWith("eu-") ? 0.043 : 0.04
}
