# Ambrium

Ambrium is a personal cost cockpit for indie developers. Connect GitHub repos,
cloud providers, and AI tools, then see which side projects are costing money,
which free tiers are close to limits, and which old projects are safe to shut
down before a surprise bill lands.

The main product question is:

> I have projects across GitHub, Vercel, Cloudflare, AWS, GCP, and AI providers. What is each project costing me right now?

Ambrium is intentionally project-first instead of account-first. Indie
developers usually do not think in cost centers or chargeback; they think in
repos, apps, free tiers, and subscriptions.

## Product Shape

- **Projects**: each GitHub repo/app with month-to-date cost, projected cost,
  linked providers, stale activity, and shutdown candidates.
- **Limits**: free-tier runway and usage thresholds across connected providers.
- **Leaks**: unexpected spend, account-level rows that need assignment, inactive
  projects still costing money, and missing provider connections.
- **Connect**: guided setup for GitHub, Vercel, Cloudflare, AWS, GCP, MotherDuck,
  and AI usage sources. The CLI is designed so Codex, Claude Code, or another
  agent can help complete provider setup while the user approves sensitive steps.

## Pricing

- **Free**: 2 projects, 2 providers, monthly refresh.
- **Indie**: $5/month for unlimited personal projects, daily refresh, alerts,
  free-tier tracking, and AI/cloud cost surfaces.

Dodo Payments is used for hosted USD checkout and subscription webhooks. Clerk
is used only for authentication.

## What Works Now

- Scans local or GitHub repositories and maps provider evidence back to projects.
- Runs as a local multi-tenant replica with email sign-in and session cookies.
- Stores isolated per-user workspace state in `.data/tenant-store.json`.
- Lets you test a GitHub connection locally without a GitHub App.
- Supports a real GitHub App install callback when app env vars are configured.
- Supports real Vercel token verification and project listing.
- Detects GitHub Actions, Vercel, Cloudflare, AWS, GCP, Azure, DigitalOcean, and Docker signals.
- Produces normalized cost rows with attribution labels:
  - `verified`: strong repo-level deployment config was found.
  - `user_confirmed`: strong IaC/workflow evidence needs resource confirmation.
  - `inferred`: probable mapping from names, docs, packages, or commands.
- Persists a computed analysis snapshot per repo in the workspace store, so the
  dashboard renders from the database instead of re-scanning GitHub and re-pulling
  provider billing on every page load. Live data is refreshed out-of-band by the
  client (and on demand) via `POST /api/analyze/refresh`.
- Shows free-tier usage remaining for any connected provider whose cost is $0,
  using real measured consumption:
  - AWS: the Free Tier Usage API (`GetFreeTierUsage`, free) for actual vs limit,
    and optionally Cost Explorer (`GetCostAndUsage`) for live per-service cost +
    usage. Cost Explorer bills $0.01/request, so it is opt-in; free-tier usage is
    always pulled at no cost. Connect with your local AWS CLI in one click —
    static keys or an `aws sso login` session (resolved via
    `aws configure export-credentials`) — or by pasting an access key.
  - GCP: usage amounts from the BigQuery billing export.
  - Vercel: FOCUS `ConsumedQuantity` from the billing charges endpoint.
  - Cloudflare: Workers request volume from the GraphQL Analytics API. Connect in
    one click with your `wrangler login` (no token setup) or a scoped API token.
    Usage works on the free plan, so you see real requests-vs-limit immediately.
  Measured usage is compared against each provider's published free-tier
  allowance (AWS reports its own limits directly). When a provider does not
  report a given metric, the allowance is shown without inventing a usage number.
  Usage is shown married with cost: even when a provider is billing, measured
  free-tier consumption appears alongside the cost rows.
- Exposes `GET /api/analyze` for JSON output (cached snapshot; `?refresh=1` to recompute).
- Exposes `GET /api/providers` for supported provider setup metadata.
- Ships an indie-first dashboard with Projects, Limits, Leaks, and Connect views.
- Surfaces both cloud costs and AI costs. Cloud cost rows come from providers
  such as AWS, GCP, Vercel, Cloudflare, Azure, DigitalOcean, and MotherDuck. AI
  costs are first-class via OpenAI, Anthropic, Cursor, Copilot, ChatGPT/Claude
  subscription tracking, local usage detection, and custom provider rows.

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

