import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { setAwsCostExplorer, setAwsCostExplorerInterval } from "@/lib/connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json().catch(() => ({}))) as { enabled?: boolean; interval?: string }
    const result: Record<string, unknown> = {}
    if (typeof payload.enabled === "boolean") {
      Object.assign(result, await setAwsCostExplorer(user.id, payload.enabled))
    }
    if (typeof payload.interval === "string") {
      Object.assign(result, await setAwsCostExplorerInterval(user.id, payload.interval))
    }
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
