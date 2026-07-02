import {
  ArrowLeft,
  Boxes,
  CheckCircle2,
  ChevronDown,
  Coins,
  DatabaseZap,
  FolderGit2,
  Gauge,
  Layers,
  RefreshCw,
  ShieldAlert,
  Signal,
  Wallet,
} from "lucide-react"
import type { ReactNode } from "react"
import Link from "next/link"
import { redirect } from "next/navigation"
import { RepoSyncPanel } from "../RepoSyncPanel"
import { ProviderConnectPanel } from "../ProviderConnectPanel"
import { CustomProviderPanel } from "../CustomProviderPanel"
import { AiSyncPanel } from "../AiSyncPanel"
import { type AiToolData, type AiUsageLimit } from "../AiInsights"
import { BudgetForecast } from "../BudgetForecast"
import { RepoAccountPicker } from "../RepoAccountPicker"
import { ProviderCostPanel } from "../ProviderCostPanel"
import { ProviderResourcePanel } from "../ProviderResourcePanel"
import { AnalysisRefresher } from "../AnalysisRefresher"
import { ProviderLogo } from "../ProviderLogo"
import { SignOutButton } from "../SignOutButton"
import { HistoricalAnalyticsPanel } from "../HistoricalAnalyticsPanel"
import { UnassignedCostQueue, type AssignmentQueueItem } from "../UnassignedCostQueue"
import { ProjectsTable, type ProjectRowVM } from "./ProjectsTable"
import { CopyButton } from "./CopyButton"
import { DateRangePicker } from "./DateRangePicker"
import { getOrCreateAnalysisSnapshot, snapshotKeyForRepo } from "@/lib/analysisService"
import { getMonthlyTotalsByRepo, getRangeSpendSummary } from "@/lib/analytics/queries"
import type { RangeSpendSummary } from "@/lib/analytics/types"
import { currentMonthRange, pastMonthsOf, resolveDateRange, rowOverlapsRange, type ResolvedDateRange } from "@/lib/dateRange"
import { currentUserFromCookies } from "@/lib/localAuth"
import { publicStore, readDashboardStore } from "@/lib/localStore"
import { CONNECTABLE_PROVIDERS, resolveLinkedProviders } from "@/lib/repoLinks"
import { ACCOUNT_SENTINEL, SPLIT_EQUAL_SENTINEL, assignedCostRowForRepo, costItemKey, isAssignedHere, isKeyAssignedHere } from "@/lib/costAttribution"
import { resourceMetricService, resourceUsageRows } from "@/lib/freeTier"
import type { AnalysisResult, FreeTierUsageRow, GitHubRepoSummary, NormalizedCostRow, Provider, ProviderConnection, RepoSignal } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Indie-first app sections, selected by ?view=. Projects is the default product
// surface; old query values are accepted as aliases below for existing links.
type ViewKey = "projects" | "limits" | "leaks" | "ai" | "insights" | "connect"
type ConnectTabKey = "setup" | "connected" | "detected" | "credentials"

