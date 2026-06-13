import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { appendEvent } from "@/lib/localStore"
import { connectAwsKeys } from "@/lib/connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json()) as {
      accessKeyId?: string
      secretAccessKey?: string
      sessionToken?: string | null
    }
    const accessKeyId = payload.accessKeyId?.trim()
    const secretAccessKey = payload.secretAccessKey?.trim()
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("AWS access key ID and secret access key are required.")
    }
    const result = await connectAwsKeys(user.id, {
      accessKeyId,
      secretAccessKey,
      sessionToken: payload.sessionToken?.trim() || null,
    })
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
