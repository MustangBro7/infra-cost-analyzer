import { NextResponse } from "next/server"
import { NextRequest } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { publicStore } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    return NextResponse.json({ user, ...(await publicStore(user.id)) })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    throw error
  }
}
