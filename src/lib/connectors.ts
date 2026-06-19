import { readWorkspace, upsertConnection } from "./localStore"
import { fetchVercelPlan, listVercelProjects, verifyVercelToken } from "./vercelClient"
import { verifyCloudflareToken } from "./cloudflareClient"
import { discoverBillingExportTable, normalizeBillingExportTableId, verifyGcpServiceAccount } from "./gcpClient"
import { assumeAwsRole, verifyAwsCredentials, type AwsCredentials } from "./awsClient"
import {
  fetchMotherDuckUsage,
  motherDuckRegion,
  sanitizeMotherDuckConnectionString,
  type MotherDuckPlan,
} from "./motherduckClient"

export async function connectVercelToken(
  userId: string,
  token: string,
  teamId?: string | null,
  slug?: string | null
) {
  const verified = await verifyVercelToken(token)
  const projects = await listVercelProjects(token, teamId)
  const plan = await fetchVercelPlan(token, teamId)
  await upsertConnection(userId, {
    provider: "vercel",
    status: "connected",
    accountLabel: verified.accountLabel,
    accessToken: token,
    connectedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    lastError: null,
    metadata: {
      plan,
      teamId: teamId ?? null,
      slug: slug ?? null,
      teams: verified.teams.map((team) => ({ id: team.id, slug: team.slug, name: team.name })),
      projectCount: projects.length,
      linkedProjects: projects
        .filter((project) => project.link?.repo)
        .slice(0, 25)
        .map((project) => ({
          id: project.id,
          name: project.name,
          repo: project.link?.repo,
          org: project.link?.org,
          framework: project.framework,
        })),
    },
  })
  return {
    accountLabel: verified.accountLabel,
    projectCount: projects.length,
    linkedProjects: projects.filter((project) => project.link?.repo).length,
  }
}

export async function connectCloudflareToken(userId: string, token: string) {
  const verified = await verifyCloudflareToken(token)
  await upsertConnection(userId, {
    provider: "cloudflare",
    status: "connected",
    accountLabel: verified.accountLabel,
    accessToken: token,
    connectedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    lastError: null,
    metadata: {
      tokenId: verified.tokenId,
      accounts: verified.accounts.slice(0, 10).map((account) => ({ id: account.id, name: account.name })),
    },
  })
  return {
    accountLabel: verified.accountLabel,
    accountCount: verified.accounts.length,
  }
}

export async function connectMotherDuck(userId: string, connectionString: string, plan: MotherDuckPlan) {
  if (!["free", "lite", "business"].includes(plan)) throw new Error("Select a valid MotherDuck plan.")
  const safeUrl = sanitizeMotherDuckConnectionString(connectionString)
  const usage = await fetchMotherDuckUsage(safeUrl)
  const effectivePlan = usage.detectedPlan ?? plan
  const accountLabel = `${usage.databaseName} · ${usage.username}`
  await upsertConnection(userId, {
    provider: "motherduck",
    status: "connected",
    accountLabel,
    accessToken: safeUrl,
    connectedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    lastError: null,
    metadata: {
      plan: effectivePlan,
      region: motherDuckRegion(safeUrl),
      databaseCount: usage.databases.length,
    },
  })
  return { accountLabel, databaseCount: usage.databases.length, plan: effectivePlan }
}

/**
 * Connects Cloudflare using the OAuth token from `wrangler login` (lowest
 * friction: if you deploy with wrangler, you're already authorized). Verifies by
 * listing accounts — the OAuth token can read accounts and the GraphQL Analytics
 * API, which is what powers free-tier usage. Billing subscriptions may need a
 * scoped API token instead, but usage still works without it.
 */
export async function connectGcpKey(userId: string, keyJson: string, billingExportTable?: string | null) {
  const verified = await verifyGcpServiceAccount(keyJson)
  let exportTable = billingExportTable?.trim() ? normalizeBillingExportTableId(billingExportTable) : null
  let exportTableSource: "provided" | "discovered" | null = exportTable ? "provided" : null
  if (!exportTable) {
    try {
      exportTable = await discoverBillingExportTable(keyJson)
      if (exportTable) exportTableSource = "discovered"
    } catch {
      exportTable = null
    }
  }
  await upsertConnection(userId, {
    provider: "gcp",
    status: "connected",
    accountLabel: verified.accountLabel,
    accessToken: keyJson,
    connectedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    lastError: null,
    metadata: {
      projectId: verified.projectId,
      billingAccounts: verified.billingAccounts?.slice(0, 10) ?? null,
      billingApiReachable: verified.billingAccounts !== null,
      billingExportTable: exportTable,
      billingExportTableSource: exportTableSource,
    },
  })
  return {
    accountLabel: verified.accountLabel,
    projectId: verified.projectId,
    billingAccountCount: verified.billingAccounts?.length ?? null,
    billingExportTable: exportTable,
    billingExportTableSource: exportTableSource,
  }
}

