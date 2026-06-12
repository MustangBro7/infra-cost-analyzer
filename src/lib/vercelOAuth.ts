import { createHash, randomBytes } from "node:crypto"
import type { NextRequest } from "next/server"

const OAUTH_COOKIE_PREFIX = "ica_vercel_oauth"

function base64Url(input: Buffer) {
  return input.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

export function randomOAuthString(bytes = 32) {
  return base64Url(randomBytes(bytes))
}

export function pkceChallenge(verifier: string) {
  return base64Url(createHash("sha256").update(verifier).digest())
}

export function vercelClientId() {
  return process.env.NEXT_PUBLIC_VERCEL_APP_CLIENT_ID || process.env.VERCEL_APP_CLIENT_ID || null
}

export function vercelClientSecret() {
  return process.env.VERCEL_APP_CLIENT_SECRET || null
}

export function vercelRedirectUri(origin: string) {
  return process.env.VERCEL_OAUTH_REDIRECT_URI || `${browserSafeLocalOrigin(origin)}/api/vercel/oauth/callback`
}

export function vercelOAuthConfigured() {
  return Boolean(vercelClientId())
}

function browserSafeLocalOrigin(origin: string) {
  try {
    const url = new URL(origin)
    if (url.hostname === "0.0.0.0") {
      url.hostname = "localhost"
    }
    return url.origin
  } catch {
    return origin
  }
}

export function oauthCookieOptions(request: NextRequest) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 10 * 60,
  }
}

export const vercelOAuthCookies = {
  state: `${OAUTH_COOKIE_PREFIX}_state`,
  nonce: `${OAUTH_COOKIE_PREFIX}_nonce`,
  verifier: `${OAUTH_COOKIE_PREFIX}_verifier`,
}
