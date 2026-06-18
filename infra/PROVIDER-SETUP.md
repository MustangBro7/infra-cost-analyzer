# Provider one-click auth — setup status & steps

Status of the "frictionless connect" work for the three CLI providers. Secrets
(AWS external id, access keys) are **not** in this file — they live in
`.env.local` (gitignored) or were shared out-of-band.

## AWS — ✅ one-click built & verified

The full read-only cross-account role flow is implemented and tested end-to-end.

**Provisioned in account `590183813615` (via AWS CLI):**
- IAM user `infra-cost-analyzer-saas` — the SaaS principal; inline policy allows
  only `sts:AssumeRole` on the role below. Its access key is in `.env.local`
  (`AWS_SAAS_ACCESS_KEY_ID` / `AWS_SAAS_SECRET_ACCESS_KEY`). In prod, set these as
  Worker secrets (`npx wrangler secret put …`).
- IAM role `infra-cost-analyzer-readonly` — trusts the SaaS user, gated by an
  ExternalId; inline policy grants `ce:GetCostAndUsage`, `ce:GetCostForecast`,
  `ce:GetDimensionValues`, `ce:GetTags`, `freetier:GetFreeTierUsage`.

**Code:** `assumeAwsRole` / `resolveAwsCredentials` in `src/lib/awsClient.ts`,
`connectAwsRole` in `src/lib/connectors.ts`, role branch in
`src/app/api/aws/connect/route.ts`, IAM-role-first UI in `ProviderConnectPanel.tsx`.
The app stores only `{roleArn, externalId}` — never customer keys — and assumes
the role on demand for short-lived credentials.

**To connect in the UI:** AWS card → paste the role ARN
(`arn:aws:iam::590183813615:role/infra-cost-analyzer-readonly`) + the external id
(shared separately) → "Verify role". Tick the Cost Explorer box for spend
(bills ~$0.01/refresh); Free Tier usage is free.

**Cross-account template:** `infra/aws-cost-readonly.cfn.yaml` — the CloudFormation
stack other AWS accounts launch to create the same role trusting our SaaS account.
(Host it at a public URL to wire a real "Launch Stack" button.)

**To revoke:** delete the access key + user + role:
```
aws iam delete-access-key --user-name infra-cost-analyzer-saas --access-key-id <id>
aws iam delete-user-policy --user-name infra-cost-analyzer-saas --policy-name assume-cost-role
aws iam delete-user --user-name infra-cost-analyzer-saas
aws iam delete-role-policy --role-name infra-cost-analyzer-readonly --policy-name cost-read
aws iam delete-role --role-name infra-cost-analyzer-readonly
```

## GCP — ⚠️ groundwork done; two console-only steps remain

**Done (via gcloud):** enabled `cloudbilling`, `bigquery`, `cloudresourcemanager`,
`iam` APIs on project `cost-analyser-494412`.

**Found:** BigQuery dataset `infra_cost_analyzer_billing` exists, but it has **no
`gcp_billing_export_*` tables yet** — the billing export isn't turned on, so there
is no detailed cost data to read. Open billing account: `01DAFF-503912-65489C`.

**Remaining (console-only — gcloud can't do these):**
1. **Enable Cloud Billing export to BigQuery.** Console → Billing → Billing export
   → BigQuery export → edit Standard (and Detailed) usage cost → project
   `cost-analyser-494412`, dataset `infra_cost_analyzer_billing` → Save. Data
   populates within a few hours. After that, the existing service-account connect
   auto-discovers the export table and shows real cost.
2. **(For OAuth one-click) Create an OAuth client.** Console → APIs & Services →
   Credentials → Create OAuth client → Web application. Redirect URI
   `http://localhost:3000/api/gcp/oauth/callback`. Set the consent screen to
   "Testing" and add yourself as a test user (avoids verification for personal
   use). Scopes: `openid email`, `cloud-billing.readonly`, `bigquery.readonly`.
   Then we wire the client id/secret and build the OAuth routes (mirrors Vercel's
   PKCE flow). Until then, GCP connects via the read-only service-account key.

> Why not fully automated: Google exposes neither OAuth web-client creation nor the
> billing-export toggle to gcloud; both are Console-only. Detailed GCP cost
> *inherently* requires the BigQuery export regardless of auth method.

## Cloudflare — ❌ can't mint a token via CLI (OAuth-scope wall)

Tried the new `cf` CLI (v0.0.6), which *does* expose `cf accounts tokens create`
for account-owned tokens. But the local `cf` (and `wrangler`) session is an **OAuth
login token** whose scopes (dozens: workers/dns/pages/…) include **neither token
management nor billing** — so `cf accounts tokens list/create` returns
`403 Unauthorized [9109]`. `cf auth login` can't request extra scopes
non-interactively (browser consent, fixed scope set), and `cf auth login --token`
needs a token we don't yet have (circular).

**Fastest path (≈20s, manual):** Cloudflare card → "Create Cloudflare token" — the
deep link opens the token page with `account_settings:read` + `billing:read` +
`account_analytics:read` pre-checked → Create → paste once. (Note: that classic
user token verifies via `/user/tokens/verify`, which the app already uses. An
account-owned token from `cf` would need a small fallback in `verifyCloudflareToken`
— not worth adding until token creation is actually unblocked.)
