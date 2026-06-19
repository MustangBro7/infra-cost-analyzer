import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { appendEvent } from "@/lib/localStore"
import { appUrl } from "@/lib/appUrl"
import {
  oauthCookieOptions,
  pkceChallenge,
  randomOAuthString,
  vercelClientId,
  vercelOAuthConfigured,
  vercelOAuthCookies,
  vercelRedirectUri,
} from "@/lib/vercelOAuth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  let user
  try {
    user = await requireUserFromRequest(request)
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.redirect(appUrl("/?auth=required", request.nextUrl.origin))
    }
    throw error
  }
  const clientId = vercelClientId()
  if (!vercelOAuthConfigured() || !clientId) {
    await appendEvent(user.id, {
      provider: "vercel",
      level: "warning",
      message: "Vercel OAuth requested, but NEXT_PUBLIC_VERCEL_APP_CLIENT_ID is not configured.",
    })
    return NextResponse.redirect(appUrl("/?connect_error=vercel_oauth_not_configured", request.nextUrl.origin))
  }

  const state = `${user.id}.${randomOAuthString()}`
  const nonce = randomOAuthString()
  const verifier = randomOAuthString(48)
  const redirectUri = vercelRedirectUri(request.nextUrl.origin)
  const authorizationUrl = new URL("https://vercel.com/oauth/authorize")
  authorizationUrl.searchParams.set("client_id", clientId)
  authorizationUrl.searchParams.set("redirect_uri", redirectUri)
  authorizationUrl.searchParams.set("response_type", "code")
  authorizationUrl.searchParams.set("scope", "openid email profile offline_access")
  authorizationUrl.searchParams.set("state", state)
  authorizationUrl.searchParams.set("nonce", nonce)
  authorizationUrl.searchParams.set("code_challenge", pkceChallenge(verifier))
  authorizationUrl.searchParams.set("code_challenge_method", "S256")

  const response = NextResponse.redirect(authorizationUrl)
  const cookieOptions = oauthCookieOptions(request)
  response.cookies.set(vercelOAuthCookies.state, state, cookieOptions)
  response.cookies.set(vercelOAuthCookies.nonce, nonce, cookieOptions)
  response.cookies.set(vercelOAuthCookies.verifier, verifier, cookieOptions)
  await appendEvent(user.id, {
    provider: "vercel",
    level: "info",
    message: "Started Vercel OAuth authorization.",
  })
  return response
}