export async function connectAwsKeys(
  userId: string,
  credentials: AwsCredentials,
  options?: { costExplorer?: boolean }
) {
  const verified = await verifyAwsCredentials(credentials)
  await upsertConnection(userId, {
    provider: "aws",
    status: "connected",
    accountLabel: verified.accountId ? `AWS ${verified.accountId}` : "AWS account",
    // Stored server-side only; publicStore never exposes accessToken.
    accessToken: JSON.stringify(credentials),
    connectedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    lastError: null,
    metadata: {
      accountId: verified.accountId,
      arn: verified.arn,
      // Cost Explorer GetCostAndUsage costs $0.01/request, so it is opt-in.
      // Free Tier usage is always pulled (free).
      costExplorer: options?.costExplorer ?? false,
    },
  })
  return { accountLabel: verified.accountId ? `AWS ${verified.accountId}` : "AWS account" }
}

/**
 * Connects AWS via a read-only cross-account IAM role (the one-click path). The
 * customer launches a CloudFormation stack that creates a role trusting our SaaS
 * principal, gated by `externalId`; we verify by assuming it, then store only the
 * role ARN + external id — never long-lived keys. Cost is pulled by assuming the
 * role on demand for short-lived credentials.
 */
/**
 * Assumes the role, tolerating IAM eventual consistency: a role the companion CLI
 * just created can take a few seconds to become assumable, so a connect fired
 * immediately after provisioning may see a transient AccessDenied / NoSuchEntity.
 * Retries briefly before surfacing the error.
 */
async function assumeAwsRoleWithRetry(ref: { roleArn: string; externalId: string; region?: string }) {
  let lastError: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await assumeAwsRole(ref)
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : ""
      const transient = /AccessDenied|not authorized|cannot be found|NoSuchEntity|InvalidClientTokenId/i.test(message)
      if (!transient || attempt === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
  throw lastError
}

export async function connectAwsRole(
  userId: string,
  ref: { roleArn: string; externalId: string; region?: string },
  options?: { costExplorer?: boolean }
) {
  const assumed = await assumeAwsRoleWithRetry(ref)
  const accountId = assumed.accountId || ref.roleArn.match(/::(\d+):/)?.[1] || ""
  const accountLabel = accountId ? `AWS ${accountId}` : "AWS account"
  await upsertConnection(userId, {
    provider: "aws",
    status: "connected",
    accountLabel,
    // Stored server-side only; publicStore never exposes accessToken. No keys —
    // just the role reference, which is useless without the SaaS principal.
    accessToken: JSON.stringify({ roleArn: ref.roleArn, externalId: ref.externalId, region: ref.region ?? "us-east-1" }),
    connectedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    lastError: null,
    metadata: {
      accountId,
      roleArn: ref.roleArn,
      authMode: "iam_role",
      // Cost Explorer GetCostAndUsage bills $0.01/request, so it stays opt-in.
      costExplorer: options?.costExplorer ?? false,
    },
  })
  return { accountLabel }
}

/**
 * Toggles Cost Explorer pulling on an existing AWS connection. Cost Explorer
 * bills $0.01/request, so this lets the user turn live spend on only when they
 * want it. Preserves the stored credentials.
 */
export async function setAwsCostExplorer(userId: string, enabled: boolean) {
  const workspace = await readWorkspace(userId)
  const aws = workspace.connections.aws
  if (!aws || aws.status !== "connected") {
    throw new Error("AWS is not connected.")
  }
  await upsertConnection(userId, {
    ...aws,
    metadata: { ...aws.metadata, costExplorer: enabled },
  })
  return { costExplorer: enabled }
}

/**
 * Sets how often Cost Explorer (billed $0.01/call) may be auto-refreshed:
 * "manual" (only on demand), "daily", "weekly" or "monthly". Between refreshes
 * the last cached result is reused, so page loads don't keep re-billing.
 */
export async function setAwsCostExplorerInterval(userId: string, interval: string) {
  const allowed = new Set(["manual", "daily", "weekly", "monthly"])
  if (!allowed.has(interval)) throw new Error("Invalid Cost Explorer interval.")
  const workspace = await readWorkspace(userId)
  const aws = workspace.connections.aws
  if (!aws || aws.status !== "connected") {
    throw new Error("AWS is not connected.")
  }
  await upsertConnection(userId, {
    ...aws,
    metadata: { ...aws.metadata, costExplorerInterval: interval },
  })
  return { costExplorerInterval: interval }
}

/**
 * Connects AWS using the credentials the AWS CLI already wrote to
 * ~/.aws/credentials (lowest-friction path: run `aws configure` once, then
 * click connect). Only works where the server has a real home directory.
 */
function decodeMaybeBase64(value: string) {
  const trimmed = value.trim()
  if (trimmed.startsWith("{")) return trimmed
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8")
    return decoded.trim().startsWith("{") ? decoded : trimmed
  } catch {
    return trimmed
  }
}

