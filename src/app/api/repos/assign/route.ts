import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { setCostAssignment } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Manually assigns a billing line item to a repo (or clears it). Body:
 * { itemKey, target } where target is a repo full name, "__account__" to force
 * account-level, "__split_equal__" to split evenly, or null to clear.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json()) as { itemKey?: string; target?: string | null }
    const itemKey = payload.itemKey?.trim()
    if (!itemKey) throw new Error("A cost item key is required.")
    const target = typeof payload.target === "string" && payload.target.length > 0 ? payload.target : null
    const saved = await setCostAssignment(user.id, itemKey, target)
    return NextResponse.json({ ok: true, itemKey, target: saved })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to assign cost item." },
      { status: 400 }
    )
  }
}
