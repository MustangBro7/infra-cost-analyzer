import type { NextRequest } from "next/server"
import { auth, currentUser } from "@clerk/nextjs/server"
import { appendEvent, createClerkUser, getUserById } from "./localStore"
import { userIdFromCliToken } from "./cliPairing"
import { autoConnectFromEnv } from "./connectors"
import type { LocalUser } from "./types"

/**
 * Authentication is owned by Clerk (Google sign-in + email). This module keeps
 * the original interface the rest of the app already consumes
 * (currentUserFromCookies / currentUserFromRequest / requireUserFromRequest) so
 * the ~25 route handlers and the page didn't have to change — they just receive
 * a LocalUser backed by the Clerk session instead of a cookie session.
 */

/**
 * Resolves the signed-in Clerk user to our LocalUser mirror. The fast path is a
 * single store read keyed by the Clerk user id (no Clerk Backend API call). On a
 * user's very first request we hydrate their profile from Clerk and run the
 * zero-click provider auto-connect that used to live in the sign-in route.
 */
async function resolveCurrentUser(): Promise<LocalUser | null> {
  const { userId } = await auth()
  if (!userId) return null

  const existing = await getUserById(userId)
  if (existing) {
    // Environment-backed provider credentials may be added after a user first
    // signed in. Re-run the idempotent connector so existing production users
    // receive newly configured accounts without recreating their workspace.
    await autoConnectFromEnv(existing.id)
    return existing
  }

  const profile = await currentUser()
  const email =
    profile?.primaryEmailAddress?.emailAddress ??
    profile?.emailAddresses?.[0]?.emailAddress ??
    `${userId}@clerk.local`
  const name =
    [profile?.firstName, profile?.lastName].filter(Boolean).join(" ").trim() ||
    profile?.username ||
    email.split("@")[0] ||
    "User"

  const user = await createClerkUser({ id: userId, email, name })

  // Zero-effort onboarding: connect every provider that has credentials
  // available (local repo scan, or tokens in server env vars).
  const outcomes = await autoConnectFromEnv(user.id)
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      await appendEvent(user.id, {
        provider: "system",
        level: "warning",
        message: `Auto-connect for ${outcome.provider} failed: ${outcome.detail}`,
      })
    }
  }
  return user
}

export async function currentUserFromCookies(): Promise<LocalUser | null> {
  return resolveCurrentUser()
}

// The request argument is retained for call-site compatibility; Clerk reads the
// session from the active request context, so it is no longer needed directly.
export async function currentUserFromRequest(_request: NextRequest): Promise<LocalUser | null> {
  return resolveCurrentUser()
}

export async function requireUserFromRequest(_request: NextRequest): Promise<LocalUser> {
  const user = await resolveCurrentUser()
  if (!user) {
    throw new AuthRequiredError()
  }
  return user
}

/**
 * Authenticates a companion-CLI request via its `Authorization: Bearer <cliToken>`
 * header (minted by the device-code pairing flow) instead of a Clerk session.
 * Returns the LocalUser the token was paired to, or throws AuthRequiredError.
 */
export async function requireUserFromCliToken(request: NextRequest): Promise<LocalUser> {
  const header = request.headers.get("authorization") ?? ""
  const cliToken = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : ""
  const userId = cliToken ? await userIdFromCliToken(cliToken) : null
  const user = userId ? await getUserById(userId) : null
  if (!user) throw new AuthRequiredError()
  return user
}

export class AuthRequiredError extends Error {
  constructor() {
    super("Sign in is required.")
    this.name = "AuthRequiredError"
  }
}
