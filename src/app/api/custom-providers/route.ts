import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { createCustomProvider, listCustomProvidersForUser } from "@/lib/customProviderApi"
import { CustomProviderError } from "@/lib/customProvider"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const providers = await listCustomProvidersForUser(user.id)
    return NextResponse.json({ providers })
  } catch (error) {
    if (error instanceof AuthRequiredError) return NextResponse.json({ error: error.message }, { status: 401 })
    throw error
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const body = await request.json()
    const def = await createCustomProvider(user.id, body)
    return NextResponse.json({ status: "created", provider: def })
  } catch (error) {
    if (error instanceof AuthRequiredError) return NextResponse.json({ error: error.message }, { status: 401 })
    if (error instanceof CustomProviderError) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to create provider." }, { status: 400 })
  }
}
