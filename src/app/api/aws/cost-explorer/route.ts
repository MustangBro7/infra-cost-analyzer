import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { setAwsCostExplorer } from "@/lib/connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json().catch(() => ({}))) as { enabled?: boolean }
    const result = await setAwsCostExplorer(user.id, payload.enabled === true)
    return NextResponse.json({ status: "ok", ...result })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update AWS cost setting." },
      { status: 400 }
    )
  }
}