function money(value: number) {
  const abs = Math.abs(value)
  // Show cents for anything under $1,000 (and any non-whole amount above it) so
  // small real costs like $0.34 are never rounded away to "$0"; whole dollars
  // only for clean large numbers. One rule everywhere keeps amounts consistent.
  const fractionDigits = abs > 0 && (abs < 1000 || value % 1 !== 0) ? 2 : 0
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

function monthLabel(period: { from: string }) {
  const date = new Date(`${period.from}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return "this month"
  return date.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
}

// "April – June 2026" for a multi-month range, "June 2026" for one month.
function monthSpanLabel(range: ResolvedDateRange) {
  const first = monthLabel({ from: range.from })
  const last = monthLabel({ from: `${range.months[range.months.length - 1]}-01` })
  if (first === last) return first
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4)
  return `${sameYear ? first.split(" ")[0] : first} – ${last}`
}

/**
 * CRITICAL cost-reporting guard: only billing rows whose period overlaps the
 * current calendar month may count toward "this month". A snapshot computed in
 * a previous month (stale cache, carried-forward rows) keeps its own billing
 * periods, so without this clamp last month's spend would be reported as the
 * current month's. The period is normalized to the current month too, so
 * projections and labels always describe the month actually on screen.
 */
function clampAnalysisToCurrentMonth(analysis: AnalysisResult, month = currentMonthRange()): AnalysisResult {
  return {
    ...analysis,
    period: { from: month.from, to: month.to },
    costRows: analysis.costRows.filter((row) => rowOverlapsRange(row, month)),
  }
}

function providerName(provider: Provider) {
  if (provider === "gcp") return "Google Cloud"
  if (provider === "aws") return "AWS"
  if (provider === "anthropic") return "Claude"
  if (provider === "openai") return "OpenAI"
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

const PROVIDER_COLOR: Partial<Record<Provider, string>> = {
  aws: "#d79c22",
  cloudflare: "#b54035",
  gcp: "#285f9f",
  vercel: "#151515",
  motherduck: "#46a37b",
  azure: "#7152a5",
  anthropic: "#d97757",
  openai: "#10a37f",
  cursor: "#3a3a44",
  custom: "#6d5bd0",
}

// Providers tracked at the account level on the overview (hosting + AI tools).
// Custom (user-defined) providers are listed separately by id.
const AI_PROVIDERS: Provider[] = ["anthropic", "openai", "cursor"]
const AI_ROW_PATTERN = /\b(openai|anthropic|claude|chatgpt|codex|cursor|copilot|gemini|openrouter|llm|tokens?|prompts?|inference|lovable|bolt|replit)\b|\b(vertex\s+ai|workers\s+ai|ai\s+gateway|ai\s+sdk|vercel\s+ai|google\s+ai|model\s+usage)\b/i
const AWS_AI_ROW_PATTERN = /\b(bedrock|sagemaker|amazon\s+q|q\s+developer|rekognition|comprehend|textract|transcribe|translate|polly|lex|kendra)\b/i

function providerColor(provider: Provider) {
  return PROVIDER_COLOR[provider] ?? "#696459"
}

// Brand color + single-letter monogram for the redesigned UI's compact provider
// chips (the small squares in project stacks, breakdowns, and connect cards).
// Mirrors the palette from the Ambrium Dashboard design source.
const DESIGN_PROV: Partial<Record<Provider, { color: string; m: string }>> = {
  vercel: { color: "#7C3AED", m: "V" },
  cloudflare: { color: "#F6821F", m: "C" },
  aws: { color: "#E8920C", m: "A" },
  gcp: { color: "#3B82F6", m: "G" },
  azure: { color: "#0078D4", m: "A" },
  openai: { color: "#0E9E76", m: "O" },
  anthropic: { color: "#CC785C", m: "A" },
  cursor: { color: "#52525B", m: "C" },
  motherduck: { color: "#D69E00", m: "M" },
  github: { color: "#24292F", m: "G" },
  digitalocean: { color: "#0080FF", m: "D" },
  docker: { color: "#2496ED", m: "D" },
}

function provMono(provider: Provider, label?: string) {
  const known = DESIGN_PROV[provider]
  if (known) return known
  return { color: "#6E40C9", m: (label ?? provider).charAt(0).toUpperCase() }
}

const CONF_CHIP: Record<IndieProjectRow["confidence"], { label: string; color: string }> = {
  verified: { label: "Verified", color: "#0F9D63" },
  confirmed: { label: "Confirmed", color: "#C77B0A" },
  inferred: { label: "Inferred", color: "#9B9BA6" },
}

// Builds the design's 60×18 sparkline polyline from a real value series. Returns
// null below two points so the trend cell stays empty rather than faking a line.
function buildSparkline(values: number[]): string | null {
  if (values.length < 2) return null
  const w = 60
  const h = 18
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  return values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
    .join(" ")
}

// The real companion-CLI entrypoint — used by the Connect view's command boxes
// so the copy buttons hand back a working command.
const CLI_BASE = "AMBRIUM_API=https://ambrium.io npx --yes github:MustangBro7/infra-cost-analyzer"

function sumCost(rows: NormalizedCostRow[]) {
  return rows.reduce((sum, row) => sum + row.cost, 0)
}

// A "series" is one bar/legend entry. Built-in providers are keyed by provider;
// each custom (user-defined) provider gets its own series so they don't all
// collapse into a single "Custom" bucket.
function seriesKey(row: { provider: Provider; customProviderId?: string }) {
  return row.provider === "custom" && row.customProviderId ? `custom:${row.customProviderId}` : row.provider
}

function seriesLabel(row: { provider: Provider; customLabel?: string }) {
  if (row.provider === "custom") return row.customLabel ?? "Custom"
  return providerName(row.provider)
}

function breakdownByProvider(rows: NormalizedCostRow[]) {
  const totals = new Map<string, { key: string; provider: Provider; label: string; total: number }>()
  for (const row of rows) {
    const key = seriesKey(row)
    const existing = totals.get(key)
    if (existing) existing.total += row.cost
    else totals.set(key, { key, provider: row.provider, label: seriesLabel(row), total: row.cost })
  }
  return [...totals.values()]
    .filter((entry) => entry.total > 0.005)
    .sort((a, b) => b.total - a.total)
}

// Days into the billing period vs. its full length, so we can extrapolate a
// month-to-date total into a projected month-end spend on the current run rate.
function periodProgress(period: { from: string; to: string }) {
  const dayMs = 24 * 60 * 60 * 1000
  const start = new Date(`${period.from}T00:00:00Z`)
  const end = new Date(`${period.to}T00:00:00Z`)
  const now = new Date()
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const clamped = today < start ? start : today > end ? end : today
  const totalDays = Math.round((end.getTime() - start.getTime()) / dayMs) + 1
  const elapsedDays = Math.round((clamped.getTime() - start.getTime()) / dayMs) + 1
  return { elapsedDays, totalDays }
}

function currentRepoFullName(analysis: AnalysisResult) {
  return `${analysis.repo.owner}/${analysis.repo.name}`
}

function repoList(state: Awaited<ReturnType<typeof publicStore>>) {
  const synced = new Set(state.syncedRepoFullNames)
  return state.githubRepos.filter((repo) => synced.has(repo.fullName))
}

function providerSignals(provider: Provider, signals: RepoSignal[]) {
  return signals.filter((signal) => signal.provider === provider)
}

function providerRows(provider: Provider, rows: NormalizedCostRow[]) {
  return rows.filter((row) => row.provider === provider)
}

function providerFreeTier(provider: Provider, freeTier: FreeTierUsageRow[]) {
  return freeTier.filter((row) => row.provider === provider)
}

function quantity(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

function percentOf(value: number, total: number) {
  if (total <= 0) return "0%"
  return `${Math.round((value / total) * 100)}%`
}

function maybeMoney(value: number | null | undefined) {
  return value == null || value <= 0 ? "—" : money(value)
}

function limitUsageLabel(limit: AiUsageLimit) {
  const used = limit.used == null ? "—" : quantity(limit.used)
  const cap = limit.limit == null ? "—" : quantity(limit.limit)
  return `${used} / ${cap} ${limit.unit}`
}

function modelCostParts(model: AiToolData["models"][number]) {
  const known = (model.inputUsd ?? 0) + (model.cacheUsd ?? 0) + (model.outputUsd ?? 0)
  if (known > 0) {
    return {
      input: model.inputUsd ?? 0,
      cache: model.cacheUsd ?? 0,
      output: model.outputUsd ?? 0,
    }
  }
  const tokens = model.inputTokens + model.cacheTokens + model.outputTokens
  if (tokens <= 0 || model.estimatedApiUsd <= 0) return { input: 0, cache: 0, output: 0 }
  return {
    input: model.estimatedApiUsd * (model.inputTokens / tokens),
    cache: model.estimatedApiUsd * (model.cacheTokens / tokens),
    output: model.estimatedApiUsd * (model.outputTokens / tokens),
  }
}

type AccountEntry = {
  key: string
  provider: Provider
  label: string
  accountLabel: string | null
  cost: number
  hasUsage: boolean
}

type IndieProjectRow = {
  repo: GitHubRepoSummary
  cost: number
  projected: number
  dailyRate: number
  linked: Provider[]
  signalCount: number
  rowCount: number
  lastActivityAt: string | null
  inactiveDays: number | null
  status: "active" | "free" | "map" | "watch" | "stale"
  statusLabel: string
  detail: string
  breakdown: Array<{ provider: Provider; label: string; total: number }>
  stackProviders: Provider[]
  // Mapping confidence shown as a chip in the design: an explicit user-set
  // repo→account link is "confirmed"; an auto-resolved link (detected + a
  // connected account) is "verified"; signals only, no link, is "inferred".
  confidence: "verified" | "confirmed" | "inferred"
}

function daysSinceIso(value: string | null | undefined): number | null {
  if (!value) return null
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return null
  return Math.max(Math.floor((Date.now() - time) / 86_400_000), 0)
}

function projectCostRows(input: {
  repo: GitHubRepoSummary
  repoAnalysis: AnalysisResult | undefined
  accountAnalysis: AnalysisResult
  assignments: Record<string, string>
  splitAcross: number
}): NormalizedCostRow[] {
  const repoShortName = input.repo.name.toLowerCase()
  const candidateRows = [...(input.repoAnalysis?.costRows ?? []), ...input.accountAnalysis.costRows]
  const uniqueRows = [...new Map(candidateRows.map((row) => [costItemKey(row), row])).values()]
  return uniqueRows
    .map((row) => assignedCostRowForRepo(row, input.assignments, input.repo.fullName, repoShortName, input.splitAcross))
    .filter((row): row is NormalizedCostRow => Boolean(row))
}

function buildIndieProjects(input: {
  repos: GitHubRepoSummary[]
  analysis: AnalysisResult
  repoAnalyses: Record<string, AnalysisResult>
  connectedProviders: Provider[]
  state: Awaited<ReturnType<typeof publicStore>>
  elapsedDays: number
  totalDays: number
}): IndieProjectRow[] {
  return input.repos.map((repo) => {
    const repoAnalysis = input.repoAnalyses[repo.fullName]
    const detectedProviders = [...new Set((repoAnalysis?.signals ?? []).map((signal) => signal.provider))]
    const explicitLinks = input.state.repoProviderLinks[repo.fullName]
    const linked = resolveLinkedProviders({
      explicit: explicitLinks,
      detected: detectedProviders,
      connected: input.connectedProviders,
    })
    const rows = projectCostRows({
      repo,
      repoAnalysis,
      accountAnalysis: input.analysis,
      assignments: input.state.costAssignments,
      splitAcross: input.repos.length,
    })
    const cost = sumCost(rows)
    const breakdown = breakdownByProvider(rows).map((entry) => ({ provider: entry.provider, label: entry.label, total: entry.total }))
    const stackProviders =
      breakdown.length > 0
        ? [...new Set(breakdown.map((entry) => entry.provider))]
        : linked.length > 0
          ? linked
          : detectedProviders
    const dailyRate = input.elapsedDays > 0 ? cost / input.elapsedDays : 0
    const projected = dailyRate * input.totalDays
    const signalCount = repoAnalysis?.signals.length ?? 0
    const lastActivityAt = repo.pushedAt ?? repo.updatedAt ?? null
    const inactiveDays = daysSinceIso(lastActivityAt)
    const status: IndieProjectRow["status"] =
      cost > 0.005 && inactiveDays !== null && inactiveDays >= 45
        ? "stale"
        : cost > 0.005 && linked.length === 0
        ? "map"
        : projected >= 10 && projected > cost * 1.8
          ? "watch"
          : cost > 0.005
            ? "active"
            : "free"
    const statusLabel =
      status === "stale"
        ? "Shutdown?"
        : status === "map"
          ? "Map accounts"
          : status === "watch"
            ? "Watch spend"
            : status === "active"
              ? "Costing now"
              : "Free/quiet"
    const detail =
      linked.length > 0
        ? `${linked.length} ${linked.length === 1 ? "account" : "accounts"} linked · ${inactiveDays !== null ? `${inactiveDays}d since push` : `${signalCount} ${signalCount === 1 ? "signal" : "signals"}`}`
        : signalCount > 0
          ? `${signalCount} ${signalCount === 1 ? "signal" : "signals"} found · pick accounts`
          : cost > 0.005
            ? "Assigned spend with no repo evidence"
            : "No assigned spend this month"
    const confidence: IndieProjectRow["confidence"] =
      Array.isArray(explicitLinks) && explicitLinks.length > 0
        ? "confirmed"
        : linked.length > 0
          ? "verified"
          : "inferred"
    return { repo, cost, projected, dailyRate, linked, signalCount, rowCount: rows.length, lastActivityAt, inactiveDays, status, statusLabel, detail, breakdown, stackProviders, confidence }
  }).sort((a, b) => b.cost - a.cost || b.signalCount - a.signalCount || a.repo.name.localeCompare(b.repo.name))
}

interface LeakCandidate {
  id: string
  severity: "crit" | "warn" | "info"
  title: string
  detail: string
  amount?: number
}

function buildLeakCandidates(input: {
  analysis: AnalysisResult
  projects: IndieProjectRow[]
  assignments: Record<string, string>
  syncedRepoFullNames: string[]
  latestMs: number | null
}): LeakCandidate[] {
  const leaks: LeakCandidate[] = []
  const synced = new Set(input.syncedRepoFullNames)
  const accountLevelRows = input.analysis.costRows.filter((row) => {
    const assigned = input.assignments[costItemKey(row)]
    if (assigned && synced.has(assigned)) return false
    return !row.attributedRepo && row.cost > 0.005
  })
  const accountLevelTotal = sumCost(accountLevelRows)
  if (accountLevelTotal > 0.005) {
    leaks.push({
      id: "account-level",
      severity: "warn",
      title: "Spend is not mapped to a project",
      detail: `${accountLevelRows.length} billing ${accountLevelRows.length === 1 ? "row is" : "rows are"} still account-level. Assign these to a repo or mark them shared.`,
      amount: accountLevelTotal,
    })
  }

  const inferred = input.analysis.costRows.filter((row) => row.attribution === "inferred" && row.cost > 0.005)
  const inferredTotal = sumCost(inferred)
  if (inferredTotal > 0.005) {
    leaks.push({
      id: "inferred",
      severity: "info",
      title: "Some spend is inferred",
      detail: `${inferred.length} ${inferred.length === 1 ? "row needs" : "rows need"} confirmation so project totals stay trustworthy.`,
      amount: inferredTotal,
    })
  }

  for (const sync of input.analysis.liveSync.filter((entry) => entry.status === "error")) {
    leaks.push({
      id: `sync-${sync.provider}`,
      severity: "warn",
      title: `${providerName(sync.provider)} could not refresh`,
      detail: sync.message || "Run ambrium-connect doctor or reconnect the provider.",
    })
  }

  if (input.latestMs !== null && input.latestMs > 26 * 3_600_000) {
    leaks.push({
      id: "stale",
      severity: "info",
      title: "Cost data is getting stale",
      detail: `Last successful refresh was ${shortAge(new Date(Date.now() - input.latestMs).toISOString())}. Refresh or run the CLI from your project machine.`,
    })
  }

  for (const project of input.projects.filter((entry) => entry.cost > 0.005 && entry.linked.length === 0).slice(0, 3)) {
    leaks.push({
      id: `project-map-${project.repo.fullName}`,
      severity: "warn",
      title: `${project.repo.name} has spend but no linked account`,
      detail: "Link the provider account so Ambrium can keep this project total accurate.",
      amount: project.cost,
    })
  }

  for (const project of input.projects.filter((entry) => entry.status === "stale").slice(0, 4)) {
    leaks.push({
      id: `stale-project-${project.repo.fullName}`,
      severity: "warn",
      title: `${project.repo.name} may be safe to shut down`,
      detail: `${project.inactiveDays} days since the last GitHub push, but it still has assigned spend this month.`,
      amount: project.cost,
    })
  }

  const rank = { crit: 0, warn: 1, info: 2 }
  return leaks.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.amount ?? 0) - (a.amount ?? 0)).slice(0, 6)
}

// Every connected account shown on the overview: built-in hosting + AI tools
// (keyed by provider) plus each connected custom provider (keyed by id).
function accountEntries(analysis: AnalysisResult, state: Awaited<ReturnType<typeof publicStore>>): AccountEntry[] {
  const entries: AccountEntry[] = []
  for (const provider of [...CONNECTABLE_PROVIDERS, ...AI_PROVIDERS]) {
    if (state.connections[provider]?.status !== "connected") continue
    entries.push({
      key: provider,
      provider,
      label: providerName(provider),
      accountLabel: state.connections[provider]?.accountLabel ?? null,
      cost: sumCost(providerRows(provider, analysis.costRows)),
      hasUsage: providerFreeTier(provider, analysis.freeTier).some((row) => row.source === "measured"),
    })
  }
  for (const def of state.customProviders ?? []) {
    if (!def.connected) continue
    entries.push({
      key: `custom:${def.id}`,
      provider: "custom",
      label: def.name,
      accountLabel: def.accountLabel ?? null,
      cost: sumCost(analysis.costRows.filter((row) => row.customProviderId === def.id)),
      hasUsage: analysis.freeTier.some((row) => row.customProviderId === def.id && row.source === "measured"),
    })
  }
  return entries.sort((a, b) => b.cost - a.cost)
}

function FreeTierUsage({
  rows,
  hasCost,
  costDataOff = false,
  heading: headingOverride,
  subtext: subtextOverride,
}: {
  rows: FreeTierUsageRow[]
  hasCost: boolean
  costDataOff?: boolean
  heading?: string
  subtext?: string
}) {
  if (!rows.length) return null
  const planName = rows[0].planName
  const heading =
    headingOverride ??
    (costDataOff
      ? `Free-tier usage — ${planName}`
      : hasCost
        ? `Free-tier allowance — ${planName}`
        : `On the free tier — ${planName}`)
  const subtext =
    subtextOverride ??
    (costDataOff
      ? "Free-tier usage only. Spend is not pulled, so this is not your full cost."
      : hasCost
        ? "Live usage this period against each free allowance, shown alongside the billed cost above."
        : "No billed cost this period. Here is how much of the free allowance is left.")
  return (
    <div className="free-tier-block">
      <div className="free-tier-head">
        <Gauge aria-hidden />
        <div>
          <strong>{heading}</strong>
          <span>{subtext}</span>
        </div>
      </div>
      <div className="free-tier-list">
        {rows.map((row) => {
          const pct = row.percentUsed ?? 0
          // Three states: (a) allowance with no reported usage, (b) measured
          // usage with a known limit, (c) measured usage with no published limit.
          const unmetered = row.used !== null && row.limit === null
          return (
            <article key={`${row.provider}-${row.service}`} className="free-tier-row" title={row.note}>
              <div className="free-tier-row-head">
                <strong>{row.service}</strong>
                {row.used === null ? (
                  <span className="free-tier-allowance">{quantity(row.limit ?? 0)} {row.unit} included</span>
                ) : unmetered ? (
                  <span className="free-tier-measured">{quantity(row.used)} {row.unit} used</span>
                ) : (
                  <span className="free-tier-remaining">{quantity(row.remaining ?? 0)} {row.unit} left</span>
                )}
              </div>
              <div className="free-tier-bar" aria-hidden>
                <span
                  className={row.used === null || unmetered ? "free-tier-fill unknown" : "free-tier-fill"}
                  style={{ width: `${unmetered ? 100 : Math.max(pct, row.used === null ? 0 : 2)}%` }}
                />
              </div>
              <small>
                {row.used === null
                  ? `Usage not reported by provider · ${quantity(row.limit ?? 0)} ${row.unit} free`
                  : unmetered
                    ? `${quantity(row.used)} ${row.unit} used · no published free-tier limit`
                    : `${quantity(row.used)} of ${quantity(row.limit ?? 0)} ${row.unit} used (${pct}%)`}
              </small>
            </article>
          )
        })}
      </div>
    </div>
  )
}

// SVG donut of the provider cost split — a more scannable companion to the
// stacked bar/legend. Segments are drawn as stroke arcs on concentric circles,
// rotated so the first segment starts at 12 o'clock.
function ProviderDonut({
  breakdown,
  total,
}: {
  breakdown: Array<{ key: string; provider: Provider; label: string; total: number }>
  total: number
}) {
  const size = 132
  const stroke = 22
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  let offset = 0
  const segments = breakdown.map((entry) => {
    const fraction = total > 0 ? entry.total / total : 0
    const seg = { entry, dash: fraction * circumference, gap: circumference - fraction * circumference, dashOffset: -offset }
    offset += fraction * circumference
    return seg
  })
  const top = breakdown[0]
  const topPct = top && total > 0 ? Math.round((top.total / total) * 100) : 0

  return (
    <div className="cost-donut" role="img" aria-label="Cost split by provider">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--track)" strokeWidth={stroke} />
          {segments.map(({ entry, dash, gap, dashOffset }) => (
            <circle
              key={entry.key}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={providerColor(entry.provider)}
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${gap}`}
              strokeDashoffset={dashOffset}
            />
          ))}
        </g>
      </svg>
      <div className="cost-donut-center">
        <strong>{breakdown.length}</strong>
        <span>{breakdown.length === 1 ? "account" : "accounts"}</span>
        {top ? <small title={top.label}>{topPct}% {top.label}</small> : null}
      </div>
    </div>
  )
}

/**
 * Reusable headline cost surface: total up front, a single stacked bar split by
 * provider, and an aligned legend. Used for the account-wide Overview total and
 * for a single repo's filtered total — the caller passes the rows to include.
 */