/**
 * Connects every provider that has credentials in server env vars and is not
 * yet connected for this user. Lets a deployment (or a local .env file) make
 * sign-in the only step a user performs.
 *
 * Supported env vars:
 *   VERCEL_TOKEN (+ VERCEL_TEAM_ID / VERCEL_TEAM_SLUG)
 *   CLOUDFLARE_PROVIDER_API_TOKEN
 *   GCP_SERVICE_ACCOUNT_KEY (raw or base64 JSON) + optional GCP_BILLING_EXPORT_TABLE
 *   MOTHERDUCK_PROVIDER_DATABASE_URL + optional MOTHERDUCK_PROVIDER_PLAN
 *
 * AWS is deliberately excluded — it is per-user (connected from the UI) so each
 * user's Cost Explorer charges and data stay on their own account.
 */
export async function autoConnectFromEnv(userId: string): Promise<Array<{ provider: string; ok: boolean; detail: string }>> {
  const workspace = await readWorkspace(userId)
  const tasks: Array<{ provider: string; run: () => Promise<string> }> = []
  // CLOUDFLARE_API_TOKEN remains a compatibility fallback for existing
  // deployments. New setups use a provider-specific name so Wrangler does not
  // mistake the application token for its own control-plane credential.
  const cloudflareProviderToken =
    process.env.CLOUDFLARE_PROVIDER_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN

  // GitHub is connected per-user via the GitHub App (users authorize their own
  // repos) — never auto-connected from server state. Provider accounts below are
  // auto-connected only when server env credentials are present.
  if (workspace.connections.vercel?.status !== "connected" && process.env.VERCEL_TOKEN) {
    tasks.push({
      provider: "vercel",
      run: async () => {
        const result = await connectVercelToken(
          userId,
          process.env.VERCEL_TOKEN as string,
          process.env.VERCEL_TEAM_ID ?? null,
          process.env.VERCEL_TEAM_SLUG ?? null
        )
        return result.accountLabel
      },
    })
  }
  if (workspace.connections.cloudflare?.status !== "connected" && cloudflareProviderToken) {
    tasks.push({
      provider: "cloudflare",
      run: async () => {
        const result = await connectCloudflareToken(userId, cloudflareProviderToken)
        return result.accountLabel
      },
    })
  }
  if (
    workspace.connections.motherduck?.status !== "connected" &&
    process.env.MOTHERDUCK_PROVIDER_DATABASE_URL
  ) {
    tasks.push({
      provider: "motherduck",
      run: async () => {
        const rawPlan = process.env.MOTHERDUCK_PROVIDER_PLAN ?? "free"
        const plan: MotherDuckPlan = ["free", "lite", "business"].includes(rawPlan)
          ? rawPlan as MotherDuckPlan
          : "free"
        const result = await connectMotherDuck(
          userId,
          process.env.MOTHERDUCK_PROVIDER_DATABASE_URL as string,
          plan
        )
        return result.accountLabel
      },
    })
  }
  // AWS is intentionally NOT auto-connected from env vars: a shared key would
  // bill the key owner's account for every user and expose their cost data to
  // all users. AWS is per-user only — each user connects their own account from
  // the UI (local CLI in dev, pasted access key in production).
  if (workspace.connections.gcp?.status !== "connected" && process.env.GCP_SERVICE_ACCOUNT_KEY) {
    tasks.push({
      provider: "gcp",
      run: async () => {
        const result = await connectGcpKey(
          userId,
          decodeMaybeBase64(process.env.GCP_SERVICE_ACCOUNT_KEY as string),
          process.env.GCP_BILLING_EXPORT_TABLE ?? null
        )
        return result.accountLabel
      },
    })
  }

  const outcomes: Array<{ provider: string; ok: boolean; detail: string }> = []
  // Sequential on purpose: the JSON store is read-modify-write, so parallel
  // connects would clobber each other's writes.
  for (const task of tasks) {
    try {
      outcomes.push({ provider: task.provider, ok: true, detail: await task.run() })
    } catch (error) {
      outcomes.push({
        provider: task.provider,
        ok: false,
        detail: error instanceof Error ? error.message : "auto-connect failed",
      })
    }
  }
  return outcomes
}
