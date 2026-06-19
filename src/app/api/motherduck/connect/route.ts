import { NextRequest, NextResponse } from "next/server"
import { connectMotherDuck } from "@/lib/connectors"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import type { MotherDuckPlan } from "@/lib/motherduckClient"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const body = (await request.json()) as { connectionString?: string; plan?: MotherDuckPlan }
    if (!body.connectionString?.trim()) throw new Error("MotherDuck PostgreSQL endpoint is required.")
    const result = await connectMotherDuck(user.id, body.connectionString, body.plan ?? "free")
    return NextResponse.json({ status: "connected", ...result })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect MotherDuck." },
      { status: 400 }
    )
  }
}
