import { NextRequest, NextResponse } from "next/server"
import { randomBytes } from "node:crypto"
import { AuthRequiredError, requireUserFromCliToken } from "@/lib/localAuth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// The CLI fetches the trust parameters for the read-only role it will create: the
// SaaS principal's account id (which the role trusts) and a fresh, server-owned
// ExternalId (confused-deputy guard). The CLI bakes both into the role, then
// calls /api/cli/connect/aws with the same values.
export async function GET(request: NextRequest) {
  try {
    await requireUserFromCliToken(request)
    const trustedAccountId = process.env.AWS_SAAS_ACCOUNT_ID
    if (!trustedAccountId) {
      throw new Error("AWS SaaS principal account is not configured (AWS_SAAS_ACCOUNT_ID).")
    }
    return NextResponse.json({
      trustedAccountId,
      externalId: randomBytes(16).toString("hex"),
      roleName: "ambrium-cost-readonly",
      // Kept in sync with infra/aws-cost-readonly.cfn.yaml.
      permissions: [
        "ce:GetCostAndUsage",
        "ce:GetCostForecast",
        "ce:GetDimensionValues",
        "ce:GetTags",
        "freetier:GetFreeTierUsage",
      ],
    })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to issue AWS params." },
      { status: 400 }
    )
  }
}
