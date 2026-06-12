import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  CloudCog,
  Code2,
  DatabaseZap,
  GitBranch,
  Github,
  KeyRound,
  Network,
  RefreshCw,
  ShieldCheck,
  Wifi,
} from "lucide-react"
import { ConnectFlow } from "./ConnectFlow"
import { SignInForm } from "./SignInForm"
import { SignOutButton } from "./SignOutButton"
import { buildAnalysisWithLiveData } from "@/lib/costEngine"
import { currentUserFromCookies } from "@/lib/localAuth"
import { publicStore } from "@/lib/localStore"
import { scanRepositorySafe } from "@/lib/repoScanner"
import type { AnalysisResult, NormalizedCostRow, Provider, RepoSignal } from "@/lib/types"

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

function percent(value: number) {
  return `${Math.max(0, Math.min(100, Math.round(value)))}%`
}

function providerClass(provider: Provider) {
  return `provider provider-${provider}`
}

function statusLabel(status: string) {
  if (status === "connected") return "Ready"
  if (status === "setup_required") return "Setup"
  if (status === "not_detected") return "Idle"
  return "Unavailable"
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

function ProviderGrid({ analysis }: { analysis: AnalysisResult }) {
  return (
    <section className="panel provider-panel" aria-label="Provider connections">
      <div className="section-heading">
        <div>
          <p>Provider Access</p>
          <h2>Detected services and billing readiness</h2>
        </div>
        <KeyRound aria-hidden />
      </div>
      <div className="provider-grid">
        {analysis.providerConnections.map((connection) => (
          <article key={connection.provider} className={connection.detected ? "provider-tile detected" : "provider-tile"}>
            <div className="provider-row">
              <span className={providerClass(connection.provider)}>{connection.label.slice(0, 2).toUpperCase()}</span>
              <span className={`status status-${connection.status}`}>{statusLabel(connection.status)}</span>
            </div>
            <h3>{connection.label}</h3>
            <p>{connection.detected ? connection.setupNotes : "No repo signal found in this scan."}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function CostRows({ rows }: { rows: NormalizedCostRow[] }) {
  return (
    <section className="panel" aria-label="Cost rows">
      <div className="section-heading">
        <div>
          <p>Normalized Costs</p>
          <h2>Repo-attributed charge rows</h2>
        </div>
        <DatabaseZap aria-hidden />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Service</th>
              <th>Resource</th>
              <th>Attribution</th>
              <th>Source</th>
              <th className="numeric">MTD</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.provider}-${row.signalId}-${row.resourceName}`}>
                <td>
                  <span className={providerClass(row.provider)}>{PROVIDER_LABELS[row.provider]}</span>
                </td>
                <td>{row.serviceName}</td>
                <td>{row.resourceName}</td>
                <td>
                  <span className={`pill pill-${row.attribution}`}>{row.attribution.replace("_", " ")}</span>
                </td>
                <td>
                  <span className={`pill pill-${row.source === "live" ? "verified" : "inferred"}`}>{row.source ?? "estimate"}</span>
                </td>
                <td className="numeric">{money(row.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Signals({ signals }: { signals: RepoSignal[] }) {
  return (
    <section className="panel" aria-label="Repository signals">
      <div className="section-heading">
        <div>
          <p>Repository Scan</p>
          <h2>Evidence found in source control</h2>
        </div>
        <Code2 aria-hidden />
      </div>
      <div className="signal-list">
        {signals.slice(0, 14).map((signal) => (
          <article key={signal.id} className="signal">
            <div>
              <span className={providerClass(signal.provider)}>{PROVIDER_LABELS[signal.provider]}</span>
              <h3>{signal.title}</h3>
              <p>{signal.sourcePath}</p>
            </div>
            <div className="confidence">
              <strong>{percent(signal.confidence * 100)}</strong>
              <span>{signal.signalType}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function Breakdown({ analysis }: { analysis: AnalysisResult }) {
  const max = Math.max(1, ...analysis.providerBreakdown.map((row) => row.total))
  return (
    <section className="panel breakdown" aria-label="Provider cost breakdown">
      <div className="section-heading">
        <div>
          <p>Cost Split</p>
          <h2>Provider-level estimate</h2>
        </div>
        <Network aria-hidden />
      </div>
      <div className="bars">
        {analysis.providerBreakdown.map((row) => (
          <div key={row.provider} className="bar-row">
            <div className="bar-label">
              <span>{PROVIDER_LABELS[row.provider]}</span>
              <strong>{money(row.total)}</strong>
            </div>
            <div className="bar-track">
              <div className={`bar-fill fill-${row.provider}`} style={{ width: `${(row.total / max) * 100}%` }} />
            </div>
            <small>
              {money(row.exact)} exact or confirmable · {money(row.inferred)} inferred
            </small>
          </div>
        ))}
      </div>
    </section>
  )
}

function LiveSync({ analysis }: { analysis: AnalysisResult }) {
  return (
    <section className="panel sync-panel" aria-label="Live billing sync">
      <div className="section-heading">
        <div>
          <p>Live Billing</p>
          <h2>Provider sync status</h2>
        </div>
        <Wifi aria-hidden />
      </div>
      <div className="sync-list">
        {analysis.liveSync.map((sync) => (
          <article key={sync.provider} className={`sync-card sync-${sync.status}`}>
            <span className={providerClass(sync.provider)}>{PROVIDER_LABELS[sync.provider]}</span>
            <strong>{sync.status.replace("_", " ")}</strong>
            <p>{sync.message}</p>
            <small>{sync.syncedAt ? `${sync.rows} rows · ${sync.syncedAt}` : `${sync.rows} rows`}</small>
          </article>
        ))}
      </div>
    </section>
  )
}

async function getAnalysis(searchParams: Promise<Record<string, string | string[] | undefined>>, userId: string) {
  const params = await searchParams
  const rawRepoPath = params.repoPath
  const repoPath = Array.isArray(rawRepoPath) ? rawRepoPath[0] : rawRepoPath
  return buildAnalysisWithLiveData(scanRepositorySafe(repoPath), process.env, userId)
}

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await currentUserFromCookies()
  if (!user) {
    return <SignInForm />
  }

  const analysis = await getAnalysis(searchParams, user.id)
  const state = { user, ...(await publicStore(user.id)) }
  const exactShare = analysis.summary.totalCost > 0 ? (analysis.summary.exactCost / analysis.summary.totalCost) * 100 : 0

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <CloudCog aria-hidden />
          </span>
          <div>
            <strong>Infra Cost Analyzer</strong>
            <small>{user.email} · {analysis.repo.owner}/{analysis.repo.name}</small>
          </div>
        </div>
        <div className="top-actions">
          <a href="/api/analyze" className="link-button">
            API JSON <ArrowUpRight aria-hidden />
          </a>
          <a href={`/?_=${Date.now()}`} className="icon-button" aria-label="Refresh scan">
            <RefreshCw aria-hidden />
          </a>
          <SignOutButton />
        </div>
      </header>

      <section className="hero-band" aria-label="Repository cost summary">
        <div className="repo-card">
          <div className="repo-icon">
            <Github aria-hidden />
          </div>
          <div>
            <p>Connected Repository</p>
            <h1>{analysis.repo.owner}/{analysis.repo.name}</h1>
            <span>{analysis.repo.path}</span>
          </div>
        </div>
        <div className="hero-metrics">
          <Stat label="Month to date" value={money(analysis.summary.totalCost)} detail={`${analysis.period.from} to ${analysis.period.to}`} />
          <Stat label="Exact / confirmable" value={money(analysis.summary.exactCost)} detail={`${percent(exactShare)} of detected spend`} />
          <Stat label="Infra signals" value={`${analysis.summary.signals}`} detail={`${analysis.summary.detectedProviders} providers detected`} />
          <Stat label="Confidence" value={`${analysis.summary.confidence}%`} detail="before live billing connections" />
        </div>
      </section>

      <section className="notice-row" aria-label="Readiness notices">
        <div className="notice strong">
          <ShieldCheck aria-hidden />
          <span>Standalone project. No GPay code, data, domains, or deployment config is used.</span>
        </div>
        <div className="notice">
          <AlertTriangle aria-hidden />
          <span>Rows marked inferred require provider billing authorization or mapping confirmation.</span>
        </div>
      </section>

      <ConnectFlow initialState={state} />

      <LiveSync analysis={analysis} />

      <section className="main-grid">
        <Breakdown analysis={analysis} />
        <ProviderGrid analysis={analysis} />
      </section>

      <section className="main-grid lower">
        <Signals signals={analysis.signals} />
        <CostRows rows={analysis.costRows} />
      </section>

      <section className="panel action-panel" aria-label="Next actions">
        <div className="section-heading">
          <div>
            <p>Deployment Checklist</p>
            <h2>What remains before production cost accuracy</h2>
          </div>
          <GitBranch aria-hidden />
        </div>
        <div className="actions">
          {analysis.actions.map((action) => (
            <div key={action} className="action">
              <CheckCircle2 aria-hidden />
              <span>{action}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}
