import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromCliToken } from "@/lib/localAuth"
import { publicStore } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Returns only safe connection metadata. Provider credentials remain server-side.
export async function GET(request: NextRequest) {
  try {
    const user = await requireUserFromCliToken(request)
    const state = await publicStore(user.id)
    return NextResponse.json({ connections: state.connections })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load provider connections." },
      { status: 400 }
    )
  }
}

