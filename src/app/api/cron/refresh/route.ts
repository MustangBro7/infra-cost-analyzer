import { NextRequest, NextResponse } from "next/server"
import { createHash, timingSafeEqual } from "node:crypto"
import { refreshAllSnapshotsLiveData } from "@/lib/analysisService"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function secretMatches(provided: string | null, expected: string | undefined) {
  if (!provided || !expected) return false
  const providedDigest = createHash("sha256").update(provided).digest()
  const expectedDigest = createHash("sha256").update(expected).digest()
  return timingSafeEqual(providedDigest, expectedDigest)
}

/**
 * Background refresh of all users' snapshots, called by the separate cron
 * Worker. Authorized by a shared CRON_SECRET header (not a user session). Always
 * free-data only — Cost Explorer is never called here, so a schedule can't bill
 * any AWS account.
 */
export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET
  const provided = request.headers.get("x-cron-secret")
  if (!secretMatches(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    const result = await refreshAllSnapshotsLiveData()
    return NextResponse.json({ ok: true, ...result, refreshedAt: new Date().toISOString() })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Cron refresh failed." },
      { status: 500 }
    )
  }
}
