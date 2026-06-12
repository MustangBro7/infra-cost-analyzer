import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { appendEvent, readWorkspace, upsertConnection } from "@/lib/localStore"
import { normalizeBillingExportTableId, queryGcpBillingExportCosts } from "@/lib/gcpClient"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function currentMonthPeriod() {
  const now = new Date()
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json()) as { table?: string }
    const rawTable = payload.table?.trim()
    if (!rawTable) throw new Error("Billing export table is required.")
    const tableId = normalizeBillingExportTableId(rawTable)

    const workspace = await readWorkspace(user.id)
    const gcp = workspace.connections.gcp
    if (!gcp?.accessToken || gcp.status !== "connected") {
      throw new Error("Connect Google Cloud before setting a billing export table.")
    }

    const rows = await queryGcpBillingExportCosts(gcp.accessToken, tableId, currentMonthPeriod())

    await upsertConnection(user.id, {
      ...gcp,
      lastVerifiedAt: new Date().toISOString(),
      lastError: null,
      metadata: {
        ...gcp.metadata,
        billingExportTable: tableId,
      },
    })
    await appendEvent(user.id, {
      provider: "gcp",
      level: "success",
      message: `Billing export table verified (${tableId}); ${rows.length} service rows found for the current month.`,
    })
    return NextResponse.json({ status: "ok", table: tableId, rowCount: rows.length })
  } catch (error) {
    const user = error instanceof AuthRequiredError ? null : await requireUserFromRequest(request).catch(() => null)
    if (user) {
      await appendEvent(user.id, {
        provider: "gcp",
        level: "error",
        message:
          error instanceof Error
            ? `Billing export setup failed: ${error.message}`
            : "Billing export setup failed.",
      })
    }
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to set billing export table." },
      { status: 400 }
    )
  }
}
