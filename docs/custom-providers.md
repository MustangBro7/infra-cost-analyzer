# Custom providers — extend Ambrium with your AI agent

Ambrium ships built-in integrations for a handful of hosting providers (AWS,
Vercel, Cloudflare, Google Cloud, MotherDuck) and AI coding tools (Claude,
OpenAI/Codex, Cursor). **Custom providers** let any user add a provider we don't
ship — without a code deploy — by registering a declarative HTTP→JSON connector
that the cost engine runs on every refresh. The resulting cost/usage rows flow
into the same dashboard as the built-ins.

There are two ways to add one: hand it to your AI coding agent (recommended), or
build the connector definition by hand under **Credentials → Add a connector
manually**.

## Let your AI agent do it

Open Claude Code / Codex / Cursor in any project and paste the prompt from
**Credentials → Add a provider with your AI agent** (it embeds your workspace
URL). The agent:

1. Reads the machine-readable spec at `GET /api/extend/spec` (no auth).
2. Pairs to your account with the device-code flow (`/api/cli/pair/*`) — you
   approve it once in your signed-in browser.
3. Builds a connector for your provider's billing/usage REST API.
4. Dry-runs it (`POST /api/cli/custom-providers/test`) until the rows look right.
5. Saves it (`POST /api/cli/custom-providers`) and attaches your API token
   (`POST /api/cli/custom-providers/secret`).

The spec endpoint is the source of truth for the schema, auth flow, endpoints,
placeholders, and examples — agents should always read it rather than rely on
this doc.

## Connector definition

```jsonc
{
  "name": "Render",                       // required, 1–60 chars
  "shortLabel": "Rn",                     // optional badge
  "color": "#6d5bd0",                     // optional chart color
  "homepage": "https://render.com",       // optional
  "auth": {
    "type": "bearer",                     // bearer | header | basic | query | none
    "headerName": "X-Api-Key",            // when type=header
    "queryParam": "api_key"               // when type=query
  },
  "request": {
    "method": "GET",                      // GET | POST
    "url": "https://api.example.com/billing?from={{periodStart}}&to={{periodEnd}}",
    "headers": { "Accept": "application/json" },
    "body": "{\"start\":\"{{periodStart}}\"}"  // POST only
  },
  "cost": {                                // provide cost and/or usage
    "itemsPath": "data.charges",          // dot path to the array ("" = root is the array)
    "amountField": "amount",              // dot path to the numeric amount
    "amountInCents": false,
    "serviceField": "service_name",       // dot path to a label (optional)
    "currency": "USD"
  },
  "usage": {
    "itemsPath": "data.charges",
    "quantityField": "quantity",
    "serviceField": "service_name",
    "unitField": "unit",
    "unit": "requests"                    // static unit if unitField absent
  }
}
```

### Placeholders

Available in `request.url`, header values, and `request.body`:

| Placeholder | Value |
|---|---|
| `{{token}}` | your saved secret |
| `{{periodStart}}` / `{{monthStart}}` | first day of the current month (`YYYY-MM-DD`) |
| `{{periodEnd}}` | last day of the current month (`YYYY-MM-DD`) |
| `{{periodStartUnix}}` | first day of the month, unix seconds |
| `{{periodEndUnix}}` | first day of next month, unix seconds |

The secret is also injected by `auth.type` (e.g. `bearer` → `Authorization:
Bearer <secret>`), so you usually don't need `{{token}}` explicitly.

## Constraints & security

- URL must be **https** and must not resolve to a private/loopback address
  (SSRF guard).
- Response must be JSON, ≤ 4 MB; requests time out after 12 s; up to 500 rows
  are read.
- The secret is stored server-side only and never returned to any client —
  identical to the built-in token connections.
- Connectors are per-user. One user's connectors never run for anyone else.

## Endpoints

Agent (cliToken auth) under `/api/cli/custom-providers`, browser (Clerk) under
`/api/custom-providers`:

| Method + path | Purpose |
|---|---|
| `POST …/test` | Dry-run `{ definition, secret }` → mapped rows + raw sample |
| `POST …` (create) | Persist a definition → `{ provider: { id } }` |
| `POST …/secret` | Save `{ id, secret }` |
| `GET …` (cli) | List connectors |
| `POST …/delete` | Remove `{ id }` |