function CostOverview({
  eyebrow,
  rows,
  measuredUsageCount,
  emptyNote,
  footnote,
}: {
  eyebrow: string
  rows: NormalizedCostRow[]
  measuredUsageCount: number
  emptyNote: string
  footnote?: ReactNode
}) {
  const total = sumCost(rows)
  const breakdown = breakdownByProvider(rows)

  return (
    <section className="cost-overview" aria-label="Cost overview">
      <div className="cost-overview-head">
        <div>
          <p>{eyebrow}</p>
          <h2>{money(total)}</h2>
          <span>
            {breakdown.length > 0
              ? `Live month-to-date spend across ${breakdown.length} ${breakdown.length === 1 ? "account" : "accounts"}.`
              : measuredUsageCount > 0
                ? `No billed spend — ${measuredUsageCount} live usage metric${measuredUsageCount === 1 ? "" : "s"} tracked.`
                : "No billed spend this month."}
          </span>
        </div>
        <span className="cost-overview-icon">
          <Wallet aria-hidden />
        </span>
      </div>

      {breakdown.length > 0 ? (
        <>
          <div className="cost-bar" role="img" aria-label="Cost split by provider">
            {breakdown.map((entry) => (
              <span
                key={entry.key}
                className="cost-bar-seg"
                style={{ width: `${Math.max((entry.total / total) * 100, 1.5)}%`, background: providerColor(entry.provider) }}
                title={`${entry.label} · ${money(entry.total)}`}
              />
            ))}
          </div>
          <div className="cost-split">
            {breakdown.length > 1 ? <ProviderDonut breakdown={breakdown} total={total} /> : null}
            <div className="cost-legend">
              {breakdown.map((entry) => {
                const pct = total > 0 ? Math.round((entry.total / total) * 100) : 0
                return (
                  <div key={entry.key} className="cost-legend-row">
                    <ProviderLogo provider={entry.provider} />
                    <strong>{entry.label}</strong>
                    <span className="cost-legend-bar" aria-hidden>
                      <i style={{ width: `${Math.max(pct, 2)}%`, background: providerColor(entry.provider) }} />
                    </span>
                    <span className="cost-legend-pct">{pct}%</span>
                    <b>{money(entry.total)}</b>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      ) : (
        <div className="cost-overview-empty">
          <Gauge aria-hidden />
          <span>{emptyNote}</span>
        </div>
      )}
      {footnote ? <div className="cost-footnote">{footnote}</div> : null}
    </section>
  )
}

function statusText(connection: ProviderConnection) {
  if (connection.status === "connected") return "Connected"
  if (connection.detected) return "Detected"
  if (connection.status === "setup_required") return "Needs billing connection"
  return "Not detected"
}

// Per-view header copy (title + one-line subtitle), mirrored from the design.
const VIEW_META: Record<ViewKey, { title: string; sub: string }> = {
  projects: { title: "Projects", sub: "What each app and side project is costing you this month" },
  limits: { title: "Free-tier runway", sub: "Measured usage vs. published limits on every $0 provider" },
  leaks: { title: "Leaks", sub: "Unmapped spend, inactive projects, and broken connections" },
  ai: { title: "AI spend", sub: "Model usage and subscriptions, broken out by tool" },
  insights: { title: "Insights", sub: "Budget, forecast, history, and account-wide usage" },
  connect: { title: "Connect", sub: "Read-only access to your providers — see costs, never touch infra" },
}

const NAV_ITEMS: Array<{ key: ViewKey; label: string; href: string; icon: ReactNode }> = [
  {
    key: "projects",
    label: "Projects",
    href: "/dashboard",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="1.8" y="1.8" width="5" height="5" rx="1.2" />
        <rect x="9.2" y="1.8" width="5" height="5" rx="1.2" />
        <rect x="1.8" y="9.2" width="5" height="5" rx="1.2" />
        <rect x="9.2" y="9.2" width="5" height="5" rx="1.2" />
      </svg>
    ),
  },
  {
    key: "limits",
    label: "Limits",
    href: "/dashboard?view=limits",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="1.8" y="5" width="12.4" height="6" rx="2" />
        <line x1="10.5" y1="3.4" x2="10.5" y2="12.6" />
      </svg>
    ),
  },
  {
    key: "leaks",
    label: "Leaks",
    href: "/dashboard?view=leaks",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M8 2 L14.5 13.5 L1.5 13.5 Z" strokeLinejoin="round" />
        <line x1="8" y1="6.2" x2="8" y2="9.4" />
        <circle cx="8" cy="11.4" r=".4" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: "ai",
    label: "AI",
    href: "/dashboard?view=ai",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M8 1.6 L9.4 6.6 L14.4 8 L9.4 9.4 L8 14.4 L6.6 9.4 L1.6 8 L6.6 6.6 Z" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: "insights",
    label: "Insights",
    href: "/dashboard?view=insights",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <line x1="2" y1="14" x2="14" y2="14" />
        <rect x="3" y="8" width="2.6" height="4" rx="0.6" />
        <rect x="6.8" y="5" width="2.6" height="7" rx="0.6" />
        <rect x="10.6" y="2.6" width="2.6" height="9.4" rx="0.6" />
      </svg>
    ),
  },
  {
    key: "connect",
    label: "Connect",
    href: "/dashboard?view=connect",
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="4.4" cy="8" r="2.4" />
        <circle cx="11.6" cy="8" r="2.4" />
        <line x1="6.8" y1="8" x2="9.2" y2="8" />
      </svg>
    ),
  },
]

function displayNameFromEmail(email: string) {
  const local = email.split("@")[0] ?? email
  const cleaned = local.replace(/[._-]+/g, " ").trim()
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || email
}

function Sidebar({
  view,
  leakCount,
  email,
  updatedLabel,
}: {
  view: ViewKey
  leakCount: number
  email: string
  updatedLabel: string
}) {
  const name = displayNameFromEmail(email)
  const initial = (name.charAt(0) || "A").toUpperCase()
  return (
    <aside className="amb-sidebar">
      <div className="amb-brand">
        <span className="amb-brand-mark" aria-hidden />
        <span className="amb-brand-name">Ambrium</span>
        <span className="amb-brand-beta">BETA</span>
      </div>

      <button type="button" className="amb-workspace">
        <span className="amb-workspace-avatar">{initial}</span>
        <span className="amb-workspace-name">My workspace</span>
        <span className="amb-workspace-caret">&#9662;</span>
      </button>

      <nav className="amb-nav" aria-label="Sections">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            prefetch={false}
            className={view === item.key ? "amb-nav-item active" : "amb-nav-item"}
            aria-current={view === item.key ? "page" : undefined}
          >
            {item.icon}
            <span className="amb-nav-label">{item.label}</span>
            {item.key === "leaks" && leakCount > 0 ? <span className="amb-nav-badge">{leakCount}</span> : null}
          </Link>
        ))}
      </nav>

      <div className="amb-sidebar-foot">
        <div className="amb-sync-status">
          <span className="amb-sync-dot" aria-hidden />
          {updatedLabel}
        </div>
        <div className="amb-plan-card">
          <div className="amb-plan-card-head">
            <strong>Indie plan</strong>
            <span>$5/mo</span>
          </div>
          <p>Unlimited projects, daily refresh, alerts.</p>
        </div>
        <div className="amb-user">
          <span className="amb-user-avatar">{initial}</span>
          <span className="amb-user-id">
            <strong>{name}</strong>
            <small>{email}</small>
          </span>
        </div>
        <SignOutButton />
      </div>
    </aside>
  )
}

function AppHeader({
  view,
  range,
  rangeParams,
  refreshHref,
}: {
  view: ViewKey
  range: ResolvedDateRange
  // Params to preserve when switching ranges; null hides the picker (views
  // that always show current state: limits, leaks, AI, connect).
  rangeParams: Record<string, string> | null
  refreshHref: string
}) {
  const meta = VIEW_META[view]
  return (
    <header className="amb-header">
      <div className="amb-header-inner">
        <div>
          <h1>{meta.title}</h1>
          <p>{meta.sub}</p>
        </div>
        <div className="amb-header-actions">
          {rangeParams ? (
            <DateRangePicker range={range} baseParams={rangeParams} />
          ) : (
            <span className="amb-chip">{monthSpanLabel(currentMonthRange())}</span>
          )}
          <a href={refreshHref} className="amb-btn-dark">
            <RefreshCw aria-hidden width={14} height={14} />
            Refresh
          </a>
        </div>
      </div>
    </header>
  )
}

function shortAge(value: string | null) {
  if (!value) return "not synced"
  const age = Math.max(Date.now() - new Date(value).getTime(), 0)
  if (!Number.isFinite(age)) return "not synced"
  if (age < 3_600_000) return `${Math.max(Math.round(age / 60_000), 1)}m ago`
  if (age < 86_400_000) return `${Math.round(age / 3_600_000)}h ago`
  return `${Math.round(age / 86_400_000)}d ago`
}

