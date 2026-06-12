import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { removeConnection } from "@/lib/localStore"
import type { Provider } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const ALLOWED = new Set<Provider>(["github", "vercel", "aws", "gcp", "azure", "cloudflare", "digitalocean", "docker"])

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json()) as { provider?: Provider }
    if (!payload.provider || !ALLOWED.has(payload.provider)) {
      return NextResponse.json({ error: "Valid provider is required." }, { status: 400 })
    }
    await removeConnection(user.id, payload.provider)
    return NextResponse.json({ status: "disconnected", provider: payload.provider })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    throw error
  }
}
