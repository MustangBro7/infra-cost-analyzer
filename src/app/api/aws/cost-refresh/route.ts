import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { readWorkspace } from "@/lib/localStore"
import { refreshAnalysisSnapshot } from "@/lib/analysisService"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Forces a single Cost Explorer pull (one billed $0.01 call), updates the cache,
 * and rebuilds the snapshot — used by the "Pull cost now" button so the user can
 * refresh AWS spend on demand regardless of the configured cadence.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const body = (await request.json().catch(() => ({}))) as { repo?: string | null }
    const workspace = await readWorkspace(user.id)
    const snapshot = await refreshAnalysisSnapshot({
      userId: user.id,
      requestedRepo: body.repo ?? null,
      githubRepos: workspace.githubRepos,
      forceCostExplorer: true,
    })
    const awsSync = snapshot.analysis.liveSync.find((entry) => entry.provider === "aws")
    return NextResponse.json({ status: "ok", computedAt: snapshot.computedAt, aws: awsSync ?? null })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to refresh AWS cost." },
      { status: 400 }
    )
  }
}
