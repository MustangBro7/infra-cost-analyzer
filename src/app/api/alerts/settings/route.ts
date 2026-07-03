import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { readWorkspace, setAlertSettings } from "@/lib/localStore"
import { normalizeAlertSettings } from "@/lib/alerts"
import { workspacePlan } from "@/lib/plan"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const workspace = await readWorkspace(user.id)
    return NextResponse.json({
      plan: workspacePlan(workspace),
      email: user.email,
      settings: normalizeAlertSettings(workspace.alertSettings),
    })
  } catch (error) {
    if (error instanceof AuthRequiredError) return NextResponse.json({ error: error.message }, { status: 401 })
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load alert settings." }, { status: 400 })
  }
}

// Saves alert preferences. Settings persist on any plan; delivery itself is
// gated to Indie at send time, so an upgrade starts alerting without re-setup.
export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const body = (await request.json()) as { enabled?: boolean; digest?: "weekly" | "off" }
    const saved = await setAlertSettings(user.id, normalizeAlertSettings(body))
    return NextResponse.json({ status: "saved", settings: saved })
  } catch (error) {
    if (error instanceof AuthRequiredError) return NextResponse.json({ error: error.message }, { status: 401 })
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save alert settings." }, { status: 400 })
  }
}