function resetLabel(value: string | null | undefined) {
  if (!value) return "reset not reported"
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return "reset not reported"
  const delta = time - Date.now()
  const abs = Math.abs(delta)
  const unit = abs < 3_600_000 ? `${Math.max(Math.round(abs / 60_000), 1)}m` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 86_400_000)}d`
  return delta >= 0 ? `resets in ${unit}` : `reset ${unit} ago`
}

const AI_USAGE_URL: Partial<Record<Provider, string>> = {
  anthropic: "https://claude.ai/new#settings/usage",
  openai: "https://chatgpt.com/codex/cloud/settings/analytics#usage",
  cursor: "https://cursor.com/dashboard",
  gcp: "https://console.cloud.google.com/billing",
  cloudflare: "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway",
  vercel: "https://vercel.com/dashboard/usage",
}

function isAiLikeRow(row: NormalizedCostRow) {
  if (AI_PROVIDERS.includes(row.provider)) return true
  const text = `${row.customLabel ?? ""} ${row.serviceName} ${row.resourceName ?? ""} ${row.resourceId ?? ""} ${row.attributionReason}`.toLowerCase()
  if (row.provider === "aws") return AWS_AI_ROW_PATTERN.test(text)
  return AI_ROW_PATTERN.test(text)
}

function isAiLikeUsage(row: FreeTierUsageRow) {
  if (AI_PROVIDERS.includes(row.provider)) return true
  const text = `${row.customLabel ?? ""} ${row.service} ${row.planName} ${row.note}`.toLowerCase()
  if (row.provider === "aws") return AWS_AI_ROW_PATTERN.test(text)
  return AI_ROW_PATTERN.test(text)
}

function gatewayLabel(row: NormalizedCostRow) {
  if (/openrouter/i.test(`${row.customLabel ?? ""} ${row.serviceName} ${row.resourceName ?? ""}`)) return "OpenRouter"
  if (/gemini|vertex ai|ai studio/i.test(`${row.serviceName} ${row.resourceName ?? ""}`)) return "Gemini / Vertex AI"
  if (/ai gateway|workers ai/i.test(`${row.serviceName} ${row.resourceName ?? ""}`) && row.provider === "cloudflare") return "Cloudflare AI"
  if (/v0|vercel ai|ai sdk/i.test(`${row.serviceName} ${row.resourceName ?? ""}`) && row.provider === "vercel") return "Vercel AI"
  return row.customLabel ?? `${providerName(row.provider)} AI`
}

// Builds the per-tool AI insight model from the snapshot + connection metadata:
// flat subscription vs live API cost, token mix, per-model breakdown (from the
// locally-pushed usage), API-rate value, gateway spend, and official usage links.
function buildAiTools(analysis: AnalysisResult, state: Awaited<ReturnType<typeof publicStore>>): AiToolData[] {
  const tools: AiToolData[] = []
  for (const provider of AI_PROVIDERS) {
    const conn = state.connections[provider]
    if (conn?.status !== "connected") continue
    const meta = (conn.metadata ?? {}) as {
      source?: "local" | "api" | "both"
      localUsage?: {
        planLabel?: string | null
        totals?: { inputTokens?: number; cacheTokens?: number; outputTokens?: number }
        limits?: AiUsageLimit[]
        models?: Array<{
          model: string
          inputTokens?: number
          cacheTokens?: number
          outputTokens?: number
          estimatedApiUsd?: number
          inputUsd?: number
          cacheUsd?: number
          outputUsd?: number
          rates?: {
            inputPerMillion?: number
            cachePerMillion?: number
            cacheReadPerMillion?: number | null
            outputPerMillion?: number
          }
        }>
      }
      subscriptionUsdOverride?: number
      planLabelOverride?: string
    }
    const rows = analysis.costRows.filter((row) => row.provider === provider)
    const subscriptionCost = rows.filter((row) => /subscription/i.test(row.serviceName)).reduce((s, r) => s + r.cost, 0)
    const apiCost = rows.filter((row) => /\(API\)/.test(row.serviceName)).reduce((s, r) => s + r.cost, 0)
    const apiValue = analysis.freeTier.find((row) => row.provider === provider && row.service === "Value at API rates")?.used ?? 0

    const apiUsage = (service: RegExp) =>
      analysis.freeTier.filter((row) => row.provider === provider && service.test(row.service)).reduce((s, r) => s + (r.used ?? 0), 0)
    const inputTokens = (meta.localUsage?.totals?.inputTokens ?? 0) + apiUsage(/^input tokens \(api\)/i)
    const cacheTokens = meta.localUsage?.totals?.cacheTokens ?? 0
    const outputTokens = (meta.localUsage?.totals?.outputTokens ?? 0) + apiUsage(/^output tokens \(api\)/i)

    const models = (meta.localUsage?.models ?? []).map((model) => {
      const input = model.inputTokens ?? 0
      const cache = model.cacheTokens ?? 0
      const output = model.outputTokens ?? 0
      return {
        model: model.model,
        inputTokens: input,
        cacheTokens: cache,
        outputTokens: output,
        totalTokens: input + cache + output,
        estimatedApiUsd: model.estimatedApiUsd ?? 0,
        inputUsd: model.inputUsd,
        cacheUsd: model.cacheUsd,
        outputUsd: model.outputUsd,
        rates: model.rates,
      }
    })

    const planLabel = meta.planLabelOverride ?? meta.localUsage?.planLabel ?? null
    // The card already shows the plan as a badge and the source as a tag, so
    // strip "(local)" and a trailing "· <plan>" from the stored label to avoid
    // repeating them in the subtitle (e.g. "Codex (local) · Plus" → "Codex").
    let accountLabel = conn.accountLabel ?? null
    if (accountLabel) {
      accountLabel = accountLabel.replace(/\s*\(local\)/i, "")
      if (planLabel) accountLabel = accountLabel.replace(new RegExp(`\\s*·\\s*${planLabel}\\s*$`, "i"), "")
      accountLabel = accountLabel.trim() || null
    }

    tools.push({
      id: provider,
      provider,
      label: providerName(provider),
      accountLabel,
      source: meta.source ?? null,
      planLabel,
      subscriptionCost: Number(subscriptionCost.toFixed(2)),
      apiCost: Number(apiCost.toFixed(2)),
      totalCost: Number((subscriptionCost + apiCost).toFixed(2)),
      apiValue: Number(apiValue.toFixed(2)),
      inputTokens,
      cacheTokens,
      outputTokens,
      totalTokens: inputTokens + cacheTokens + outputTokens,
      models,
      limits: meta.localUsage?.limits ?? [],
      lastVerifiedAt: conn.lastVerifiedAt ?? null,
      usageUrl: AI_USAGE_URL[provider] ?? null,
      category: subscriptionCost > 0 ? "subscription" : meta.source === "local" ? "local" : "api",
    })
  }

  const gatewayRows = analysis.costRows.filter((row) => !AI_PROVIDERS.includes(row.provider) && isAiLikeRow(row))
  const grouped = new Map<string, NormalizedCostRow[]>()
  for (const row of gatewayRows) {
    const key = `${row.provider}:${row.customProviderId ?? row.customLabel ?? gatewayLabel(row)}`
    grouped.set(key, [...(grouped.get(key) ?? []), row])
  }

  for (const [id, rows] of grouped) {
    const first = rows[0]
    const cost = sumCost(rows)
    const usageRows = analysis.freeTier.filter((row) => row.provider === first.provider && isAiLikeUsage(row))
    const tokenUsage = usageRows
      .filter((row) => /token/i.test(row.unit) || /token/i.test(row.service))
      .reduce((sum, row) => sum + (row.used ?? 0), 0)
    tools.push({
      id,
      provider: first.provider,
      label: gatewayLabel(first),
      accountLabel: first.customLabel ?? providerName(first.provider),
      source: "api",
      planLabel: "gateway",
      subscriptionCost: 0,
      apiCost: Number(cost.toFixed(2)),
      totalCost: Number(cost.toFixed(2)),
      apiValue: Number(cost.toFixed(2)),
      inputTokens: tokenUsage,
      cacheTokens: 0,
      outputTokens: 0,
      totalTokens: tokenUsage,
      models: rows.map((row) => ({
        model: row.serviceName,
        inputTokens: 0,
        cacheTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedApiUsd: row.cost,
      })),
      limits: [],
      lastVerifiedAt: analysis.liveSync.find((entry) => entry.provider === first.provider)?.syncedAt ?? null,
      usageUrl: AI_USAGE_URL[first.provider] ?? null,
      category: "gateway",
    })
  }
  return tools.sort((a, b) => b.totalCost - a.totalCost)
}

function repoCandidates(repos: GitHubRepoSummary[]) {
  return repos.map((repo) => ({ fullName: repo.fullName, name: repo.name }))
}

function suggestedReposForRow(row: NormalizedCostRow, repos: GitHubRepoSummary[]) {
  const haystack = `${row.serviceName} ${row.resourceName ?? ""} ${row.resourceId ?? ""} ${row.attributionReason}`.toLowerCase()
  const matches = repos.filter((repo) => haystack.includes(repo.name.toLowerCase()))
  return (matches.length ? matches : repos).slice(0, 3).map((repo) => ({ fullName: repo.fullName, name: repo.name }))
}

// Unmapped / inferred / shared cost rows that need a human to attach them to a
// project. Surfaced inside the Leaks view so they can be assigned in place.
function buildAssignmentQueue(input: {
  analysis: AnalysisResult
  repos: GitHubRepoSummary[]
  assignments: Record<string, string>
}): AssignmentQueueItem[] {
  if (input.repos.length === 0) return []
  const seen = new Set<string>()
  const rows = input.analysis.costRows
    .filter((row) => row.cost > 0.005)
    .map((row) => {
      const itemKey = costItemKey(row)
      if (seen.has(itemKey)) return null
      seen.add(itemKey)
      const manual = input.assignments[itemKey]
      const needsReview =
        !manual && !row.attributedRepo ||
        !manual && row.attribution === "inferred" ||
        manual === ACCOUNT_SENTINEL
      if (manual === SPLIT_EQUAL_SENTINEL) return null
      if (!needsReview) return null
      const confidence: AssignmentQueueItem["confidence"] =
        manual === ACCOUNT_SENTINEL ? "manual" : row.attribution === "inferred" ? "inferred" : "unassigned"
      return {
        itemKey,
        providerLabel: seriesLabel(row),
        serviceName: row.serviceName,
        resourceName: row.resourceName ?? row.resourceId ?? "Account-level spend",
        cost: row.cost,
        currency: row.currency,
        reason:
          manual === ACCOUNT_SENTINEL
            ? "Marked shared/account-level. Reassign it if this should belong to a project."
            : row.attribution === "inferred"
              ? row.attributionReason || "This row was inferred from naming or repo evidence."
              : "No repo matched this provider billing row.",
        confidence,
        suggestedRepos: suggestedReposForRow(row, input.repos),
      }
    })
    .filter((row): row is AssignmentQueueItem => Boolean(row))

  return rows.sort((a, b) => b.cost - a.cost).slice(0, 20)
}

type AccountUsageGroup = {
  key: string
  provider: Provider
  label: string
  planName: string
  rows: FreeTierUsageRow[]
}

function accountUsageGroups(rows: FreeTierUsageRow[]): AccountUsageGroup[] {
  const groups = new Map<string, AccountUsageGroup>()
  for (const row of rows) {
    const key = row.provider === "custom" && row.customProviderId ? `custom:${row.customProviderId}` : row.provider
    const existing = groups.get(key)
    if (existing) {
      existing.rows.push(row)
      continue
    }
    groups.set(key, {
      key,
      provider: row.provider,
      label: row.customLabel ?? providerName(row.provider),
      planName: row.planName,
      rows: [row],
    })
  }
  return [...groups.values()].sort((a, b) => {
    const aMeasured = a.rows.filter((row) => row.source === "measured").length
    const bMeasured = b.rows.filter((row) => row.source === "measured").length
    return bMeasured - aMeasured || a.label.localeCompare(b.label)
  })
}

// Full account-wide usage across every regular/custom cloud source, shown on the
// Insights view alongside budget/forecast/history.
function AccountWideUsagePanel({ rows }: { rows: FreeTierUsageRow[] }) {
  const groups = accountUsageGroups(rows)
  if (!groups.length) return null
  const measured = rows.filter((row) => row.source === "measured").length
  const nearLimit = rows.filter((row) => (row.percentUsed ?? 0) >= 80).length

  return (
    <section className="account-usage-panel" aria-label="Account-wide provider usage">
      <div className="insight-panel-head account-usage-head">
        <div>
          <p>Account-wide usage</p>
          <h2>Every provider metric</h2>
          <span>Live consumption and published allowances for the full connected account, independent of repo assignment.</span>
        </div>
        <div className="account-usage-summary">
          <strong>{measured}</strong>
          <span>measured</span>
          <small>{groups.length} providers · {nearLimit} near limit</small>
        </div>
      </div>
      <div className="account-usage-grid">
        {groups.map((group) => {
          const measuredRows = group.rows.filter((row) => row.source === "measured")
          const highest = Math.max(...measuredRows.map((row) => row.percentUsed ?? 0), 0)
          return (
            <details className="account-usage-provider" key={group.key}>
              <summary>
                <ProviderLogo provider={group.provider} />
                <div>
                  <strong>{group.label}</strong>
                  <span>{group.planName} · {group.rows.length} metric{group.rows.length === 1 ? "" : "s"}</span>
                </div>
                <b>{highest > 0 ? `${Math.round(highest)}% peak` : `${measuredRows.length} measured`}</b>
                <ChevronDown aria-hidden />
              </summary>
              <div className="account-usage-detail">
                <FreeTierUsage
                  rows={group.rows}
                  hasCost={false}
                  heading="Account-wide usage"
                  subtext="Usage for the whole connected provider account."
                />
              </div>
            </details>
          )
        })}
      </div>
    </section>
  )
}

function RepositoryDashboard({
  analysis,
  repos,
  state,
  repoAnalyses,
  view,
  connectTab,
  repoTrends,
  range,
  rangeSpend,
}: {
  analysis: AnalysisResult
  repos: GitHubRepoSummary[]
  selectedRepo: string | null
  state: Awaited<ReturnType<typeof publicStore>>
  repoAnalyses: Record<string, AnalysisResult>
  view: ViewKey
  connectTab: ConnectTabKey
  // Real monthly cost-per-repo history for sparklines; {} when historical
  // analytics reads are disabled or empty (we then render no trend, not a fake).
  repoTrends: Record<string, Array<{ month: string; total: number }>>
  // Selected reporting range + the historical (pre-current-month) spend for it.
  range: ResolvedDateRange
  rangeSpend: RangeSpendSummary | null
}) {
  const connectedProviders = CONNECTABLE_PROVIDERS.filter((provider) => state.connections[provider]?.status === "connected")
  const accounts = accountEntries(analysis, state)
  const totalCost = sumCost(analysis.costRows)
  const { elapsedDays, totalDays } = periodProgress(analysis.period)
  const forecast = {
    elapsedDays,
    totalDays,
    dailyRate: elapsedDays > 0 ? totalCost / elapsedDays : 0,
    projected: (elapsedDays > 0 ? totalCost / elapsedDays : 0) * totalDays,
  }
  const latestSync = analysis.liveSync
    .filter((entry) => entry.status === "success")
    .map((entry) => entry.syncedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1)
  const latestSyncTime = latestSync ? new Date(latestSync).getTime() : Number.NaN
  const latestMs = Number.isFinite(latestSyncTime) ? Math.max(Date.now() - latestSyncTime, 0) : null
  const indieProjects = buildIndieProjects({
    repos,
    analysis,
    repoAnalyses,
    connectedProviders,
    state,
    elapsedDays: forecast.elapsedDays,
    totalDays: forecast.totalDays,
  })
  const leaks = buildLeakCandidates({
    analysis,
    projects: indieProjects,
    assignments: state.costAssignments,
    syncedRepoFullNames: state.syncedRepoFullNames,
    latestMs,
  })
  const accountUsageRows = analysis.freeTier.filter((row) => !AI_PROVIDERS.includes(row.provider))
  // Unmapped/inferred/shared cost rows to attach to a repo from the Leaks view.
  const assignmentQueue = buildAssignmentQueue({ analysis, repos, assignments: state.costAssignments })
  const aiTools = buildAiTools(analysis, state)
  const emptyWorkspace = repos.length === 0 && accounts.length === 0 && totalCost <= 0.005

  const aiTotal = aiTools.reduce((sum, tool) => sum + tool.totalCost, 0)
  const recoverable = leaks.reduce((sum, leak) => sum + (leak.amount ?? 0), 0)
  const pacePct = totalCost > 0.005 ? Math.round(((forecast.projected - totalCost) / totalCost) * 100) : 0

  // Range totals: live snapshot for the current month + analytics history for
  // past months. Each month comes from exactly one source, so nothing is
  // double-counted and last month's spend can never inflate this month's.
  const rangeCurrentPortion = range.includesCurrentMonth ? totalCost : 0
  const rangeTotal = rangeCurrentPortion + (rangeSpend?.total ?? 0)
  const historyMissing = !range.isCurrentMonthOnly && rangeSpend?.available !== true
  const rangeRepoTotal = (fullName: string, currentCost: number) =>
    (range.includesCurrentMonth ? currentCost : 0) + (rangeSpend?.byRepo[fullName] ?? 0)

  // Repo display name keyed by its lowercased short name (cost rows attribute by
  // short name) so AI/limit attribution can show the project's real name.
  const repoNameByShort = new Map(repos.map((repo) => [repo.name.toLowerCase(), repo.name]))

  // Which repos link each provider — drives "N projects" on Connect cards and
  // single-project attribution for limit metrics.
  const reposByProvider = new Map<Provider, Set<string>>()
  for (const project of indieProjects) {
    for (const provider of project.linked) {
      if (!reposByProvider.has(provider)) reposByProvider.set(provider, new Set())
      reposByProvider.get(provider)!.add(project.repo.name)
    }
  }
  const singleRepoFor = (provider: Provider) => {
    const set = reposByProvider.get(provider)
    return set && set.size === 1 ? [...set][0] : null
  }

  // --- Projects view-model -------------------------------------------------
  // Bars are scaled to the largest project's projected spend so widths are
  // comparable across rows (matching the design's fixed-scale stacked bars).
  const projectScale = Math.max(...indieProjects.map((p) => Math.max(p.projected, p.cost)), 1)
  const usageByProvider = new Map<Provider, FreeTierUsageRow>()
  for (const row of accountUsageRows) {
    if (row.source !== "measured" || row.limit === null || row.percentUsed === null) continue
    const current = usageByProvider.get(row.provider)
    if (!current || (row.percentUsed ?? 0) > (current.percentUsed ?? 0)) usageByProvider.set(row.provider, row)
  }
  // Range mode (anything but the default "this month"): each project's cost
  // column shows its total over the selected range. Provider-split bars and
  // projections only describe the live current month, so range mode swaps them
  // for a single comparable bar scaled to the largest range total.
  const rangeMode = !range.isCurrentMonthOnly
  const rangeCostByRepo = new Map(indieProjects.map((p) => [p.repo.fullName, rangeRepoTotal(p.repo.fullName, p.cost)]))
  const rangeScale = Math.max(...rangeCostByRepo.values(), 1)
  const projectVMs: ProjectRowVM[] = indieProjects.map((p) => {
    const displayCost = rangeMode ? rangeCostByRepo.get(p.repo.fullName) ?? 0 : p.cost
    const free = displayCost <= 0.005
    const conf = CONF_CHIP[p.confidence]
    const dots = p.stackProviders.slice(0, 4).map((prov) => {
      const d = provMono(prov)
      return { color: d.color, monogram: d.m, name: providerName(prov) }
    })
    const segments = rangeMode
      ? free
        ? []
        : [{ color: "#19191D", width: `${((displayCost / rangeScale) * 100).toFixed(2)}%` }]
      : p.breakdown.map((b) => {
          const d = provMono(b.provider, b.label)
          return { color: d.color, width: `${((b.total / projectScale) * 100).toFixed(2)}%` }
        })
    // Real sparkline: historical monthly totals for this repo + current MTD as
    // the latest point. No history → no points → empty trend cell (not faked).
    const series = [...(repoTrends[p.repo.fullName]?.map((t) => t.total) ?? []), p.cost]
    const sparkPoints = buildSparkline(series)
    const sparkUp = series.length >= 2 && series[series.length - 1] >= series[0]
    let runwayLabel = "On free tier"
    let runwayPctLabel = ""
    let runwayFill = "0%"
    let runwayColor = "#0F9D63"
    if (free) {
      let best: FreeTierUsageRow | undefined
      for (const prov of p.stackProviders) {
        const u = usageByProvider.get(prov)
        if (u && (!best || (u.percentUsed ?? 0) > (best.percentUsed ?? 0))) best = u
      }
      if (best) {
        const pct = Math.round(best.percentUsed ?? 0)
        runwayLabel = `${providerName(best.provider)} · ${best.service}`
        runwayPctLabel = `${pct}%`
        runwayFill = `${Math.max(pct, 2)}%`
        runwayColor = pct >= 80 ? "#DC2B3F" : pct >= 55 ? "#C77B0A" : "#0F9D63"
      }
    }
    const breakdown = p.breakdown.map((b) => {
      const d = provMono(b.provider, b.label)
      return {
        name: b.label,
        color: d.color,
        monogram: d.m,
        cost: money(b.total),
        width: `${p.cost > 0 ? Math.max((b.total / p.cost) * 100, 2) : 0}%`,
      }
    })
    const evidence =
      p.signalCount > 0
        ? `Detected via ${p.signalCount} repo signal${p.signalCount === 1 ? "" : "s"}`
        : p.linked.length > 0
          ? `Detected via ${p.linked.length} linked account${p.linked.length === 1 ? "" : "s"}`
          : "No repo evidence yet"
    const projDisplay = rangeMode
      ? free
        ? "no spend in range"
        : range.includesCurrentMonth
          ? `incl. ${money(p.cost)} this month`
          : range.months.length === 1
            ? "full month"
            : `over ${range.months.length} months`
      : free
        ? "on free tier"
        : `proj ${money(p.projected)}`
    return {
      id: p.repo.name,
      repo: p.repo.fullName,
      href: `/dashboard?repo=${encodeURIComponent(p.repo.fullName)}${rangeMode ? `&range=${encodeURIComponent(String(range.key))}` : ""}`,
      free,
      mtdValue: displayCost,
      mtdLabel: free ? (rangeMode ? "No spend" : "Free tier") : money(displayCost),
      mtdColor: free ? "#0F9D63" : "#19191D",
      projDisplay,
      confLabel: conf.label,
      confColor: conf.color,
      dots,
      segments,
      projMarker: rangeMode ? "0%" : `${Math.min((p.projected / projectScale) * 100, 100).toFixed(2)}%`,
      sparkPoints,
      sparkColor: sparkUp ? "#C77B0A" : "#0F9D63",
      runwayLabel,
      runwayPctLabel,
      runwayFill,
      runwayColor,
      desc: p.detail,
      evidence,
      breakdown,
    }
  })

  // --- Limits view-model ---------------------------------------------------
  const measuredUsage = accountUsageRows.filter((row) => row.source === "measured")
  const limitRows = measuredUsage
    .filter((row) => row.limit !== null && row.percentUsed !== null)
    .sort((a, b) => (b.percentUsed ?? 0) - (a.percentUsed ?? 0))
  const nearingCount = limitRows.filter((row) => (row.percentUsed ?? 0) >= 80).length
  const comfortableCount = limitRows.filter((row) => (row.percentUsed ?? 0) < 55).length

  // --- Leaks view-model ----------------------------------------------------
  const leakVMs = leaks.map((leak) => {
    const sev = leak.severity === "crit" ? "#DC2B3F" : leak.severity === "warn" ? "#C77B0A" : "#9B9BA6"
    const tag = leak.severity === "crit" ? "High" : leak.severity === "warn" ? "Medium" : "Info"
    const t = leak.title.toLowerCase()
    const action = /shut down|safe to shut|inactive|no traffic/.test(t)
      ? "Shut down"
      : /map|assign|unmapped|not mapped/.test(t)
        ? "Assign"
        : /sync|refresh|reconnect|expire|connection/.test(t)
          ? "Reconnect"
          : /export|connect/.test(t)
            ? "Connect"
            : "Review"
    return {
      id: leak.id,
      sev,
      tag,
      title: leak.title,
      detail: leak.detail,
      amount: leak.amount != null ? `${money(leak.amount)} / mo` : "—",
      action,
    }
  })

  // --- AI view-model -------------------------------------------------------
  const aiSubscription = aiTools.reduce((sum, tool) => sum + tool.subscriptionCost, 0)
  const aiUsage = aiTools.reduce((sum, tool) => sum + tool.apiCost, 0)
  const aiTokens = aiTools.reduce((sum, tool) => sum + tool.totalTokens, 0)
  const aiInputTokens = aiTools.reduce((sum, tool) => sum + tool.inputTokens, 0)
  const aiCacheTokens = aiTools.reduce((sum, tool) => sum + tool.cacheTokens, 0)
  const aiOutputTokens = aiTools.reduce((sum, tool) => sum + tool.outputTokens, 0)
  const aiApiValue = aiTools.reduce((sum, tool) => sum + tool.apiValue, 0)
  const aiSynced = aiTools.filter((tool) => tool.lastVerifiedAt).length
  const aiShare = totalCost > 0.005 ? Math.round((aiTotal / totalCost) * 100) : 0
  const aiTopTool = [...aiTools].sort((a, b) => b.totalTokens - a.totalTokens || b.totalCost - a.totalCost)[0] ?? null
  const aiTopModel = aiTools
    .flatMap((tool) => tool.models.map((model) => ({ ...model, toolLabel: tool.label })))
    .sort((a, b) => b.totalTokens - a.totalTokens)[0] ?? null
  const aiStack = aiTools
    .filter((tool) => tool.totalCost > 0)
    .map((tool) => {
      const d = provMono(tool.provider, tool.label)
      return { width: `${aiTotal > 0 ? (tool.totalCost / aiTotal) * 100 : 0}%`, color: d.color }
    })
  const aiMax = Math.max(...aiTools.map((tool) => tool.totalCost), 0.01)
  // Real per-tool project list from AI-attributed cost rows.
  const aiReposByProvider = new Map<Provider, Set<string>>()
  for (const row of analysis.costRows) {
    if (!isAiLikeRow(row) || !row.attributedRepo) continue
    if (!aiReposByProvider.has(row.provider)) aiReposByProvider.set(row.provider, new Set())
    aiReposByProvider.get(row.provider)!.add(repoNameByShort.get(row.attributedRepo) ?? row.attributedRepo)
  }
  const aiDeepDiveVMs = aiTools.map((tool) => {
    const d = provMono(tool.provider, tool.label)
    const projects = [...(aiReposByProvider.get(tool.provider) ?? [])]
    const topModel = [...tool.models].sort((a, b) => b.totalTokens - a.totalTokens)[0] ?? null
    const totalModelValue = tool.models.reduce((sum, model) => sum + model.estimatedApiUsd, 0)
    const inputValue = tool.models.reduce((sum, model) => sum + modelCostParts(model).input, 0)
    const cacheValue = tool.models.reduce((sum, model) => sum + modelCostParts(model).cache, 0)
    const outputValue = tool.models.reduce((sum, model) => sum + modelCostParts(model).output, 0)
    const valueMultiple = tool.totalCost > 0 && tool.apiValue > 0 ? tool.apiValue / tool.totalCost : null
    const modelRows = [...tool.models]
      .sort((a, b) => b.estimatedApiUsd - a.estimatedApiUsd || b.totalTokens - a.totalTokens)
      .map((model) => {
        const parts = modelCostParts(model)
        const rates = model.rates
        return {
          name: model.model,
          tokens: compactNumber(model.totalTokens),
          mix: `${compactNumber(model.inputTokens)} in · ${compactNumber(model.cacheTokens)} cache · ${compactNumber(model.outputTokens)} out`,
          inputCost: maybeMoney(parts.input),
          cacheCost: maybeMoney(parts.cache),
          outputCost: maybeMoney(parts.output),
          totalValue: maybeMoney(model.estimatedApiUsd),
          rates:
            rates && (rates.inputPerMillion || rates.cachePerMillion || rates.outputPerMillion)
              ? `${maybeMoney(rates.inputPerMillion)}/M in · ${maybeMoney(rates.cachePerMillion)}/M cache · ${maybeMoney(rates.outputPerMillion)}/M out`
              : "No rate detail",
        }
      })
    const limits = tool.limits.map((limit) => {
      const pct = limit.used != null && limit.limit && limit.limit > 0 ? Math.min(100, Math.round((limit.used / limit.limit) * 100)) : null
      return {
        ...limit,
        pct,
        label: `${limit.label} · ${limit.period}`,
        usage: limitUsageLabel(limit),
        reset: resetLabel(limit.resetsAt),
      }
    })
    return {
      id: tool.id ?? tool.provider,
      provider: tool.provider,
      color: d.color,
      monogram: d.m,
      name: tool.label,
      sub: projects.length > 0 ? projects.join(", ") : tool.accountLabel ?? tool.planLabel ?? providerName(tool.provider),
      kind: tool.category === "subscription" ? "Flat" : "Usage",
      width: `${Math.max((tool.totalCost / aiMax) * 100, 2)}%`,
      tokens: compactNumber(tool.totalTokens),
      tokenShare: `${aiTokens > 0 ? Math.max((tool.totalTokens / aiTokens) * 100, 2) : 0}%`,
      output: percentOf(tool.outputTokens, tool.totalTokens),
      value: valueMultiple === null ? "—" : `${valueMultiple.toFixed(1)}x`,
      topModel: topModel?.model ?? "—",
      topModelShare: topModel ? `${percentOf(topModel.totalTokens, tool.totalTokens)} of tokens` : "No model breakdown",
      plan: tool.planLabel ?? (tool.source === "api" ? "API" : "Connected"),
      source: tool.source === "both" ? "subscription + API" : tool.source ?? tool.category ?? "connected",
      totalCost: money(tool.totalCost),
      subscriptionCost: money(tool.subscriptionCost),
      apiCost: money(tool.apiCost),
      apiValue: money(tool.apiValue),
      tokenTotal: compactNumber(tool.totalTokens),
      valueMultiple: tool.totalCost > 0 && tool.apiValue > 0 ? `${(tool.apiValue / tool.totalCost).toFixed(1)}x` : "—",
      inputValue: maybeMoney(inputValue),
      cacheValue: maybeMoney(cacheValue),
      outputValue: maybeMoney(outputValue),
      totalModelValue: maybeMoney(totalModelValue),
      modelRows,
      limits,
    }
  }).sort((a, b) => {
    const aTool = aiTools.find((tool) => (tool.id ?? tool.provider) === a.id)
    const bTool = aiTools.find((tool) => (tool.id ?? tool.provider) === b.id)
    return (bTool?.totalTokens ?? 0) - (aTool?.totalTokens ?? 0) || (bTool?.totalCost ?? 0) - (aTool?.totalCost ?? 0)
  })

  // --- Connect view-model --------------------------------------------------
  const connectedVMs = accounts.map((account) => {
    const d = provMono(account.provider, account.label)
    const connection = account.provider === "custom" ? undefined : state.connections[account.provider]
    const synced = connection?.lastVerifiedAt ?? null
    const projectCount = account.provider === "custom" ? 0 : reposByProvider.get(account.provider)?.size ?? 0
    const base = projectCount > 0 ? `${projectCount} project${projectCount === 1 ? "" : "s"}` : account.accountLabel ?? "Connected"
    const warn = Boolean(connection?.lastError)
    return {
      key: account.key,
      color: d.color,
      monogram: d.m,
      name: account.label,
      detail: synced ? `${base} · synced ${shortAge(synced)}` : base,
      warn,
    }
  })
  const pendingConnections = analysis.providerConnections.filter(
    (connection) => connection.status !== "connected" && (connection.detected || connection.status === "setup_required")
  )
  const connectTabs: Array<{ key: ConnectTabKey; label: string; detail: string; count?: number }> = [
    { key: "setup", label: "Setup", detail: "Read-only + CLI" },
    { key: "connected", label: "Connected", detail: "Live accounts", count: connectedVMs.length },
    { key: "detected", label: "Detected", detail: "Found in repos", count: pendingConnections.length },
    { key: "credentials", label: "Credentials", detail: "Manage access" },
  ]

  return (
    <>
      {view === "projects" ? (
        <>
          {emptyWorkspace ? (
            <div className="amb-banner amber">
              <span className="amb-banner-dot" aria-hidden />
              <span>No accounts connected yet — connect your providers to see your real numbers.</span>
              <Link href="/dashboard?view=connect" prefetch={false} className="amb-banner-link">
                Connect accounts
              </Link>
            </div>
          ) : null}

          {historyMissing ? (
            <div className="amb-banner amber">
              <span className="amb-banner-dot" aria-hidden />
              <span>
                Historical spend for this range is unavailable right now — totals below only include
                {range.includesCurrentMonth ? " the current month" : " what could be read"}.
              </span>
            </div>
          ) : null}

          <div className="amb-kpi-grid">
            <div className="amb-kpi">
              <div className="amb-kpi-label">{rangeMode ? range.label : "Month to date"}</div>
              <div className="amb-kpi-value">{money(rangeTotal)}</div>
              <div className="amb-kpi-sub">
                {rangeMode
                  ? `${monthSpanLabel(range)} · ${range.months.length} ${range.months.length === 1 ? "month" : "months"}`
                  : `across ${repos.length} ${repos.length === 1 ? "project" : "projects"} · ${forecast.elapsedDays} days in`}
              </div>
            </div>
            {rangeMode ? (
              <div className="amb-kpi">
                <div className="amb-kpi-label">Monthly average</div>
                <div className="amb-kpi-value">{money(rangeTotal / Math.max(range.months.length, 1))}</div>
                <div className="amb-kpi-sub">
                  {range.includesCurrentMonth ? `incl. ${money(totalCost)} this month so far` : "per calendar month"}
                </div>
              </div>
            ) : (
              <div className="amb-kpi">
                <div className="amb-kpi-label">Projected ({monthLabel(analysis.period).split(" ")[0]})</div>
                <div className="amb-kpi-value">{money(forecast.projected)}</div>
                <div className={pacePct > 0 ? "amb-kpi-sub up" : "amb-kpi-sub"}>
                  {pacePct > 0 ? `▲ +${pacePct}% to month-end` : "at current run rate"}
                </div>
              </div>
            )}
            <div className="amb-kpi">
              <div className="amb-kpi-label">AI spend</div>
              <div className="amb-kpi-value">{money(aiTotal)}</div>
              <div className="amb-kpi-sub">{aiShare}% of this month&apos;s spend</div>
            </div>
            <Link href="/dashboard?view=leaks" prefetch={false} className="amb-kpi action">
              <div className="amb-kpi-action-head">
                <span>Recoverable</span>
                <em>&#8594;</em>
              </div>
              <div className="amb-kpi-value">{money(recoverable)}</div>
              <div className="amb-kpi-sub">
                {leaks.length} {leaks.length === 1 ? "issue" : "issues"} · recoverable
              </div>
            </Link>
          </div>

          <ProjectsTable
            projects={projectVMs}
            totalLabel={money(rangeTotal)}
            defaultExpanded={projectVMs[0]?.id ?? null}
            costHeader={rangeMode ? range.label : "Month to date"}
            breakdownLabel={rangeMode ? "Cost by provider · this month" : "Cost by provider"}
          />
        </>
      ) : null}

      {view === "limits" ? (
        <>
          <div className="amb-stat-row">
            <div className="amb-stat">
              <div className="amb-stat-label">Free tiers tracked</div>
              <div className="amb-stat-value">{measuredUsage.length}</div>
            </div>
            <div className={nearingCount > 0 ? "amb-stat danger" : "amb-stat"}>
              <div className="amb-stat-label">Nearing limit</div>
              <div className="amb-stat-value">{nearingCount}</div>
            </div>
            <div className="amb-stat good">
              <div className="amb-stat-label">Comfortable</div>
              <div className="amb-stat-value">{comfortableCount}</div>
            </div>
          </div>

          {limitRows.length > 0 ? (
            <div className="amb-grid-2">
              {limitRows.map((row) => {
                const pct = Math.round(row.percentUsed ?? 0)
                const color = pct >= 80 ? "#DC2B3F" : pct >= 55 ? "#C77B0A" : "#0F9D63"
                const d = provMono(row.provider, row.customLabel)
                const note = pct >= 80 ? "Watch closely" : pct >= 55 ? "Monitor weekly" : "Comfortable"
                const project = singleRepoFor(row.provider)
                return (
                  <div className="amb-limit" key={`${row.provider}-${row.service}`}>
                    <div className="amb-limit-head">
                      <span className="amb-mono-badge" style={{ background: d.color }}>
                        {d.m}
                      </span>
                      <div className="amb-limit-id">
                        <strong>{row.service}</strong>
                        <small>
                          {providerName(row.provider)} · {project ?? row.planName}
                        </small>
                      </div>
                      <span className="amb-limit-pct" style={{ color }}>
                        {pct}%
                      </span>
                    </div>
                    <div className="amb-limit-track">
                      <div className="amb-limit-fill" style={{ width: `${Math.max(pct, 2)}%`, background: color }} />
                    </div>
                    <div className="amb-limit-foot">
                      <span className="used">
                        {quantity(row.used ?? 0)} / {quantity(row.limit ?? 0)} {row.unit}
                      </span>
                      <span className="note" style={{ color }}>
                        {note}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="amb-empty-card">
              <strong>No measured free-tier usage yet</strong>
              <span>Connect a provider that reports usage (Cloudflare, Vercel, GCP…) to see runway here.</span>
              <Link href="/dashboard?view=connect" prefetch={false} className="amb-btn-sm-dark">
                Connect a provider
              </Link>
            </div>
          )}
        </>
      ) : null}

      {view === "leaks" ? (
        <>
          <div className="amb-leak-banner">
            <div className="amt">{money(recoverable)}</div>
            <div>
              <strong>recoverable per month</strong>
              <span>
                across {leaks.length} {leaks.length === 1 ? "issue" : "issues"} — sorted by impact
              </span>
            </div>
          </div>

          {leakVMs.length > 0 ? (
            <div className="amb-leak-list">
              {leakVMs.map((leak) => (
                <div className="amb-leak" key={leak.id}>
                  <span className="amb-leak-sev" style={{ background: leak.sev }} aria-hidden />
                  <div className="amb-leak-body">
                    <span className="amb-leak-tag" style={{ color: leak.sev }}>
                      {leak.tag}
                    </span>
                    <div className="amb-leak-title">{leak.title}</div>
                    <div className="amb-leak-detail">{leak.detail}</div>
                  </div>
                  <div className="amb-leak-aside">
                    <span className="amb-leak-amt">{leak.amount}</span>
                    <Link href="/dashboard?view=connect" prefetch={false} className="amb-btn-sm-dark">
                      {leak.action}
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="amb-banner green">
              <span className="amb-banner-icon" aria-hidden>
                <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="1.6">
                  <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div>
                <strong>No leaks right now</strong>
                <span>Spend is mapped, refreshes are clean, and inferred rows are under control.</span>
              </div>
            </div>
          )}

          {assignmentQueue.length > 0 ? (
            <div className="amb-legacy">
              <p className="amb-legacy-head">Unmapped spend — attach to a project</p>
              <UnassignedCostQueue items={assignmentQueue} repos={repoCandidates(repos)} />
            </div>
          ) : null}
        </>
      ) : null}

      {view === "insights" ? (
        <div className="amb-legacy" style={{ marginTop: 0 }}>
          <BudgetForecast
            spent={totalCost}
            projected={forecast.projected}
            dailyRate={forecast.dailyRate}
            elapsedDays={forecast.elapsedDays}
            totalDays={forecast.totalDays}
            budget={state.monthlyBudgetUsd ?? null}
            monthLabel={monthLabel(analysis.period)}
          />
          <HistoricalAnalyticsPanel repo={null} currentMonth={analysis.period.from.slice(0, 7)} />
          <AccountWideUsagePanel rows={accountUsageRows} />
        </div>
      ) : null}

      {view === "ai" ? (
        aiTools.length ? (
          <>
            <div className="amb-ai-top">
              <div className="amb-card">
                <div className="amb-ai-headline">
                  <span className="big">{money(aiTotal)}</span>
                  <span>AI spend this month · {aiShare}% of total</span>
                </div>
                <div className="amb-stack">
                  {aiStack.map((seg, i) => (
                    <div key={i} className="amb-stack-seg" style={{ width: seg.width, background: seg.color }} />
                  ))}
                </div>
                <div className="amb-ai-legend">
                  <span>Usage-based {money(aiUsage)}</span>
                  <span>Subscriptions {money(aiSubscription)}</span>
                </div>
              </div>
              <div className="amb-card amb-ai-share">
                <div className="lbl">AI as share of total spend</div>
                <div className="pct">{aiShare}%</div>
                <div className="amb-ai-share-track">
                  <div className="amb-ai-share-fill" style={{ width: `${aiShare}%` }} />
                </div>
              </div>
            </div>
            <div className="amb-ai-usage">
              <div className="amb-ai-usage-summary">
                <article>
                  <span>Token composition</span>
                  <strong>{percentOf(aiOutputTokens, aiTokens)} output</strong>
                  <small>{compactNumber(aiInputTokens)} input · {compactNumber(aiCacheTokens)} cache · {compactNumber(aiOutputTokens)} output</small>
                </article>
                <article>
                  <span>Heaviest tool</span>
                  <strong>{aiTopTool ? aiTopTool.label : "No token data"}</strong>
                  <small>{aiTopTool ? `${compactNumber(aiTopTool.totalTokens)} tokens · ${money(aiTopTool.totalCost)}` : "Connect local or API usage"}</small>
                </article>
                <article>
                  <span>Top model</span>
                  <strong>{aiTopModel ? aiTopModel.model : "No model data"}</strong>
                  <small>{aiTopModel ? `${aiTopModel.toolLabel} · ${compactNumber(aiTopModel.totalTokens)} tokens` : "Sync local usage for model rows"}</small>
                </article>
                <article>
                  <span>Sync coverage</span>
                  <strong>{aiSynced}/{aiTools.length}</strong>
                  <small>{money(aiApiValue)} API-rate value tracked</small>
                </article>
              </div>
              <div className="amb-ai-usage-table">
                <div className="amb-ai-usage-title">
                  <strong>Usage detail</strong>
                  <span>Tokens, API-rate value, limits, and model concentration by connected AI tool.</span>
                </div>
                <div className="amb-ai-usage-grid">
                  <div className="amb-ai-usage-headrow">
                    <div className="head">Tool</div>
                    <div className="head">Tokens</div>
                    <div className="head">Value / $</div>
                    <div className="head">Top model</div>
                    <div className="head" aria-hidden />
                  </div>
                  {aiDeepDiveVMs.map((tool) => (
                    <details className="amb-ai-usage-row" key={tool.id}>
                      <summary>
                        <span className="tool">
                          <span className="amb-mono-badge" style={{ background: tool.color }}>
                            {tool.monogram}
                          </span>
                          <span>
                            <strong>{tool.name}</strong>
                            <small>{tool.source}</small>
                          </span>
                        </span>
                        <span className="amb-ai-token-cell">
                          <span>
                            <strong>{tool.tokens}</strong>
                            <small>{tool.output} output</small>
                          </span>
                          <span className="amb-ai-token-track" aria-hidden>
                            <i style={{ width: tool.tokenShare, background: tool.color }} />
                          </span>
                        </span>
                        <span><strong>{tool.value}</strong><small>{tool.apiValue} API value</small></span>
                        <span><strong>{tool.topModel}</strong><small>{tool.topModelShare}</small></span>
                        <ChevronDown aria-hidden />
                      </summary>
                      <div className="amb-ai-provider-body">
                    <div className="amb-ai-provider-metrics">
                      <article><span>Total</span><strong>{tool.totalCost}</strong><small>subscription + API</small></article>
                      <article><span>Subscription</span><strong>{tool.subscriptionCost}</strong><small>flat plan</small></article>
                      <article><span>API spend</span><strong>{tool.apiCost}</strong><small>usage based</small></article>
                      <article><span>API value</span><strong>{tool.totalModelValue}</strong><small>{tool.valueMultiple} value / spend</small></article>
                      <article><span>Input value</span><strong>{tool.inputValue}</strong><small>priced separately</small></article>
                      <article><span>Output value</span><strong>{tool.outputValue}</strong><small>priced separately</small></article>
                    </div>
                    <div className="amb-ai-provider-split">
                      <strong>Cost split by token direction</strong>
                      <div className="amb-ai-provider-split-grid">
                        <span><i style={{ background: "#4d8cf0" }} /> Input {tool.inputValue}</span>
                        <span><i style={{ background: "#b9a14a" }} /> Cache {tool.cacheValue}</span>
                        <span><i style={{ background: "#46a37b" }} /> Output {tool.outputValue}</span>
                      </div>
                    </div>
                    <div className="amb-ai-provider-section">
                      <div className="amb-ai-provider-section-head">
                        <strong>Limits</strong>
                        <span>Session, weekly, monthly, or provider-reported usage windows.</span>
                      </div>
                      {tool.limits.length ? (
                        <div className="amb-ai-limit-list">
                          {tool.limits.map((limit) => (
                            <div className="amb-ai-limit-row" key={`${tool.id}-${limit.label}`}>
                              <div>
                                <strong>{limit.label}</strong>
                                <small>{limit.usage} · {limit.reset}</small>
                              </div>
                              <span className="amb-ai-limit-track" aria-hidden>
                                <i style={{ width: `${limit.pct ?? 0}%`, background: limit.pct != null && limit.pct >= 80 ? "#DC2B3F" : tool.color }} />
                              </span>
                              <em>{limit.pct == null ? "—" : `${limit.pct}%`}</em>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="amb-ai-provider-empty">No provider limit window was reported with this usage sync.</div>
                      )}
                    </div>
                    <div className="amb-ai-provider-section">
                      <div className="amb-ai-provider-section-head">
                        <strong>Models</strong>
                        <span>Input, cache, and output rates differ by model; total value uses the reported parts when available.</span>
                      </div>
                      {tool.modelRows.length ? (
                        <div className="amb-ai-model-economics">
                          <div className="head">Model</div>
                          <div className="head">Tokens</div>
                          <div className="head">Input</div>
                          <div className="head">Cache</div>
                          <div className="head">Output</div>
                          <div className="head">Total</div>
                          {tool.modelRows.map((model) => (
                            <div className="amb-ai-model-economic-row" key={`${tool.id}-${model.name}`}>
                              <div><strong>{model.name}</strong><small>{model.rates}</small></div>
                              <div><strong>{model.tokens}</strong><small>{model.mix}</small></div>
                              <div><strong>{model.inputCost}</strong><small>input</small></div>
                              <div><strong>{model.cacheCost}</strong><small>cache</small></div>
                              <div><strong>{model.outputCost}</strong><small>output</small></div>
                              <div><strong>{model.totalValue}</strong><small>API-rate value</small></div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="amb-ai-provider-empty">No model-level token rows have been synced yet.</div>
                      )}
                    </div>
                  </div>
                </details>
              ))}
            </div>
            </div>
            </div>
          </>
        ) : (
          <div className="amb-empty-card">
            <strong>No AI usage connected yet</strong>
            <span>Link your AI tools to compare subscriptions, APIs, and gateways here.</span>
            <Link href="/dashboard?view=connect" prefetch={false} className="amb-btn-sm-dark">
              Connect AI tools
            </Link>
          </div>
        )
      ) : null}

      {view === "connect" ? (
        <>
          <div className="amb-connect-tabs" role="tablist" aria-label="Connect sections">
            {connectTabs.map((tab) => (
              <Link
                key={tab.key}
                href={tab.key === "setup" ? "/dashboard?view=connect" : `/dashboard?view=connect&connectTab=${tab.key}`}
                prefetch={false}
                role="tab"
                aria-selected={connectTab === tab.key}
                className={connectTab === tab.key ? "amb-connect-tab active" : "amb-connect-tab"}
              >
                <span>
                  <strong>{tab.label}</strong>
                  <small>{tab.detail}</small>
                </span>
                {typeof tab.count === "number" ? <em>{tab.count}</em> : null}
              </Link>
            ))}
          </div>

          {connectTab === "setup" ? (
            <div className="amb-connect-tab-panel">
              <div className="amb-banner green">
                <span className="amb-banner-icon" aria-hidden>
                  <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="1.6">
                    <rect x="3" y="7" width="10" height="6.5" rx="1.5" />
                    <path d="M5 7 V5 a3 3 0 0 1 6 0 V7" />
                  </svg>
                </span>
                <div>
                  <strong>Read-only by design</strong>
                  <span>Ambrium uses scoped, read-only credentials. It can see costs and usage — never touch your infrastructure.</span>
                </div>
              </div>

              <div className="amb-agent-card">
                <h3>Set up with an AI agent</h3>
                <p>Run the companion CLI — Claude Code or Codex can drive it while you approve each OAuth, IAM, and token step.</p>
                <div className="amb-cmd">
                  <span className="sigil">$</span>
                  <code>{CLI_BASE}</code>
                  <CopyButton text={CLI_BASE} />
                </div>
              </div>
            </div>
          ) : null}

          {connectTab === "connected" ? (
            <div className="amb-connect-tab-panel">
              <p className="amb-section-label">Connected · {connectedVMs.length}</p>
              {connectedVMs.length > 0 ? (
                <div className="amb-conn-grid">
                  {connectedVMs.map((c) => (
                    <div className="amb-conn" key={c.key}>
                      <span className="amb-mono-badge" style={{ background: c.color }}>
                        {c.monogram}
                      </span>
                      <div className="amb-conn-id">
                        <strong>{c.name}</strong>
                        <small>{c.detail}</small>
                      </div>
                      <div className="amb-conn-status" style={{ color: c.warn ? "#C77B0A" : "#0F9D63" }}>
                        <span className="dot" style={{ background: c.warn ? "#C77B0A" : "#0F9D63" }} />
                        {c.warn ? "Needs attention" : "Connected"}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="amb-empty-card">
                  <strong>No providers connected yet</strong>
                  <span>Use the setup or credentials tabs to connect your first account.</span>
                  <Link href="/dashboard?view=connect&connectTab=credentials" prefetch={false} className="amb-btn-sm-dark">
                    Open credentials
                  </Link>
                </div>
              )}
            </div>
          ) : null}

          {connectTab === "detected" ? (
            <div className="amb-connect-tab-panel">
              {pendingConnections.length > 0 ? (
                <>
                  <p className="amb-section-label">Detected, not connected · {pendingConnections.length}</p>
                  <div className="amb-pending-list">
                    {pendingConnections.map((connection) => {
                      const d = provMono(connection.provider)
                      const cmd = `${CLI_BASE} ${connection.provider}`
                      return (
                        <div className="amb-pending" key={connection.provider}>
                          <div className="amb-pending-head">
                            <span className="amb-mono-badge" style={{ background: d.color }}>
                              {d.m}
                            </span>
                            <div className="amb-pending-id">
                              <strong>{providerName(connection.provider)}</strong>
                              <small>{connection.detected ? "Detected in your projects" : statusText(connection)}</small>
                            </div>
                            <Link href="/dashboard?view=connect&connectTab=credentials" prefetch={false} className="amb-btn-sm-dark">
                              Connect
                            </Link>
                          </div>
                          <div className="amb-cmd light">
                            <span className="sigil">$</span>
                            <code>{cmd}</code>
                            <CopyButton text={cmd} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </>
              ) : (
                <div className="amb-empty-card">
                  <strong>No detected providers waiting</strong>
                  <span>Synced repositories are either connected already or do not expose new provider signals yet.</span>
                </div>
              )}
            </div>
          ) : null}

          {connectTab === "credentials" ? (
            <div className="amb-connect-tab-panel">
              <div className="amb-legacy" id="credentials">
                <p className="amb-legacy-head">Manage &amp; credentials</p>
                <RepoSyncPanel initialState={state} />
                <ProviderConnectPanel providerConnections={analysis.providerConnections} initialState={state} />
                <AiSyncPanel initialState={state} />
                <CustomProviderPanel initialState={state} />
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  )
}

function ProviderAccordion({
  analysis,
  connection,
  repoFullName,
  repoShort,
  assignments,
  repoLabels,
  splitAcross,
  costDataOff = false,
}: {
  analysis: AnalysisResult
  connection: ProviderConnection
  repoFullName: string
  repoShort: string
  assignments: Record<string, string>
  repoLabels: Record<string, string>
  splitAcross: number
  costDataOff?: boolean
}) {
  const rows = providerRows(connection.provider, analysis.costRows)
  const projectRows = rows
    .map((row) => assignedCostRowForRepo(row, assignments, repoFullName, repoShort, splitAcross))
    .filter((row): row is NormalizedCostRow => Boolean(row))
  const restRows = rows.filter((row) => !isAssignedHere(row, assignments, repoFullName, repoShort))
  const projectTotal = sumCost(projectRows)
  const restTotal = Math.max(sumCost(rows) - projectTotal, 0)
  const signals = providerSignals(connection.provider, analysis.signals)
  const freeTier = providerFreeTier(connection.provider, analysis.freeTier)
  const resourceItems = (analysis.resourceItems ?? []).filter((item) => item.provider === connection.provider)
  const hasResources = resourceItems.length > 0
  const assignedResources = resourceItems.filter((item) =>
    isKeyAssignedHere(item.itemKey, item.attributedRepo, assignments, repoFullName, repoShort)
  )
  // When a provider exposes per-resource usage (Cloudflare), the repo's usage is
  // re-derived from just the resources assigned to it; metrics no resource maps
  // to (R2, D1, …) stay account-wide.
  const projectUsageRows = hasResources ? resourceUsageRows(connection.provider, assignedResources) : []
  const coveredServices = new Set(
    resourceItems.map((item) => resourceMetricService(item.kind)).filter((service): service is string => Boolean(service))
  )
  const accountWideUsage = hasResources ? freeTier.filter((row) => !coveredServices.has(row.service)) : freeTier
  const hasCost = rows.length > 0
  const hasProjectCost = projectRows.length > 0
  const hasUsage = freeTier.length > 0
  const sync = analysis.liveSync.find((entry) => entry.provider === connection.provider)
  const hasMeasuredUsage = freeTier.some((row) => row.source === "measured")
  // Surface why usage/cost is empty when connected but a sync errored, or usage
  // could not be measured (e.g. a token missing Account Analytics: Read).
  const showSyncNote =
    connection.status === "connected" && sync && (sync.status === "error" || (hasUsage && !hasMeasuredUsage && sync.message.length > 0))

  const statusTone =
    connection.status === "connected"
      ? "connected"
      : connection.status === "setup_required"
        ? "warn"
        : "muted"

  return (
    <details className="provider-accordion">
      <summary>
        <ProviderLogo provider={connection.provider} />
        <div className="provider-sum-id">
          <strong>{providerName(connection.provider)}</strong>
          <small>
            <span className={`status-chip ${statusTone}`}>{statusText(connection)}</span>
            <span className="sum-meta">
              {signals.length} {signals.length === 1 ? "signal" : "signals"}
              {hasCost ? ` · ${rows.length} ${rows.length === 1 ? "row" : "rows"}` : ""}
              {hasUsage ? ` · ${freeTier.length} usage` : ""}
            </span>
          </small>
        </div>
        <div className="provider-sum-amount">
          {hasProjectCost ? (
            <strong>{money(projectTotal)}</strong>
          ) : (
            <span className={`amount-tag ${costDataOff ? "warn" : hasUsage ? "ok" : restTotal > 0.005 ? "muted" : "muted"}`}>
              {costDataOff ? "Cost off" : restTotal > 0.005 ? "Account-level" : hasUsage ? "Free tier" : "No cost"}
            </span>
          )}
          <small>
            {restTotal > 0.005
              ? `+ ${money(restTotal)} rest of account`
              : costDataOff
                ? "enable cost data"
                : hasProjectCost && hasUsage
                  ? "+ usage tracked"
                  : hasUsage
                    ? "within free tier"
                    : "no live data"}
          </small>
        </div>
        <ChevronDown aria-hidden />
      </summary>
      <div className="provider-detail-body">
        {connection.status !== "connected" && connection.detected ? (
          <div className="provider-warning">
            <ShieldAlert aria-hidden />
            <span>{connection.setupNotes}</span>
          </div>
        ) : null}
        {showSyncNote && sync ? (
          <div className="provider-warning">
            <ShieldAlert aria-hidden />
            <span>{sync.message}</span>
          </div>
        ) : null}

        <div className="provider-detail-tabs">
          <input
            className="provider-tab-input cost"
            type="radio"
            id={`${connection.provider}-cost-tab`}
            name={`${connection.provider}-detail-tab`}
            defaultChecked
          />
          <input
            className="provider-tab-input evidence"
            type="radio"
            id={`${connection.provider}-evidence-tab`}
            name={`${connection.provider}-detail-tab`}
          />
          <div className="provider-tab-list" role="group" aria-label={`${providerName(connection.provider)} details`}>
            <label className="provider-tab cost" htmlFor={`${connection.provider}-cost-tab`}>
              Cost
            </label>
            <label className="provider-tab evidence" htmlFor={`${connection.provider}-evidence-tab`}>
              Repo evidence
            </label>
          </div>

          <div className="provider-tab-panels">
            <section className="provider-tab-panel cost">
              <h3>Live resources and cost</h3>
              {costDataOff ? (
                <div className="provider-warning">
                  <ShieldAlert aria-hidden />
                  <span>
                    Cost data is off, so your AWS spend isn’t shown — this is not a confirmation that everything is
                    free. If you have paid resources running, turn on <b>Pull cost data</b> on the AWS card above
                    ($0.01 per refresh) to see your actual cost.
                  </span>
                </div>
              ) : null}

              {projectRows.length ? (
                <ProviderCostPanel
                  rows={projectRows}
                  repoFullName={repoFullName}
                  selectedShort={repoShort}
                  assignments={assignments}
                  repoLabels={repoLabels}
                />
              ) : null}
              {!projectRows.length && !projectUsageRows.length && !costDataOff ? (
                <div className="empty-provider-block">
                  <DatabaseZap aria-hidden />
                  <span>
                    No cost or resource usage is assigned to this project.
                  </span>
                </div>
              ) : null}
              {projectUsageRows.length ? (
                <FreeTierUsage
                  rows={projectUsageRows}
                  hasCost={hasCost}
                  heading="This project’s usage"
                  subtext="Re-derived from the resources assigned to this repo."
                />
              ) : null}
              {assignedResources.length ? (
                <ProviderResourcePanel
                  items={assignedResources}
                  repoFullName={repoFullName}
                  selectedShort={repoShort}
                  assignments={assignments}
                  repoLabels={repoLabels}
                />
              ) : null}
              {restRows.length || accountWideUsage.length || resourceItems.length > assignedResources.length ? (
                <details className="account-detail-disclosure">
                  <summary>
                    <Layers aria-hidden />
                    <span>
                      <strong>Account-wide usage and unassigned resources</strong>
                      <small>Shared data and items not currently assigned to this project.</small>
                    </span>
                    <ChevronDown aria-hidden />
                  </summary>
                  <div className="account-detail-content">
                    {restRows.length ? (
                      <ProviderCostPanel
                        rows={restRows}
                        repoFullName={repoFullName}
                        selectedShort={repoShort}
                        assignments={assignments}
                        repoLabels={repoLabels}
                      />
                    ) : null}
                    {accountWideUsage.length ? (
                      <FreeTierUsage
                        rows={accountWideUsage}
                        hasCost={hasCost}
                        heading="Account-wide usage"
                        subtext="Shared across the whole provider account."
                      />
                    ) : null}
                    {resourceItems.length > assignedResources.length ? (
                      <ProviderResourcePanel
                        items={resourceItems.filter((item) => !assignedResources.includes(item))}
                        repoFullName={repoFullName}
                        selectedShort={repoShort}
                        assignments={assignments}
                        repoLabels={repoLabels}
                      />
                    ) : null}
                  </div>
                </details>
              ) : null}
            </section>
            <section className="provider-tab-panel evidence">
              <h3>Repo evidence</h3>
              {signals.length ? (
                <div className="signal-compact-list">
                  {signals.map((signal) => (
                    <article key={signal.id}>
                      <Signal aria-hidden />
                      <div>
                        <strong>{signal.title}</strong>
                        <span>{signal.sourcePath}</span>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-provider-block">
                  <Signal aria-hidden />
                  <span>No repo evidence found for this provider.</span>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </details>
  )
}

function RepoDetail({
  analysis,
  repo,
  state,
  range,
  rangeSpend,
}: {
  analysis: AnalysisResult
  repo: GitHubRepoSummary | null
  state: Awaited<ReturnType<typeof publicStore>>
  range: ResolvedDateRange
  rangeSpend: RangeSpendSummary | null
}) {
  const scannedRepo = currentRepoFullName(analysis)
  const selectedName = repo?.fullName ?? scannedRepo
  const hasScan = selectedName === scannedRepo
  const connectedProviders = CONNECTABLE_PROVIDERS.filter((provider) => state.connections[provider]?.status === "connected")
  const detectedProviders = [...new Set(analysis.signals.map((signal) => signal.provider))]
  const linked = resolveLinkedProviders({
    explicit: state.repoProviderLinks[selectedName],
    detected: detectedProviders,
    connected: connectedProviders,
  })
  const linkedSet = new Set<Provider>(linked)
  const repoShort = analysis.repo.name.toLowerCase()
  const assignments = state.costAssignments
  const repoLabels = Object.fromEntries(state.githubRepos.map((entry) => [entry.fullName, entry.name]))
  const linkedCostRows = analysis.costRows.filter((row) => linkedSet.has(row.provider))
  // Within the linked accounts, split the cost actually tied to this project
  // (auto-attributed or manually assigned) from the rest of those accounts.
  const splitAcross = Math.max(state.syncedRepoFullNames.length, 1)
  const projectCostRows = linkedCostRows
    .map((row) => assignedCostRowForRepo(row, assignments, selectedName, repoShort, splitAcross))
    .filter((row): row is NormalizedCostRow => Boolean(row))
  const projectTotal = sumCost(projectCostRows)
  const restTotal = Math.max(sumCost(linkedCostRows) - projectTotal, 0)
  // Range total for this project: live assigned cost for the current month
  // plus this repo's analytics history for the range's past months.
  const projectRangeTotal = (range.includesCurrentMonth ? projectTotal : 0) + (rangeSpend?.byRepo[selectedName] ?? 0)
  const historyMissing = !range.isCurrentMonthOnly && rangeSpend?.available !== true
  const measuredUsageCount = analysis.freeTier.filter((row) => row.source === "measured" && linkedSet.has(row.provider)).length
  const linkedConnections = analysis.providerConnections.filter((connection) => linkedSet.has(connection.provider))
  // Providers this repo detected that can't be linked because they aren't
  // connected yet — the picker points the user to the Overview to connect them.
  const detectedNotConnected = detectedProviders.filter(
    (provider) => CONNECTABLE_PROVIDERS.includes(provider) && !connectedProviders.includes(provider)
  )

  return (
    <>
      <Link href="/dashboard" prefetch={false} className="back-link">
        <ArrowLeft aria-hidden />
        Overview
      </Link>

      <section className="repo-detail-hero" aria-label="Repository detail">
        <div>
          <p>Project Drill-Down</p>
          <h1>{selectedName}</h1>
          <span>{hasScan ? analysis.repo.path : "Synced repository. Remote scan data is not available yet."}</span>
        </div>
        <div className="repo-detail-totals">
          <div>
            <span>Linked accounts</span>
            <strong>{hasScan ? linked.length : 0}</strong>
          </div>
          <div>
            <span>Repo signals</span>
            <strong>{hasScan ? analysis.summary.signals : 0}</strong>
          </div>
        </div>
      </section>

      {hasScan ? (
        <>
          <div className="ai-kpis repo-kpis">
            <article>
              <Coins aria-hidden />
              <span>This project</span>
              <strong>{money(projectRangeTotal)}</strong>
              <small>
                {range.isCurrentMonthOnly
                  ? "assigned cost this month"
                  : historyMissing
                    ? `${range.label} · history unavailable`
                    : `assigned · ${monthSpanLabel(range)}`}
              </small>
            </article>
            <article><Layers aria-hidden /><span>Rest of accounts</span><strong>{money(restTotal)}</strong><small>account-level, not this repo</small></article>
            <article><Boxes aria-hidden /><span>Linked accounts</span><strong>{linked.length}</strong><small>providers this repo uses</small></article>
            <article><Signal aria-hidden /><span>Repo signals</span><strong>{analysis.summary.signals}</strong><small>infra detected in code</small></article>
          </div>

          <CostOverview
            eyebrow={`This Project · ${monthLabel(analysis.period)}`}
            rows={projectCostRows}
            measuredUsageCount={measuredUsageCount}
            emptyNote={
              linked.length === 0
                ? "No accounts linked to this repo yet. Tick the accounts it uses below to see its cost."
                : restTotal > 0.005
                  ? "No cost is tied directly to this project — it's all account-level in the linked accounts (see below)."
                  : "No billed cost for the linked accounts this month — usage shows under each account below."
            }
            footnote={
              restTotal > 0.005 ? (
                <>
                  <Layers aria-hidden />
                  <span>
                    <strong>{money(restTotal)}</strong> more is billed to the linked accounts but isn’t tied to this
                    project — expand an account below to see it.
                  </span>
                </>
              ) : null
            }
          />

          <HistoricalAnalyticsPanel repo={selectedName} currentMonth={analysis.period.from.slice(0, 7)} />

          <RepoAccountPicker
            repo={selectedName}
            connected={connectedProviders.map((provider) => ({
              provider,
              accountLabel: state.connections[provider]?.accountLabel ?? null,
            }))}
            detectedNotConnected={detectedNotConnected}
            linked={linked}
          />

          {linked.length > 0 ? (
            <section className="provider-deep-dive" aria-label="Linked account cost breakdown">
              <div className="deep-dive-heading">
                <div>
                  <p>Linked Accounts</p>
                  <h2>Expand an account for exact cost rows, usage, and repo evidence</h2>
                  <span className="live-cost-note">Only live billing sources produce dollar amounts — nothing here is estimated.</span>
                </div>
                <Layers aria-hidden />
              </div>
              {linkedConnections.map((connection) => {
                const meta = state.connections[connection.provider]?.metadata as { costExplorer?: boolean } | undefined
                // AWS only pulls spend when Cost Explorer is opted in; otherwise we
                // have not checked cost, so don't imply "free tier".
                const costDataOff =
                  connection.provider === "aws" && connection.status === "connected" && meta?.costExplorer !== true
                return (
                  <ProviderAccordion
                    key={connection.provider}
                    analysis={analysis}
                    connection={connection}
                    repoFullName={selectedName}
                    repoShort={repoShort}
                    assignments={assignments}
                    repoLabels={repoLabels}
                    splitAcross={splitAcross}
                    costDataOff={costDataOff}
                  />
                )
              })}
            </section>
          ) : null}
        </>
      ) : (
        <section className="provider-deep-dive pending-scan">
          <FolderGit2 aria-hidden />
          <h2>Remote repo scanning is the next backend step</h2>
          <p>This repository is synced and appears on your dashboard. Cost/provider detail will populate after the GitHub API scanner reads this repo’s files.</p>
        </section>
      )}

      <RepoSyncPanel initialState={state} />
    </>
  )
}

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Clerk middleware (src/proxy.ts) already gates this route, so an
  // unauthenticated request is redirected to /sign-in before reaching here. The
  // guard remains as a defensive fallback.
  const user = await currentUserFromCookies()
  if (!user) redirect("/sign-in")

  const params = await searchParams
  const rawRepo = params.repo
  const requestedRepo = Array.isArray(rawRepo) ? rawRepo[0] : rawRepo ?? null
  const rawView = Array.isArray(params.view) ? params.view[0] : params.view
  const view: ViewKey =
    rawView === "limits" ||
    rawView === "leaks" ||
    rawView === "ai" ||
    rawView === "insights" ||
    rawView === "connect" ||
    rawView === "projects"
      ? rawView
      : rawView === "repos"
        ? "projects"
        : rawView === "credentials"
          ? "connect"
          : "projects"
  const rawConnectTab = Array.isArray(params.connectTab) ? params.connectTab[0] : params.connectTab
  const connectTab: ConnectTabKey =
    rawConnectTab === "connected" || rawConnectTab === "detected" || rawConnectTab === "credentials"
      ? rawConnectTab
      : "setup"
  // Selected reporting range (?range=). Defaults to the current month; past
  // months come from the analytics history, the current month from the live
  // snapshot — never both for the same month.
  const rawRange = Array.isArray(params.range) ? params.range[0] : params.range
  const range = resolveDateRange(rawRange ?? null)
  const dashboardStore = await readDashboardStore(user.id)
  const state = { user, ...dashboardStore.publicState }
  const workspace = dashboardStore.workspace
  const repoAnalyses = Object.fromEntries(
    Object.entries(workspace.analysisSnapshots)
      .filter(([key]) => key !== "__overview__" && key !== "__local__")
      .map(([key, value]) => [key, clampAnalysisToCurrentMonth(value.analysis)])
  )
  // Renders from the persisted snapshot (DB read). Live provider/GitHub data is
  // refreshed out-of-band by <AnalysisRefresher>, not on every page load. The
  // clamp drops any rows from a previous billing month (see its doc comment).
  const snapshot =
    workspace.analysisSnapshots[snapshotKeyForRepo(requestedRepo)] ??
    await getOrCreateAnalysisSnapshot({
      userId: user.id,
      requestedRepo,
      githubRepos: state.githubRepos,
    })
  const analysis = clampAnalysisToCurrentMonth(snapshot.analysis)
  const repos = repoList(state)

  // Historical portion of the selected range (months strictly before the
  // current one), from the analytics store. Bounded wait: if history can't be
  // read in time, render with available:false so the UI says so instead of
  // silently reporting $0 for past months.
  const pastMonths = pastMonthsOf(range)
  let rangeSpend: RangeSpendSummary | null = null
  if (pastMonths.length > 0) {
    try {
      rangeSpend = await Promise.race([
        getRangeSpendSummary({ userId: user.id, months: pastMonths }),
        new Promise<RangeSpendSummary>((resolve) =>
          setTimeout(() => resolve({ available: false, total: 0, byMonth: [], byProvider: [], byRepo: {} }), 5_000)
        ),
      ])
    } catch {
      rangeSpend = { available: false, total: 0, byMonth: [], byProvider: [], byRepo: {} }
    }
  }
  const selectedRepo = requestedRepo ? repos.find((repo) => repo.fullName === requestedRepo) ?? null : null

  // Lightweight derivation for the sidebar: a leak badge count + freshness label.
  // (RepositoryDashboard recomputes the full set; these pure helpers are cheap.)
  const connectedProviders = CONNECTABLE_PROVIDERS.filter((provider) => state.connections[provider]?.status === "connected")
  const { elapsedDays, totalDays } = periodProgress(analysis.period)
  const latestSyncVal =
    analysis.liveSync
      .filter((entry) => entry.status === "success")
      .map((entry) => entry.syncedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null
  const latestSyncTime = latestSyncVal ? new Date(latestSyncVal).getTime() : Number.NaN
  const latestMs = Number.isFinite(latestSyncTime) ? Math.max(Date.now() - latestSyncTime, 0) : null
  const sidebarProjects = buildIndieProjects({ repos, analysis, repoAnalyses, connectedProviders, state, elapsedDays, totalDays })
  const leakCount = buildLeakCandidates({
    analysis,
    projects: sidebarProjects,
    assignments: state.costAssignments,
    syncedRepoFullNames: state.syncedRepoFullNames,
    latestMs,
  }).length
  const rangeSuffix = range.key === "this-month" ? "" : `range=${encodeURIComponent(String(range.key))}`
  const refreshHref = requestedRepo
    ? `/dashboard?repo=${encodeURIComponent(requestedRepo)}${rangeSuffix ? `&${rangeSuffix}` : ""}`
    : view === "projects"
      ? rangeSuffix
        ? `/dashboard?${rangeSuffix}`
        : "/dashboard"
      : `/dashboard?view=${view}`

  // Real per-repo monthly history for the Projects sparklines. Only needed for
  // the Projects view; guarded so a disabled/unreachable analytics store yields
  // {} (no trend) instead of breaking the page.
  let repoTrends: Record<string, Array<{ month: string; total: number }>> = {}
  if (!requestedRepo && view === "projects") {
    const currentMonth = analysis.period.from.slice(0, 7)
    const [y, m] = currentMonth.split("-").map(Number)
    const fromDate = new Date(Date.UTC(y, m - 1 - 5, 1))
    const fromMonth = `${fromDate.getUTCFullYear()}-${String(fromDate.getUTCMonth() + 1).padStart(2, "0")}`
    try {
      // Sparkline history comes from MotherDuck (OLAP) over a fresh connection,
      // which can take seconds when the pool is cold. The sparklines are
      // decorative, so cap the wait: if history isn't back in time, render the
      // page now with no trend rather than freezing the whole dashboard on it.
      repoTrends = await Promise.race([
        getMonthlyTotalsByRepo({ userId: user.id, from: fromMonth, to: currentMonth }),
        new Promise<Record<string, Array<{ month: string; total: number }>>>((resolve) =>
          setTimeout(() => resolve({}), 1_500)
        ),
      ])
    } catch {
      repoTrends = {}
    }
  }

  // The range selector is shown where spend is reported over time (Projects
  // overview + repo drill-down). Limits/leaks/AI/connect describe current
  // state, so they keep a static current-month chip.
  const rangeSupported = Boolean(requestedRepo) || view === "projects"
  const rangeParams: Record<string, string> | null = rangeSupported
    ? requestedRepo
      ? { repo: requestedRepo }
      : {}
    : null

  return (
    <main className="amb-app">
      <AnalysisRefresher repo={requestedRepo} computedAt={snapshot.computedAt} />
      <Sidebar view={view} leakCount={leakCount} email={user.email} updatedLabel={`Updated ${shortAge(latestSyncVal)}`} />
      <div className="amb-main">
        <AppHeader view={view} range={range} rangeParams={rangeParams} refreshHref={refreshHref} />
        <div className="amb-content">
          {requestedRepo ? (
            <div className="amb-legacy" style={{ marginTop: 0 }}>
              <RepoDetail analysis={analysis} repo={selectedRepo} state={state} range={range} rangeSpend={rangeSpend} />
            </div>
          ) : (
            <RepositoryDashboard
              analysis={analysis}
              repos={repos}
              selectedRepo={state.selectedRepoFullName}
              state={state}
              repoAnalyses={repoAnalyses}
              view={view}
              connectTab={connectTab}
              repoTrends={repoTrends}
              range={range}
              rangeSpend={rangeSpend}
            />
          )}
        </div>
      </div>
    </main>
  )
}
