import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { appendEvent } from "@/lib/localStore"
import { connectVercelToken } from "@/lib/connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json()) as { token?: string; teamId?: string | null; slug?: string | null }
    const token = payload.token?.trim()
    if (!token) throw new Error("Vercel token is required.")
    const result = await connectVercelToken(user.id, token, payload.teamId ?? null, payload.slug ?? null)
    return NextResponse.json({ status: "connected", ...result })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    const user = await requireUserFromRequest(request).catch(() => null)
    if (user) {
      await appendEvent(user.id, {
        provider: "vercel",
        level: "error",
        message: error instanceof Error ? `Vercel connection failed: ${error.message}` : "Vercel connection failed.",
      })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect Vercel." },
      { status: 400 }
    )
  }
}
