import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { setRepoProviderLinks } from "@/lib/localStore"
import { CONNECTABLE_PROVIDERS } from "@/lib/repoLinks"
import type { Provider } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Sets which connected provider accounts a repo is linked to, so the repo view
 * filters cost/usage to just those accounts. Body: { repo, providers }.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json()) as { repo?: string; providers?: unknown }
    const repo = payload.repo?.trim()
    if (!repo) throw new Error("A repo full name is required.")
    const allowed = new Set<Provider>(CONNECTABLE_PROVIDERS)
    const providers = Array.isArray(payload.providers)
      ? (payload.providers.filter((value): value is Provider => typeof value === "string" && allowed.has(value as Provider)))
      : []
    const saved = await setRepoProviderLinks(user.id, repo, providers)
    return NextResponse.json({ ok: true, repo, providers: saved })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update repo accounts." },
      { status: 400 }
    )
  }
}
