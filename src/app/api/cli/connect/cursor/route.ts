import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromCliToken } from "@/lib/localAuth"
import { connectCursorKey } from "@/lib/connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromCliToken(request)
    const body = (await request.json()) as { key?: string }
    const key = body.key?.trim()
    if (!key) throw new Error("key is required.")
    const result = await connectCursorKey(user.id, key)
    return NextResponse.json({ status: "connected", ...result })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect Cursor." },
      { status: 400 }
    )
  }
}
