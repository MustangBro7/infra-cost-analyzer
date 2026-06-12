import { NextRequest, NextResponse } from "next/server"
import { currentUserFromRequest } from "@/lib/localAuth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  return NextResponse.json({ user: await currentUserFromRequest(request) })
}
