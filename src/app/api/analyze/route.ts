import { NextRequest, NextResponse } from "next/server"
import { getOrCreateAnalysisSnapshot, refreshAnalysisSnapshot } from "@/lib/analysisService"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { readWorkspace } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const repo = request.nextUrl.searchParams.get("repo")
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1"
    const workspace = await readWorkspace(user.id)
    const input = {
      userId: user.id,
      requestedRepo: repo,
      githubRepos: workspace.githubRepos,
    }
    // Default: serve the persisted snapshot (DB read, no live round-trip).
    // `?refresh=1` recomputes live data and updates the stored snapshot.
    const snapshot = forceRefresh
      ? await refreshAnalysisSnapshot(input)
      : await getOrCreateAnalysisSnapshot(input)
    return NextResponse.json({ ...snapshot.analysis, computedAt: snapshot.computedAt })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to analyze repository.",
      },
      { status: 400 }
    )
  }
}
