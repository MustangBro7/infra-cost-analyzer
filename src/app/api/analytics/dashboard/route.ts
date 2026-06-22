import { NextRequest, NextResponse } from "next/server"
import { getAnalyticsDashboard } from "@/lib/analytics/queries"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const from = request.nextUrl.searchParams.get("from") ?? ""
    const to = request.nextUrl.searchParams.get("to") ?? ""
    const month = request.nextUrl.searchParams.get("month") ?? ""
    const repo = request.nextUrl.searchParams.get("repo")
    const result = await getAnalyticsDashboard({ userId: user.id, from, to, month, repo })
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
      },
    })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    const message = error instanceof Error ? error.message : "Failed to query historical analytics."
    const status = /disabled|configured/i.test(message) ? 503 : 400
    return NextResponse.json({ error: message }, { status })
  }
}
