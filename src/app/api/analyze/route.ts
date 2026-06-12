import { NextRequest, NextResponse } from "next/server"
import { buildAnalysisWithLiveData } from "@/lib/costEngine"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { scanRepositorySafe } from "@/lib/repoScanner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const repoPath = request.nextUrl.searchParams.get("repoPath")
    const scan = scanRepositorySafe(repoPath)
    return NextResponse.json(await buildAnalysisWithLiveData(scan, process.env, user.id))
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
