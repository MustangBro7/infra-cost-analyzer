import test from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"

function baseUrl(server: Server) {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return `http://127.0.0.1:${address.port}`
}

async function startAgent(overrides: {
  push?: (payload: unknown) => Promise<void>
  collect?: () => Promise<Array<Record<string, unknown>>>
  autoSyncMs?: number
} = {}) {
  const { startUsageAgent } = await import("../cli/usage-agent.mjs")
  const pushed: unknown[] = []
  const server = startUsageAgent({
    port: 0, // ephemeral for tests
    apiBase: "https://ambrium.io",
    push: overrides.push ?? (async (payload) => void pushed.push(payload)),
    collect:
      overrides.collect ??
      (async () => [
        { provider: "anthropic", toolLabel: "Claude Code", models: [{}], limits: [{}, {}] },
        { provider: "openai", toolLabel: "Codex", models: [{}, {}], limits: [{}] },
      ]),
    autoSyncMs: overrides.autoSyncMs,
  })
  await new Promise((resolve) => server.on("listening", resolve))
  return { server, pushed, url: baseUrl(server) }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(predicate(), true, "condition was not reached before timeout")
}

test("usage agent allows dashboard origins and refuses others", async () => {
  const { agentAllowedOrigin } = await import("../cli/usage-agent.mjs")
  assert.equal(agentAllowedOrigin("https://ambrium.io", "https://ambrium.io"), "https://ambrium.io")
  assert.equal(agentAllowedOrigin("http://localhost:3000", "https://ambrium.io"), "http://localhost:3000")
  assert.equal(agentAllowedOrigin("https://evil.example", "https://ambrium.io"), null)
  assert.equal(agentAllowedOrigin(null, "https://ambrium.io"), null)

  const { server, url } = await startAgent()
  try {
    const preflight = await fetch(`${url}/v1/refresh`, { method: "OPTIONS", headers: { origin: "https://ambrium.io" } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://ambrium.io")
    assert.equal(preflight.headers.get("access-control-allow-private-network"), "true")

    const refused = await fetch(`${url}/v1/status`, { headers: { origin: "https://evil.example" } })
    assert.equal(refused.status, 403)
    assert.equal(refused.headers.get("access-control-allow-origin"), null)
  } finally {
    server.close()
  }
})

test("usage agent pushes collected payloads and reports a summary", async () => {
  const { server, pushed, url } = await startAgent()
  try {
    const status = await fetch(`${url}/v1/status`, { headers: { origin: "https://ambrium.io" } })
    assert.equal(status.status, 200)
    assert.equal(((await status.json()) as { ok: boolean }).ok, true)

    const response = await fetch(`${url}/v1/refresh`, { method: "POST", headers: { origin: "https://ambrium.io" } })
    const body = (await response.json()) as { ok: boolean; pushed: Array<{ label: string; limits: number }> }
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.deepEqual(
      body.pushed.map((tool) => tool.label),
      ["Claude Code", "Codex"]
    )
    assert.equal(body.pushed[0].limits, 2)
    assert.equal(pushed.length, 2)
  } finally {
    server.close()
  }
})

test("usage agent surfaces push failures without crashing", async () => {
  const { server, url } = await startAgent({
    push: async () => {
      throw new Error("token expired")
    },
  })
  try {
    const response = await fetch(`${url}/v1/refresh`, { method: "POST" })
    assert.equal(response.status, 502)
    const body = (await response.json()) as { ok: boolean; errors: Array<{ error: string }> }
    assert.equal(body.ok, false)
    assert.equal(body.errors[0].error, "token expired")
  } finally {
    server.close()
  }
})

test("continuous agent pushes at startup and deduplicates unchanged scheduled checks", async () => {
  let collectCount = 0
  const { server, pushed, url } = await startAgent({
    autoSyncMs: 15,
    collect: async () => {
      collectCount += 1
      return [{ provider: "openai", toolLabel: "Codex", models: [{ total: 10 }], limits: [] }]
    },
  })
  try {
    await waitFor(() => collectCount >= 3)
    assert.equal(pushed.length, 1, "identical scheduled payloads should only be uploaded once")

    const status = (await (await fetch(`${url}/v1/status`)).json()) as {
      autoSync: boolean
      intervalMs: number
      lastSync: { unchanged: boolean }
    }
    assert.equal(status.autoSync, true)
    assert.equal(status.intervalMs, 15)
    assert.equal(status.lastSync.unchanged, true)
  } finally {
    server.close()
  }
})

test("continuous agent uploads a new snapshot when local usage changes", async () => {
  let version = 1
  const { server, pushed } = await startAgent({
    autoSyncMs: 15,
    collect: async () => [{ provider: "openai", toolLabel: "Codex", models: [{ total: version }], limits: [] }],
  })
  try {
    await waitFor(() => pushed.length === 1)
    version = 2
    await waitFor(() => pushed.length === 2)
  } finally {
    server.close()
  }
})
