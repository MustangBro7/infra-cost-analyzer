import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { appendEvent } from "@/lib/localStore"
import { connectAnthropicKey } from "@/lib/connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json()) as { key?: string }
    const key = payload.key?.trim()
    if (!key) throw new Error("Anthropic Admin API key is required.")
    const result = await connectAnthropicKey(user.id, key)
    return NextResponse.json({ status: "connected", ...result })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    const user = await requireUserFromRequest(request).catch(() => null)
    if (user) {
      await appendEvent(user.id, {
        provider: "anthropic",
        level: "error",
        message: error instanceof Error ? `Claude connection failed: ${error.message}` : "Claude connection failed.",
      })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect Claude." },
      { status: 400 }
    )
  }
}
