// Standalone cron Worker for infra-cost-analyzer.
//
// OpenNext's generated Worker has no `scheduled` handler, so background refresh
// lives here. On each cron tick it calls the main app's protected
// /api/cron/refresh endpoint, which re-pulls free provider usage for every
// user's snapshots (never the billed AWS Cost Explorer).
//
// Secrets/vars:
//   CRON_SECRET  (secret)  shared with the main Worker; authorizes the call
//   APP_URL      (var)     base URL of the deployed app

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRefresh(env))
  },

  // Lets you trigger a refresh manually (and verify wiring) by hitting this
  // Worker's URL with the right secret: GET /?secret=...  or header x-cron-secret.
  async fetch(request, env) {
    const url = new URL(request.url)
    const provided = request.headers.get("x-cron-secret") ?? url.searchParams.get("secret")
    if (!env.CRON_SECRET || provided !== env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 })
    }
    const result = await runRefresh(env)
    return Response.json(result)
  },
}

async function runRefresh(env) {
  if (!env.CRON_SECRET) return { ok: false, error: "CRON_SECRET not set" }
  const target = `${env.APP_URL}/api/cron/refresh`
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { "x-cron-secret": env.CRON_SECRET, "content-type": "application/json" },
      body: "{}",
    })
    const body = await response.json().catch(() => ({}))
    return { ok: response.ok, status: response.status, ...body }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "fetch failed" }
  }
}
