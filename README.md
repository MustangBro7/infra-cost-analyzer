# Infra Cost Analyzer

Standalone repository-aware infrastructure cost analyzer. This project lives inside the current workspace only as a temporary development location and does not import or depend on the GPay Cost Analyzer frontend, backend, domains, data model, or deployment configuration.

## What Works Now

- Scans a local repository path, defaulting to the parent folder of this project.
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
- Shows free-tier usage remaining for any connected provider whose cost is $0:
  measured consumption (Vercel FOCUS quantities, GCP billing-export usage) is
  compared against the provider's published free-tier allowance.
- Exposes `GET /api/analyze` for JSON output (cached snapshot; `?refresh=1` to recompute).
- Exposes `GET /api/providers` for supported provider setup metadata.
- Ships a production dashboard that can be deployed independently.

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

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
https://your-worker-domain/api/github/callback
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

### Vercel

This app is ready for Vercel as a standalone Next project:

```bash
vercel
vercel --prod
```

Set environment variables from `.env.example` in the Vercel project settings. In a hosted deployment, replace local filesystem scanning with GitHub App installation scans.

### Docker

Use the standalone Next output:

```bash
npm run build
npm run start
```

For container deployment, run `npm ci`, `npm run build`, then `npm run start` with `PORT` configured by the host.

### Cloudflare

The current implementation uses Node.js filesystem APIs for the local scanner and targets Vercel/Node first. To deploy the full app to Cloudflare Workers, split the scanner into:

- GitHub API adapter for repo file reads.
- Cloudflare-compatible backend routes without `node:fs`.
- D1/R2 persistence for provider connections and cost snapshots.

The product model and UI are already separated enough for that migration.

## Production Connector Roadmap

The current cost rows are deterministic estimates derived from repo evidence. Production exactness requires provider billing connections:

- GitHub App: repo metadata, contents, workflows, deployments.
- Vercel: billing charges and project-to-repo metadata.
- AWS: Cost Explorer plus resource tags through a read-only cross-account role.
- GCP: Cloud Billing account/project discovery plus BigQuery detailed billing export.
- Azure: Cost Management Query scoped to subscription/resource group/tag.
- Cloudflare: account inventory and billing usage where the account API has access.
- DigitalOcean: billing history, invoices, balance, and project/resource inventory.

Tokens and credentials should be encrypted before database storage. Do not store plaintext provider credentials in production.
