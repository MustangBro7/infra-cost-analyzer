import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { updateCustomProvider } from "@/lib/customProviderApi"
import { CustomProviderError } from "@/lib/customProvider"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const body = (await request.json()) as { id?: string; definition?: unknown }
    if (!body.id) throw new CustomProviderError("id is required.")
    const def = await updateCustomProvider(user.id, body.id, body.definition)
    return NextResponse.json({ status: "updated", provider: def })
  } catch (error) {
    if (error instanceof AuthRequiredError) return NextResponse.json({ error: error.message }, { status: 401 })
    if (error instanceof CustomProviderError) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to update provider." }, { status: 400 })
  }
}
