import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  ChevronDown,
  CloudCog,
  Coins,
  DatabaseZap,
  FolderGit2,
  Gauge,
  Layers,
  RefreshCw,
  ShieldAlert,
  Signal,
  TerminalSquare,
  TrendingUp,
  Wallet,
} from "lucide-react"
import type { ReactNode } from "react"
import Link from "next/link"
import { redirect } from "next/navigation"
import { RepoSyncPanel } from "../RepoSyncPanel"
import { ProviderConnectPanel } from "../ProviderConnectPanel"
import { CustomProviderPanel } from "../CustomProviderPanel"
import { AiSyncPanel } from "../AiSyncPanel"
import { AiInsights, type AiToolData } from "../AiInsights"
import { BudgetForecast } from "../BudgetForecast"
import { RepoAccountPicker } from "../RepoAccountPicker"
import { ProviderCostPanel } from "../ProviderCostPanel"
import { ProviderResourcePanel } from "../ProviderResourcePanel"
import { AnalysisRefresher } from "../AnalysisRefresher"
import { ProviderLogo } from "../ProviderLogo"
import { SignOutButton } from "../SignOutButton"
import { ThemeToggle } from "../ThemeToggle"
import { HistoricalAnalyticsPanel } from "../HistoricalAnalyticsPanel"
import { RepoHomeCard } from "../RepoHomeCard"
import { UnassignedCostQueue, type AssignmentQueueItem } from "../UnassignedCostQueue"
import { getOrCreateAnalysisSnapshot, snapshotKeyForRepo } from "@/lib/analysisService"
import { currentUserFromCookies } from "@/lib/localAuth"
import { publicStore, readDashboardStore } from "@/lib/localStore"
import { CONNECTABLE_PROVIDERS, resolveLinkedProviders } from "@/lib/repoLinks"
import { ACCOUNT_SENTINEL, costItemKey, isAssignedHere, isKeyAssignedHere } from "@/lib/costAttribution"
import { resourceMetricService, resourceUsageRows } from "@/lib/freeTier"
import { buildCloudProviderReports, type CloudProviderReport } from "@/lib/cloudReporting"
import type { AnalysisResult, FreeTierUsageRow, GitHubRepoSummary, NormalizedCostRow, Provider, ProviderConnection, RepoSignal } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Indie-first app sections, selected by ?view=. Projects is the default product
// surface; old query values are accepted as aliases below for existing links.
type ViewKey = "projects" | "limits" | "leaks" | "ai" | "connect"

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

// Roll cost rows up to one entry per provider+service so the dashboard can rank
// "where the money goes" without double-counting individual line items.
function breakdownByService(rows: NormalizedCostRow[]) {
  const totals = new Map<string, { provider: Provider; serviceName: string; total: number }>()
  for (const row of rows) {
    const key = `${row.provider}:${row.serviceName}`
    const existing = totals.get(key)
    if (existing) existing.total += row.cost
    else totals.set(key, { provider: row.provider, serviceName: row.serviceName, total: row.cost })
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
}): NormalizedCostRow[] {
  const repoShortName = input.repo.name.toLowerCase()
  const candidateRows = [...(input.repoAnalysis?.costRows ?? []), ...input.accountAnalysis.costRows]
  const uniqueRows = [...new Map(candidateRows.map((row) => [costItemKey(row), row])).values()]
  return uniqueRows.filter((row) => isAssignedHere(row, input.assignments, input.repo.fullName, repoShortName))
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
    const linked = resolveLinkedProviders({
      explicit: input.state.repoProviderLinks[repo.fullName],
      detected: detectedProviders,
      connected: input.connectedProviders,
    })
    const rows = projectCostRows({
      repo,
      repoAnalysis,
      accountAnalysis: input.analysis,
      assignments: input.state.costAssignments,
    })
    const cost = sumCost(rows)
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
    return { repo, cost, projected, dailyRate, linked, signalCount, rowCount: rows.length, lastActivityAt, inactiveDays, status, statusLabel, detail }
  }).sort((a, b) => b.cost - a.cost || b.signalCount - a.signalCount || a.repo.name.localeCompare(b.repo.name))
}

