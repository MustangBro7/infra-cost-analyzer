import { NextRequest, NextResponse } from "next/server"
import { normalizeDashboardLayout } from "@/lib/dashboardLayout"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { setDashboardLayout } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const body = (await request.json()) as { layout?: unknown }
    const layout = normalizeDashboardLayout(body.layout)
    await setDashboardLayout(user.id, layout)
    return NextResponse.json({ status: "saved", layout })
  } catch (error) {
    if (error instanceof AuthRequiredError) return NextResponse.json({ error: error.message }, { status: 401 })
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save layout." }, { status: 400 })
  }
}

