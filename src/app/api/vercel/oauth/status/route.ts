import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { vercelClientId, vercelOAuthConfigured, vercelRedirectUri } from "@/lib/vercelOAuth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  try {
    requireUserFromRequest(request)
    return NextResponse.json({
      configured: vercelOAuthConfigured(),
      hasClientId: Boolean(vercelClientId()),
      redirectUri: vercelRedirectUri(request.nextUrl.origin),
      missingEnv: vercelClientId() ? [] : ["NEXT_PUBLIC_VERCEL_APP_CLIENT_ID"],
    })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    throw error
  }
}
