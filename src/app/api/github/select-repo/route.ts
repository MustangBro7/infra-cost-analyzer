import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromRequest } from "@/lib/localAuth"
import { readWorkspace, selectGitHubRepo, upsertConnection } from "@/lib/localStore"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromRequest(request)
    const payload = (await request.json()) as { fullName?: string }
    if (!payload.fullName) throw new Error("fullName is required.")
    await selectGitHubRepo(user.id, payload.fullName)
    const workspace = await readWorkspace(user.id)
    const github = workspace.connections.github
    if (github) {
      await upsertConnection(user.id, {
        ...github,
        selectedRepoFullName: payload.fullName,
        lastVerifiedAt: new Date().toISOString(),
      })
    }
    return NextResponse.json({ selectedRepoFullName: payload.fullName })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to select repo." },
      { status: 400 }
    )
  }
}
