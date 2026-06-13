import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  CloudCog,
  DatabaseZap,
  FolderGit2,
  Github,
  RefreshCw,
  ShieldAlert,
  Signal,
} from "lucide-react"
import { RepoSyncPanel } from "./RepoSyncPanel"
import { SignInForm } from "./SignInForm"
import { SignOutButton } from "./SignOutButton"
import { buildAnalysisWithLiveData } from "@/lib/costEngine"
import { scanInstallationRepository } from "@/lib/githubClient"
import { currentUserFromCookies } from "@/lib/localAuth"
import { publicStore, readWorkspace } from "@/lib/localStore"
import { scanRepositorySafe } from "@/lib/repoScanner"
import type { AnalysisResult, GitHubRepoSummary, NormalizedCostRow, Provider, ProviderConnection, RepoSignal } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const PROVIDER_LABELS: Record<Provider, string> = {
  github: "GitHub",
  vercel: "Vercel",
  aws: "AWS",
  gcp: "GCP",
  azure: "Azure",
  cloudflare: "Cloudflare",
  digitalocean: "DigitalOcean",
  docker: "Docker",
  unknown: "Unknown",
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value)
}

function providerClass(provider: Provider) {
  return `provider provider-${provider}`
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

function hasLiveRows(rows: NormalizedCostRow[]) {
  return rows.some((row) => row.source === "live")
}

function costModeLabel(rows: NormalizedCostRow[]) {
  return hasLiveRows(rows) ? "Live billing + estimates" : "Repo-based estimate"
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
  const estimateOnly = !hasLiveRows(analysis.costRows)

  return (
    <>
      <section className="repo-home-summary" aria-label="Synced repository summary">
        <div>
          <p>Synced Repositories</p>
          <h1>{repos.length} repos</h1>
        </div>
        <div className="repo-home-metric">
          <span>{estimateOnly ? "Estimated MTD" : "Known MTD cost"}</span>
          <strong>{money(knownTotal)}</strong>
          {estimateOnly ? <small>Not actual billing</small> : null}
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
                <span>{hasCost ? `${costModeLabel(analysis.costRows)} · ${analysis.summary.signals} signals` : "Synced, awaiting remote scan"}</span>
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
  const live = rows.some((row) => row.source === "live")

  return (
    <details className="provider-accordion" open={connection.detected || rows.length > 0}>
      <summary>
        <span className={providerClass(connection.provider)}>{PROVIDER_LABELS[connection.provider]}</span>
        <div>
          <strong>{money(total)}</strong>
          <small>{live ? "Live billing rows" : "Estimated from repo evidence"} · {statusText(connection)} · {signals.length} repo signals · {rows.length} rows</small>
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
        {!live && rows.length > 0 ? (
          <div className="provider-warning estimate-warning">
            <ShieldAlert aria-hidden />
            <span>These are not actual charges. They are rough estimates from repository files. Connect this provider's billing data to replace estimates with live cost rows.</span>
          </div>
        ) : null}

        <div className="provider-detail-grid">
          <section>
            <h3>{live ? "Resources and cost" : "Estimated resources"}</h3>
            {rows.length ? (
              <div className="resource-list">
                {rows.map((row) => (
                  <article key={`${row.provider}-${row.serviceName}-${row.resourceName}-${row.signalId}`} className="resource-row">
                    <div>
                      <strong>{row.serviceName}</strong>
                      <span>{row.resourceName ?? row.resourceId ?? "Unmapped resource"}</span>
                      <small>{row.source === "live" ? "Actual billing row" : `Estimate · ${row.attribution.replace("_", " ")}`}</small>
                    </div>
                    <b>{money(row.cost)}</b>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-provider-block">
                <DatabaseZap aria-hidden />
                <span>No cost rows for this provider yet.</span>
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
  const estimateOnly = !hasLiveRows(analysis.costRows)
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
            <span>{estimateOnly ? "Estimated MTD" : "MTD cost"}</span>
            <strong>{hasScan ? money(analysis.summary.totalCost) : "Pending"}</strong>
            {hasScan && estimateOnly ? <small>Not actual billing</small> : null}
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
        <section className="provider-deep-dive" aria-label="Provider cost breakdown">
          <div className="deep-dive-heading">
            <div>
              <p>Hosting Providers</p>
              <h2>Expand a provider for {estimateOnly ? "repo-based estimates" : "resources and cost breakdown"}</h2>
              {estimateOnly ? <span className="estimate-banner">No provider billing source is connected for this repo yet. Amounts below are rough estimates from repo evidence, not your actual bill.</span> : null}
            </div>
            <CheckCircle2 aria-hidden />
          </div>
          {relevantProviders.map((connection) => (
            <ProviderAccordion key={connection.provider} analysis={analysis} connection={connection} />
          ))}
        </section>
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

async function getAnalysis(input: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
  userId: string
  requestedRepo?: string | null
  githubRepos: GitHubRepoSummary[]
}) {
  if (input.requestedRepo) {
    const repo = input.githubRepos.find((candidate) => candidate.fullName === input.requestedRepo)
    const workspace = await readWorkspace(input.userId)
    const installationId = workspace.connections.github?.installationId
    if (repo && installationId) {
      return buildAnalysisWithLiveData(await scanInstallationRepository(repo, installationId), process.env, input.userId)
    }
  }
  const params = await input.searchParams
  const rawRepoPath = params.repoPath
  const repoPath = Array.isArray(rawRepoPath) ? rawRepoPath[0] : rawRepoPath
  return buildAnalysisWithLiveData(scanRepositorySafe(repoPath), process.env, input.userId)
}

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await currentUserFromCookies()
  if (!user) return <SignInForm />

  const params = await searchParams
  const rawRepo = params.repo
  const requestedRepo = Array.isArray(rawRepo) ? rawRepo[0] : rawRepo
  const state = { user, ...(await publicStore(user.id)) }
  const analysis = await getAnalysis({
    searchParams: Promise.resolve(params),
    userId: user.id,
    requestedRepo,
    githubRepos: state.githubRepos,
  })
  const repos = repoList(state, analysis)
  const selectedRepo = requestedRepo ? repos.find((repo) => repo.fullName === requestedRepo) ?? null : null

  return (
    <main className="app-shell repo-app">
      <Header subtitle={user.email} />
      {requestedRepo ? (
        <RepoDetail analysis={analysis} repo={selectedRepo} state={state} />
      ) : (
        <RepositoryDashboard analysis={analysis} repos={repos} selectedRepo={state.selectedRepoFullName} state={state} />
      )}
    </main>
  )
}
