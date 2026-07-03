import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { readWorkspace, selectGitHubRepo, syncGitHubRepo, unsyncGitHubRepo, upsertConnection } from "@/lib/localStore"
import { PlanLimitError } from "@/lib/plan"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json()) as { fullName?: string; action?: "select" | "sync" | "unsync" }
    if (!payload.fullName) throw new Error("fullName is required.")
    if (payload.action === "unsync") {
      await unsyncGitHubRepo(user.id, payload.fullName)
    } else if (payload.action === "sync") {
      await syncGitHubRepo(user.id, payload.fullName)
    } else {
      await selectGitHubRepo(user.id, payload.fullName)
      await syncGitHubRepo(user.id, payload.fullName)
    }
    const workspace = await readWorkspace(user.id)
    const github = workspace.connections.github
    if (github) {
      await upsertConnection(user.id, {
        ...github,
        selectedRepoFullName: workspace.selectedRepoFullName ?? undefined,
        lastVerifiedAt: new Date().toISOString(),
        metadata: {
          ...github.metadata,
          syncedRepoFullNames: workspace.syncedRepoFullNames,
        },
      })
    }
    return NextResponse.json({
      selectedRepoFullName: workspace.selectedRepoFullName,
      syncedRepoFullNames: workspace.syncedRepoFullNames,
    })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    if (error instanceof PlanLimitError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 402 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to select repo." },
      { status: 400 }
    )
  }
}
