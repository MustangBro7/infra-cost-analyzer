import type { CustomProviderDef } from "./types"

// Executes a user-defined ("custom") provider connector: a declarative
// HTTP-to-JSON mapping that the user or their AI coding agent registers at
// runtime via the extension API. No code deploy is needed — the cost engine
// runs this on every refresh and the resulting rows flow through the exact same
// pipeline as the built-in providers.

export interface CustomCostRow {
  service: string
  cost: number
  currency: string
}

export interface CustomUsageRow {
  service: string
  quantity: number
  unit: string
}

export interface CustomRunResult {
  costRows: CustomCostRow[]
  usage: CustomUsageRow[]
}

// Hard caps so a misbehaving connector can't exhaust the Worker.
const FETCH_TIMEOUT_MS = 12_000
const MAX_RESPONSE_BYTES = 4_000_000
const MAX_ROWS = 500

/** The current calendar month as an inclusive { from, to } YYYY-MM-DD range. */
export function monthPeriod(): { from: string; to: string } {
  const now = new Date()
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

export class CustomProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CustomProviderError"
  }
}

/** Resolves a dot/bracket path ("data.items", "results[0].amount") against a value. */
export function getPath(source: unknown, path: string): unknown {
  if (!path) return source
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((segment) => segment.length > 0)
  let current: unknown = source
  for (const segment of segments) {
    if (current == null) return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      current = Number.isInteger(index) ? current[index] : undefined
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return current
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function toArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
  if (value && typeof value === "object") return [value as Record<string, unknown>]
  return []
}

interface Placeholders {
  token: string
  periodStart: string
  periodEnd: string
  monthStart: string
  periodStartUnix: string
  periodEndUnix: string
}

function buildPlaceholders(secret: string, period: { from: string; to: string }): Placeholders {
  const endExclusive = new Date(`${period.to}T00:00:00Z`)
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1)
  return {
    token: secret,
    periodStart: period.from,
    periodEnd: period.to,
    monthStart: period.from,
    periodStartUnix: String(Math.floor(new Date(`${period.from}T00:00:00Z`).getTime() / 1000)),
    periodEndUnix: String(Math.floor(endExclusive.getTime() / 1000)),
  }
}

function interpolate(template: string, values: Placeholders): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    key in values ? String(values[key as keyof Placeholders]) : match
  )
}

// Blocks obviously-private/loopback hosts to reduce SSRF surface. Connectors are
// meant to call public provider billing APIs, never internal addresses.
function assertSafeUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new CustomProviderError("Request URL is not a valid URL.")
  }
  if (url.protocol !== "https:") {
    throw new CustomProviderError("Request URL must use https.")
  }
  const host = url.hostname.toLowerCase()
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "metadata.google.internal" ||
    host === "[::1]"
  if (blocked) {
    throw new CustomProviderError("Request URL points at a private or loopback address, which is not allowed.")
  }
  return url
}

/**
 * Validates a custom provider definition shape and returns a normalized copy.
 * Used by the API before persisting (so bad manifests are rejected at write
 * time, not at refresh time). Throws CustomProviderError on the first problem.
 */
export function validateCustomProviderDef(input: unknown): Omit<CustomProviderDef, "id" | "createdAt" | "updatedAt"> {
  if (!input || typeof input !== "object") throw new CustomProviderError("Definition must be an object.")
  const def = input as Record<string, unknown>

  const name = typeof def.name === "string" ? def.name.trim() : ""
  if (!name || name.length > 60) throw new CustomProviderError("name is required (1–60 chars).")

  const auth = (def.auth ?? {}) as Record<string, unknown>
  const authType = typeof auth.type === "string" ? auth.type : "bearer"
  if (!["bearer", "header", "basic", "query", "none"].includes(authType)) {
    throw new CustomProviderError("auth.type must be one of bearer, header, basic, query, none.")
  }
  if (authType === "header" && !(typeof auth.headerName === "string" && auth.headerName.trim())) {
    throw new CustomProviderError("auth.headerName is required when auth.type is header.")
  }
  if (authType === "query" && !(typeof auth.queryParam === "string" && auth.queryParam.trim())) {
    throw new CustomProviderError("auth.queryParam is required when auth.type is query.")
  }

  const request = (def.request ?? {}) as Record<string, unknown>
  const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET"
  if (!["GET", "POST"].includes(method)) throw new CustomProviderError("request.method must be GET or POST.")
  const url = typeof request.url === "string" ? request.url.trim() : ""
  if (!url) throw new CustomProviderError("request.url is required.")
  // Validate the non-templated parts of the URL; {{token}} etc. are filled later.
  assertSafeUrl(url.replace(/\{\{\s*\w+\s*\}\}/g, "x"))

  const headers: Record<string, string> = {}
  if (request.headers && typeof request.headers === "object") {
    for (const [key, value] of Object.entries(request.headers as Record<string, unknown>)) {
      if (typeof value === "string") headers[key] = value
    }
  }

  const cost = def.cost && typeof def.cost === "object" ? (def.cost as Record<string, unknown>) : null
  const usage = def.usage && typeof def.usage === "object" ? (def.usage as Record<string, unknown>) : null
  if (!cost && !usage) throw new CustomProviderError("Provide at least one of cost or usage mapping.")
  if (cost && typeof cost.amountField !== "string") throw new CustomProviderError("cost.amountField is required.")
  if (usage && typeof usage.quantityField !== "string") throw new CustomProviderError("usage.quantityField is required.")

  return {
    name,
    shortLabel: typeof def.shortLabel === "string" ? def.shortLabel.slice(0, 2) : null,
    color: typeof def.color === "string" && /^#[0-9a-fA-F]{6}$/.test(def.color) ? def.color : null,
    homepage: typeof def.homepage === "string" ? def.homepage : null,
    auth: {
      type: authType as CustomProviderDef["auth"]["type"],
      headerName: typeof auth.headerName === "string" ? auth.headerName : null,
      queryParam: typeof auth.queryParam === "string" ? auth.queryParam : null,
    },
    request: {
      method: method as "GET" | "POST",
      url,
      headers,
      body: typeof request.body === "string" ? request.body : null,
    },
    cost: cost
      ? {
          itemsPath: typeof cost.itemsPath === "string" ? cost.itemsPath : "",
          amountField: cost.amountField as string,
          amountInCents: cost.amountInCents === true,
          serviceField: typeof cost.serviceField === "string" ? cost.serviceField : null,
          currency: typeof cost.currency === "string" ? cost.currency : "USD",
        }
      : null,
    usage: usage
      ? {
          itemsPath: typeof usage.itemsPath === "string" ? usage.itemsPath : "",
          quantityField: usage.quantityField as string,
          serviceField: typeof usage.serviceField === "string" ? usage.serviceField : null,
          unitField: typeof usage.unitField === "string" ? usage.unitField : null,
          unit: typeof usage.unit === "string" ? usage.unit : null,
        }
      : null,
  }
}

