import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromCliToken } from "@/lib/localAuth"
import { connectCloudflareToken } from "@/lib/connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Cloudflare can't be minted from the CLI's OAuth session (no api_tokens scope),
// so the CLI collects a scoped token (env or one paste via the deep link) and
// posts it here; we verify + store via connectCloudflareToken. cliToken auth.
export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromCliToken(request)
    const body = (await request.json()) as { token?: string }
    const token = body.token?.trim()
    if (!token) throw new Error("token is required.")
    const result = await connectCloudflareToken(user.id, token)
    return NextResponse.json({ status: "connected", ...result })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect Cloudflare." },
      { status: 400 }
    )
  }
}
