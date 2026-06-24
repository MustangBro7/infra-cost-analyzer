import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { setMonthlyBudget } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Sets or clears the workspace monthly spend budget (USD). amount <= 0 / null clears.
export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const body = (await request.json()) as { amount?: number | null }
    const amount = typeof body.amount === "number" ? body.amount : null
    const saved = await setMonthlyBudget(user.id, amount)
    return NextResponse.json({ status: "saved", monthlyBudgetUsd: saved })
  } catch (error) {
    if (error instanceof AuthRequiredError) return NextResponse.json({ error: error.message }, { status: 401 })
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save budget." }, { status: 400 })
  }
}
