import { NextRequest, NextResponse } from "next/server"
import { githubInstallUrl, hasGitHubAppConfig } from "@/lib/githubClient"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { appendEvent } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
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
