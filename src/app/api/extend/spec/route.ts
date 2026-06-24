import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Public, machine-readable guide for AI coding agents (Claude Code, Codex,
// Cursor, …) that a user points at their Ambrium workspace to add a hosting
// provider we don't ship a built-in integration for. The agent reads this,
// then drives the device-pairing + custom-provider endpoints. No auth — it's
// documentation, contains no secrets.
const SPEC = {
  name: "Ambrium provider extension API",
  version: "1.0",
  summary:
    "Add a hosting provider's cost & usage to Ambrium without a code deploy by registering a declarative HTTP→JSON connector. The connector runs in Ambrium on every refresh and its rows flow into the same dashboard as the built-in providers.",
  audience:
    "AI coding agents. The user will ask you to 'add <provider> to Ambrium'. Follow the steps below end to end, testing the mapping before saving.",
  pairing: {
    description:
      "You authenticate as the user with a short-lived cliToken via the OAuth 2.0 Device Authorization Grant. No browser session needed in the agent.",
    steps: [
      "POST /api/cli/pair/start (no auth) → { deviceCode, userCode, verificationUrl, interval, expiresIn }.",
      "Show the user the userCode and verificationUrl; they approve it in their signed-in browser.",
      "Poll POST /api/cli/pair/poll { deviceCode } every `interval` seconds until { status:'authorized', cliToken }.",
      "Use the cliToken as `Authorization: Bearer <cliToken>` on every /api/cli/* call below.",
    ],
  },
  workflow: [
    "1. Identify the provider's public billing/usage REST API and the credential the user must supply (usually an API token).",
    "2. Build a definition (schema below) describing the HTTP request and how to map the JSON response to cost rows and/or usage rows.",
    "3. Dry-run it: POST /api/cli/custom-providers/test { definition, secret }. Inspect the returned costRows/usage and sampleResponse; adjust paths until the rows look right.",
    "4. Save it: POST /api/cli/custom-providers { ...definition } → returns { provider: { id } }.",
    "5. Attach the secret: POST /api/cli/custom-providers/secret { id, secret }.",
    "6. Tell the user it's connected — it now appears on their dashboard and refreshes automatically.",
  ],
  endpoints: {
    "POST /api/cli/custom-providers/test": "Dry-run a definition (body: { definition, secret }) — returns mapped rows + raw sample. Always do this first.",
    "POST /api/cli/custom-providers": "Create a connector (body: the definition). Returns the saved definition with its id.",
    "POST /api/cli/custom-providers/secret": "Save the user's secret/token for a connector (body: { id, secret }).",
    "GET /api/cli/custom-providers": "List the user's connectors.",
    "POST /api/cli/custom-providers/delete": "Delete a connector (body: { id }).",
  },
  definitionSchema: {
    name: "string (1-60 chars), required — display name, e.g. 'Render'",
    shortLabel: "string (<=2 chars), optional",
    color: "string '#rrggbb', optional — chart color",
    homepage: "string url, optional",
    auth: {
      type: "'bearer' | 'header' | 'basic' | 'query' | 'none' — how the secret is sent",
      headerName: "string, required when type='header' (e.g. 'X-Api-Key')",
      queryParam: "string, required when type='query' (e.g. 'api_key')",
    },
    request: {
      method: "'GET' | 'POST'",
      url: "https url, required. May use placeholders (see below).",
      headers: "object<string,string>, optional. Values may use placeholders.",
      body: "string (JSON), optional — for POST. May use placeholders.",
    },
    cost: {
      _note: "Optional. Provide cost and/or usage (at least one).",
      itemsPath: "dot path to the array of line items in the response. '' = the response itself is the array.",
      amountField: "dot path within an item to the numeric amount, required",
      amountInCents: "boolean, optional — divide amounts by 100",
      serviceField: "dot path to a label for the line item, optional (defaults to the provider name)",
      currency: "string, optional (default 'USD')",
    },
    usage: {
      itemsPath: "dot path to the array of usage items",
      quantityField: "dot path to the numeric quantity, required",
      serviceField: "dot path to a label, optional",
      unitField: "dot path to a unit string, optional",
      unit: "static unit string, optional (used when unitField is absent)",
    },
  },
  placeholders: {
    "{{token}}": "the user's saved secret",
    "{{periodStart}}": "first day of the current month, YYYY-MM-DD",
    "{{periodEnd}}": "last day of the current month, YYYY-MM-DD",
    "{{monthStart}}": "alias of periodStart",
    "{{periodStartUnix}}": "first day of the month, unix seconds",
    "{{periodEndUnix}}": "first day of next month, unix seconds",
  },
  constraints: [
    "URL must be https and must not point at private/loopback addresses (SSRF guard).",
    "Response must be JSON, <= 4 MB; request times out after 12s; up to 500 rows are read.",
    "The secret is stored server-side and never returned to any client.",
  ],
  examples: [
    {
      title: "Bearer-token REST API returning a list of monthly charges",
      definition: {
        name: "Example Cloud",
        color: "#6d5bd0",
        auth: { type: "bearer" },
        request: {
          method: "GET",
          url: "https://api.example.com/v1/billing/usage?from={{periodStart}}&to={{periodEnd}}",
        },
        cost: { itemsPath: "data.charges", amountField: "amount", serviceField: "service_name", currency: "USD" },
        usage: { itemsPath: "data.charges", quantityField: "quantity", serviceField: "service_name", unitField: "unit" },
      },
    },
    {
      title: "API key in a custom header, amounts in cents, POST with a JSON body",
      definition: {
        name: "Example Host",
        auth: { type: "header", headerName: "X-Api-Key" },
        request: {
          method: "POST",
          url: "https://api.examplehost.com/reports/spend",
          body: '{"start":"{{periodStart}}","end":"{{periodEnd}}"}',
        },
        cost: { itemsPath: "results", amountField: "spend_cents", amountInCents: true, serviceField: "project" },
      },
    },
  ],
}

export async function GET() {
  return NextResponse.json(SPEC)
}
