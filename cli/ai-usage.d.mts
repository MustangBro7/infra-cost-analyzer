// Types for the CLI usage collector's exports that server code/tests import.
export interface AiLimitRow {
  label: string
  used: number | null
  limit: number | null
  unit: string
  period: string
  resetsAt: string | null
}

export function codexRateLimitRows(rateLimits: unknown): AiLimitRow[]
export function codexUsageLimitRows(usage: unknown): AiLimitRow[]
export function readCodexAuth(): { accessToken: string; accountId: string | null } | null
export function fetchCodexLimits(): Promise<{ limits: AiLimitRow[]; planLabel: string | null } | null>
export function claudeLimitRows(usage: unknown): AiLimitRow[]
export function readClaudeOAuthCreds(): { accessToken: string; subscriptionType?: string } | null
export function fetchClaudeLimits(): Promise<{ limits: AiLimitRow[]; planLabel: string | null } | null>
export function readClaudeUsage(month?: string): unknown
export function readCodexUsage(month?: string): unknown
export function collectAiUsage(month?: string): Promise<unknown[]>
