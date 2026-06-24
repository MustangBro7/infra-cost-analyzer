import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { connectCustomProvider } from "@/lib/customProviderApi"
import { CustomProviderError } from "@/lib/customProvider"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const body = (await request.json()) as { id?: string; secret?: string }
    if (!body.id) throw new CustomProviderError("id is required.")
    await connectCustomProvider(user.id, body.id, body.secret ?? "")
    return NextResponse.json({ status: "connected" })
  } catch (error) {
    if (error instanceof AuthRequiredError) return NextResponse.json({ error: error.message }, { status: 401 })
    if (error instanceof CustomProviderError) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save secret." }, { status: 400 })
  }
}
