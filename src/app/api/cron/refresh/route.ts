import { NextRequest, NextResponse } from "next/server"
import { refreshAllSnapshotsLiveData } from "@/lib/analysisService"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Background refresh of all users' snapshots, called by the separate cron
 * Worker. Authorized by a shared CRON_SECRET header (not a user session). Always
 * free-data only — Cost Explorer is never called here, so a schedule can't bill
 * any AWS account.
 */
export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET
  const provided = request.headers.get("x-cron-secret")
  if (!expected || !provided || provided !== expected) {
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