For agent-assisted setup, run:

```bash
npx ambrium connect
npx ambrium status
npx ambrium doctor
```

The CLI detects the current Git repo, AWS CLI profiles, GCP projects,
Cloudflare Wrangler auth, Vercel auth, MotherDuck configuration, and local AI
tool usage where possible. Agents can use `npx ambrium spec` to get the setup
contract and complete non-sensitive configuration while the user approves OAuth,
IAM, billing exports, and token creation.

### Dodo Payments Billing

Create a Dodo Payments subscription product for Ambrium Indie:

- Name: `Ambrium Indie`
- Price: `$5/month`
- Tax category: digital product / SaaS
- Product ID: set as `DODO_INDIE_PRODUCT_ID`

Set runtime secrets in Cloudflare:

```bash
npx wrangler secret put DODO_PAYMENTS_API_KEY
npx wrangler secret put DODO_PAYMENTS_WEBHOOK_KEY
```

Set `DODO_PAYMENTS_ENVIRONMENT=live` and `DODO_INDIE_PRODUCT_ID=...` in the
deployment environment. The webhook endpoint is:

```text
https://ambrium.io/api/billing/webhook/dodo
```

Subscribe it to subscription/payment lifecycle events. The checkout route stores
`user_id` metadata, and the webhook updates the user's subscription in D1.

### Production application storage

Cloudflare D1 is the application store. In the Workers runtime, application
state is stored in normalized D1 tables for users, sessions, workspace settings,
provider connections, GitHub repos, custom providers, events, and cached
snapshots. Provider connection tokens and private metadata are encrypted before
they are written to D1.

Set a long random encryption key as a Worker secret before connecting providers:

```bash
openssl rand -base64 32
npx wrangler secret put APP_ENCRYPTION_KEY
```

The app can still read and migrate the old `app_kv` JSON row on first startup,
then deletes that legacy row after writing the normalized tables.

### MotherDuck analytics

D1 remains the application store. Historical cost, usage, and resource
observations are stored in MotherDuck.

1. Create `infra_cost_analyzer_dev`, `infra_cost_analyzer_staging`, and
   `infra_cost_analyzer_prod` in MotherDuck.
2. Create a read-write service token for each database.
3. Put the development PostgreSQL endpoint in `.env.local`:

```bash
MOTHERDUCK_DATABASE_URL="postgresql://postgres:<token>@pg.us-east-1-aws.motherduck.com:5432/infra_cost_analyzer_dev?sslmode=require"
ANALYTICS_ENABLED=true
ANALYTICS_READS_ENABLED=true
```

4. Apply and seed the local analytical schema:

```bash
npm run analytics:migrate
npm run analytics:seed -- --user=user_your_clerk_user_id
npm run analytics:validate
```

`npm run dev` uses the direct development URL with the same `pg` repository and
DuckDB SQL used in production. `npm run dev:parity` builds and runs the app in
the Workers runtime. After the `ANALYTICS_DB` binding has been added, set this
before parity preview to make Wrangler resolve that binding to the dev database:

```bash
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_ANALYTICS_DB="$MOTHERDUCK_DATABASE_URL"
```

For production, create Hyperdrive with caching disabled because month-to-date
analytical reads must reflect the latest completed sync:

```bash
npx wrangler hyperdrive create infra-cost-analyzer-motherduck \
  --connection-string="$MOTHERDUCK_DATABASE_URL" \
  --caching-disabled
```

Add the returned ID to `wrangler.jsonc` as binding `ANALYTICS_DB`, rerun
`npm run cf-typegen`, apply migrations to the production database, and deploy.

To migrate existing snapshots without calling provider APIs:

```bash
npm run analytics:backfill:d1 -- --dry-run
npm run analytics:backfill:d1
```

