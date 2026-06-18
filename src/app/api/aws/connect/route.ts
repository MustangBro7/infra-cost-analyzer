import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { appendEvent } from "@/lib/localStore"
import { connectAwsKeys, connectAwsRole } from "@/lib/connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json()) as {
      roleArn?: string
      externalId?: string
      region?: string
      accessKeyId?: string
      secretAccessKey?: string
      sessionToken?: string | null
      costExplorer?: boolean
    }
    // Preferred one-click path: a read-only cross-account role (no stored keys).
    const roleArn = payload.roleArn?.trim()
    const externalId = payload.externalId?.trim()
    if (roleArn || externalId) {
      if (!roleArn || !externalId) {
        throw new Error("Both the role ARN and external ID are required for IAM role connect.")
      }
      const result = await connectAwsRole(
        user.id,
        { roleArn, externalId, region: payload.region?.trim() || undefined },
        { costExplorer: payload.costExplorer === true }
      )
      return NextResponse.json({ status: "connected", ...result })
    }
    // Advanced fallback: long-lived access keys.
    const accessKeyId = payload.accessKeyId?.trim()
    const secretAccessKey = payload.secretAccessKey?.trim()
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("Provide an IAM role ARN + external ID, or AWS access keys.")
    }
    const result = await connectAwsKeys(
      user.id,
      {
        accessKeyId,
        secretAccessKey,
        sessionToken: payload.sessionToken?.trim() || null,
      },
      { costExplorer: payload.costExplorer === true }
    )
    return NextResponse.json({ status: "connected", ...result })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    const user = await requireUserFromRequest(request).catch(() => null)
    if (user) {
      await appendEvent(user.id, {
        provider: "aws",
        level: "error",
        message: error instanceof Error ? `AWS connection failed: ${error.message}` : "AWS connection failed.",
      })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect AWS." },
      { status: 400 }
    )
  }
}
