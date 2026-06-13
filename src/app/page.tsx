import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  CloudCog,
  DatabaseZap,
  FolderGit2,
  Gauge,
  Github,
  RefreshCw,
  ShieldAlert,
  Signal,
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
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value)
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

function FreeTierUsage({ rows }: { rows: FreeTierUsageRow[] }) {
  if (!rows.length) return null
  const planName = rows[0].planName
  return (
    <div className="free-tier-block">
      <div className="free-tier-head">
        <Gauge aria-hidden />
        <div>
          <strong>On the free tier — {planName}</strong>
          <span>No billed cost this period. Here is how much of the free allowance is left.</span>
        </div>
      </div>
      <div className="free-tier-list">
        {rows.map((row) => {
          const pct = row.percentUsed ?? 0
          return (
            <article key={`${row.provider}-${row.service}`} className="free-tier-row" title={row.note}>
              <div className="free-tier-row-head">
                <strong>{row.service}</strong>
                {row.used === null ? (
                  <span className="free-tier-allowance">{quantity(row.limit)} {row.unit} included</span>
                ) : (
                  <span className="free-tier-remaining">{quantity(row.remaining ?? 0)} {row.unit} left</span>
                )}
              </div>
              <div className="free-tier-bar" aria-hidden>
                <span className={row.used === null ? "free-tier-fill unknown" : "free-tier-fill"} style={{ width: `${Math.max(pct, row.used === null ? 0 : 2)}%` }} />
              </div>
              <small>
                {row.used === null
                  ? `Usage not reported by provider · ${quantity(row.limit)} ${row.unit} free`
                  : `${quantity(row.used)} of ${quantity(row.limit)} ${row.unit} used (${pct}%)`}
              </small>
            </article>
          )
        })}
      </div>
    </div>
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

function ProviderAccordion({ analysis, connection }: { analysis: AnalysisResult; connection: ProviderConnection }) {
  const rows = providerRows(connection.provider, analysis.costRows)
  const signals = providerSignals(connection.provider, analysis.signals)
  const total = providerTotal(connection.provider, analysis.costRows)
  const freeTier = providerFreeTier(connection.provider, analysis.freeTier)
  const onFreeTier = rows.length === 0 && freeTier.length > 0

  return (
    <details className="provider-accordion" open={connection.detected || rows.length > 0 || onFreeTier}>
      <summary>
        <ProviderLogo provider={connection.provider} />
        <div>
          <strong>{rows.length ? money(total) : onFreeTier ? "Free tier" : "No live cost"}</strong>
          <small>
            {statusText(connection)} · {signals.length} repo signals ·{" "}
            {onFreeTier ? `${freeTier.length} free-tier allowances` : `${rows.length} live billing rows`}
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

        <div className="provider-detail-grid">
          <section>
            <h3>Live resources and cost</h3>
            {rows.length ? (
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
            ) : onFreeTier ? (
              <FreeTierUsage rows={freeTier} />
            ) : (
              <div className="empty-provider-block">
                <DatabaseZap aria-hidden />
                <span>No live billing rows for this provider yet. Connect the provider or add the required billing export to show actual costs.</span>
              </div>
            )}
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
            <span>Live MTD cost</span>
            <strong>{hasScan ? money(analysis.summary.totalCost) : "Pending"}</strong>
          </div>
          <div>
            <span>Providers</span>
            <strong>{hasScan ? relevantProviders.length : 0}</strong>
          </div>
          <div>
            <span>Signals</span>
            <strong>{hasScan ? analysis.summary.signals : 0}</strong>
          </div>
        </div>
      </section>

      {hasScan ? (
        <>
          <ProviderConnectPanel providerConnections={relevantProviders} initialState={state} />
          <section className="provider-deep-dive" aria-label="Provider cost breakdown">
            <div className="deep-dive-heading">
              <div>
                <p>Hosting Providers</p>
                <h2>Expand a provider for live cost rows and repo evidence</h2>
                <span className="live-cost-note">Repo scan detects providers, but dollar amounts appear only from connected billing sources. No estimates are shown.</span>
              </div>
              <CheckCircle2 aria-hidden />
            </div>
            {relevantProviders.map((connection) => (
              <ProviderAccordion key={connection.provider} analysis={analysis} connection={connection} />
            ))}
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
