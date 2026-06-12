import { NextRequest, NextResponse } from "next/server"
import { createInstallationToken, listInstallationRepos } from "@/lib/githubClient"
import { appendEvent, saveGitHubRepos, upsertConnection } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const installationId = Number.parseInt(request.nextUrl.searchParams.get("installation_id") ?? "", 10)
    if (!Number.isFinite(installationId)) {
      throw new Error("Missing installation_id from GitHub callback.")
    }
    const userId = request.nextUrl.searchParams.get("state")
    if (!userId) throw new Error("Missing GitHub callback state.")
    const token = await createInstallationToken(installationId)
    const repos = await listInstallationRepos(token.token)
    const selected = repos[0]?.fullName ?? null
    await saveGitHubRepos(userId, repos, selected)
    await upsertConnection(userId, {
      provider: "github",
      status: "connected",
      accountLabel: selected ? `${repos.length} repos installed` : "GitHub App installed",
      installationId,
      selectedRepoFullName: selected ?? undefined,
      connectedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
      lastError: null,
      metadata: {
        repositories: repos.length,
        tokenExpiresAt: token.expires_at,
      },
    })
    return NextResponse.redirect(new URL("/", request.url))
  } catch (error) {
    const userId = request.nextUrl.searchParams.get("state")
    if (userId) await appendEvent(userId, {
      provider: "github",
      level: "error",
      message: error instanceof Error ? `GitHub callback failed: ${error.message}` : "GitHub callback failed.",
    })
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "GitHub callback failed." },
      { status: 400 }
    )
  }
}