function ProjectCostCockpit({ projects }: { projects: IndieProjectRow[] }) {
  const costing = projects.filter((project) => project.cost > 0.005)
  const total = costing.reduce((sum, project) => sum + project.cost, 0)
  const top = projects.slice(0, 6)

  return (
    <section className="project-cockpit" aria-label="Project costs">
      <div className="insight-panel-head">
        <div>
          <p>Projects</p>
          <h2>{projects.length ? `${projects.length} project${projects.length === 1 ? "" : "s"}` : "No projects yet"}</h2>
          <span>{costing.length ? `${money(total)} assigned this month across ${costing.length} costing project${costing.length === 1 ? "" : "s"}.` : "Connect GitHub and providers to see what each app or side project costs."}</span>
        </div>
        <FolderGit2 aria-hidden />
      </div>

      {top.length ? (
        <div className="project-cockpit-list">
          {top.map((project) => (
            <Link key={project.repo.fullName} href={`/dashboard?repo=${encodeURIComponent(project.repo.fullName)}`} prefetch={false} className={`project-cockpit-row ${project.status}`}>
              <span className="project-cockpit-name">
                <strong title={project.repo.fullName}>{project.repo.name}</strong>
                <small>{project.detail}</small>
              </span>
              <span className={`project-status ${project.status}`}>{project.statusLabel}</span>
              <span className="project-cockpit-money">
                <strong>{money(project.cost)}</strong>
                <small>{project.projected > project.cost + 0.005 ? `${money(project.projected)} projected` : `${project.rowCount} ${project.rowCount === 1 ? "row" : "rows"}`}</small>
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="cost-overview-empty">
          <FolderGit2 aria-hidden />
          <span>No synced projects yet. Use the CLI or GitHub connection to map repos to running infrastructure.</span>
        </div>
      )}
    </section>
  )
}

function FreeTierRunwayPanel({ rows }: { rows: FreeTierUsageRow[] }) {
  const measured = rows.filter((row) => row.source === "measured")
  const risky = measured
    .filter((row) => row.limit !== null && row.percentUsed !== null)
    .sort((a, b) => (b.percentUsed ?? 0) - (a.percentUsed ?? 0))
    .slice(0, 6)
  const unknownLimit = measured.filter((row) => row.limit === null).length
  const safe = measured.length - risky.filter((row) => (row.percentUsed ?? 0) >= 80).length

  return (
    <section className="runway-panel" aria-label="Free-tier runway">
      <div className="insight-panel-head">
        <div>
          <p>Limits</p>
          <h2>Free-tier runway</h2>
          <span>{measured.length ? `${measured.length} live usage metric${measured.length === 1 ? "" : "s"} checked across connected providers.` : "Connect providers to see usage before it becomes spend."}</span>
        </div>
        <Gauge aria-hidden />
      </div>

      <div className="runway-summary">
        <article>
          <strong>{risky.filter((row) => (row.percentUsed ?? 0) >= 80).length}</strong>
          <span>near limit</span>
        </article>
        <article>
          <strong>{safe}</strong>
          <span>with headroom</span>
        </article>
        <article>
          <strong>{unknownLimit}</strong>
          <span>usage only</span>
        </article>
      </div>

      {risky.length ? (
        <div className="runway-list">
          {risky.map((row) => {
            const pct = Math.round(row.percentUsed ?? 0)
            const tone = pct >= 95 ? "crit" : pct >= 80 ? "warn" : "ok"
            return (
              <article key={`${row.provider}-${row.service}`} className={`runway-row ${tone}`}>
                <div>
                  <strong>{providerName(row.provider)} · {row.service}</strong>
                  <span>{quantity(row.used ?? 0)} of {quantity(row.limit ?? 0)} {row.unit} used</span>
                </div>
                <b>{pct}%</b>
              </article>
            )
          })}
        </div>
      ) : (
        <div className="attention-clear compact">
          <CheckCircle2 aria-hidden />
          <span>{measured.length ? "Measured free-tier metrics have headroom." : "No measured free-tier usage yet."}</span>
        </div>
      )}
    </section>
  )
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

function repoCandidates(repos: GitHubRepoSummary[]) {
  return repos.map((repo) => ({ fullName: repo.fullName, name: repo.name }))
}

function suggestedReposForRow(row: NormalizedCostRow, repos: GitHubRepoSummary[]) {
  const haystack = `${row.serviceName} ${row.resourceName ?? ""} ${row.resourceId ?? ""} ${row.attributionReason}`.toLowerCase()
  const matches = repos.filter((repo) => haystack.includes(repo.name.toLowerCase()))
  return (matches.length ? matches : repos).slice(0, 3).map((repo) => ({ fullName: repo.fullName, name: repo.name }))
}

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

function DemoWorkspacePreview() {
  const rows = [
    { project: "my-saas", now: "$18.42", projected: "$27.10", status: "OK", tone: "ok" },
    { project: "ai-bot", now: "$4.30", projected: "$31.00", status: "OpenAI spike", tone: "warn" },
    { project: "old-demo", now: "$7.80", projected: "$7.80", status: "No recent activity", tone: "stale" },
    { project: "portfolio", now: "$0.00", projected: "$0.00", status: "Free tier", tone: "free" },
  ]
  return (
    <section className="demo-workspace" aria-label="Demo workspace preview">
      <div className="insight-panel-head">
        <div>
          <p>Sample workspace</p>
          <h2>See the value before connecting accounts</h2>
          <span>This is the target five-minute outcome: projects, runway, leaks, and AI spend in one readable cockpit.</span>
        </div>
        <DatabaseZap aria-hidden />
      </div>
      <div className="demo-table">
        <div className="demo-table-head">
          <span>Project</span>
          <span>This month</span>
          <span>Projected</span>
          <span>Status</span>
        </div>
        {rows.map((row) => (
          <article key={row.project} className={`demo-row ${row.tone}`}>
            <strong>{row.project}</strong>
            <span>{row.now}</span>
            <span>{row.projected}</span>
            <b>{row.status}</b>
          </article>
        ))}
      </div>
      <div className="demo-insights">
        <article><Gauge aria-hidden /><strong>72%</strong><span>Cloudflare Workers free requests used</span></article>
        <article><ShieldAlert aria-hidden /><strong>$7.80</strong><span>stale project still billing</span></article>
        <article><Boxes aria-hidden /><strong>2.4x</strong><span>Claude plan value at API rates</span></article>
      </div>
      <div className="demo-actions">
        <a href="/dashboard?view=connect" className="command-button">Connect my workspace</a>
        <a href="/dashboard?view=ai" className="ghost-button">View AI analysis</a>
      </div>
    </section>
  )
}

function CostLeakPanel({ leaks }: { leaks: LeakCandidate[] }) {
  return (
    <section className="leak-panel" aria-label="Cost leak candidates">
      <div className="insight-panel-head">
        <div>
          <p>Leaks</p>
          <h2>Cost leak candidates</h2>
          <span>Places where spend is unmapped, inferred, stale, or blocked by a provider connection issue.</span>
        </div>
        <ShieldAlert aria-hidden />
      </div>

      {leaks.length ? (
        <div className="leak-list">
          {leaks.map((leak) => (
            <article key={leak.id} className={`leak-row ${leak.severity}`}>
              <span className="attention-icon" aria-hidden>
                {leak.severity === "warn" || leak.severity === "crit" ? <AlertTriangle /> : <ShieldAlert />}
              </span>
              <div>
                <strong>{leak.title}</strong>
                <span>{leak.detail}</span>
              </div>
              {leak.amount != null ? <b>{money(leak.amount)}</b> : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="attention-clear compact">
          <CheckCircle2 aria-hidden />
          <span>No obvious leaks. Spend is mapped, refreshes are clean, and inferred rows are under control.</span>
        </div>
      )}
    </section>
  )
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

// Bumped every deploy — a visible marker so it's obvious which build is live.
const BUILD_TAG = "build jun25·direct-layout"

function Header({ subtitle }: { subtitle: string }) {
  return (
    <header className="topbar clean">
      <div className="brand">
        <span className="brand-mark">
          <CloudCog aria-hidden />
        </span>
        <div>
          <strong>Ambrium <span className="build-tag" title="deployed build">{BUILD_TAG}</span></strong>
          <small>{subtitle}</small>
        </div>
      </div>
      <div className="top-actions">
        <a href="/pricing" className="link-button">
          Pricing <ArrowUpRight aria-hidden />
        </a>
        <a href="/api/analyze" className="link-button">
          API JSON <ArrowUpRight aria-hidden />
        </a>
        <a href="/dashboard" className="icon-button" aria-label="Refresh">
          <RefreshCw aria-hidden />
        </a>
        <ThemeToggle />
        <SignOutButton />
      </div>
    </header>
  )
}

function ViewTabs({ view }: { view: ViewKey }) {
  const tabs: Array<{ key: ViewKey; label: string; icon: typeof Gauge; href: string }> = [
    { key: "projects", label: "Projects", icon: FolderGit2, href: "/dashboard" },
    { key: "limits", label: "Limits", icon: Gauge, href: "/dashboard?view=limits" },
    { key: "leaks", label: "Leaks", icon: ShieldAlert, href: "/dashboard?view=leaks" },
    { key: "ai", label: "AI", icon: Boxes, href: "/dashboard?view=ai" },
    { key: "connect", label: "Connect", icon: TerminalSquare, href: "/dashboard?view=connect" },
  ]
  return (
    <nav className="view-tabs" aria-label="Sections">
      {tabs.map(({ key, label, icon: Icon, href }) => (
        <Link
          key={key}
          href={href}
          prefetch={false}
          className={view === key ? "view-tab active" : "view-tab"}
          aria-current={view === key ? "page" : undefined}
        >
          <Icon aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  )
}

function AccountsBoard({ accounts }: { accounts: AccountEntry[] }) {
  if (accounts.length === 0) {
    return (
      <section className="accounts-board empty" aria-label="Connected accounts">
        <ShieldAlert aria-hidden />
        <div>
          <strong>Connect a provider account to begin</strong>
          <span>Cost and usage are pulled from your provider accounts. Connect at least one below, then link repos to it.</span>
        </div>
      </section>
    )
  }
  return (
    <section className="accounts-board" aria-label="Connected accounts">
      <h3>Connected accounts</h3>
      <div className="accounts-board-list">
        {accounts.map((entry) => (
          <div key={entry.key} className="account-board-row">
            <span className="cost-legend-dot" style={{ background: providerColor(entry.provider) }} aria-hidden />
            <ProviderLogo provider={entry.provider} />
            <span className="account-board-id">
              <strong>{entry.label}</strong>
              <small>{entry.accountLabel ?? "Connected"}</small>
            </span>
            {entry.cost > 0.005 ? (
              <b>{money(entry.cost)}</b>
            ) : (
              <span className={`amount-tag ${entry.hasUsage ? "ok" : "muted"}`}>{entry.hasUsage ? "Usage tracked" : "No cost"}</span>
            )}
          </div>
        ))}
      </div>
    </section>
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

// Provider-level operating view for regular cloud accounts. Each card combines
// actual spend, run-rate projection, the biggest billed service, measured usage,
// resource inventory, and source freshness so cost and usage are read together.
function CloudProviderReportPanel({ reports }: { reports: CloudProviderReport[] }) {
  if (!reports.length) return null
  const complete = reports.filter((report) => report.coverageTone === "complete").length
  const measured = reports.reduce((sum, report) => sum + report.measuredMetrics, 0)
  const resources = reports.reduce((sum, report) => sum + report.resourceCount, 0)

  return (
    <section className="cloud-report-panel" aria-label="Cloud provider cost and usage reports">
      <div className="insight-panel-head cloud-report-head">
        <div>
          <p>Cloud operations</p>
          <h2>Provider cost &amp; usage reports</h2>
          <span>Actual month-to-date billing paired with the usage and resources each provider exposes.</span>
        </div>
        <div className="cloud-report-summary">
          <strong>{complete}/{reports.length}</strong>
          <span>full cost coverage</span>
          <small>{measured} metrics · {resources} resources</small>
        </div>
      </div>

      <div className="cloud-report-grid">
        {reports.map((report) => {
          const usageTone =
            report.highestUsagePercent != null && report.highestUsagePercent >= 90
              ? "crit"
              : report.highestUsagePercent != null && report.highestUsagePercent >= 80
                ? "warn"
                : "ok"
          return (
            <details className={`cloud-report-card coverage-${report.coverageTone}`} key={report.provider}>
              <summary>
                <ProviderLogo provider={report.provider} />
                <span className="cloud-report-summary-id">
                  <strong>{providerName(report.provider)}</strong>
                  <small>{report.coverageLabel}</small>
                </span>
                <span className="cloud-report-summary-cost">
                  <strong>{money(report.cost)}</strong>
                  <small>{Math.round(report.share)}% of cloud spend</small>
                </span>
                <span className={`cloud-report-usage-pulse ${usageTone}`}>
                  {report.highestUsagePercent == null ? `${report.measuredMetrics} metrics` : `${Math.round(report.highestUsagePercent)}% peak`}
                </span>
                <ChevronDown aria-hidden />
              </summary>
              <div className="cloud-report-detail">
                <div className="cloud-report-money">
                  <div>
                    <span>Month to date</span>
                    <strong>{money(report.cost)}</strong>
                    <small>{Math.round(report.share)}% of cloud spend</small>
                  </div>
                  <div>
                    <span>Projected</span>
                    <strong>{money(report.projected)}</strong>
                    <small>at current run rate</small>
                  </div>
                </div>

                <div className="cloud-report-driver">
                  <span>Top billed service</span>
                  <strong>{report.topService ?? "No billed service"}</strong>
                  <b>{report.topService ? money(report.topServiceCost) : "—"}</b>
                </div>

                <div className="cloud-report-signals">
                  <div><Gauge aria-hidden /><span>Usage</span><strong>{report.measuredMetrics}<small> metrics</small></strong><em className={usageTone}>{report.highestUsagePercent == null ? "no limit data" : `${Math.round(report.highestUsagePercent)}% highest`}</em></div>
                  <div><Boxes aria-hidden /><span>Resources</span><strong>{report.resourceCount}</strong><em>{report.resourceCount ? "inventory live" : "not exposed"}</em></div>
                  <div><RefreshCw aria-hidden /><span>Freshness</span><strong>{shortAge(report.syncedAt)}</strong><em>{report.syncStatus === "success" ? "responding" : report.syncStatus.replace("_", " ")}</em></div>
                </div>

                <footer><DatabaseZap aria-hidden /><span>{report.coverageDetail}</span></footer>
              </div>
            </details>
          )
        })}
      </div>
    </section>
  )
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

// Full account-wide usage is intentionally visible without opening a modal.
// This restores the operational view across every regular/custom cloud source;
// the compact headroom widget below remains a prioritized risk summary.
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
        )})}
      </div>
    </section>
  )
}

type AlertSeverity = "crit" | "warn"

interface DashAlert {
  id: string
  severity: AlertSeverity
  title: string
  detail: string
}

// Consolidates every actionable signal across the non-AI surface into one
// prioritized list: forecast vs budget, free-tier metrics near their limit,
// failed provider syncs, and stale data. Pure derivation from the snapshot so
// both the KPI band ("needs attention" count) and the panel share one source.
function dashboardAlerts({
  freeTier,
  liveSync,
  projected,
  budget,
  latestMs,
}: {
  freeTier: FreeTierUsageRow[]
  liveSync: AnalysisResult["liveSync"]
  projected: number
  budget: number | null
  latestMs: number | null
}): DashAlert[] {
  const alerts: DashAlert[] = []

  if (budget != null && budget > 0 && projected > 0) {
    if (projected > budget) {
      const over = projected - budget
      alerts.push({
        id: "budget-over",
        severity: "crit",
        title: "Forecast over budget",
        detail: `Projected ${money(projected)} is ${money(over)} (${Math.round((over / budget) * 100)}%) above your ${money(budget)} budget.`,
      })
    } else if (projected > budget * 0.9) {
      alerts.push({
        id: "budget-near",
        severity: "warn",
        title: "Approaching budget",
        detail: `Projected ${money(projected)} is ${Math.round((projected / budget) * 100)}% of your ${money(budget)} budget.`,
      })
    }
  }

  const nearLimit = freeTier
    .filter((row) => row.source === "measured" && row.percentUsed !== null && row.limit !== null && (row.percentUsed ?? 0) >= 80)
    .sort((a, b) => (b.percentUsed ?? 0) - (a.percentUsed ?? 0))
    .slice(0, 4)
  for (const row of nearLimit) {
    const pct = Math.round(row.percentUsed ?? 0)
    alerts.push({
      id: `usage-${row.customProviderId ?? row.provider}-${row.service}`,
      severity: pct >= 95 ? "crit" : "warn",
      title: `${providerName(row.provider)} · ${row.service} near free-tier limit`,
      detail: `${pct}% used — ${quantity(row.used ?? 0)} of ${quantity(row.limit ?? 0)} ${row.unit}, ${quantity(row.remaining ?? 0)} ${row.unit} left.`,
    })
  }

  for (const [index, sync] of liveSync.filter((entry) => entry.status === "error").entries()) {
    alerts.push({
      id: `sync-${sync.provider}-${index}`,
      severity: "warn",
      title: `${providerName(sync.provider)} sync failed`,
      detail: sync.message || "The last refresh could not read this account. Re-check its connection under Credentials.",
    })
  }

  if (latestMs !== null && latestMs > 26 * 3_600_000) {
    const days = Math.round(latestMs / (24 * 3_600_000))
    alerts.push({
      id: "stale",
      severity: "warn",
      title: "Data may be stale",
      detail: `Last successful refresh was about ${days === 1 ? "a day" : `${days} days`} ago. Use “Refresh now” to update cost and usage.`,
    })
  }

  const rank: Record<AlertSeverity, number> = { crit: 0, warn: 1 }
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity])
}

// Executive KPI band at the top of the Dashboards view: the four numbers that
// answer "how much, where it's heading, how fast, and is anything wrong" — so
// the rest of the page is detail rather than the first read.
function OverviewKpis({
  total,
  projected,
  dailyRate,
  elapsedDays,
  totalDays,
  accountCount,
  serviceCount,
  budget,
  alertCount,
}: {
  total: number
  projected: number
  dailyRate: number
  elapsedDays: number
  totalDays: number
  accountCount: number
  serviceCount: number
  budget: number | null
  alertCount: number
}) {
  const overBudget = budget != null && budget > 0 && projected > budget
  const daysLeft = Math.max(totalDays - elapsedDays, 0)
  return (
    <div className="ai-kpis overview-kpis">
      <article>
        <Coins aria-hidden />
        <span>Month to date</span>
        <strong>{money(total)}</strong>
        <small>
          {accountCount} {accountCount === 1 ? "account" : "accounts"}
          {serviceCount > 0 ? ` · ${serviceCount} ${serviceCount === 1 ? "service" : "services"}` : ""}
        </small>
      </article>
      <article className={overBudget ? "kpi-warn" : undefined}>
        <TrendingUp aria-hidden />
        <span>Projected month-end</span>
        <strong>{money(projected)}</strong>
        <small>
          {budget != null && budget > 0
            ? `${Math.round((projected / budget) * 100)}% of ${money(budget)} budget`
            : "at current run rate"}
        </small>
      </article>
      <article>
        <Activity aria-hidden />
        <span>Daily run rate</span>
        <strong>{money(dailyRate)}</strong>
        <small>{daysLeft} {daysLeft === 1 ? "day" : "days"} left of {totalDays}</small>
      </article>
      <article className={alertCount > 0 ? "kpi-warn" : "kpi-ok"}>
        {alertCount > 0 ? <AlertTriangle aria-hidden /> : <CheckCircle2 aria-hidden />}
        <span>Needs attention</span>
        <strong>{alertCount}</strong>
        <small>{alertCount > 0 ? `${alertCount === 1 ? "item" : "items"} to review below` : "all clear"}</small>
      </article>
    </div>
  )
}

// Consolidated, prioritized alerts surface. Shows the highest-severity issues
// first; a clean state is an explicit "all clear" rather than a hidden panel so
// the user can trust the absence of warnings.
function AttentionPanel({ alerts }: { alerts: DashAlert[] }) {
  const crit = alerts.filter((alert) => alert.severity === "crit").length
  return (
    <section className="insight-panel attention-panel" aria-label="Needs attention">
      <div className="insight-panel-head">
        <div>
          <p>Status</p>
          <h2>Needs attention</h2>
        </div>
        <span className={alerts.length === 0 ? "attention-flag ok" : crit > 0 ? "attention-flag crit" : "attention-flag warn"}>
          {alerts.length === 0 ? "All clear" : crit > 0 ? `${crit} urgent` : `${alerts.length} to review`}
        </span>
      </div>
      {alerts.length === 0 ? (
        <div className="attention-clear">
          <CheckCircle2 aria-hidden />
          <span>Nothing needs attention. Spend is within budget, free-tier usage has headroom, and every account synced cleanly.</span>
        </div>
      ) : (
        <div className="attention-list">
          {alerts.map((alert) => (
            <article key={alert.id} className={`attention-row ${alert.severity}`}>
              <span className="attention-icon" aria-hidden>
                {alert.severity === "crit" ? <AlertTriangle /> : <ShieldAlert />}
              </span>
              <div>
                <strong>{alert.title}</strong>
                <span>{alert.detail}</span>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function CliConnectionGuide() {
  const agentPrompt = `Use the Ambrium CLI to connect this machine's cloud and AI provider accounts to my Ambrium workspace.

Rules:
- Only create or use read-only credentials.
- Never print secrets into chat.
- Prefer existing local CLI sessions where available.
- Ask me before opening provider dashboards or approving OAuth/IAM changes.
- After each provider, verify the connection and summarize what was connected.

Start with:
AMBRIUM_API=https://ambrium.io npx --yes github:MustangBro7/infra-cost-analyzer doctor

Then run:
AMBRIUM_API=https://ambrium.io npx --yes github:MustangBro7/infra-cost-analyzer`
  return (
    <section className="cli-connect-guide" aria-label="Connect accounts with the CLI">
      <div className="cli-guide-head">
        <div>
          <p>Recommended setup</p>
          <h2>Connect your projects with one command, or let your coding agent drive it</h2>
          <span>The CLI pairs to this signed-in workspace, detects local cloud and AI tooling, prepares read-only access, verifies each account, and keeps human approval at the provider consent steps.</span>
        </div>
        <TerminalSquare aria-hidden />
      </div>

      <div className="cli-setup-modes">
        <article className="cli-mode-card primary">
          <div>
            <strong>One-command setup</strong>
            <span>Best when you are in the project repo and already use local CLIs like <code>aws</code>, <code>gcloud</code>, or <code>wrangler</code>.</span>
          </div>
          <div className="cli-command">
            <span>Run from your terminal</span>
            <code>AMBRIUM_API=https://ambrium.io npx --yes github:MustangBro7/infra-cost-analyzer</code>
          </div>
          <div className="cli-command secondary">
            <span>Diagnose first</span>
            <code>AMBRIUM_API=https://ambrium.io npx --yes github:MustangBro7/infra-cost-analyzer doctor</code>
          </div>
        </article>

        <article className="cli-mode-card">
          <div>
            <strong>Connect with Codex or Claude Code</strong>
            <span>Paste this prompt into your coding agent. It can run diagnostics, use the CLI, and stop for your approval when provider access is required.</span>
          </div>
          <pre className="agent-prompt">{agentPrompt}</pre>
          <div className="cli-mode-actions">
            <a className="ghost-button" href="/api/extend/spec" target="_blank" rel="noreferrer">
              <ArrowUpRight aria-hidden />
              Agent setup spec
            </a>
          </div>
        </article>
      </div>

      <div className="cli-step-grid">
        <article><b>1</b><div><strong>Detect local context</strong><span>The CLI checks Git, AWS, Google Cloud, Cloudflare, Vercel, MotherDuck, and local AI usage.</span></div></article>
        <article><b>2</b><div><strong>Pair to Ambrium</strong><span>The command opens Ambrium. Confirm the displayed device code while signed in.</span></div></article>
        <article><b>3</b><div><strong>Approve read-only access</strong><span>Your agent can prepare setup, but you approve OAuth, IAM, service accounts, billing exports, and token creation.</span></div></article>
        <article><b>4</b><div><strong>Verify coverage</strong><span>Run <code>ambrium-connect status</code> or <code>doctor</code>. Cards below show cost live, usage only, partial, or blocked states.</span></div></article>
      </div>
      <div className="cli-prereqs">
        <strong>Provider notes</strong>
        <span>AWS Cost Explorer is opt-in because AWS charges per request. GCP detailed cost still requires Billing Export. Cloudflare may require a scoped token paste. The CLI also reads your local Claude Code &amp; Codex logs to track AI usage for flat personal plans — the only place that data exists.</span>
      </div>
    </section>
  )
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
        models?: Array<{ model: string; inputTokens?: number; cacheTokens?: number; outputTokens?: number; estimatedApiUsd?: number }>
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
      return { model: model.model, inputTokens: input, cacheTokens: cache, outputTokens: output, totalTokens: input + cache + output, estimatedApiUsd: model.estimatedApiUsd ?? 0 }
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
      lastVerifiedAt: analysis.liveSync.find((entry) => entry.provider === first.provider)?.syncedAt ?? null,
      usageUrl: AI_USAGE_URL[first.provider] ?? null,
      category: "gateway",
    })
  }
  return tools.sort((a, b) => b.totalCost - a.totalCost)
}

function RepositoryDashboard({
  analysis,
  repos,
  selectedRepo,
  state,
  repoAnalyses,
  view,
}: {
  analysis: AnalysisResult
  repos: GitHubRepoSummary[]
  selectedRepo: string | null
  state: Awaited<ReturnType<typeof publicStore>>
  repoAnalyses: Record<string, AnalysisResult>
  view: ViewKey
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
  const serviceCount = breakdownByService(analysis.costRows).length
  const latestSync = analysis.liveSync
    .filter((entry) => entry.status === "success")
    .map((entry) => entry.syncedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1)
  const latestSyncTime = latestSync ? new Date(latestSync).getTime() : Number.NaN
  const latestMs = Number.isFinite(latestSyncTime) ? Math.max(Date.now() - latestSyncTime, 0) : null
  // Non-AI alerts only: drop AI providers from the free-tier feed feeding alerts.
  const alerts = dashboardAlerts({
    freeTier: analysis.freeTier.filter((row) => !AI_PROVIDERS.includes(row.provider)),
    liveSync: analysis.liveSync.filter((entry) => !AI_PROVIDERS.includes(entry.provider)),
    projected: forecast.projected,
    budget: state.monthlyBudgetUsd ?? null,
    latestMs,
  })
  const cloudReports = buildCloudProviderReports({
    analysis,
    connections: state.connections,
    elapsedDays: forecast.elapsedDays,
    totalDays: forecast.totalDays,
  })
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
  const assignmentQueue = buildAssignmentQueue({
    analysis,
    repos,
    assignments: state.costAssignments,
  })
  const accountUsageRows = analysis.freeTier.filter((row) => !AI_PROVIDERS.includes(row.provider))
  const aiTools = buildAiTools(analysis, state)
  const emptyWorkspace = repos.length === 0 && accounts.length === 0 && totalCost <= 0.005

  return (
    <>
      <ViewTabs view={view} />

      {view === "projects" ? (
        <>
          <section className="overview-hero" aria-label="Cost dashboard">
            <p>Projects · {monthLabel(analysis.period)}</p>
            <h1>
              What each project costs{" "}
              <span className="hero-sub">before the bill surprises you</span>
            </h1>
          </section>

          <OverviewKpis
            total={totalCost}
            projected={forecast.projected}
            dailyRate={forecast.dailyRate}
            elapsedDays={forecast.elapsedDays}
            totalDays={forecast.totalDays}
            accountCount={accounts.length}
            serviceCount={serviceCount}
            budget={state.monthlyBudgetUsd ?? null}
            alertCount={alerts.length}
          />

          <ProjectCostCockpit projects={indieProjects} />

          {emptyWorkspace ? <DemoWorkspacePreview /> : null}

          {repos.length > 0 ? (() => {
            const repoCosts = indieProjects.map((project) => {
              const repo = project.repo
              const repoAnalysis = repoAnalyses[repo.fullName]
              return { repo, repoAnalysis, linked: project.linked, cost: project.cost }
            })
            const ranked = repoCosts.filter((entry) => entry.cost > 0.005).sort((a, b) => b.cost - a.cost)
            const rankMax = Math.max(...ranked.map((entry) => entry.cost), 0.01)
            const rankedTotal = ranked.reduce((sum, entry) => sum + entry.cost, 0)

            return (
              <>
                {ranked.length > 0 ? (
                  <section className="insight-panel repo-ranking" aria-label="Cost by repository">
                    <div className="insight-panel-head">
                      <div>
                        <p>Cost by repository · {monthLabel(analysis.period)}</p>
                        <h2>{money(rankedTotal)} <span className="hero-sub">assigned across {ranked.length} {ranked.length === 1 ? "repo" : "repos"}</span></h2>
                      </div>
                      <Coins aria-hidden />
                    </div>
                    <div className="repo-rank-list">
                      {ranked.map((entry) => {
                        const pct = rankedTotal > 0 ? Math.round((entry.cost / rankedTotal) * 100) : 0
                        return (
                          <Link key={entry.repo.fullName} href={`/dashboard?repo=${encodeURIComponent(entry.repo.fullName)}`} prefetch={false} className="repo-rank-row">
                            <span className="repo-rank-name">
                              <FolderGit2 aria-hidden />
                              <span title={entry.repo.fullName}>{entry.repo.name}</span>
                            </span>
                            <span className="repo-rank-bar" aria-hidden>
                              <i style={{ width: `${Math.max((entry.cost / rankMax) * 100, 2)}%` }} />
                            </span>
                            <span className="repo-rank-meta"><b>{money(entry.cost)}</b><small>{pct}%</small></span>
                          </Link>
                        )
                      })}
                    </div>
                  </section>
                ) : null}

                <section className="repo-home-grid" aria-label="Synced repositories">
                  {repoCosts.map(({ repo, repoAnalysis, linked, cost }) => (
                    <RepoHomeCard
                      key={repo.fullName}
                      fullName={repo.fullName}
                      isPrivate={repo.private}
                      defaultBranch={repo.defaultBranch}
                      active={repo.fullName === selectedRepo}
                      headline={linked.length === 0 ? (cost > 0.005 ? money(cost) : "Pick accounts") : money(cost)}
                      detail={
                        linked.length === 0
                          ? cost > 0.005
                            ? "Assigned cost · open to link accounts"
                            : "No accounts linked yet — open to link"
                          : `${linked.length} ${linked.length === 1 ? "account" : "accounts"} linked${repoAnalysis ? ` · ${repoAnalysis.summary.signals} signals` : ""}`
                      }
                    />
                  ))}
                </section>
              </>
            )
          })() : null}

          <RepoSyncPanel initialState={state} />
        </>
      ) : null}

      {view === "limits" ? (
        <>
          <section className="overview-hero" aria-label="Limits">
            <p>Limits · {monthLabel(analysis.period)}</p>
            <h1>
              Know when free stops being free <span className="hero-sub">budgets, usage, and runway</span>
            </h1>
          </section>

          <div className="two-panel-grid">
            <FreeTierRunwayPanel rows={accountUsageRows} />
            <BudgetForecast
              spent={totalCost}
              projected={forecast.projected}
              dailyRate={forecast.dailyRate}
              elapsedDays={forecast.elapsedDays}
              totalDays={forecast.totalDays}
              budget={state.monthlyBudgetUsd ?? null}
              monthLabel={monthLabel(analysis.period)}
            />
          </div>

          <AccountWideUsagePanel rows={accountUsageRows} />

          <CloudProviderReportPanel reports={cloudReports} />
        </>
      ) : null}

      {view === "leaks" ? (
        <>
          <section className="overview-hero" aria-label="Leaks">
            <p>Leaks</p>
            <h1>
              What changed or looks wasteful <span className="hero-sub">unmapped, stale, inferred, or failing</span>
            </h1>
          </section>

          <div className="two-panel-grid">
            <CostLeakPanel leaks={leaks} />
            <AttentionPanel alerts={alerts} />
          </div>

          <UnassignedCostQueue items={assignmentQueue} repos={repoCandidates(repos)} />

          <HistoricalAnalyticsPanel repo={null} currentMonth={analysis.period.from.slice(0, 7)} />
        </>
      ) : null}

      {view === "ai" ? (
        <>
          <section className="overview-hero" aria-label="AI costs">
            <p>AI · subscriptions, APIs, and gateways</p>
            <h1>
              Is your AI spend paying off? <span className="hero-sub">plans, tokens, API value, and project signals</span>
            </h1>
          </section>

          {aiTools.length ? (
            <AiInsights tools={aiTools} expanded />
          ) : (
            <section className="ai-empty-state">
              <div>
                <p>AI cost cockpit</p>
                <h2>Connect AI usage to compare subscriptions, APIs, and gateways</h2>
                <span>Ambrium can read local Claude Code/Codex usage, OpenAI and Anthropic admin billing, Cursor team spend, and AI-like rows from custom providers such as OpenRouter, Gemini/Vertex AI, Cloudflare AI Gateway, and Vercel AI.</span>
              </div>
              <div className="demo-insights">
                <article><Wallet aria-hidden /><strong>$20</strong><span>ChatGPT/Codex plan</span></article>
                <article><TrendingUp aria-hidden /><strong>$48</strong><span>API-equivalent value</span></article>
                <article><Gauge aria-hidden /><strong>2.4x</strong><span>subscription justified</span></article>
              </div>
              <a href="/dashboard?view=connect" className="command-button">Connect AI tools</a>
            </section>
          )}

          <AiSyncPanel initialState={state} />
        </>
      ) : null}

      {view === "connect" ? (
        <>
          <section className="overview-hero" aria-label="Connect">
            <p>Connect</p>
            <h1>
              Run one command, see project costs <span className="hero-sub">{accounts.length} {accounts.length === 1 ? "account" : "accounts"} connected</span>
            </h1>
          </section>

          <CliConnectionGuide />

          <AccountsBoard accounts={accounts} />

          <ProviderConnectPanel providerConnections={analysis.providerConnections} initialState={state} />

          <AiSyncPanel initialState={state} />

          <CustomProviderPanel initialState={state} />
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
  costDataOff = false,
}: {
  analysis: AnalysisResult
  connection: ProviderConnection
  repoFullName: string
  repoShort: string
  assignments: Record<string, string>
  repoLabels: Record<string, string>
  costDataOff?: boolean
}) {
  const rows = providerRows(connection.provider, analysis.costRows)
  const projectRows = rows.filter((row) => isAssignedHere(row, assignments, repoFullName, repoShort))
  const restRows = rows.filter((row) => !isAssignedHere(row, assignments, repoFullName, repoShort))
  const projectTotal = sumCost(projectRows)
  const restTotal = sumCost(restRows)
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
}: {
  analysis: AnalysisResult
  repo: GitHubRepoSummary | null
  state: Awaited<ReturnType<typeof publicStore>>
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
  const projectCostRows = linkedCostRows.filter((row) => isAssignedHere(row, assignments, selectedName, repoShort))
  const projectTotal = sumCost(projectCostRows)
  const restTotal = sumCost(linkedCostRows.filter((row) => !isAssignedHere(row, assignments, selectedName, repoShort)))
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
            <article><Coins aria-hidden /><span>This project</span><strong>{money(projectTotal)}</strong><small>assigned cost this month</small></article>
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
    rawView === "limits" || rawView === "leaks" || rawView === "ai" || rawView === "connect" || rawView === "projects"
      ? rawView
      : rawView === "repos"
        ? "projects"
        : rawView === "credentials"
          ? "connect"
          : "projects"
  const dashboardStore = await readDashboardStore(user.id)
  const state = { user, ...dashboardStore.publicState }
  const workspace = dashboardStore.workspace
  const repoAnalyses = Object.fromEntries(
    Object.entries(workspace.analysisSnapshots)
      .filter(([key]) => key !== "__overview__" && key !== "__local__")
      .map(([key, value]) => [key, value.analysis])
  )
  // Renders from the persisted snapshot (DB read). Live provider/GitHub data is
  // refreshed out-of-band by <AnalysisRefresher>, not on every page load.
  const snapshot =
    workspace.analysisSnapshots[snapshotKeyForRepo(requestedRepo)] ??
    await getOrCreateAnalysisSnapshot({
      userId: user.id,
      requestedRepo,
      githubRepos: state.githubRepos,
    })
  const analysis = snapshot.analysis
  const repos = repoList(state)
  const selectedRepo = requestedRepo ? repos.find((repo) => repo.fullName === requestedRepo) ?? null : null

  return (
    <main className="app-shell repo-app">
      <Header subtitle={user.email} />
      <AnalysisRefresher repo={requestedRepo} computedAt={snapshot.computedAt} />
      {requestedRepo ? (
        <RepoDetail analysis={analysis} repo={selectedRepo} state={state} />
      ) : (
        <RepositoryDashboard
          analysis={analysis}
          repos={repos}
          selectedRepo={state.selectedRepoFullName}
          state={state}
          repoAnalyses={repoAnalyses}
          view={view}
        />
      )}
    </main>
  )
}
