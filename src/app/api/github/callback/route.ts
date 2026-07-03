import { NextRequest, NextResponse } from "next/server"
import { createInstallationToken, listInstallationRepos } from "@/lib/githubClient"
import { currentUserFromRequest } from "@/lib/localAuth"
import { appendEvent, saveGitHubRepos, syncGitHubRepo, upsertConnection } from "@/lib/localStore"
import { PlanLimitError } from "@/lib/plan"
import { appUrl } from "@/lib/appUrl"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const installationId = Number.parseInt(request.nextUrl.searchParams.get("installation_id") ?? "", 10)
    if (!Number.isFinite(installationId)) {
      throw new Error("Missing installation_id from GitHub callback.")
    }
    const signedInUser = await currentUserFromRequest(request)
    if (!signedInUser) throw new Error("Sign in required.")
    const stateUserId = request.nextUrl.searchParams.get("state")
    if (!stateUserId) {
      throw new Error("Missing GitHub callback state. Return to the app and click Choose GitHub repos again.")
    }
    if (stateUserId !== signedInUser.id) {
      throw new Error("GitHub callback state does not match the signed-in user.")
    }
    const userId = signedInUser.id
    const token = await createInstallationToken(installationId)
    const repos = await listInstallationRepos(token.token)
    const selected = repos[0]?.fullName ?? null
    await saveGitHubRepos(userId, repos, selected)
    // Sync installed repos up to the plan's project limit; the rest stay
    // available to sync later (or after an upgrade) instead of failing the
    // whole installation callback.
    let planLimitHit: PlanLimitError | null = null
    for (const repo of repos) {
      try {
        await syncGitHubRepo(userId, repo.fullName)
      } catch (error) {
        if (error instanceof PlanLimitError) {
          planLimitHit = error
          break
        }
        throw error
      }
    }
    if (planLimitHit) {
      await appendEvent(userId, {
        provider: "github",
        level: "warning",
        message: `Some repositories were not synced: ${planLimitHit.message}`,
      })
    }
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
        syncedRepoFullNames: repos.map((repo) => repo.fullName),
        tokenExpiresAt: token.expires_at,
      },
    })
    return NextResponse.redirect(appUrl("/dashboard?view=repos", request.nextUrl.origin))
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
