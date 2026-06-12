import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { appendEvent } from "@/lib/localStore"
import { connectGcpKey } from "@/lib/connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json()) as { keyJson?: string; billingExportTable?: string }
    const keyJson = payload.keyJson?.trim()
    if (!keyJson) throw new Error("Google service account key JSON is required.")
    const result = await connectGcpKey(user.id, keyJson, payload.billingExportTable ?? null)
    return NextResponse.json({ status: "connected", ...result })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    const user = await requireUserFromRequest(request).catch(() => null)
    if (user) {
      await appendEvent(user.id, {
        provider: "gcp",
        level: "error",
        message: error instanceof Error ? `Google Cloud connection failed: ${error.message}` : "Google Cloud connection failed.",
      })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect Google Cloud." },
      { status: 400 }
    )
  }
}
