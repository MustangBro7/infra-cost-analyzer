import { NextRequest, NextResponse } from "next/server"
import { pollCliPairing } from "@/lib/cliPairing"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Step 4: the CLI polls with its deviceCode until the user approves, then
// receives the short-lived cliToken. No Clerk session — the deviceCode is the
// secret, and only the matching pairing can yield its token.
export async function POST(request: NextRequest) {
  const { deviceCode } = (await request.json().catch(() => ({}))) as { deviceCode?: string }
  if (!deviceCode) {
    return NextResponse.json({ error: "deviceCode is required." }, { status: 400 })
  }
  const result = await pollCliPairing(deviceCode)
  return NextResponse.json(result)
}
