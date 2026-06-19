import {
  ArrowLeft,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  ChevronDown,
  CloudCog,
  DatabaseZap,
  FolderGit2,
  Gauge,
  Layers,
  RefreshCw,
  ShieldAlert,
  Signal,
  TerminalSquare,
  Wallet,
} from "lucide-react"
import type { ReactNode } from "react"
import { redirect } from "next/navigation"
import { RepoSyncPanel } from "../RepoSyncPanel"
import { ProviderConnectPanel } from "../ProviderConnectPanel"
import { RepoAccountPicker } from "../RepoAccountPicker"
import { ProviderCostPanel } from "../ProviderCostPanel"
import { ProviderResourcePanel } from "../ProviderResourcePanel"
import { AnalysisRefresher } from "../AnalysisRefresher"
import { ProviderLogo } from "../ProviderLogo"
import { SignOutButton } from "../SignOutButton"
import { ThemeToggle } from "../ThemeToggle"
import { HistoricalAnalyticsPanel } from "../HistoricalAnalyticsPanel"
import { RepoHomeCard } from "../RepoHomeCard"
import { getOrCreateAnalysisSnapshot } from "@/lib/analysisService"
import { currentUserFromCookies } from "@/lib/localAuth"
import { publicStore, readWorkspace } from "@/lib/localStore"
import { CONNECTABLE_PROVIDERS, resolveLinkedProviders } from "@/lib/repoLinks"
import { costItemKey, isAssignedHere, isKeyAssignedHere } from "@/lib/costAttribution"
import { resourceMetricService, resourceUsageRows } from "@/lib/freeTier"
import type { AnalysisResult, FreeTierUsageRow, GitHubRepoSummary, NormalizedCostRow, Provider, ProviderConnection, RepoSignal } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// The overview is split into three sections, selected by ?view=. Dashboards is
// the default (cost now; richer widgets later), Repos manages synced repos, and
// Credentials manages provider connections.
type ViewKey = "dashboards" | "repos" | "credentials"

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
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

const PROVIDER_COLOR: Partial<Record<Provider, string>> = {
  aws: "#d79c22",
  cloudflare: "#b54035",
  gcp: "#285f9f",
  vercel: "#151515",
  motherduck: "#46a37b",
  azure: "#7152a5",
}

function providerColor(provider: Provider) {
  return PROVIDER_COLOR[provider] ?? "#696459"
}

function sumCost(rows: NormalizedCostRow[]) {
  return rows.reduce((sum, row) => sum + row.cost, 0)
}

function breakdownByProvider(rows: NormalizedCostRow[]) {
  const totals = new Map<Provider, number>()
  for (const row of rows) totals.set(row.provider, (totals.get(row.provider) ?? 0) + row.cost)
  return [...totals.entries()]
    .map(([provider, total]) => ({ provider, total }))
    .filter((entry) => entry.total > 0.005)
    .sort((a, b) => b.total - a.total)
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
                key={entry.provider}
                className="cost-bar-seg"
                style={{ width: `${Math.max((entry.total / total) * 100, 1.5)}%`, background: providerColor(entry.provider) }}
                title={`${providerName(entry.provider)} · ${money(entry.total)}`}
              />
            ))}
          </div>
          <div className="cost-legend">
            {breakdown.map((entry) => {
              const pct = total > 0 ? Math.round((entry.total / total) * 100) : 0
              return (
                <div key={entry.provider} className="cost-legend-row">
                  <span className="cost-legend-dot" style={{ background: providerColor(entry.provider) }} aria-hidden />
                  <ProviderLogo provider={entry.provider} />
                  <strong>{providerName(entry.provider)}</strong>
                  <span className="cost-legend-pct">{pct}%</span>
                  <b>{money(entry.total)}</b>
                </div>
              )
            })}
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

function Header({ subtitle }: { subtitle: string }) {
  return (
    <header className="topbar clean">
      <div className="brand">
        <span className="brand-mark">
          <CloudCog aria-hidden />
        </span>
        <div>
          <strong>Ambrium</strong>
          <small>{subtitle}</small>
        </div>
      </div>
      <div className="top-actions">
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
    { key: "dashboards", label: "Dashboards", icon: Gauge, href: "/dashboard" },
    { key: "repos", label: "Repos", icon: FolderGit2, href: "/dashboard?view=repos" },
    { key: "credentials", label: "Credentials", icon: ShieldAlert, href: "/dashboard?view=credentials" },
  ]
  return (
    <nav className="view-tabs" aria-label="Sections">
      {tabs.map(({ key, label, icon: Icon, href }) => (
        <a
          key={key}
          href={href}
          className={view === key ? "view-tab active" : "view-tab"}
          aria-current={view === key ? "page" : undefined}
        >
          <Icon aria-hidden />
          {label}
        </a>
      ))}
    </nav>
  )
}

