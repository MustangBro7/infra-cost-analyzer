import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Public, machine-readable guide for AI coding agents (Claude Code, Codex,
// Cursor, …) that a user points at their Ambrium workspace to add a hosting
// provider we don't ship a built-in integration for. The agent reads this,
// then drives the device-pairing + custom-provider endpoints. No auth — it's
// documentation, contains no secrets.
const SPEC = {
  name: "Ambrium agent setup and provider extension API",
  version: "1.1",
  summary:
    "Connect a user's cloud, AI, and custom provider accounts to Ambrium with read-only access. Built-in providers should be connected through the companion CLI where possible; niche providers can be added without a code deploy by registering a declarative HTTP→JSON connector.",
  audience:
    "AI coding agents such as Codex, Claude Code, and Cursor. The user may ask you to connect Ambrium, diagnose setup, or add a missing provider. Complete safe local steps yourself and pause for the user's approval whenever provider consent, IAM, service accounts, paid APIs, or secrets are involved.",
  agentSetup: {
    prompt: `Use the Ambrium CLI to connect this machine's cloud and AI provider accounts to my Ambrium workspace.

Rules:
- Only create or use read-only credentials.
- Never print secrets into chat or logs.
- Prefer existing local CLI sessions where available.
- Ask me before opening provider dashboards or approving OAuth/IAM changes.
- Ask me before enabling paid APIs such as AWS Cost Explorer.
- After each provider, verify the connection and summarize what was connected.

Start with:
npx --yes github:MustangBro7/infra-cost-analyzer doctor

Then run:
npx --yes github:MustangBro7/infra-cost-analyzer`,
    safeAutomationRules: [
      "You may inspect local CLI state, Git remotes, environment variables, and Ambrium CLI status.",
      "You may run the Ambrium CLI and provider CLIs to prepare read-only setup.",
      "Do not expose secrets in chat. If the user must paste a token, let the CLI prompt or direct them to the app.",
      "Ask the user to approve OAuth consent screens, GitHub App installs, IAM role creation, GCP service account keys, Cloudflare token creation, billing exports, and paid APIs.",
      "Never create write-capable provider credentials for Ambrium.",
    ],
    cli: {
      command: "npx --yes github:MustangBro7/infra-cost-analyzer",
      productionCommand: "npx @ambrium/connect",
      environment: {
        AMBRIUM_API: "Set to the user's Ambrium base URL when not using the default local app.",
        CLOUDFLARE_API_TOKEN: "Optional; lets the CLI connect Cloudflare without an interactive token paste.",
        MOTHERDUCK_DATABASE_URL: "Optional; lets the CLI connect MotherDuck without an interactive paste.",
      },
      subcommands: {
        connect: "Default. Pair this machine to Ambrium and connect available providers.",
        status: "Show local and Ambrium workspace connection status.",
        doctor: "Diagnose local setup and missing provider prerequisites.",
        spec: "Print this agent setup spec.",
        "--ai-only": "Push local Claude Code / Codex usage without cloud provisioning.",
      },
    },
    builtInProviders: [
      {
        provider: "github",
        setupMode: "browser approval",
        agentCanDo: ["open the GitHub authorization flow", "explain requested read-only repo permissions"],
        userMustApprove: ["GitHub App installation or repository selection"],
        expectedCoverage: "Repo identity, source evidence, workflow/deployment signals.",
      },
      {
        provider: "aws",
        setupMode: "CLI-assisted IAM role",
        agentCanDo: ["detect aws CLI auth", "run ambrium-connect", "prepare a named read-only role through the CLI"],
        userMustApprove: ["local AWS CLI account context", "IAM role creation", "Cost Explorer opt-in if requested"],
        expectedCoverage: "Free-tier usage by default; actual spend when Cost Explorer is enabled.",
      },
      {
        provider: "gcp",
        setupMode: "CLI-assisted service account plus billing export",
        agentCanDo: ["detect gcloud auth", "create/read service account through the CLI", "verify BigQuery access"],
        userMustApprove: ["service account key creation", "Cloud Billing to BigQuery export setup"],
        expectedCoverage: "Usage/project access after connect; detailed cost after Billing Export is enabled.",
      },
      {
        provider: "cloudflare",
        setupMode: "token-assisted",
        agentCanDo: ["detect wrangler auth", "open a prefilled scoped token page", "use CLOUDFLARE_API_TOKEN if already present"],
        userMustApprove: ["token creation or paste"],
        expectedCoverage: "Workers/Pages/D1/R2 inventory and usage where the token scopes allow it.",
      },
      {
        provider: "vercel",
        setupMode: "token or OAuth",
        agentCanDo: ["open token page", "explain team/project billing limitation"],
        userMustApprove: ["token creation or OAuth consent"],
        expectedCoverage: "Usage on supported plans; billing rows only where Vercel exposes them.",
      },
      {
        provider: "ai-tools",
        setupMode: "local usage plus optional admin APIs",
        agentCanDo: ["read local Claude Code / Codex usage through the CLI", "push local usage with --ai-only"],
        userMustApprove: ["Admin API keys for OpenAI/Anthropic/Cursor team usage"],
        expectedCoverage: "Local subscription/API-equivalent usage and API/team spend where admin APIs are connected.",
      },
    ],
  },
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
    "1. For built-in providers, prefer the Ambrium CLI. Run `ambrium-connect doctor`, then `ambrium-connect`, and verify with `ambrium-connect status`.",
    "2. If a provider is not built in, identify its public billing/usage REST API and the credential the user must supply (usually an API token).",
    "3. Build a definition (schema below) describing the HTTP request and how to map the JSON response to cost rows and/or usage rows.",
    "4. Dry-run it: POST /api/cli/custom-providers/test { definition, secret }. Inspect the returned costRows/usage and sampleResponse; adjust paths until the rows look right.",
    "5. Save it: POST /api/cli/custom-providers { ...definition } → returns { provider: { id } }.",
    "6. Attach the secret: POST /api/cli/custom-providers/secret { id, secret }.",
    "7. Tell the user what's connected, what remains partial, and which dashboard card should update after refresh.",
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
