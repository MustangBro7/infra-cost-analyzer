import { NextRequest, NextResponse } from "next/server"
import { createCliPairing } from "@/lib/cliPairing"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Step 1 of the device-code flow: the CLI requests a pairing. No auth — the
// resulting codes are useless until a signed-in user approves the userCode.
export async function POST(request: NextRequest) {
  const pairing = await createCliPairing()
  const verificationUrl = new URL("/pair", request.nextUrl.origin).toString()
  return NextResponse.json({ ...pairing, verificationUrl })
}
