import { Client, type ClientConfig } from "pg"

interface HyperdriveLike {
  connectionString: string
}

export interface AnalyticsConnectionEnv {
  ANALYTICS_DB?: HyperdriveLike
  MOTHERDUCK_DATABASE_URL?: string
  ANALYTICS_ENABLED?: string
  ANALYTICS_READS_ENABLED?: string
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return !["0", "false", "off", "no"].includes(value.toLowerCase())
}

export function analyticsWritesEnabled(
  env: AnalyticsConnectionEnv = process.env as unknown as AnalyticsConnectionEnv
): boolean {
  return flag(env.ANALYTICS_ENABLED, Boolean(env.ANALYTICS_DB?.connectionString || env.MOTHERDUCK_DATABASE_URL))
}

/**
 * Reads only require a connection + the reads flag — independent of writes, so
 * a read-only environment (staging pointed at the production MotherDuck with
 * ANALYTICS_ENABLED=false) can show history without ever writing to it.
 */
export function analyticsReadsEnabled(
  env: AnalyticsConnectionEnv = process.env as unknown as AnalyticsConnectionEnv
): boolean {
  const hasConnection = Boolean(env.ANALYTICS_DB?.connectionString || env.MOTHERDUCK_DATABASE_URL)
  return hasConnection && flag(env.ANALYTICS_READS_ENABLED, true)
}

async function cloudflareEnv(): Promise<AnalyticsConnectionEnv | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare/cloudflare-context")
    return getCloudflareContext().env as unknown as AnalyticsConnectionEnv
  } catch {
    return null
  }
}

export async function resolveAnalyticsConnectionString(
  explicitEnv?: AnalyticsConnectionEnv
): Promise<string | null> {
  const processEnvironment = process.env as unknown as AnalyticsConnectionEnv
  const env: AnalyticsConnectionEnv = explicitEnv ?? {
    ...processEnvironment,
    ...((await cloudflareEnv()) ?? {}),
  }
  return env.ANALYTICS_DB?.connectionString ?? env.MOTHERDUCK_DATABASE_URL ?? process.env.MOTHERDUCK_DATABASE_URL ?? null
}

export async function analyticsRuntimeFlags(): Promise<{ writes: boolean; reads: boolean }> {
  const env: AnalyticsConnectionEnv = {
    ...(process.env as unknown as AnalyticsConnectionEnv),
    ...((await cloudflareEnv()) ?? {}),
  }
  return {
    writes: analyticsWritesEnabled(env),
    reads: analyticsReadsEnabled(env),
  }
}

export async function createAnalyticsClient(): Promise<Client> {
  const connectionString = await resolveAnalyticsConnectionString()
  if (!connectionString) throw new Error("MotherDuck analytics connection is not configured.")
  const config: ClientConfig = {
    connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 60_000,
  }
  return new Client(config)
}

export async function withAnalyticsClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
  const client = await createAnalyticsClient()
  await client.connect()
  try {
    return await operation(client)
  } finally {
    await client.end().catch(() => undefined)
  }
}
