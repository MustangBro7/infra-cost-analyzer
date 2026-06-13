import { readWorkspace, saveGitHubRepos, upsertConnection } from "./localStore"
import { scanRepositorySafe } from "./repoScanner"
import { listVercelProjects, verifyVercelToken } from "./vercelClient"
import { verifyCloudflareToken } from "./cloudflareClient"
import { discoverBillingExportTable, normalizeBillingExportTableId, verifyGcpServiceAccount } from "./gcpClient"
import { verifyAwsCredentials, type AwsCredentials } from "./awsClient"
import { readLocalAwsCredentials } from "./awsLocalCreds"

export async function connectGithubLocal(userId: string) {
  const scan = scanRepositorySafe()
  const repo = {
    id: Date.now(),
    owner: scan.repo.owner,
    name: scan.repo.name,
    fullName: `${scan.repo.owner}/${scan.repo.name}`,
    private: true,
    defaultBranch: "local",
    htmlUrl: scan.repo.remoteUrl ?? scan.repo.path,
  }
  await saveGitHubRepos(userId, [repo], repo.fullName)
  await upsertConnection(userId, {
    provider: "github",
    status: "connected",
    accountLabel: repo.fullName,
    selectedRepoFullName: repo.fullName,
    connectedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    lastError: null,
    metadata: {
      mode: "local",
      path: scan.repo.path,
      syncedRepoFullNames: [repo.fullName],
    },
  })
  return repo
}

export async function connectVercelToken(
  userId: string,
  token: string,
  teamId?: string | null,
  slug?: string | null
) {
  const verified = await verifyVercelToken(token)
  const projects = await listVercelProjects(token, teamId)
  await upsertConnection(userId, {
    provider: "vercel",
    status: "connected",
    accountLabel: verified.accountLabel,
    accessToken: token,
    connectedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    lastError: null,
    metadata: {
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

export async function connectAwsKeys(userId: string, credentials: AwsCredentials) {
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
    },
  })
  return { accountLabel: verified.accountId ? `AWS ${verified.accountId}` : "AWS account" }
}

/**
 * Connects AWS using the credentials the AWS CLI already wrote to
 * ~/.aws/credentials (lowest-friction path: run `aws configure` once, then
 * click connect). Only works where the server has a real home directory.
 */
export async function connectAwsLocal(userId: string, profile?: string | null) {
  const local = readLocalAwsCredentials(profile)
  if (!local) {
    throw new Error(
      "No static AWS CLI credentials found in ~/.aws/credentials. Run `aws configure` (or paste an access key), then try again. SSO-only profiles are not yet supported."
    )
  }
  const result = await connectAwsKeys(userId, {
    accessKeyId: local.accessKeyId,
    secretAccessKey: local.secretAccessKey,
    sessionToken: local.sessionToken,
  })
  return { ...result, profile: local.profile, region: local.region }
}

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
 *   CLOUDFLARE_API_TOKEN
 *   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ optional AWS_SESSION_TOKEN)
 *   GCP_SERVICE_ACCOUNT_KEY (raw or base64 JSON) + optional GCP_BILLING_EXPORT_TABLE
 */
export async function autoConnectFromEnv(userId: string): Promise<Array<{ provider: string; ok: boolean; detail: string }>> {
  const workspace = await readWorkspace(userId)
  const tasks: Array<{ provider: string; run: () => Promise<string> }> = []

  if (workspace.connections.github?.status !== "connected") {
    tasks.push({
      provider: "github",
      run: async () => {
        const repo = await connectGithubLocal(userId)
        return `local repo ${repo.fullName}`
      },
    })
  }
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
  if (workspace.connections.cloudflare?.status !== "connected" && process.env.CLOUDFLARE_API_TOKEN) {
    tasks.push({
      provider: "cloudflare",
      run: async () => {
        const result = await connectCloudflareToken(userId, process.env.CLOUDFLARE_API_TOKEN as string)
        return result.accountLabel
      },
    })
  }
  if (workspace.connections.aws?.status !== "connected" && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    tasks.push({
      provider: "aws",
      run: async () => {
        const result = await connectAwsKeys(userId, {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
          sessionToken: process.env.AWS_SESSION_TOKEN ?? null,
        })
        return result.accountLabel
      },
    })
  }
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
