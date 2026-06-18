import { randomBytes } from "node:crypto"
import { readStore, writeStore } from "./localStore"
import type { CliPairing } from "./types"

// OAuth 2.0 Device Authorization Grant (RFC 8628) for the companion CLI. The CLI
// can't hold a Clerk session, so it starts a pairing, the user approves it in the
// browser (typing the short userCode), and the CLI polls for a short-lived
// cliToken it then uses as a Bearer credential on the /api/cli/* endpoints.

const PAIRING_TTL_MS = 10 * 60 * 1000 // approval window for the user/device code
const CLI_TOKEN_TTL_MS = 30 * 60 * 1000 // lifetime of the minted CLI token
export const PAIRING_POLL_INTERVAL_SECONDS = 5

// User-typed code: avoid ambiguous chars (no 0/O/1/I), grouped XXXX-XXXX.
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function token(prefix: string, bytes = 32) {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`
}

function userCode() {
  const raw = randomBytes(8)
  const chars = Array.from(raw, (b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length])
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}`
}

function isExpired(pairing: CliPairing, now: number) {
  const tokenExp = pairing.cliTokenExpiresAt ? Date.parse(pairing.cliTokenExpiresAt) : 0
  const latest = Math.max(Date.parse(pairing.expiresAt), tokenExp)
  return now > latest
}

// Drops fully-expired pairings so the store stays small. Mutates the map.
function prune(pairings: Record<string, CliPairing>, now: number) {
  for (const [key, pairing] of Object.entries(pairings)) {
    if (isExpired(pairing, now)) delete pairings[key]
  }
}

export async function createCliPairing(): Promise<{
  deviceCode: string
  userCode: string
  interval: number
  expiresIn: number
}> {
  const store = await readStore()
  const now = Date.now()
  prune(store.cliPairings, now)
  const pairing: CliPairing = {
    deviceCode: token("dev_"),
    userCode: userCode(),
    userId: null,
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
    cliToken: null,
    cliTokenExpiresAt: null,
  }
  store.cliPairings[pairing.deviceCode] = pairing
  await writeStore(store)
  return {
    deviceCode: pairing.deviceCode,
    userCode: pairing.userCode,
    interval: PAIRING_POLL_INTERVAL_SECONDS,
    expiresIn: Math.floor(PAIRING_TTL_MS / 1000),
  }
}

/**
 * Binds a pending pairing (looked up by the user-typed code) to the approving
 * user and mints the short-lived CLI token. Idempotent for an already-approved
 * code by the same user. Throws on unknown/expired codes.
 */
export async function approveCliPairing(rawUserCode: string, userId: string): Promise<void> {
  const normalized = rawUserCode.trim().toUpperCase().replace(/\s+/g, "")
  const store = await readStore()
  const now = Date.now()
  prune(store.cliPairings, now)
  const pairing = Object.values(store.cliPairings).find((entry) => entry.userCode === normalized)
  if (!pairing) throw new Error("That code is invalid or has expired. Re-run the CLI to get a new one.")
  if (now > Date.parse(pairing.expiresAt)) throw new Error("That code has expired. Re-run the CLI to get a new one.")
  if (pairing.status === "denied") throw new Error("That pairing was denied.")
  pairing.userId = userId
  pairing.status = "authorized"
  pairing.cliToken = pairing.cliToken ?? token("cli_")
  pairing.cliTokenExpiresAt = new Date(now + CLI_TOKEN_TTL_MS).toISOString()
  await writeStore(store)
}

export async function pollCliPairing(
  deviceCode: string
): Promise<{ status: "pending" | "authorized" | "denied" | "expired"; cliToken?: string; expiresIn?: number }> {
  const store = await readStore()
  const now = Date.now()
  const pairing = store.cliPairings[deviceCode]
  if (!pairing) return { status: "expired" }
  if (now > Date.parse(pairing.expiresAt) && pairing.status !== "authorized") {
    delete store.cliPairings[deviceCode]
    await writeStore(store)
    return { status: "expired" }
  }
  if (pairing.status === "authorized" && pairing.cliToken && pairing.cliTokenExpiresAt) {
    return {
      status: "authorized",
      cliToken: pairing.cliToken,
      expiresIn: Math.max(0, Math.floor((Date.parse(pairing.cliTokenExpiresAt) - now) / 1000)),
    }
  }
  return { status: pairing.status }
}

/** Resolves a CLI bearer token to the user it was minted for, or null if invalid/expired. */
export async function userIdFromCliToken(cliToken: string): Promise<string | null> {
  if (!cliToken) return null
  const store = await readStore()
  const now = Date.now()
  const pairing = Object.values(store.cliPairings).find((entry) => entry.cliToken === cliToken)
  if (!pairing || pairing.status !== "authorized" || !pairing.userId) return null
  if (!pairing.cliTokenExpiresAt || now > Date.parse(pairing.cliTokenExpiresAt)) return null
  return pairing.userId
}
