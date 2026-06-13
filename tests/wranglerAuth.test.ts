import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readWranglerOAuth } from "../src/lib/wranglerAuth"

function withWranglerHome(toml: string, run: () => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "wrangler-"))
  mkdirSync(path.join(dir, "config"), { recursive: true })
  writeFileSync(path.join(dir, "config", "default.toml"), toml)
  const original = process.env.WRANGLER_HOME
  process.env.WRANGLER_HOME = dir
  try {
    run()
  } finally {
    if (original === undefined) delete process.env.WRANGLER_HOME
    else process.env.WRANGLER_HOME = original
    rmSync(dir, { recursive: true, force: true })
  }
}

test("readWranglerOAuth reads a valid token and expiry", () => {
  const future = new Date(Date.now() + 3_600_000).toISOString()
  withWranglerHome(`oauth_token = "abc123token"\nexpiration_time = "${future}"\nrefresh_token = "r"\n`, () => {
    const result = readWranglerOAuth()
    assert.ok(result)
    assert.equal(result.token, "abc123token")
    assert.equal(result.expired, false)
  })
})

test("readWranglerOAuth flags an expired token", () => {
  const past = new Date(Date.now() - 1000).toISOString()
  withWranglerHome(`oauth_token = "stale"\nexpiration_time = "${past}"\n`, () => {
    const result = readWranglerOAuth()
    assert.ok(result)
    assert.equal(result.expired, true)
  })
})

test("readWranglerOAuth returns null without a token", () => {
  withWranglerHome(`# no token here\n`, () => {
    assert.equal(readWranglerOAuth(), null)
  })
})
