import { NextRequest, NextResponse } from "next/server"
import { setSessionCookie, signInLocalUser } from "@/lib/localAuth"
import { autoConnectFromEnv } from "@/lib/connectors"
import { appendEvent } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const payload = (await request.json()) as { email?: string; name?: string | null }
    const { user, session } = await signInLocalUser({
      email: payload.email ?? "",
      name: payload.name ?? null,
    })

    // Zero-effort onboarding: connect every provider that has credentials
    // available (local repo scan, or tokens in server env vars).
    const outcomes = await autoConnectFromEnv(user.id)
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        await appendEvent(user.id, {
          provider: "system",
          level: "warning",
          message: `Auto-connect for ${outcome.provider} failed: ${outcome.detail}`,
        })
      }
    }

    const response = NextResponse.json({
      user,
      autoConnected: outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.provider),
    })
    setSessionCookie(response, session.id)
    return response
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to sign in." },
      { status: 400 }
    )
  }
}
