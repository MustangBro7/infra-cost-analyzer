import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  CloudCog,
  DatabaseZap,
  FolderGit2,
  Gauge,
  Github,
  Layers,
  RefreshCw,
  ShieldAlert,
  Signal,
  Wallet,
} from "lucide-react"
import { RepoSyncPanel } from "./RepoSyncPanel"
import { ProviderConnectPanel } from "./ProviderConnectPanel"
import { AnalysisRefresher } from "./AnalysisRefresher"
import { ProviderLogo } from "./ProviderLogo"
import { SignInForm } from "./SignInForm"
import { SignOutButton } from "./SignOutButton"
import { getOrCreateAnalysisSnapshot } from "@/lib/analysisService"
import { currentUserFromCookies } from "@/lib/localAuth"
import { publicStore } from "@/lib/localStore"
import type { AnalysisResult, FreeTierUsageRow, GitHubRepoSummary, NormalizedCostRow, Provider, ProviderConnection, RepoSignal } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

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
  azure: "#7152a5",
}

function providerColor(provider: Provider) {
  return PROVIDER_COLOR[provider] ?? "#696459"
}

function currentRepoFullName(analysis: AnalysisResult) {
  return `${analysis.repo.owner}/${analysis.repo.name}`
}

function repoList(state: Awaited<ReturnType<typeof publicStore>>, analysis: AnalysisResult) {
  const synced = new Set(state.syncedRepoFullNames)
  const syncedRepos = state.githubRepos.filter((repo) => synced.has(repo.fullName))
  if (syncedRepos.length) return syncedRepos
  return [{
    id: 0,
    owner: analysis.repo.owner,
    name: analysis.repo.name,
    fullName: currentRepoFullName(analysis),
    private: true,
    defaultBranch: "local",
    htmlUrl: analysis.repo.remoteUrl ?? analysis.repo.path,
  }]
}

function providerTotal(provider: Provider, rows: NormalizedCostRow[]) {
  return rows.filter((row) => row.provider === provider).reduce((sum, row) => sum + row.cost, 0)
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
}: {
  rows: FreeTierUsageRow[]
  hasCost: boolean
  costDataOff?: boolean
}) {
  if (!rows.length) return null
  const planName = rows[0].planName
  const heading = costDataOff
    ? `Free-tier usage — ${planName}`
    : hasCost
      ? `Free-tier allowance — ${planName}`
      : `On the free tier — ${planName}`
  const subtext = costDataOff
    ? "Free-tier usage only. Spend is not pulled, so this is not your full cost."
    : hasCost
      ? "Live usage this period against each free allowance, shown alongside the billed cost above."
      : "No billed cost this period. Here is how much of the free allowance is left."
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
 * The headline "what does this repo cost, and where" surface. Shows the total
 * up front, a single stacked bar split by provider, and an aligned legend so the
 * biggest line items are obvious at a glance — drill-down lives in the
 * per-provider accordions below.
 */
function CostOverview({ analysis }: { analysis: AnalysisResult }) {
  const breakdown = analysis.providerBreakdown.filter((entry) => entry.total > 0.005)
  const total = analysis.summary.totalCost
  const measuredUsage = analysis.freeTier.filter((row) => row.source === "measured").length
  const usageProviders = new Set(
    analysis.freeTier.filter((row) => row.source === "measured").map((row) => row.provider)
  ).size

  return (
    <section className="cost-overview" aria-label="Cost overview">
      <div className="cost-overview-head">
        <div>
          <p>Total Cost · {monthLabel(analysis.period)}</p>
          <h2>{money(total)}</h2>
          <span>
            {breakdown.length > 0
              ? `Live month-to-date spend across ${breakdown.length} ${breakdown.length === 1 ? "provider" : "providers"}.`
              : usageProviders > 0
                ? `No billed spend yet — ${measuredUsage} live usage metric${measuredUsage === 1 ? "" : "s"} tracked across ${usageProviders} connected provider${usageProviders === 1 ? "" : "s"}.`
                : "No billed spend yet. Connect a provider below to pull live cost and usage."}
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
          <span>
            {usageProviders > 0
              ? "Everything connected is inside the free tier this month. Expand a provider below to see exactly how much you've used."
              : "Once you connect a provider, its live cost and free-tier usage appear here and in the breakdown below."}
          </span>
        </div>
      )}
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
          <strong>Infra Cost Analyzer</strong>
          <small>{subtitle}</small>
        </div>
      </div>
      <div className="top-actions">
        <a href="/api/analyze" className="link-button">
          API JSON <ArrowUpRight aria-hidden />
        </a>
        <a href="/" className="icon-button" aria-label="Refresh repositories">
          <RefreshCw aria-hidden />
        </a>
        <SignOutButton />
      </div>
    </header>
  )
}

