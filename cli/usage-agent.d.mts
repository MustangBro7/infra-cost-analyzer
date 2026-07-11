import type { Server } from "node:http"

export const DEFAULT_AGENT_PORT: number

export function agentAllowedOrigin(origin: string | undefined | null, apiBase?: string | null): string | null

export function startUsageAgent(options: {
  port?: number
  apiBase?: string | null
  push: (payload: unknown) => Promise<void>
  collect?: () => Promise<Array<Record<string, unknown>>>
  log?: (line: string) => void
  autoSyncMs?: number
}): Server
