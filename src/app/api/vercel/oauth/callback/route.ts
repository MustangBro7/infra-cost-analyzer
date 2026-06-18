import { NextRequest, NextResponse } from "next/server"
import { appendEvent, upsertConnection } from "@/lib/localStore"
import {
  exchangeVercelAuthorizationCode,
  fetchVercelUserInfo,
  listVercelProjects,
  verifyVercelToken,
} from "@/lib/vercelClient"
import {
  vercelClientId,
  vercelClientSecret,
  vercelOAuthCookies,
  vercelRedirectUri,
} from "@/lib/vercelOAuth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: NextRequest) {
  const redirectHome = new URL("/dashboard?view=credentials", request.url)
  try {
    const code = request.nextUrl.searchParams.get("code")
    const state = request.nextUrl.searchParams.get("state")
    const storedState = request.cookies.get(vercelOAuthCookies.state)?.value
    const codeVerifier = request.cookies.get(vercelOAuthCookies.verifier)?.value
    const clientId = vercelClientId()
    if (!code) throw new Error("Vercel OAuth callback did not include a code.")
    if (!state || !storedState || state !== storedState) throw new Error("Vercel OAuth state mismatch.")
    const userId = state.split(".")[0]
    if (!userId) throw new Error("Vercel OAuth state did not include a user.")
    if (!codeVerifier) throw new Error("Missing Vercel OAuth PKCE verifier.")
    if (!clientId) throw new Error("NEXT_PUBLIC_VERCEL_APP_CLIENT_ID is not configured.")

    const token = await exchangeVercelAuthorizationCode({
      code,
      codeVerifier,
      redirectUri: vercelRedirectUri(request.nextUrl.origin),
      clientId,
      clientSecret: vercelClientSecret() ?? undefined,
    })

    const userInfo = await fetchVercelUserInfo(token.access_token)
    let accountLabel = userInfo.name || userInfo.username || userInfo.email || userInfo.sub || "Vercel account"
    let teams: Array<{ id: string; slug: string; name: string }> = []
    let projectCount = 0
    let linkedProjects: Array<Record<string, unknown>> = []
    let restApiStatus = "not_checked"

    try {
      const verified = await verifyVercelToken(token.access_token)
      accountLabel = verified.accountLabel || accountLabel
      teams = verified.teams.map((team) => ({ id: team.id, slug: team.slug, name: team.name }))
      const projects = await listVercelProjects(token.access_token)
      projectCount = projects.length
      linkedProjects = projects
        .filter((project) => project.link?.repo)
        .slice(0, 25)
        .map((project) => ({
          id: project.id,
          name: project.name,
          repo: project.link?.repo,
          org: project.link?.org,
          framework: project.framework,
        }))
      restApiStatus = "ok"
    } catch (error) {
      restApiStatus = error instanceof Error ? error.message : "Vercel REST API check failed."
      await appendEvent(userId, {
        provider: "vercel",
        level: "warning",
        message: `Vercel login succeeded, but REST API project check needs more permissions: ${restApiStatus}`,
      })
    }

    await upsertConnection(userId, {
      provider: "vercel",
      status: "connected",
      accountLabel,
      accessToken: token.access_token,
      connectedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
      lastError: null,
      metadata: {
        authMode: "oauth",
        scope: token.scope ?? null,
        expiresIn: token.expires_in ?? null,
        hasRefreshToken: Boolean(token.refresh_token),
        refreshToken: token.refresh_token ?? null,
        teams,
        projectCount,
        linkedProjects,
        restApiStatus,
      },
    })

    await appendEvent(userId, {
      provider: "vercel",
      level: "success",
      message: `Vercel OAuth completed for ${accountLabel}.`,
    })

    const response = NextResponse.redirect(redirectHome)
    response.cookies.delete(vercelOAuthCookies.state)
    response.cookies.delete(vercelOAuthCookies.nonce)
    response.cookies.delete(vercelOAuthCookies.verifier)
    return response
  } catch (error) {
    const userId = request.nextUrl.searchParams.get("state")?.split(".")[0]
    if (userId) await appendEvent(userId, {
      provider: "vercel",
      level: "error",
      message: error instanceof Error ? `Vercel OAuth failed: ${error.message}` : "Vercel OAuth failed.",
    })
    redirectHome.searchParams.set("connect_error", "vercel_oauth_failed")
    return NextResponse.redirect(redirectHome)
  }
}
