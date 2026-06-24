import { randomBytes } from "node:crypto"
import type { CustomProviderDef } from "./types"
import {
  CustomProviderError,
  dryRunCustomProvider,
  monthPeriod,
  validateCustomProviderDef,
} from "./customProvider"
import {
  listCustomProviders,
  readWorkspace,
  removeCustomProvider,
  setCustomConnection,
  upsertCustomProvider,
} from "./localStore"

// Shared service layer behind both the browser (Clerk) and agent (cliToken)
// custom-provider endpoints, so the two route families stay in lockstep.

function newId(): string {
  return `cpr_${randomBytes(6).toString("hex")}`
}

/** Validates + persists a new custom provider definition. Returns the stored def. */
export async function createCustomProvider(userId: string, input: unknown): Promise<CustomProviderDef> {
  const normalized = validateCustomProviderDef(input)
  const now = new Date().toISOString()
  const def: CustomProviderDef = { ...normalized, id: newId(), createdAt: now, updatedAt: now }
  return upsertCustomProvider(userId, def)
}

/** Validates + updates an existing definition (keeps its id + saved secret). */
export async function updateCustomProvider(userId: string, id: string, input: unknown): Promise<CustomProviderDef> {
  const workspace = await readWorkspace(userId)
  const existing = workspace.customProviders[id]
  if (!existing) throw new CustomProviderError("Unknown custom provider id.")
  const normalized = validateCustomProviderDef(input)
  return upsertCustomProvider(userId, { ...normalized, id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() })
}

export async function deleteCustomProvider(userId: string, id: string): Promise<void> {
  await removeCustomProvider(userId, id)
}

export async function listCustomProvidersForUser(userId: string): Promise<CustomProviderDef[]> {
  return listCustomProviders(userId)
}

/** Saves the pasted secret for a custom provider. */
export async function connectCustomProvider(userId: string, id: string, secret: string): Promise<void> {
  if (!secret.trim()) throw new CustomProviderError("A secret/token is required.")
  await setCustomConnection(userId, id, secret.trim())
}

/**
 * Dry-runs a definition against the live endpoint with the supplied secret and
 * returns the mapped rows + a raw sample so the user/agent can debug the mapping
 * BEFORE saving. Accepts either an inline definition (body.definition) or an
 * existing saved id (body.id) whose stored secret is reused when none is given.
 */
export async function testCustomProvider(
  userId: string,
  input: { definition?: unknown; id?: string; secret?: string }
): Promise<{ ok: boolean; costRows: unknown[]; usage: unknown[]; sampleResponse: string; error?: string }> {
  let def: CustomProviderDef
  let secret = input.secret?.trim() ?? ""

  if (input.id) {
    const workspace = await readWorkspace(userId)
    const existing = workspace.customProviders[input.id]
    if (!existing) throw new CustomProviderError("Unknown custom provider id.")
    def = input.definition
      ? { ...validateCustomProviderDef(input.definition), id: existing.id, createdAt: existing.createdAt, updatedAt: existing.updatedAt }
      : existing
    if (!secret) secret = workspace.customConnections[input.id]?.accessToken ?? ""
  } else {
    const normalized = validateCustomProviderDef(input.definition)
    const now = new Date().toISOString()
    def = { ...normalized, id: "cpr_test", createdAt: now, updatedAt: now }
  }

  if (!secret && def.auth.type !== "none") {
    throw new CustomProviderError("A secret/token is required to test (or set auth.type to none).")
  }

  try {
    const result = await dryRunCustomProvider(def, secret, monthPeriod())
    return { ok: true, costRows: result.costRows, usage: result.usage, sampleResponse: result.sampleResponse }
  } catch (error) {
    return {
      ok: false,
      costRows: [],
      usage: [],
      sampleResponse: "",
      error: error instanceof Error ? error.message : "Test failed.",
    }
  }
}