function RepositoryDashboard({
  analysis,
  repos,
  selectedRepo,
  state,
}: {
  analysis: AnalysisResult
  repos: GitHubRepoSummary[]
  selectedRepo: string | null
  state: Awaited<ReturnType<typeof publicStore>>
}) {
  const knownRepo = currentRepoFullName(analysis)
  const knownTotal = repos.some((repo) => repo.fullName === knownRepo) ? analysis.summary.totalCost : 0
  const providerCount = new Set(analysis.providerConnections.filter((connection) => connection.detected).map((connection) => connection.provider)).size

  return (
    <>
      <section className="repo-home-summary" aria-label="Synced repository summary">
        <div>
          <p>Synced Repositories</p>
          <h1>{repos.length} repos</h1>
        </div>
        <div className="repo-home-metric">
          <span>Live MTD cost</span>
          <strong>{money(knownTotal)}</strong>
        </div>
        <div className="repo-home-metric">
          <span>Detected providers</span>
          <strong>{providerCount}</strong>
        </div>
      </section>

      <section className="repo-home-grid" aria-label="Synced repositories">
        {repos.map((repo) => {
          const hasCost = repo.fullName === knownRepo
          return (
            <a key={repo.fullName} href={`/?repo=${encodeURIComponent(repo.fullName)}`} className={repo.fullName === selectedRepo ? "repo-home-card active" : "repo-home-card"}>
              <div className="repo-home-card-head">
                <Github aria-hidden />
                <span>{repo.private ? "Private" : "Public"}</span>
              </div>
              <h2>{repo.fullName}</h2>
              <p>{repo.defaultBranch}</p>
              <div className="repo-card-metrics">
                <strong>{hasCost ? money(analysis.summary.totalCost) : "Pending scan"}</strong>
                <span>{hasCost ? `Live billing only · ${analysis.summary.signals} repo signals` : "Synced, awaiting remote scan"}</span>
              </div>
            </a>
          )
        })}
      </section>

      <RepoSyncPanel initialState={state} />
    </>
  )
}

