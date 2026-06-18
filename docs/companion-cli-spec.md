# Companion CLI — pairing & auto-provision spec

## Why
Connecting providers today requires the user to know exactly which console toggle
to flip and which scopes to grant — they succeed only with hand-holding. But the
target audience (developers using a cost tool) almost always has `aws`, `gcloud`,
and `wrangler`/`cf` **already authenticated locally**, and those CLI sessions hold
the permissions the browser OAuth tokens lack. A companion CLI can do the exact
provisioning a human-guided session does, reducing connection to **one approval
per provider**.

Non-goal: zero human approval. Each provider intentionally gates access behind a
consent/console moment — that's a security feature. We collapse it to one click and
automate everything else.

## Shape
`npx @ambrium/connect` (Node CLI; shells out to the installed cloud CLIs). It:
1. Detects which cloud CLIs are authenticated.
2. Pairs to the user's Ambrium account via a device-code handshake.
3. Provisions least-privilege read-only access per provider (reusing the exact
   IAM-role / service-account / token logic validated manually).
4. Pushes the resulting references to the SaaS, which verifies and stores them.

## Target UX
```
$ npx @ambrium/connect
◇ Detecting cloud CLIs…
   ✓ aws     account 590183813615
   ✓ gcloud  project cost-analyser-494412
   ✓ cf      account c064bc22…
◇ Pair with Ambrium → open https://ambrium.io/pair and enter:  WDJB-MJHT
   ✓ paired as abhinav@…
◇ AWS         creating read-only role…           ✓ connected (590183813615)
◇ Google Cloud creating service account…          ✓ connected
              ⚠ enable BigQuery billing export (1 click): https://console.cloud.google.com/billing/…/export/bigquery
◇ Cloudflare  opening token page (scopes prefilled)… paste token › ••••  ✓ connected
✓ Done — 3 providers connected. Dashboard: https://ambrium.io
```

## Pairing handshake (OAuth 2.0 Device Authorization Grant, RFC 8628)
The CLI must attach provisioned creds to the right Clerk user **without** logging
into Clerk itself. Standard device-code flow:

1. `POST /api/cli/pair/start` (unauth, rate-limited) → `{ deviceCode, userCode,
   verificationUrl, interval, expiresIn }`. `userCode` is human-typable (e.g.
   `WDJB-MJHT`); `deviceCode` is a long random secret.
2. CLI prints the `verificationUrl` + `userCode` (and may auto-open the browser).
3. User — already signed in to Ambrium (Clerk) — visits `/pair`, enters the
   `userCode`, clicks Approve → `POST /api/cli/pair/approve { userCode }` binds the
   device code to `userId`.
4. CLI polls `POST /api/cli/pair/poll { deviceCode }` every `interval`s →
   `pending` | `denied` | `expired` | `{ status:"authorized", cliToken, expiresIn }`.
5. CLI stores the short-lived `cliToken` in `~/.ambrium/credentials` (0600) and uses
   it as `Authorization: Bearer` for the connect endpoints.

`cliToken`: short-lived (e.g. 15 min), single-user, scoped to connect actions only.
Re-runs reuse it until expiry, else re-pair.

