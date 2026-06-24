import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromCliToken } from "@/lib/localAuth"
import { createCustomProvider, listCustomProvidersForUser } from "@/lib/customProviderApi"
import { CustomProviderError } from "@/lib/customProvider"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Agent-facing custom provider management (cliToken auth). Lets a paired AI
// coding agent register a new hosting provider connector for its user without a
// code deploy. See GET /api/extend/spec for the manifest schema + examples.
export async function GET(request: NextRequest) {
  try {
    const user = await requireUserFromCliToken(request)
    return NextResponse.json({ providers: await listCustomProvidersForUser(user.id) })
  } catch (error) {
    if (error instanceof AuthRequiredError) return NextResponse.json({ error: error.message }, { status: 401 })
    throw error
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromCliToken(request)
    const def = await createCustomProvider(user.id, await request.json())
    return NextResponse.json({ status: "created", provider: def })
  } catch (error) {
    if (error instanceof AuthRequiredError) return NextResponse.json({ error: error.message }, { status: 401 })
    if (error instanceof CustomProviderError) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to create provider." }, { status: 400 })
  }
}
