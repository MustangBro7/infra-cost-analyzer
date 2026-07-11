// Types for the CLI usage collector's exports that server code/tests import.
export interface AiLimitRow {
  label: string
  used: number | null
  limit: number | null
  unit: string
  period: string
  resetsAt: string | null
}

export function pricedModel(
  model: string,
  tokens: { input: number; displayInput?: number; cacheCreate?: number; cacheRead?: number; cached?: number; output: number },
  price: { in: number; cacheWrite?: number; cacheRead?: number; cachedIn?: number; out: number }
): {
  model: string
  inputTokens: number
  cacheTokens: number
  outputTokens: number
  inputUsd: number
  cacheUsd: number
  outputUsd: number
  estimatedApiUsd: number
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
