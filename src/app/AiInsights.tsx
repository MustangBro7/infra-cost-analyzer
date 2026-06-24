"use client"

import * as React from "react"
import { ArrowUpRight, Boxes, Clock, Coins, Gauge, Layers, TrendingUp } from "lucide-react"
import type { Provider } from "@/lib/types"
import { ProviderLogo } from "./ProviderLogo"

export interface AiModelStat {
  model: string
  inputTokens: number
  cacheTokens: number
  outputTokens: number
  totalTokens: number
  estimatedApiUsd: number
}

export interface AiToolData {
  provider: Provider
  label: string
  accountLabel: string | null
  source: "local" | "api" | "both" | null
  planLabel: string | null
  subscriptionCost: number
  apiCost: number
  totalCost: number
  apiValue: number
  inputTokens: number
  cacheTokens: number
  outputTokens: number
  totalTokens: number
  models: AiModelStat[]
  lastVerifiedAt: string | null
  usageUrl: string | null
}

const PROVIDER_COLOR: Partial<Record<Provider, string>> = {
  anthropic: "#d97757",
  openai: "#10a37f",
  cursor: "#3a3a44",
}
const color = (p: Provider) => PROVIDER_COLOR[p] ?? "#6d5bd0"
// Token-type colors (consistent across every chart).
const INPUT_C = "#4d8cf0"
const CACHE_C = "#b9a14a"
const OUTPUT_C = "#46a37b"

