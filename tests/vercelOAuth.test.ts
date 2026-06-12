import test from "node:test"
import assert from "node:assert/strict"
import { pkceChallenge, randomOAuthString, vercelRedirectUri } from "../src/lib/vercelOAuth"

test("pkceChallenge returns deterministic base64url SHA-256 challenge", () => {
  assert.equal(
    pkceChallenge("verifier"),
    "iMnq5o6zALKXGivsnlom_0F5_WYda32GHkxlV7mq7hQ"
  )
})

test("randomOAuthString is URL safe", () => {
  const value = randomOAuthString()
  assert.match(value, /^[A-Za-z0-9_-]+$/)
})

test("vercelRedirectUri defaults to local callback under origin", () => {
  const previous = process.env.VERCEL_OAUTH_REDIRECT_URI
  delete process.env.VERCEL_OAUTH_REDIRECT_URI
  try {
    assert.equal(vercelRedirectUri("http://localhost:3002"), "http://localhost:3002/api/vercel/oauth/callback")
  } finally {
    if (previous === undefined) {
      delete process.env.VERCEL_OAUTH_REDIRECT_URI
    } else {
      process.env.VERCEL_OAUTH_REDIRECT_URI = previous
    }
  }
})

test("vercelRedirectUri maps 0.0.0.0 to localhost for browser OAuth callbacks", () => {
  const previous = process.env.VERCEL_OAUTH_REDIRECT_URI
  delete process.env.VERCEL_OAUTH_REDIRECT_URI
  try {
    assert.equal(vercelRedirectUri("http://0.0.0.0:3002"), "http://localhost:3002/api/vercel/oauth/callback")
  } finally {
    if (previous === undefined) {
      delete process.env.VERCEL_OAUTH_REDIRECT_URI
    } else {
      process.env.VERCEL_OAUTH_REDIRECT_URI = previous
    }
  }
})
