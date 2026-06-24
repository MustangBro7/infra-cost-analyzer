import { NextRequest, NextResponse } from "next/server"
import { AuthRequiredError, requireUserFromCliToken } from "@/lib/localAuth"
import { recordAiLocalUsage, type AiLocalUsagePayload } from "@/lib/connectors"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const PROVIDERS = new Set(["anthropic", "openai", "cursor"])

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

// Receives AI usage the companion CLI parsed from local Claude Code / Codex logs
// (cliToken auth). Defensively normalizes the payload before persisting.
export async function POST(request: NextRequest) {
  try {
    const user = await requireUserFromCliToken(request)
    const body = (await request.json()) as Record<string, unknown>
    const provider = String(body.provider ?? "")
    if (!PROVIDERS.has(provider)) {
      return NextResponse.json({ error: "provider must be anthropic, openai, or cursor." }, { status: 400 })
    }
    const models = Array.isArray(body.models) ? (body.models as Array<Record<string, unknown>>) : []
    const normalizedModels = models.map((model) => ({
      model: String(model.model ?? "unknown"),
      inputTokens: num(model.inputTokens),
      cacheTokens: num(model.cacheTokens),
      outputTokens: num(model.outputTokens),
      estimatedApiUsd: num(model.estimatedApiUsd),
    }))
    const totals = normalizedModels.reduce(
      (acc, model) => ({
        inputTokens: acc.inputTokens + model.inputTokens,
        cacheTokens: acc.cacheTokens + model.cacheTokens,
        outputTokens: acc.outputTokens + model.outputTokens,
        estimatedApiUsd: acc.estimatedApiUsd + model.estimatedApiUsd,
      }),
      { inputTokens: 0, cacheTokens: 0, outputTokens: 0, estimatedApiUsd: 0 }
    )
    if (totals.inputTokens + totals.outputTokens === 0) {
      return NextResponse.json({ error: "No usage found in local logs for the current month." }, { status: 400 })
    }
    const payload: AiLocalUsagePayload = {
      month: typeof body.month === "string" ? body.month : new Date().toISOString().slice(0, 7),
      subscriptionUsd: num(body.subscriptionUsd),
      planLabel: typeof body.planLabel === "string" ? body.planLabel : null,
      toolLabel: typeof body.toolLabel === "string" ? body.toolLabel : undefined,
      models: normalizedModels,
      totals,
    }
    const result = await recordAiLocalUsage(user.id, provider as "anthropic" | "openai" | "cursor", payload)
    return NextResponse.json({ status: "recorded", ...result, totals })
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 401 })
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to record usage." }, { status: 400 })
  }
}
