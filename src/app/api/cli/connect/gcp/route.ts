import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromCliToken } from "@/lib/localAuth"
import { connectGcpKey } from "@/lib/connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// The CLI provisions a read-only service account via gcloud and posts its key
// here; we verify + auto-discover the billing-export table via connectGcpKey
// (same path the UI uses). cliToken auth instead of a Clerk session.
export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromCliToken(request)
    const body = (await request.json()) as { keyJson?: string; billingExportTable?: string | null }
    const keyJson = body.keyJson?.trim()
    if (!keyJson) throw new Error("keyJson is required.")
    const result = await connectGcpKey(user.id, keyJson, body.billingExportTable ?? null)
    return NextResponse.json({ status: "connected", ...result })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect Google Cloud." },
      { status: 400 }
    )
  }
}
