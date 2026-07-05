// Local usage agent: a tiny loopback HTTP server the dashboard's
// "Pull from this device" button talks to. Started with `ambrium-connect serve`.
//
// Security model: the agent binds 127.0.0.1 only and never returns usage data
// to the browser — POST /v1/refresh makes the agent itself collect local
// Claude Code / Codex usage and push it to Ambrium with its OWN saved pairing
// token (exactly what `--ai-only` does). The worst any web page could do by
// hitting this port is sync the user's data to the user's account. Responses
// carry CORS headers only for allowlisted origins, so other sites can't even
// read the ok/summary JSON.

import { createServer } from "node:http"
import { collectAiUsage } from "./ai-usage.mjs"

export const DEFAULT_AGENT_PORT = 41414

/**
 * Returns the origin to echo in Access-Control-Allow-Origin, or null when the
 * origin is not allowed to read responses. No-Origin requests (curl, same
 * machine scripts) are served without CORS headers.
 */
export function agentAllowedOrigin(origin, apiBase) {
  if (!origin) return null
  const allowed = new Set(
    [
      apiBase,
      "https://ambrium.io",
      "https://api.ambrium.io",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ].filter(Boolean)
  )
  return allowed.has(origin) ? origin : null
}

function corsHeaders(origin, apiBase) {
  const allowed = agentAllowedOrigin(origin, apiBase)
  if (!allowed) return {}
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    // Chrome Private/Local Network Access: public https pages need this on the
    // preflight to talk to a loopback server.
    "access-control-allow-private-network": "true",
    vary: "origin",
  }
}

/**
 * Starts the loopback agent. `push(payload)` uploads one collected tool
 * payload to Ambrium (injected so this module stays network/token agnostic
 * and testable). Returns the http server (listening).
 */
export function startUsageAgent({ port = DEFAULT_AGENT_PORT, apiBase, push, collect = collectAiUsage, log = () => {} }) {
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin
    const headers = { "content-type": "application/json", ...corsHeaders(origin, apiBase) }
    // A browser origin outside the allowlist gets a hard 403 (no CORS headers,
    // so it couldn't read the body anyway — this just makes intent explicit).
    if (origin && !agentAllowedOrigin(origin, apiBase)) {
      response.writeHead(403, headers)
      response.end(JSON.stringify({ error: "Origin not allowed." }))
      return
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers)
      response.end()
      return
    }
    const path = (request.url ?? "/").split("?")[0]
    if (request.method === "GET" && path === "/v1/status") {
      response.writeHead(200, headers)
      response.end(JSON.stringify({ ok: true, agent: "ambrium-usage-agent" }))
      return
    }
    if (request.method === "POST" && path === "/v1/refresh") {
      try {
        const payloads = await collect()
        if (payloads.length === 0) {
          response.writeHead(200, headers)
          response.end(JSON.stringify({ ok: true, pushed: [], note: "No local Claude Code / Codex usage found for this month." }))
          return
        }
        const pushed = []
        const errors = []
        for (const payload of payloads) {
          try {
            await push(payload)
            pushed.push({
              provider: payload.provider,
              label: payload.toolLabel,
              models: payload.models.length,
              limits: Array.isArray(payload.limits) ? payload.limits.length : 0,
            })
          } catch (error) {
            errors.push({ label: payload.toolLabel, error: error instanceof Error ? error.message : String(error) })
          }
        }
        log(`↺ device pull: pushed ${pushed.map((p) => p.label).join(", ") || "nothing"}${errors.length ? ` · ${errors.length} failed` : ""}`)
        response.writeHead(errors.length > 0 && pushed.length === 0 ? 502 : 200, headers)
        response.end(JSON.stringify({ ok: pushed.length > 0, pushed, errors }))
      } catch (error) {
        response.writeHead(500, headers)
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Refresh failed." }))
      }
      return
    }
    response.writeHead(404, headers)
    response.end(JSON.stringify({ error: "Not found." }))
  })
  server.listen(port, "127.0.0.1")
  return server
}
