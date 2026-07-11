import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { readAiSyncState } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Lightweight change token polled by the AI page while it is visible. */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const state = await readAiSyncState(user.id)
    return NextResponse.json(state, {
      headers: { "cache-control": "private, no-store, max-age=0" },
    })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read AI sync state." },
      { status: 500 }
    )
  }
}