The command requires `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, a
`CLOUDFLARE_API_TOKEN` with D1 read access, and the production
`MOTHERDUCK_DATABASE_URL`. This control-plane token is separate from the
application's `CLOUDFLARE_PROVIDER_API_TOKEN`. The command can also
read a local export with `--file=.data/tenant-store.json`. The migration is
idempotent and never copies sessions or provider credentials.

The first screen is local sign-in. Use different email addresses to test different tenants. Each signed-in user gets isolated:

- repository selection;
- provider connections;
- provider credentials;
- connection logs;
- live cost sync state.

## Test The Connection Flow

### 1. Local GitHub flow

Use this first. It proves the onboarding state flow without external credentials:

1. Open the app.
2. Click `Local connect` in the Connection Flow panel.
3. The app stores the current repository as the connected GitHub source.
4. Refresh the dashboard and GitHub should show as `Ready`.

The stored multi-tenant state is written to:

```text
.data/tenant-store.json
```

### 2. Real Vercel flow

Preferred login flow:

1. In Vercel, create an App from the team/account settings.
2. Add this Authorization Callback URL:

```text
http://localhost:3002/api/vercel/oauth/callback
```

3. Add local env vars:

```bash
NEXT_PUBLIC_VERCEL_APP_CLIENT_ID="your-client-id"
VERCEL_APP_CLIENT_SECRET="your-client-secret"
VERCEL_OAUTH_REDIRECT_URI="http://localhost:3002/api/vercel/oauth/callback"
```

4. Rebuild and run the standalone server.
5. Click `Connect with Vercel`.
6. Vercel will show its login/consent screen and redirect back locally.
7. The app stores the OAuth access token in `.data/connections.json`.
8. The dashboard then calls Vercel `/v1/billing/charges` for the current month.
9. If Vercel returns FOCUS billing rows, estimated Vercel rows are replaced by live rows.

Advanced local fallback:

1. Create a Vercel token from Vercel Account Settings.
2. Open `Advanced token fallback`.
3. Paste the token.
4. If billing is under a Vercel team, enter the team ID such as `team_...` or the team slug.
5. Click `Verify`.

The `Live Billing` panel tells you whether live rows were loaded, whether Vercel returned an empty result, or whether the token/team scope needs a different permission.

### 3. Real GitHub App flow

This is a one-time app-owner setup. After these values are configured in the
deployment, every signed-in user can click `Choose GitHub repos`, authorize this
GitHub App on their own repositories, and return to a workspace that only shows
their synced repos.

Create one GitHub App for this product with these settings:

- Callback URL: `http://localhost:3000/api/github/callback`
- Repository permissions:
  - Contents: read-only
  - Metadata: read-only
  - Actions: read-only
  - Deployments: read-only

For production, use the deployed URL shown in the app's setup guide for both
Callback URL and Setup URL:

```text
https://ambrium.io/api/github/callback
```

In the GitHub App's Post installation section, check `Redirect on update`.
Keep webhooks inactive for now.

Then set these deployment secrets:

```bash
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
```

On Cloudflare Workers, the setup guide shows copyable commands:

```bash
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_APP_SLUG
npm run deploy
```

After redeploy, regular users do not see the owner setup guide. They only click
`Choose GitHub repos`, select repositories in GitHub, and the callback stores
those repos under their own signed-in workspace.

To scan a different local repo:

```bash
REPO_SCAN_ROOT=/absolute/path/to/repo npm run dev
```

Or use:

```text
http://localhost:3000/?repoPath=/absolute/path/to/repo
http://localhost:3000/api/analyze?repoPath=/absolute/path/to/repo
```

## Verification

```bash
npm run verify
```

This runs TypeScript checking, scanner/cost-engine tests, and a production Next build.

## Deployment

Ambrium deploys to Cloudflare Workers through OpenNext:

```bash
npm run deploy
```

Set production secrets before connecting real providers:

```bash
npx wrangler secret put APP_ENCRYPTION_KEY
npx wrangler secret put CLERK_SECRET_KEY
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
```

Set provider secrets only for the integrations you operate centrally. Most
provider connections are per-user and should be connected from the signed-in UI
or the CLI.

## Production Connector Coverage

The current cost rows are deterministic estimates derived from repo evidence. Production exactness requires provider billing connections:

- GitHub App: repo metadata, contents, workflows, deployments.
- Vercel: billing charges and project-to-repo metadata.
- AWS: Cost Explorer plus resource tags through a read-only cross-account role.
- GCP: Cloud Billing account/project discovery plus BigQuery detailed billing export.
- Azure: Cost Management Query scoped to subscription/resource group/tag.
- Cloudflare: account inventory and billing usage where the account API has access.
- DigitalOcean: billing history, invoices, balance, and project/resource inventory.

Provider tokens and private connection metadata are encrypted before D1 storage
with `APP_ENCRYPTION_KEY`. Do not log or expose plaintext provider credentials.
