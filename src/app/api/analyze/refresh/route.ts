import { NextRequest, NextResponse } from "next/server"
import { refreshAnalysisSnapshot } from "@/lib/analysisService"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { readWorkspace } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const body = (await request.json().catch(() => ({}))) as { repo?: string | null }
    const workspace = await readWorkspace(user.id)
    const snapshot = await refreshAnalysisSnapshot({
      userId: user.id,
      requestedRepo: body.repo ?? null,
      githubRepos: workspace.githubRepos,
    })
    return NextResponse.json({
      key: snapshot.key,
      computedAt: snapshot.computedAt,
      totalCost: snapshot.analysis.summary.totalCost,
      liveSync: snapshot.analysis.liveSync,
      analytics: snapshot.analytics,
    })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to refresh analysis." },
      { status: 400 }
    )
  }
}
