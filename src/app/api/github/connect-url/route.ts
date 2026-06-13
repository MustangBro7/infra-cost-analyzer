import { NextRequest, NextResponse } from "next/server"
import { githubInstallUrl, hasGitHubAppConfig } from "@/lib/githubClient"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { appendEvent } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const origin = request.nextUrl.origin
    const callbackUrl = new URL("/api/github/callback", origin).toString()
    const appName = "Infra Cost Analyzer"
    const githubNewAppUrl = new URL("https://github.com/settings/apps/new")
    githubNewAppUrl.searchParams.set("name", appName)
    githubNewAppUrl.searchParams.set("url", origin)
    githubNewAppUrl.searchParams.set("callback_url", callbackUrl)
    githubNewAppUrl.searchParams.set("webhook_active", "false")
    const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || "c064bc22afe7d6511334c0c5cdd43bc1"
    const workerName = process.env.CLOUDFLARE_WORKER_NAME || "infra-cost-analyzer"
    const cloudflareSecretsUrl = `https://dash.cloudflare.com/${cloudflareAccountId}/workers/services/view/${workerName}/settings/variables`
    const url = githubInstallUrl()
    if (!hasGitHubAppConfig() || !url) {
      await appendEvent(user.id, {
        provider: "github",
        level: "warning",
        message: "GitHub App install requested, but GitHub App environment variables are not configured.",
      })
    }
    const installUrl = url ? new URL(url) : null
    if (installUrl) {
      installUrl.searchParams.set("state", user.id)
    }
    return NextResponse.json({
      configured: hasGitHubAppConfig() && Boolean(installUrl),
      url: installUrl?.toString() ?? null,
      requiredEnv: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG or GITHUB_APP_CLIENT_ID"],
      callbackUrl,
      setupLinks: {
        createGitHubApp: githubNewAppUrl.toString(),
        githubAppsSettings: "https://github.com/settings/apps",
        cloudflareWorkerVariables: cloudflareSecretsUrl,
      },
      setupCommands: [
        "npx wrangler secret put GITHUB_APP_ID",
        "npx wrangler secret put GITHUB_APP_PRIVATE_KEY",
        "npx wrangler secret put GITHUB_APP_SLUG",
        "npm run deploy",
      ],
      message: installUrl
        ? "Open this URL to install the GitHub App on a repository."
        : "Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_SLUG or GITHUB_APP_CLIENT_ID to enable GitHub repository selection.",
    })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    throw error
  }
}