function AccountsBoard({
  analysis,
  connectedProviders,
  state,
}: {
  analysis: AnalysisResult
  connectedProviders: Provider[]
  state: Awaited<ReturnType<typeof publicStore>>
}) {
  if (connectedProviders.length === 0) {
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
        {connectedProviders.map((provider) => {
          const cost = sumCost(providerRows(provider, analysis.costRows))
          const usage = providerFreeTier(provider, analysis.freeTier).some((row) => row.source === "measured")
          const label = state.connections[provider]?.accountLabel
          return (
            <div key={provider} className="account-board-row">
              <span className="cost-legend-dot" style={{ background: providerColor(provider) }} aria-hidden />
              <ProviderLogo provider={provider} />
              <span className="account-board-id">
                <strong>{providerName(provider)}</strong>
                <small>{label ?? "Connected"}</small>
              </span>
              {cost > 0.005 ? (
                <b>{money(cost)}</b>
              ) : (
                <span className={`amount-tag ${usage ? "ok" : "muted"}`}>{usage ? "Free tier" : "No cost"}</span>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function DashboardWidgets({
  analysis,
  connectedProviders,
}: {
  analysis: AnalysisResult
  connectedProviders: Provider[]
}) {
  const successful = analysis.liveSync.filter((entry) => entry.status === "success").length
  const errors = analysis.liveSync.filter((entry) => entry.status === "error").length
  const measured = analysis.freeTier.filter((row) => row.source === "measured").length
  const latest = analysis.liveSync
    .map((entry) => entry.syncedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1)
  return (
    <section className="dashboard-widgets" aria-label="Account health">
      <article>
        <CheckCircle2 aria-hidden />
        <span>Live sources</span>
        <strong>{successful}/{connectedProviders.length}</strong>
        <small>{errors ? `${errors} need attention` : "All responding"}</small>
      </article>
      <article>
        <Gauge aria-hidden />
        <span>Usage metrics</span>
        <strong>{measured}</strong>
        <small>Measured this period</small>
      </article>
      <article>
        <Boxes aria-hidden />
        <span>Resources</span>
        <strong>{analysis.resourceItems.length}</strong>
        <small>Available for repo assignment</small>
      </article>
      <article>
        <RefreshCw aria-hidden />
        <span>Last refresh</span>
        <strong>{latest ? new Date(latest).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "—"}</strong>
        <small>{latest ? new Date(latest).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "Waiting for first sync"}</small>
      </article>
    </section>
  )
}

function CliConnectionGuide() {
  return (
    <section className="cli-connect-guide" aria-label="Connect accounts with the CLI">
      <div className="cli-guide-head">
        <div>
          <p>Recommended setup</p>
          <h2>Connect every local cloud account from one command</h2>
          <span>The CLI pairs to this signed-in workspace, provisions read-only access, verifies each account, and starts the first data refresh.</span>
        </div>
        <TerminalSquare aria-hidden />
      </div>
      <div className="cli-command">
        <span>Run from your terminal</span>
        <code>AMBRIUM_API=https://ambrium.io npx --yes github:MustangBro7/infra-cost-analyzer</code>
      </div>
      <div className="cli-step-grid">
        <article><b>1</b><div><strong>Sign in to local CLIs</strong><span>Use <code>aws login</code>, <code>gcloud auth login</code>, and keep your Cloudflare/MotherDuck tokens ready.</span></div></article>
        <article><b>2</b><div><strong>Approve pairing</strong><span>The command opens Ambrium. Confirm the displayed device code while signed in.</span></div></article>
        <article><b>3</b><div><strong>Review read-only access</strong><span>AWS gets a scoped IAM role; GCP gets a billing-reader service account; Cloudflare and MotherDuck use tokens you provide.</span></div></article>
        <article><b>4</b><div><strong>Verify data</strong><span>Return here after the command finishes. Connected cards turn green and the dashboard refreshes cost and usage.</span></div></article>
      </div>
      <div className="cli-prereqs">
        <strong>Provider notes</strong>
        <span>AWS Cost Explorer is opt-in because AWS charges per request. GCP detailed cost still requires Billing Export. MotherDuck shows verified storage usage only because its actual invoice is available only in MotherDuck Billing.</span>
      </div>
    </section>
  )
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
  const measuredUsageCount = analysis.freeTier.filter((row) => row.source === "measured").length
  const totalCost = sumCost(analysis.costRows)

  return (
    <>
      <ViewTabs view={view} />

      {view === "dashboards" ? (
        <>
          <section className="overview-hero" aria-label="Cost dashboard">
            <p>Dashboards · {monthLabel(analysis.period)}</p>
            <h1>
              {money(totalCost)} <span className="hero-sub">across {connectedProviders.length} {connectedProviders.length === 1 ? "account" : "accounts"}</span>
            </h1>
          </section>

          <CostOverview
            eyebrow={`All Accounts · ${monthLabel(analysis.period)}`}
            rows={analysis.costRows}
            measuredUsageCount={measuredUsageCount}
            emptyNote="No billed spend across your connected accounts this month. Connect accounts under Credentials, or check Repos for per-project usage."
          />

          <DashboardWidgets analysis={analysis} connectedProviders={connectedProviders} />

          <AccountsBoard analysis={analysis} connectedProviders={connectedProviders} state={state} />

          <HistoricalAnalyticsPanel repo={null} currentMonth={analysis.period.from.slice(0, 7)} />
        </>
      ) : null}

      {view === "repos" ? (
        <>
          <section className="overview-hero" aria-label="Repositories">
            <p>Repos</p>
            <h1>
              {repos.length} {repos.length === 1 ? "repo" : "repos"} <span className="hero-sub">synced</span>
            </h1>
          </section>

          {repos.length > 0 ? (
            <section className="repo-home-grid" aria-label="Synced repositories">
              {repos.map((repo) => {
                const repoAnalysis = repoAnalyses[repo.fullName]
                const detectedProviders = [...new Set((repoAnalysis?.signals ?? []).map((signal) => signal.provider))]
                const linked = resolveLinkedProviders({
                  explicit: state.repoProviderLinks[repo.fullName],
                  detected: detectedProviders,
                  connected: connectedProviders,
                })
                const repoShortName = repo.name.toLowerCase()
                const candidateRows = [...(repoAnalysis?.costRows ?? []), ...analysis.costRows]
                const uniqueRows = [...new Map(candidateRows.map((row) => [costItemKey(row), row])).values()]
                const projectCost = sumCost(
                  uniqueRows.filter(
                    (row) => isAssignedHere(row, state.costAssignments, repo.fullName, repoShortName)
                  )
                )
                return (
                  <RepoHomeCard
                    key={repo.fullName}
                    fullName={repo.fullName}
                    isPrivate={repo.private}
                    defaultBranch={repo.defaultBranch}
                    active={repo.fullName === selectedRepo}
                    headline={linked.length === 0 ? (projectCost > 0.005 ? money(projectCost) : "Pick accounts") : money(projectCost)}
                    detail={
                      linked.length === 0
                        ? projectCost > 0.005
                          ? "Assigned cost · open to link accounts"
                          : "No accounts linked yet — open to link"
                        : `${linked.length} ${linked.length === 1 ? "account" : "accounts"} linked${repoAnalysis ? ` · ${repoAnalysis.summary.signals} signals` : ""}`
                    }
                  />
                )
              })}
            </section>
          ) : null}

          <RepoSyncPanel initialState={state} />
        </>
      ) : null}

      {view === "credentials" ? (
        <>
          <section className="overview-hero" aria-label="Credentials">
            <p>Credentials</p>
            <h1>
              {connectedProviders.length} {connectedProviders.length === 1 ? "account" : "accounts"} <span className="hero-sub">connected</span>
            </h1>
          </section>

          <CliConnectionGuide />

          <AccountsBoard analysis={analysis} connectedProviders={connectedProviders} state={state} />

          <ProviderConnectPanel providerConnections={analysis.providerConnections} initialState={state} />
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
      <a href="/dashboard" className="back-link">
        <ArrowLeft aria-hidden />
        Overview
      </a>

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
  const view: ViewKey = rawView === "repos" || rawView === "credentials" ? rawView : "dashboards"
  const state = { user, ...(await publicStore(user.id)) }
  const workspace = await readWorkspace(user.id)
  const repoAnalyses = Object.fromEntries(
    Object.entries(workspace.analysisSnapshots)
      .filter(([key]) => key !== "__overview__" && key !== "__local__")
      .map(([key, value]) => [key, value.analysis])
  )
  // Renders from the persisted snapshot (DB read). Live provider/GitHub data is
  // refreshed out-of-band by <AnalysisRefresher>, not on every page load.
  const snapshot = await getOrCreateAnalysisSnapshot({
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
