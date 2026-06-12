import { NextRequest, NextResponse } from "next/server"
import { clearSessionCookie, signOutSession } from "@/lib/localAuth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  await signOutSession(request)
  const response = NextResponse.json({ status: "signed_out" })
  clearSessionCookie(response)
  return response
}