## SaaS-side endpoints (new)
All under `/api/cli/*`. Pairing state lives in the existing D1 KV store under a new
`cliPairings` map keyed by `deviceCode`: `{ userCode, userId|null, status,
createdAt, expiresAt, cliToken|null }`, with TTL sweep.

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/cli/pair/start` | none (rate-limited) | issue device/user codes |
| `POST /api/cli/pair/approve` | Clerk (browser) | bind `userCode` → current user |
| `POST /api/cli/pair/poll` | device code | return status + `cliToken` when authorized |
| `GET  /api/cli/aws/params` | cliToken | `{ trustedAccountId, externalId }` (server-owned per-connection external id) |
| `POST /api/cli/connect/aws` | cliToken | body `{ roleArn, externalId, region }` → `connectAwsRole` |
| `POST /api/cli/connect/gcp` | cliToken | body `{ keyJson }` → `connectGcpKey` |
| `POST /api/cli/connect/cloudflare` | cliToken | body `{ token }` → `connectCloudflareToken` |

The connect endpoints are thin wrappers over the **existing connector functions**
(`src/lib/connectors.ts`: `connectAwsRole`, `connectGcpKey`, `connectCloudflareToken`)
— same verification + storage as the UI path. Only the auth differs (cliToken
instead of Clerk session), so add a `requireUserFromCliToken(request)` alongside
`requireUserFromRequest`.

The browser side needs a `/pair` page (Clerk-protected): an input for the
`userCode` + Approve button calling `/api/cli/pair/approve`.

## Per-provider provisioning (CLI side)

### AWS — fully automatic (reuses tonight's flow)
- Precondition: `aws sts get-caller-identity` succeeds.
- CLI calls `GET /api/cli/aws/params` → `{ trustedAccountId, externalId }`. The
  **SaaS owns the externalId** (generated per connection), so it's a real
  confused-deputy guard, not user-typed.
- CLI provisions in the user's account (idempotent, clearly named):
  - role `ambrium-cost-readonly` trusting `arn:aws:iam::<trustedAccountId>:root`,
    `Condition sts:ExternalId == <externalId>`;
  - inline policy: `ce:GetCostAndUsage`, `ce:GetCostForecast`,
    `ce:GetDimensionValues`, `ce:GetTags`, `freetier:GetFreeTierUsage`.
  (Same JSON as `infra/aws-cost-readonly.cfn.yaml`.)
- CLI → `POST /api/cli/connect/aws { roleArn, externalId, region }`; SaaS verifies
  with `assumeAwsRole` and stores `{ roleArn, externalId }` — **no keys leave the
  account**.

### Google Cloud — automatic except the export toggle
- Precondition: `gcloud auth print-access-token` succeeds.
- CLI provisions (idempotent): service account `ambrium-cost@<project>.iam`, grants
  `roles/bigquery.jobUser` + `roles/bigquery.dataViewer` (+ `roles/billing.viewer`),
  creates a key JSON; enables `cloudbilling`/`bigquery` APIs; creates the
  `ambrium_billing` dataset.
- CLI → `POST /api/cli/connect/gcp { keyJson }`; SaaS verifies + auto-discovers the
  billing-export table + stores (existing `connectGcpKey` already does discovery).
- **Remaining 1 click:** Cloud Billing → BigQuery export is console-only (no API /
  gcloud / Terraform — confirmed). CLI prints the deep link and warns if no
  `gcp_billing_export_*` table exists yet.

### Cloudflare — paste-assisted (token-mgmt scope wall)
- The local `cf`/`wrangler` OAuth session lacks `api_tokens:write` + billing scopes,
  so the CLI **can't mint a token** from it (`403`, verified).
- CLI behavior, in order of preference:
  1. If `CLOUDFLARE_API_TOKEN` env or a Global API Key is present → use it.
  2. Else open the deep-link token page (scopes `account_settings:read`,
     `billing:read`, `account_analytics:read` pre-checked), prompt the user to paste
     the created token.
- CLI → `POST /api/cli/connect/cloudflare { token }`.

## Security model
- **No SaaS secret reaches the CLI.** It only learns `trustedAccountId` (semi-public)
  + a per-connection `externalId`. The AWS SaaS-principal key stays a Worker secret.
- **AWS:** no long-lived customer credential ever leaves the user's account — only a
  role ARN + external id.
- **GCP key / CF token:** transmitted over HTTPS to the SaaS, stored server-side in
  the existing connection store (never returned to any client; `publicStore`
  already strips secrets) — identical risk profile to the current UI paste.
- **Pairing:** device-code flow means creds can only bind to a user who actively
  approved in their authenticated browser session (anti-phishing). `cliToken` is
  short-lived, single-user, connect-scoped.
- **Least privilege + auditability:** every provisioned resource is read-only and
  named `ambrium-cost-*`; the CLI is open-source and prints exactly what it creates,
  with revoke instructions.

## Phasing
1. **Pairing handshake + AWS.** Highest value, fully automatic, reuses tonight's
   role/`assumeAwsRole`. Ship `pair/*` endpoints, `/pair` page,
   `requireUserFromCliToken`, `/api/cli/aws/params`, `/api/cli/connect/aws`, and the
   AWS provisioning in the CLI.
2. **GCP** service-account provisioning + `/api/cli/connect/gcp`, dataset creation,
   export deep-link/warn.
3. **Cloudflare** paste-assist + `/api/cli/connect/cloudflare`; polish, idempotency,
   `~/.ambrium/credentials` reuse, JSON/`--quiet` output.

## Open decisions (assumptions made)
- Package name `@ambrium/connect` (rename freely).
- Device-code pairing over an API-key paste (better UX + anti-phishing) — recommended.
- CLI shells out to `aws`/`gcloud`/`cf` (assumes installed+authed) rather than
  bundling SDKs — smaller, matches the dev audience; revisit if we want zero-CLI.

## Reused from the existing codebase
- Connectors: `connectAwsRole`, `connectGcpKey`, `connectCloudflareToken`
  (`src/lib/connectors.ts`).
- `assumeAwsRole` + the external-id pattern (`src/lib/awsClient.ts`).
- D1 KV store (`src/lib/localStore.ts`) for `cliPairings`.
- CloudFormation template + provisioning JSON (`infra/aws-cost-readonly.cfn.yaml`,
  `infra/PROVIDER-SETUP.md`).
- Clerk auth (`requireUserFromRequest`) — add a `requireUserFromCliToken` sibling.