function ProviderAccordion({
  analysis,
  connection,
  costDataOff = false,
}: {
  analysis: AnalysisResult
  connection: ProviderConnection
  costDataOff?: boolean
}) {
  const rows = providerRows(connection.provider, analysis.costRows)
  const signals = providerSignals(connection.provider, analysis.signals)
  const total = providerTotal(connection.provider, analysis.costRows)
  const freeTier = providerFreeTier(connection.provider, analysis.freeTier)
  const hasCost = rows.length > 0
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
    <details className="provider-accordion" open={connection.detected || hasCost || hasUsage}>
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
          {hasCost ? (
            <strong>{money(total)}</strong>
          ) : (
            <span className={`amount-tag ${costDataOff ? "warn" : hasUsage ? "ok" : "muted"}`}>
              {costDataOff ? "Cost off" : hasUsage ? "Free tier" : "No cost"}
            </span>
          )}
          <small>
            {hasCost && hasUsage
              ? "+ usage tracked"
              : costDataOff
                ? "enable cost data"
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

        <div className="provider-detail-grid">
          <section>
            <h3>Live resources and cost</h3>
            {costDataOff ? (
              <div className="provider-warning">
                <ShieldAlert aria-hidden />
                <span>
                  Cost data is off, so your AWS spend isn’t shown — this is not a confirmation that everything is free.
                  If you have paid resources running, turn on <b>Pull cost data</b> on the AWS card above ($0.01 per
                  refresh) to see your actual cost.
                </span>
              </div>
            ) : null}
            {hasCost ? (
              <div className="resource-list">
                {rows.map((row) => (
                  <article key={`${row.provider}-${row.serviceName}-${row.resourceName}-${row.signalId}`} className="resource-row">
                    <div>
                      <strong>{row.serviceName}</strong>
                      <span>{row.resourceName ?? row.resourceId ?? "Unmapped resource"}</span>
                      <small>Actual billing row · {row.attribution.replace("_", " ")}</small>
                    </div>
                    <b>{money(row.cost)}</b>
                  </article>
                ))}
              </div>
            ) : !hasUsage && !costDataOff ? (
              <div className="empty-provider-block">
                <DatabaseZap aria-hidden />
                <span>No live billing rows for this provider yet. Connect the provider or add the required billing export to show actual costs.</span>
              </div>
            ) : null}
            {hasUsage ? <FreeTierUsage rows={freeTier} hasCost={hasCost} costDataOff={costDataOff} /> : null}
          </section>
          <section>
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
  const relevantProviders = analysis.providerConnections.filter((connection) => {
    return connection.detected || connection.status === "connected" || providerRows(connection.provider, analysis.costRows).length > 0
  })

  return (
    <>
      <a href="/" className="back-link">
        <ArrowLeft aria-hidden />
        All synced repos
      </a>

      <section className="repo-detail-hero" aria-label="Repository detail">
        <div>
          <p>Repository Deep Dive</p>
          <h1>{selectedName}</h1>
          <span>{hasScan ? analysis.repo.path : "Synced repository. Remote scan data is not available yet."}</span>
        </div>
        <div className="repo-detail-totals">
          <div>
            <span>Providers</span>
            <strong>{hasScan ? relevantProviders.length : 0}</strong>
          </div>
          <div>
            <span>Repo signals</span>
            <strong>{hasScan ? analysis.summary.signals : 0}</strong>
          </div>
        </div>
      </section>

      {hasScan ? (
        <>
          <CostOverview analysis={analysis} />
          <ProviderConnectPanel providerConnections={relevantProviders} initialState={state} />
          <section className="provider-deep-dive" aria-label="Provider cost breakdown">
            <div className="deep-dive-heading">
              <div>
                <p>By Provider</p>
                <h2>Expand any provider for exact cost rows, usage, and repo evidence</h2>
                <span className="live-cost-note">Only live billing sources produce dollar amounts — nothing here is estimated.</span>
              </div>
              <Layers aria-hidden />
            </div>
            {relevantProviders.map((connection) => {
              const meta = state.connections[connection.provider]?.metadata as { costExplorer?: boolean } | undefined
              // AWS only pulls spend when Cost Explorer is opted in; otherwise we
              // have not checked cost, so don't imply "free tier".
              const costDataOff =
                connection.provider === "aws" && connection.status === "connected" && meta?.costExplorer !== true
              return (
                <ProviderAccordion key={connection.provider} analysis={analysis} connection={connection} costDataOff={costDataOff} />
              )
            })}
          </section>
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
  const user = await currentUserFromCookies()
  if (!user) return <SignInForm />

  const params = await searchParams
  const rawRepo = params.repo
  const requestedRepo = Array.isArray(rawRepo) ? rawRepo[0] : rawRepo ?? null
  const rawRepoPath = params.repoPath
  const repoPath = Array.isArray(rawRepoPath) ? rawRepoPath[0] : rawRepoPath ?? null
  const state = { user, ...(await publicStore(user.id)) }
  // Renders from the persisted snapshot (DB read). Live provider/GitHub data is
  // refreshed out-of-band by <AnalysisRefresher>, not on every page load.
  const snapshot = await getOrCreateAnalysisSnapshot({
    userId: user.id,
    requestedRepo,
    githubRepos: state.githubRepos,
    repoPath,
  })
  const analysis = snapshot.analysis
  const repos = repoList(state, analysis)
  const selectedRepo = requestedRepo ? repos.find((repo) => repo.fullName === requestedRepo) ?? null : null

  return (
    <main className="app-shell repo-app">
      <Header subtitle={user.email} />
      <AnalysisRefresher repo={requestedRepo} computedAt={snapshot.computedAt} />
      {requestedRepo ? (
        <RepoDetail analysis={analysis} repo={selectedRepo} state={state} />
      ) : (
        <RepositoryDashboard analysis={analysis} repos={repos} selectedRepo={state.selectedRepoFullName} state={state} />
      )}
    </main>
  )
}
