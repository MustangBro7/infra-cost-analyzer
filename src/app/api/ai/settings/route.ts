import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { setAiSettings } from "@/lib/connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const PROVIDERS = new Set(["anthropic", "openai", "cursor"])

// Sets AI display settings: monthly subscription price (e.g. $200 Claude Max /
// ChatGPT Pro), plan label, and whether to also surface live API cost/usage.
export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const body = (await request.json()) as {
      provider?: string
      subscriptionUsd?: number
      planLabel?: string | null
      showApi?: boolean
    }
    if (!body.provider || !PROVIDERS.has(body.provider)) {
      return NextResponse.json({ error: "Valid AI provider is required." }, { status: 400 })
    }
    await setAiSettings(user.id, body.provider as "anthropic" | "openai" | "cursor", {
      subscriptionUsd: body.subscriptionUsd,
      planLabel: body.planLabel,
      showApi: body.showApi,
    })
    return NextResponse.json({ status: "saved" })
  } catch (error) {
    if (error instanceof AuthRequiredError) return NextResponse.json({ error: error.message }, { status: 401 })
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save settings." }, { status: 400 })
  }
}