function money(value: number) {
  const abs = Math.abs(value)
  const digits = abs > 0 && abs < 1000 ? 2 : 0
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
}
function compact(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)
}
function timeAgo(iso: string | null) {
  if (!iso) return "never"
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return "never"
  const mins = Math.round(ms / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function TokenMixBar({ input, cache, output }: { input: number; cache: number; output: number }) {
  const total = input + cache + output
  if (total <= 0) return null
  const seg = (v: number) => `${Math.max((v / total) * 100, v > 0 ? 1.5 : 0)}%`
  return (
    <div className="ai-mix">
      <div className="ai-mix-bar" role="img" aria-label="Token mix">
        <span style={{ width: seg(input), background: INPUT_C }} title={`Input ${compact(input)}`} />
        <span style={{ width: seg(cache), background: CACHE_C }} title={`Cache ${compact(cache)}`} />
        <span style={{ width: seg(output), background: OUTPUT_C }} title={`Output ${compact(output)}`} />
      </div>
      <div className="ai-mix-legend">
        <span><i style={{ background: INPUT_C }} /> Input {compact(input)}</span>
        <span><i style={{ background: CACHE_C }} /> Cache {compact(cache)}</span>
        <span><i style={{ background: OUTPUT_C }} /> Output {compact(output)}</span>
      </div>
    </div>
  )
}

// One model row: bar length conveys total tokens (magnitude); inside, the bar is
// split into input/cache/output so composition is visible per model.
function ModelRow({ model, max }: { model: AiModelStat; max: number }) {
  const total = model.totalTokens || 1
  const magnitude = Math.max((model.totalTokens / max) * 100, 2)
  const share = (value: number) => `${(value / total) * 100}%`
  return (
    <div className="ai-model-row">
      <span className="ai-model-name" title={model.model}>{model.model}</span>
      <span className="ai-model-bar" aria-hidden title={`Input ${compact(model.inputTokens)} · Cache ${compact(model.cacheTokens)} · Output ${compact(model.outputTokens)}`}>
        <span className="ai-model-fill" style={{ width: `${magnitude}%` }}>
          <i style={{ width: share(model.inputTokens), background: INPUT_C }} />
          <i style={{ width: share(model.cacheTokens), background: CACHE_C }} />
          <i style={{ width: share(model.outputTokens), background: OUTPUT_C }} />
        </span>
      </span>
      <span className="ai-model-meta">{compact(model.totalTokens)} · {money(model.estimatedApiUsd)}</span>
    </div>
  )
}

export function AiInsights({ tools }: { tools: AiToolData[] }) {
  const [filter, setFilter] = React.useState<Provider | "all">("all")
  if (tools.length === 0) return null

  const shown = filter === "all" ? tools : tools.filter((tool) => tool.provider === filter)

  const totalCost = tools.reduce((sum, tool) => sum + tool.totalCost, 0)
  const totalValue = tools.reduce((sum, tool) => sum + tool.apiValue, 0)
  const totalSub = tools.reduce((sum, tool) => sum + tool.subscriptionCost, 0)
  const totalTokens = tools.reduce((sum, tool) => sum + tool.totalTokens, 0)
  const multiplier = totalSub > 0 && totalValue > 0 ? totalValue / totalSub : null

  // Top models by API-rate value across the filtered tools.
  const modelRows = shown
    .flatMap((tool) => tool.models.map((model) => ({ ...model, provider: tool.provider })))
    .filter((model) => model.estimatedApiUsd > 0 || model.totalTokens > 0)
    .sort((a, b) => b.estimatedApiUsd - a.estimatedApiUsd)
    .slice(0, 8)
  const modelMax = Math.max(...modelRows.map((model) => model.estimatedApiUsd), 0.01)

  return (
    <section className="insight-panel ai-insights" aria-label="AI coding tools">
      <div className="insight-panel-head">
        <div>
          <p>AI coding tools</p>
          <h2>
            {money(totalCost)} <span className="hero-sub">this month{multiplier ? ` · ${multiplier.toFixed(1)}× API value` : ""}</span>
          </h2>
        </div>
        <Boxes aria-hidden />
      </div>

      <div className="ai-kpis">
        <article><Coins aria-hidden /><span>Monthly spend</span><strong>{money(totalCost)}</strong><small>subscriptions + API</small></article>
        <article><TrendingUp aria-hidden /><span>Value at API rates</span><strong>{money(totalValue)}</strong><small>what your usage is worth</small></article>
        <article><Gauge aria-hidden /><span>Value multiple</span><strong>{multiplier ? `${multiplier.toFixed(1)}×` : "—"}</strong><small>value ÷ subscription</small></article>
        <article><Layers aria-hidden /><span>Tokens this month</span><strong>{compact(totalTokens)}</strong><small>across {tools.length} {tools.length === 1 ? "tool" : "tools"}</small></article>
      </div>

      <details className="widget-drilldown ai-drilldown">
        <summary>
          <span>
            <strong>Explore tool and model detail</strong>
            <small>Token mix, per-model usage, API-rate value, and official usage links.</small>
          </span>
          <ArrowUpRight aria-hidden />
        </summary>
        <div className="widget-drilldown-body">
          {tools.length > 1 ? (
            <div className="ai-filter" role="tablist" aria-label="Filter AI tools">
              <button type="button" className={filter === "all" ? "ai-filter-chip active" : "ai-filter-chip"} onClick={() => setFilter("all")}>
                All
              </button>
              {tools.map((tool) => (
                <button
                  key={tool.provider}
                  type="button"
                  className={filter === tool.provider ? "ai-filter-chip active" : "ai-filter-chip"}
                  onClick={() => setFilter(tool.provider)}
                >
                  <ProviderLogo provider={tool.provider} /> {tool.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="ai-card-grid">
            {shown.map((tool) => {
          const valueMult = tool.subscriptionCost > 0 && tool.apiValue > 0 ? tool.apiValue / tool.subscriptionCost : null
          const topModels = [...tool.models].sort((a, b) => b.totalTokens - a.totalTokens)
          const tokenMax = Math.max(...topModels.map((m) => m.totalTokens), 1)
          return (
            <article key={tool.provider} className="ai-card" style={{ borderTopColor: color(tool.provider) }}>
              <header className="ai-card-head">
                <ProviderLogo provider={tool.provider} />
                <div className="ai-card-id">
                  <span className="ai-card-title">
                    <strong>{tool.label}</strong>
                    {tool.planLabel ? <span className="plan-badge">{tool.planLabel}</span> : null}
                  </span>
                  <small>{tool.accountLabel ?? "Connected"}</small>
                </div>
                {tool.source ? <span className={`ai-source-tag ${tool.source}`}>{tool.source === "both" ? "sub + API" : tool.source === "api" ? "API" : "local"}</span> : null}
              </header>

              <div className="ai-card-amount">
                <b>{money(tool.totalCost)}</b>
                <span className="ai-card-sub">
                  {tool.subscriptionCost > 0 && tool.apiCost > 0.005
                    ? `${money(tool.subscriptionCost)} plan · ${money(tool.apiCost)} API`
                    : tool.apiCost > 0.005
                      ? "live API usage"
                      : tool.subscriptionCost > 0
                        ? "flat subscription"
                        : ""}
                </span>
                {valueMult ? (
                  <span className="ai-card-value">≈ {money(tool.apiValue)} value · {valueMult.toFixed(1)}×</span>
                ) : null}
              </div>

              <TokenMixBar input={tool.inputTokens} cache={tool.cacheTokens} output={tool.outputTokens} />

              {topModels.length > 0 ? (
                <div className="ai-models">
                  <div className="ai-models-head">By model · bar length = tokens, fill = input / cache / output</div>
                  {topModels.slice(0, 4).map((model) => (
                    <ModelRow key={model.model} model={model} max={tokenMax} />
                  ))}
                  {topModels.length > 4 ? (
                    <details className="ai-models-more">
                      <summary>{topModels.length - 4} more model{topModels.length - 4 === 1 ? "" : "s"}</summary>
                      {topModels.slice(4).map((model) => (
                        <ModelRow key={model.model} model={model} max={tokenMax} />
                      ))}
                    </details>
                  ) : null}
                </div>
              ) : null}

              <footer className="ai-card-foot">
                <span><Clock aria-hidden /> synced {timeAgo(tool.lastVerifiedAt)}</span>
                {tool.usageUrl ? (
                  <a href={tool.usageUrl} target="_blank" rel="noreferrer">
                    Official usage <ArrowUpRight aria-hidden />
                  </a>
                ) : null}
              </footer>
            </article>
              )
            })}
          </div>

          {modelRows.length > 0 ? (
            <div className="ai-topmodels">
              <div className="ai-topmodels-head">Top models by API-rate value</div>
              {modelRows.map((model) => (
                <div className="ai-topmodel-row" key={`${model.provider}-${model.model}`}>
                  <span className="ai-topmodel-label">
                    <ProviderLogo provider={model.provider} />
                    <span title={model.model}>{model.model}</span>
                  </span>
                  <span className="ai-topmodel-bar" aria-hidden>
                    <i style={{ width: `${Math.max((model.estimatedApiUsd / modelMax) * 100, 2)}%`, background: color(model.provider) }} />
                  </span>
                  <span className="ai-topmodel-meta">
                    <b>{money(model.estimatedApiUsd)}</b>
                    <small>{compact(model.totalTokens)} tok</small>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </details>
    </section>
  )
}
