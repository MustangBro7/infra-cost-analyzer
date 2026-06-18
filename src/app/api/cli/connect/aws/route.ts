import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromCliToken } from "@/lib/localAuth"
import { connectAwsRole } from "@/lib/connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Final step: the CLI reports the role it created; we verify by assuming it (via
// connectAwsRole -> assumeAwsRole) and store {roleArn, externalId} on the paired
// user's workspace. Same connector the UI uses — only the auth differs.
export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromCliToken(request)
    const body = (await request.json()) as {
      roleArn?: string
      externalId?: string
      region?: string
      costExplorer?: boolean
    }
    const roleArn = body.roleArn?.trim()
    const externalId = body.externalId?.trim()
    if (!roleArn || !externalId) {
      throw new Error("roleArn and externalId are required.")
    }
    const result = await connectAwsRole(
      user.id,
      { roleArn, externalId, region: body.region?.trim() || undefined },
      { costExplorer: body.costExplorer === true }
    )
    return NextResponse.json({ status: "connected", ...result })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to connect AWS." },
      { status: 400 }
    )
  }
}
