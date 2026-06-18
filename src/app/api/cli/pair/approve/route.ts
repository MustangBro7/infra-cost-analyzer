import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { approveCliPairing } from "@/lib/cliPairing"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Step 3: the signed-in user approves a pairing by typing its userCode. This is
// the one Clerk-protected CLI endpoint — it binds the pairing to this user.
export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const { userCode } = (await request.json()) as { userCode?: string }
    if (!userCode?.trim()) throw new Error("A pairing code is required.")
    await approveCliPairing(userCode, user.id)
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to approve pairing." },
      { status: 400 }
    )
  }
}
