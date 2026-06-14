import test from "node:test"
import assert from "node:assert/strict"
import { resolveLinkedProviders } from "../src/lib/repoLinks"

test("an explicit link wins, but only for providers that are connected", () => {
  const linked = resolveLinkedProviders({
    explicit: ["aws", "vercel"],
    detected: ["cloudflare"],
    connected: ["aws", "cloudflare"],
  })
  assert.deepEqual(linked, ["aws"]) // vercel dropped: not connected
})

test("with no explicit link, defaults to connected providers the repo detected", () => {
  const linked = resolveLinkedProviders({
    explicit: undefined,
    detected: ["cloudflare", "vercel"],
    connected: ["cloudflare", "aws"],
  })
  assert.deepEqual(linked, ["cloudflare"]) // vercel detected but not connected
})

test("returns empty when nothing detected is connected (UI prompts to pick)", () => {
  const linked = resolveLinkedProviders({
    explicit: [],
    detected: ["gcp"],
    connected: ["aws"],
  })
  assert.deepEqual(linked, [])
})
