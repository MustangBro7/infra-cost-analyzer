// Reads AI coding-tool usage from LOCAL logs (Claude Code, Codex) and turns it
// into a usage + estimated-API-cost payload to push to Ambrium. This is the path
// for flat personal subscriptions (Claude Pro/Max, ChatGPT Plus/Pro) whose
// vendors expose no cost API — the only place that month's token usage exists.
//
// Pure Node built-ins; no deps. Cost figures are ESTIMATES at public API list
// prices (the value of what you used), not what your flat subscription charges.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const HOME = homedir()

// Per-million-token list prices (USD). Matched by substring against the model id;
// first match wins, else the provider default. Approximate and clearly labeled
// as estimates in the UI.
const CLAUDE_PRICES = [
  { match: /opus/i, in: 15, cacheWrite: 18.75, cacheRead: 1.5, out: 75 },
  { match: /sonnet/i, in: 3, cacheWrite: 3.75, cacheRead: 0.3, out: 15 },
  { match: /haiku/i, in: 0.8, cacheWrite: 1.0, cacheRead: 0.08, out: 4 },
  { match: /fable/i, in: 15, cacheWrite: 18.75, cacheRead: 1.5, out: 75 },
]
const CLAUDE_DEFAULT = { in: 3, cacheWrite: 3.75, cacheRead: 0.3, out: 15 }

const OPENAI_PRICES = [
  { match: /gpt-5.*mini/i, in: 0.25, cachedIn: 0.025, out: 2 },
  { match: /gpt-5/i, in: 1.25, cachedIn: 0.125, out: 10 },
  { match: /gpt-4o.*mini/i, in: 0.15, cachedIn: 0.075, out: 0.6 },
  { match: /gpt-4o|gpt-4\.1/i, in: 2.5, cachedIn: 1.25, out: 10 },
  { match: /o[134]/i, in: 1.1, cachedIn: 0.55, out: 4.4 },
  { match: /codex/i, in: 1.25, cachedIn: 0.125, out: 10 },
]
const OPENAI_DEFAULT = { in: 1.25, cachedIn: 0.125, out: 10 }

const M = 1_000_000

function claudePrice(model) {
  return CLAUDE_PRICES.find((p) => p.match.test(model)) ?? CLAUDE_DEFAULT
}
function openAiPrice(model) {
  return OPENAI_PRICES.find((p) => p.match.test(model)) ?? OPENAI_DEFAULT
}

function pricedModel(model, tokens, price) {
  const inputUsd = (tokens.input * price.in) / M
  const cacheUsd = ((tokens.cacheCreate ?? tokens.cached ?? 0) * (price.cacheWrite ?? price.cachedIn ?? 0) + (tokens.cacheRead ?? 0) * (price.cacheRead ?? 0)) / M
  const outputUsd = (tokens.output * price.out) / M
  return {
    model,
    inputTokens: tokens.displayInput ?? tokens.input,
    cacheTokens: (tokens.cacheCreate ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cached ?? 0),
    outputTokens: tokens.output,
    inputUsd: Number(inputUsd.toFixed(4)),
    cacheUsd: Number(cacheUsd.toFixed(4)),
    outputUsd: Number(outputUsd.toFixed(4)),
    estimatedApiUsd: Number((inputUsd + cacheUsd + outputUsd).toFixed(4)),
    rates: {
      inputPerMillion: price.in,
      cachePerMillion: price.cacheWrite ?? price.cachedIn ?? 0,
      cacheReadPerMillion: price.cacheRead ?? null,
      outputPerMillion: price.out,
    },
  }
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7) // YYYY-MM (UTC)
}

function normalizeLimitValue(value, fallbackLabel, fallbackPeriod) {
  if (!value || typeof value !== "object") return null
  const used = Number(value.used ?? value.current ?? value.consumed ?? value.usage)
  const limit = Number(value.limit ?? value.maximum ?? value.max ?? value.quota)
  return {
    label: String(value.label ?? value.name ?? fallbackLabel),
    used: Number.isFinite(used) ? used : null,
    limit: Number.isFinite(limit) ? limit : null,
    unit: String(value.unit ?? "tokens"),
    period: String(value.period ?? fallbackPeriod),
    resetsAt: typeof value.resets_at === "string" ? value.resets_at : typeof value.resetsAt === "string" ? value.resetsAt : null,
  }
}

function normalizeRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== "object") return []
  const known = [
    ["session", "Session limit"],
    ["weekly", "Weekly limit"],
    ["daily", "Daily limit"],
    ["monthly", "Monthly limit"],
  ]
  const limits = []
  for (const [key, label] of known) {
    const row = normalizeLimitValue(rateLimits[key] ?? rateLimits[`${key}_limit`], label, key)
    if (row) limits.push(row)
  }
  if (limits.length > 0) return limits
  return Object.entries(rateLimits)
    .map(([key, value]) => normalizeLimitValue(value, key.replace(/_/g, " "), key))
    .filter(Boolean)
}

