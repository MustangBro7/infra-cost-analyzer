import test from "node:test"
import assert from "node:assert/strict"
import { appOrigin, appUrl } from "../src/lib/appUrl"

test("production hosts resolve to the canonical Ambrium origin", () => {
  assert.equal(appOrigin("https://infra-cost-analyzer.example.workers.dev", {}), "https://ambrium.io")
  assert.equal(appOrigin("https://api.ambrium.io", {}), "https://ambrium.io")
  assert.equal(appOrigin("https://ambrium.io", {}), "https://ambrium.io")
})

test("local development preserves the browser-facing local origin", () => {
  assert.equal(appOrigin("http://localhost:3002", {}), "http://localhost:3002")
  assert.equal(appOrigin("http://0.0.0.0:3002", {}), "http://localhost:3002")
})

test("APP_URL overrides inferred public origins", () => {
  assert.equal(
    appUrl("/api/github/callback", "https://example.workers.dev", { APP_URL: "https://ambrium.io/" }).toString(),
    "https://ambrium.io/api/github/callback"
  )
})
