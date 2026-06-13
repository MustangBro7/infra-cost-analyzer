import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { appendEvent } from "@/lib/localStore"
import { connectAwsLocal } from "@/lib/connectors"
import { listLocalAwsProfiles } from "@/lib/awsLocalCreds"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Reports which local AWS CLI profiles are available so the UI can offer them.
export async function GET(request: NextRequest) {
  try {
    await requireUserFromRequest(request)
    return NextResponse.json({ profiles: listLocalAwsProfiles() })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    // Filesystem not available (e.g. on Workers) — just report no profiles.
    return NextResponse.json({ profiles: [] })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json().catch(() => ({}))) as { profile?: string | null; costExplorer?: boolean }
    const result = await connectAwsLocal(user.id, payload.profile ?? null, { costExplorer: payload.costExplorer === true })
    return NextResponse.json({ status: "connected", ...result })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    const user = await requireUserFromRequest(request).catch(() => null)
    if (user) {
      await appendEvent(user.id, {
        provider: "aws",
        level: "error",
        message: error instanceof Error ? `AWS CLI connection failed: ${error.message}` : "AWS CLI connection failed.",
      })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect AWS from local CLI credentials." },
      { status: 400 }
    )
  }
}
