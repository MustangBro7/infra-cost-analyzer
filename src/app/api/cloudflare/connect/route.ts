import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { appendEvent } from "@/lib/localStore"
import { connectCloudflareToken } from "@/lib/connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json()) as { token?: string }
    const token = payload.token?.trim()
    if (!token) throw new Error("Cloudflare API token is required.")
    const result = await connectCloudflareToken(user.id, token)
    return NextResponse.json({ status: "connected", ...result })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    const user = await requireUserFromRequest(request).catch(() => null)
    if (user) {
      await appendEvent(user.id, {
        provider: "cloudflare",
        level: "error",
        message: error instanceof Error ? `Cloudflare connection failed: ${error.message}` : "Cloudflare connection failed.",
      })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect Cloudflare." },
      { status: 400 }
    )
  }
}
