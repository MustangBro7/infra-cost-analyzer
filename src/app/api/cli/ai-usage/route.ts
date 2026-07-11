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
    const limits = Array.isArray(body.limits) ? (body.limits as Array<Record<string, unknown>>) : null
    const normalizedModels = models.map((model) => ({
      model: String(model.model ?? "unknown"),
      inputTokens: num(model.inputTokens),
      cacheTokens: num(model.cacheTokens),
      outputTokens: num(model.outputTokens),
      estimatedApiUsd: num(model.estimatedApiUsd),
      inputUsd: num(model.inputUsd),
      cacheUsd: num(model.cacheUsd),
      outputUsd: num(model.outputUsd),
      rates: {
        inputPerMillion: num((model.rates as Record<string, unknown> | undefined)?.inputPerMillion),
        cachePerMillion: num((model.rates as Record<string, unknown> | undefined)?.cachePerMillion),
        cacheReadPerMillion:
          (model.rates as Record<string, unknown> | undefined)?.cacheReadPerMillion == null
            ? null
            : num((model.rates as Record<string, unknown> | undefined)?.cacheReadPerMillion),
        outputPerMillion: num((model.rates as Record<string, unknown> | undefined)?.outputPerMillion),
      },
    }))
    const totals = normalizedModels.reduce(
      (acc, model) => ({
        inputTokens: acc.inputTokens + model.inputTokens,
        cacheTokens: acc.cacheTokens + model.cacheTokens,
        outputTokens: acc.outputTokens + model.outputTokens,
        estimatedApiUsd: acc.estimatedApiUsd + model.estimatedApiUsd,
        inputUsd: acc.inputUsd + model.inputUsd,
        cacheUsd: acc.cacheUsd + model.cacheUsd,
        outputUsd: acc.outputUsd + model.outputUsd,
      }),
      { inputTokens: 0, cacheTokens: 0, outputTokens: 0, estimatedApiUsd: 0, inputUsd: 0, cacheUsd: 0, outputUsd: 0 }
    )
    if (totals.inputTokens + totals.outputTokens === 0) {
      return NextResponse.json({ error: "No usage found in local logs for the current month." }, { status: 400 })
    }
    const payload: AiLocalUsagePayload = {
      month: typeof body.month === "string" ? body.month : new Date().toISOString().slice(0, 7),
      subscriptionUsd: num(body.subscriptionUsd),
      planLabel: typeof body.planLabel === "string" ? body.planLabel : null,
      toolLabel: typeof body.toolLabel === "string" ? body.toolLabel : undefined,
      ...(limits
        ? {
            limits: limits.map((limit) => ({
              label: String(limit.label ?? "Usage limit"),
              used: limit.used == null ? null : num(limit.used),
              limit: limit.limit == null ? null : num(limit.limit),
              unit: typeof limit.unit === "string" && limit.unit.trim() ? limit.unit : "units",
              period: typeof limit.period === "string" && limit.period.trim() ? limit.period : "period",
              resetsAt: typeof limit.resetsAt === "string" ? limit.resetsAt : null,
            })),
          }
        : {}),
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
