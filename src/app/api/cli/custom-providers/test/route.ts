import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromCliToken } from "@/lib/localAuth"
import { testCustomProvider } from "@/lib/customProviderApi"
import { CustomProviderError } from "@/lib/customProvider"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromCliToken(request)
    const body = (await request.json()) as { definition?: unknown; id?: string; secret?: string }
    return NextResponse.json(await testCustomProvider(user.id, body))
  } catch (error) {
    if (error instanceof AuthRequiredError) return NextResponse.json({ error: error.message }, { status: 401 })
    if (error instanceof CustomProviderError) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ error: error instanceof Error ? error.message : "Test failed." }, { status: 400 })
  }
}
