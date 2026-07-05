import test from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"

function baseUrl(server: Server) {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return `http://127.0.0.1:${address.port}`
}

async function startAgent(overrides: { push?: (payload: unknown) => Promise<void>; collect?: () => Promise<Array<Record<string, unknown>>> } = {}) {
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
  })
  await new Promise((resolve) => server.on("listening", resolve))
  return { server, pushed, url: baseUrl(server) }
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