// Recursively list files under dir (depth-limited), tolerating missing dirs.
function walk(dir, predicate, out = [], depth = 0) {
  if (depth > 8 || !existsSync(dir)) return out
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, predicate, out, depth + 1)
    else if (predicate(full)) out.push(full)
  }
  return out
}

function readLines(file) {
  try {
    return readFileSync(file, "utf8").split("\n")
  } catch {
    return []
  }
}

// ---- Claude Code: ~/.claude/projects/**/*.jsonl ----
export function readClaudeUsage(month = currentMonth()) {
  const root = join(HOME, ".claude", "projects")
  if (!existsSync(root)) return null
  const monthStart = new Date(`${month}-01T00:00:00Z`).getTime()
  const files = walk(root, (f) => f.endsWith(".jsonl")).filter((f) => {
    try {
      return statSync(f).mtimeMs >= monthStart
    } catch {
      return false
    }
  })

  const byModel = new Map()
  const seen = new Set()
  for (const file of files) {
    for (const line of readLines(file)) {
      if (!line || !line.includes('"usage"')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type !== "assistant") continue
      const ts = typeof event.timestamp === "string" ? event.timestamp : ""
      if (!ts.startsWith(month)) continue
      const message = event.message || {}
      const usage = message.usage
      const model = message.model
      // Skip Claude Code's internal "<synthetic>" model (no real billing).
      if (!usage || !model || model.startsWith("<")) continue
      const id = message.id || `${event.requestId}:${event.uuid}`
      if (id && seen.has(id)) continue
      if (id) seen.add(id)
      const m = byModel.get(model) || { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 }
      m.input += Number(usage.input_tokens) || 0
      m.cacheCreate += Number(usage.cache_creation_input_tokens) || 0
      m.cacheRead += Number(usage.cache_read_input_tokens) || 0
      m.output += Number(usage.output_tokens) || 0
      byModel.set(model, m)
    }
  }
  if (byModel.size === 0) return null

  const models = [...byModel.entries()]
    .filter(([, t]) => t.input + t.cacheCreate + t.cacheRead + t.output > 0)
    .map(([model, t]) => {
      const p = claudePrice(model)
      return pricedModel(model, t, p)
    })
  if (models.length === 0) return null
  return {
    provider: "anthropic",
    toolLabel: "Claude Code",
    month,
    planLabel: process.env.AMBRIUM_CLAUDE_PLAN || null,
    subscriptionUsd: Number(process.env.AMBRIUM_CLAUDE_PLAN_COST ?? process.env.AMBRIUM_PLAN_COST ?? 20),
    models,
  }
}

// ---- Codex: ~/.codex/sessions/YYYY/MM/**/rollout-*.jsonl ----
export function readCodexUsage(month = currentMonth()) {
  const [year, mm] = month.split("-")
  const root = join(HOME, ".codex", "sessions", year, mm)
  if (!existsSync(root)) return null
  const files = walk(root, (f) => f.endsWith(".jsonl") && f.includes("rollout-"))

  const byModel = new Map()
  let planType = null
  let lastRateLimits = null
  for (const file of files) {
    let model = "gpt-5"
    let lastTotals = null
    for (const line of readLines(file)) {
      if (!line) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      const payload = event.payload || {}
      if (typeof payload.model === "string") model = payload.model
      else if (typeof event.model === "string") model = event.model
      if (payload.type === "token_count" && payload.info?.total_token_usage) {
        lastTotals = payload.info.total_token_usage
        if (payload.rate_limits?.plan_type) planType = payload.rate_limits.plan_type
        if (payload.rate_limits) lastRateLimits = payload.rate_limits
      }
    }
    if (!lastTotals) continue
    const m = byModel.get(model) || { input: 0, cached: 0, output: 0 }
    m.input += Number(lastTotals.input_tokens) || 0
    m.cached += Number(lastTotals.cached_input_tokens) || 0
    m.output += (Number(lastTotals.output_tokens) || 0) + (Number(lastTotals.reasoning_output_tokens) || 0)
    byModel.set(model, m)
  }
  if (byModel.size === 0) return null

  const models = [...byModel.entries()].map(([model, t]) => {
    const p = openAiPrice(model)
    const uncachedInput = Math.max(t.input - t.cached, 0)
    return pricedModel(model, { input: uncachedInput, displayInput: t.input, cached: t.cached, output: t.output }, p)
  })
  const planLabel = planType ? planType.charAt(0).toUpperCase() + planType.slice(1) : null
  const planCost = process.env.AMBRIUM_PLAN_COST ?? (planType === "pro" ? 200 : 20)
  return {
    provider: "openai",
    toolLabel: "Codex",
    month,
    planLabel,
    subscriptionUsd: Number(planCost),
    limits: normalizeRateLimits(lastRateLimits),
    models,
  }
}

/** Returns one payload per AI tool that has local usage this month. */
export function collectAiUsage(month = currentMonth()) {
  return [readClaudeUsage(month), readCodexUsage(month)].filter(Boolean)
}