async function fetchJson(def: CustomProviderDef, secret: string, period: { from: string; to: string }): Promise<unknown> {
  const placeholders = buildPlaceholders(secret, period)
  let urlString = interpolate(def.request.url, placeholders)

  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(def.request.headers ?? {})) {
    headers[key] = interpolate(value, placeholders)
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "accept")) headers.accept = "application/json"

  switch (def.auth.type) {
    case "bearer":
      headers.authorization = `Bearer ${secret}`
      break
    case "header":
      if (def.auth.headerName) headers[def.auth.headerName] = secret
      break
    case "basic":
      headers.authorization = `Basic ${Buffer.from(`${secret}:`).toString("base64")}`
      break
    case "query": {
      const u = new URL(urlString)
      if (def.auth.queryParam) u.searchParams.set(def.auth.queryParam, secret)
      urlString = u.toString()
      break
    }
    case "none":
      break
  }

  const url = assertSafeUrl(urlString)
  let body: string | undefined
  if (def.request.method === "POST" && def.request.body) {
    body = interpolate(def.request.body, placeholders)
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json"
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url.toString(), {
      method: def.request.method,
      headers,
      body,
      signal: controller.signal,
      redirect: "follow",
    })
  } catch (error) {
    throw new CustomProviderError(
      error instanceof Error && error.name === "AbortError"
        ? "Request timed out."
        : `Request failed: ${error instanceof Error ? error.message : "network error"}`
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new CustomProviderError("Response is too large.")
  if (!response.ok) {
    throw new CustomProviderError(`Upstream returned ${response.status}: ${text.slice(0, 200)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new CustomProviderError("Response was not valid JSON.")
  }
}

function mapResult(def: CustomProviderDef, json: unknown): CustomRunResult {
  const costRows: CustomCostRow[] = []
  const usage: CustomUsageRow[] = []

  if (def.cost) {
    const items = toArray(getPath(json, def.cost.itemsPath)).slice(0, MAX_ROWS)
    for (const item of items) {
      let cost = toNumber(getPath(item, def.cost.amountField))
      if (def.cost.amountInCents) cost = cost / 100
      if (cost === 0) continue
      const service = def.cost.serviceField
        ? String(getPath(item, def.cost.serviceField) ?? def.name)
        : def.name
      costRows.push({ service, cost: Number(cost.toFixed(4)), currency: def.cost.currency || "USD" })
    }
  }

  if (def.usage) {
    const items = toArray(getPath(json, def.usage.itemsPath)).slice(0, MAX_ROWS)
    for (const item of items) {
      const quantity = toNumber(getPath(item, def.usage.quantityField))
      if (quantity === 0) continue
      const service = def.usage.serviceField ? String(getPath(item, def.usage.serviceField) ?? "Usage") : "Usage"
      const unit = def.usage.unitField ? String(getPath(item, def.usage.unitField) ?? def.usage.unit ?? "") : def.usage.unit ?? ""
      usage.push({ service, quantity, unit })
    }
  }

  return { costRows, usage }
}

/** Fetches and maps a custom provider's data into cost + usage rows. */
export async function runCustomProvider(
  def: CustomProviderDef,
  secret: string,
  period: { from: string; to: string }
): Promise<CustomRunResult> {
  const json = await fetchJson(def, secret, period)
  return mapResult(def, json)
}

/**
 * Dry-run used by the "test connector" endpoint: returns the mapped result plus
 * a small sample of the raw response so the user/agent can debug their mapping.
 */
export async function dryRunCustomProvider(
  def: CustomProviderDef,
  secret: string,
  period: { from: string; to: string }
): Promise<CustomRunResult & { sampleResponse: string }> {
  const json = await fetchJson(def, secret, period)
  const mapped = mapResult(def, json)
  return { ...mapped, sampleResponse: JSON.stringify(json).slice(0, 2000) }
}
