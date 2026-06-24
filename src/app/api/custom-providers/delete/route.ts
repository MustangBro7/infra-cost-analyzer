import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { deleteCustomProvider } from "@/lib/customProviderApi"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const body = (await request.json()) as { id?: string }
    if (!body.id) return NextResponse.json({ error: "id is required." }, { status: 400 })
    await deleteCustomProvider(user.id, body.id)
    return NextResponse.json({ status: "deleted" })
  } catch (error) {
    if (error instanceof AuthRequiredError) return NextResponse.json({ error: error.message }, { status: 401 })
    throw error
  }
}
