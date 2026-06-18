import { NextRequest, NextResponse } from "next/server"
import { getAnalyticsTrends } from "@/lib/analytics/queries"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const from = request.nextUrl.searchParams.get("from") ?? ""
    const to = request.nextUrl.searchParams.get("to") ?? ""
    const repo = request.nextUrl.searchParams.get("repo")
    return NextResponse.json(await getAnalyticsTrends({ userId: user.id, from, to, repo }))
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    const message = error instanceof Error ? error.message : "Failed to query historical analytics."
    const status = /disabled|configured/i.test(message) ? 503 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
