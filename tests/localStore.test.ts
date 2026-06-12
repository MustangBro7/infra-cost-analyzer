import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"

function setStorePath() {
  const dir = mkdtempSync(path.join(tmpdir(), "infra-store-"))
  return { dir, filePath: path.join(dir, "connections.json") }
}

test("local store persists safe public provider state", async () => {
  const { dir, filePath } = setStorePath()
  try {
    const { appendEvent, publicStore, setStorePathForTests, upsertConnection } = await import("../src/lib/localStore")
    setStorePathForTests(filePath)
    await appendEvent("usr_a", {
      provider: "system",
      level: "info",
      message: "Started local test.",
    })
    await upsertConnection("usr_a", {
      provider: "vercel",
      status: "connected",
      accountLabel: "Acme",
      accessToken: "secret-token",
      connectedAt: "2026-06-12T00:00:00.000Z",
      lastVerifiedAt: "2026-06-12T00:00:00.000Z",
      lastError: null,
      metadata: { projectCount: 3 },
    })
    const state = await publicStore("usr_a")
    const otherState = await publicStore("usr_b")
    assert.equal(state.connections.vercel?.status, "connected")
    assert.equal(otherState.connections.vercel, undefined)
    assert.equal("accessToken" in (state.connections.vercel ?? {}), false)
    assert.equal(state.connections.vercel?.metadata.projectCount, 3)
    assert.equal(state.events.length, 2)
    assert.equal(state.events[0].level, "success")
  } finally {
    const { setStorePathForTests } = await import("../src/lib/localStore")
    setStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
