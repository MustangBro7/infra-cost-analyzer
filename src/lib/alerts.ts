import type { AlertSettings, AlertState, AnalysisResult, FreeTierUsageRow, NormalizedCostRow } from "./types"
import { projectedSpend } from "./forecast"
import { planLimits } from "./plan"
import { getUserById, readWorkspace, saveAlertState } from "./localStore"
import { OVERVIEW_SNAPSHOT_KEY } from "./analysisService"
import { sendEmail } from "./email"

export const DEFAULT_ALERT_SETTINGS: AlertSettings = { enabled: true, digest: "weekly" }

export function normalizeAlertSettings(settings?: Partial<AlertSettings> | null): AlertSettings {
  return {
    enabled: settings?.enabled !== false,
    digest: settings?.digest === "off" ? "off" : "weekly",
  }
}

export function normalizeAlertState(state?: Partial<AlertState> | null): AlertState {
  return {
    sentKeys: state?.sentKeys ?? {},
    lastDigestAt: state?.lastDigestAt ?? null,
  }
}

export interface AlertItem {
  /** Stable dedupe key, scoped to the billing month, e.g. "2026-07:budget:80". */
  key: string
  severity: "warning" | "critical"
  title: string
  detail: string
}

function money(value: number): string {
  const abs = Math.abs(value)
  const digits = abs > 0 && abs < 1000 ? 2 : 0
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

function sumCost(rows: Array<Pick<NormalizedCostRow, "cost">>): number {
  return rows.reduce((sum, row) => sum + (Number.isFinite(row.cost) ? row.cost : 0), 0)
}

function periodProgress(period: { from: string; to: string }, now: Date) {
  const dayMs = 24 * 60 * 60 * 1000
  const start = new Date(period.from)
  const end = new Date(period.to)
  const totalDays = Math.max(Math.round((end.getTime() - start.getTime()) / dayMs), 1)
  const clamped = Math.min(Math.max(now.getTime(), start.getTime()), end.getTime())
  const elapsedDays = Math.min(Math.max(Math.round((clamped - start.getTime()) / dayMs) + 1, 1), totalDays)
  return { elapsedDays, totalDays }
}

function providerLabel(row: Pick<NormalizedCostRow | FreeTierUsageRow, "provider"> & { customLabel?: string }): string {
  if (row.customLabel) return row.customLabel
  const provider = row.provider
  if (provider === "github") return "GitHub"
  if (provider === "gcp") return "Google Cloud"
  if (provider === "aws") return "AWS"
  if (provider === "openai") return "OpenAI"
  if (provider === "motherduck") return "MotherDuck"
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

/**
 * Pure threshold evaluation over one analysis snapshot. Returns EVERY currently
 * firing alert; the caller filters against AlertState.sentKeys so each key is
 * emailed once per billing month.
 *
 * Rules (v1):
 *  • Month-to-date spend crosses 50% / 80% / 100% of the monthly budget.
 *  • Projected month-end spend exceeds the budget (subscription-aware forecast).
 *  • A free-tier metric reaches 80% (warning) or 100% (critical) of its limit.
 */
export function evaluateThresholdAlerts(input: {
  analysis: Pick<AnalysisResult, "costRows" | "freeTier" | "period">
  monthlyBudgetUsd: number | null | undefined
  now?: Date
}): AlertItem[] {
  const now = input.now ?? new Date()
  const month = input.analysis.period.from.slice(0, 7)
  const items: AlertItem[] = []

  const budget = input.monthlyBudgetUsd
  if (budget != null && budget > 0) {
    const spent = sumCost(input.analysis.costRows)
    const pct = (spent / budget) * 100
    for (const threshold of [100, 80, 50]) {
      if (pct >= threshold) {
        items.push({
          key: `${month}:budget:${threshold}`,
          severity: threshold >= 100 ? "critical" : "warning",
          title:
            threshold >= 100
              ? `Budget exceeded — ${money(spent)} spent of ${money(budget)}`
              : `${threshold}% of budget used — ${money(spent)} of ${money(budget)}`,
          detail: `Month-to-date spend is at ${Math.round(pct)}% of your ${money(budget)} monthly budget.`,
        })
        break // Only the highest crossed threshold; lower ones are implied.
      }
    }

    const { elapsedDays, totalDays } = periodProgress(input.analysis.period, now)
    const forecast = projectedSpend(input.analysis.costRows, elapsedDays, totalDays)
    if (forecast.projected > budget && elapsedDays < totalDays) {
      items.push({
        key: `${month}:budget:forecast`,
        severity: "warning",
        title: `Forecast over budget — ${money(forecast.projected)} projected vs ${money(budget)}`,
        detail: `At the current run rate (${money(forecast.dailyRate)}/day usage + ${money(forecast.flatTotal)} subscriptions), month-end spend is projected ${money(forecast.projected - budget)} over budget.`,
      })
    }
  }

  for (const row of input.analysis.freeTier) {
    if (row.percentUsed == null || row.limit == null) continue
    const threshold = row.percentUsed >= 100 ? 100 : row.percentUsed >= 80 ? 80 : null
    if (threshold == null) continue
    const scope = `${row.provider}:${row.customProviderId ?? ""}:${row.service}`
    items.push({
      key: `${month}:freetier:${scope}:${threshold}`,
      severity: threshold >= 100 ? "critical" : "warning",
      title:
        threshold >= 100
          ? `${providerLabel(row)} free tier exhausted — ${row.service}`
          : `${providerLabel(row)} free tier at ${Math.round(row.percentUsed)}% — ${row.service}`,
      detail: `${row.used ?? 0} of ${row.limit} ${row.unit} used on ${row.planName}. ${
        threshold >= 100 ? "Further usage may start billing." : "You are close to the limit."
      }`,
    })
  }

  return items
}

// ---------- email rendering ----------

const EMAIL_STYLE = {
  body: `margin:0;padding:24px;background:#f4f4f2;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a18;`,
  card: `max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e3e1dc;padding:28px;`,
  brand: `font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:#6f6b62;margin:0 0 18px;`,
  h1: `font-size:19px;margin:0 0 14px;color:#1a1a18;`,
  item: `padding:12px 14px;margin:0 0 10px;border-left:3px solid #b8860b;background:#faf9f7;`,
  itemCritical: `padding:12px 14px;margin:0 0 10px;border-left:3px solid #b3261e;background:#fdf6f5;`,
  itemTitle: `font-weight:600;font-size:14px;margin:0 0 4px;`,
  itemDetail: `font-size:13px;color:#4d4a44;margin:0;`,
  table: `width:100%;border-collapse:collapse;font-size:13px;margin:0 0 16px;`,
  td: `padding:7px 0;border-bottom:1px solid #eeece8;`,
  tdRight: `padding:7px 0;border-bottom:1px solid #eeece8;text-align:right;font-variant-numeric:tabular-nums;`,
  foot: `font-size:12px;color:#8a867d;margin:18px 0 0;`,
}

function emailShell(heading: string, inner: string): string {
  return `<div style="${EMAIL_STYLE.body}"><div style="${EMAIL_STYLE.card}"><p style="${EMAIL_STYLE.brand}">Ambrium</p><h1 style="${EMAIL_STYLE.h1}">${heading}</h1>${inner}<p style="${EMAIL_STYLE.foot}">Sent by Ambrium cost alerts · manage in Dashboard → Insights → Email alerts.</p></div></div>`
}

export function buildAlertEmail(items: AlertItem[], monthLabel: string): { subject: string; html: string; text: string } {
  const critical = items.filter((item) => item.severity === "critical").length
  const subject =
    items.length === 1
      ? `Ambrium alert: ${items[0].title}`
      : `Ambrium: ${items.length} cost alerts${critical > 0 ? ` (${critical} critical)` : ""} — ${monthLabel}`
  const html = emailShell(
    `Cost alerts for ${monthLabel}`,
    items
      .map(
        (item) =>
          `<div style="${item.severity === "critical" ? EMAIL_STYLE.itemCritical : EMAIL_STYLE.item}"><p style="${EMAIL_STYLE.itemTitle}">${item.title}</p><p style="${EMAIL_STYLE.itemDetail}">${item.detail}</p></div>`
      )
      .join("")
  )
  const text = [
    `Ambrium cost alerts — ${monthLabel}`,
    "",
    ...items.map((item) => `• [${item.severity.toUpperCase()}] ${item.title}\n  ${item.detail}`),
  ].join("\n")
  return { subject, html, text }
}

export function buildDigestEmail(input: {
  analysis: Pick<AnalysisResult, "costRows" | "freeTier" | "period">
  monthlyBudgetUsd: number | null | undefined
  syncedRepoCount: number
  now?: Date
}): { subject: string; html: string; text: string } {
  const now = input.now ?? new Date()
  const monthLabel = new Date(input.analysis.period.from).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })
  const spent = sumCost(input.analysis.costRows)
  const { elapsedDays, totalDays } = periodProgress(input.analysis.period, now)
  const forecast = projectedSpend(input.analysis.costRows, elapsedDays, totalDays)

  const byProvider = new Map<string, number>()
  for (const row of input.analysis.costRows) {
    const label = providerLabel(row)
    byProvider.set(label, (byProvider.get(label) ?? 0) + row.cost)
  }
  const topProviders = [...byProvider.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)

  const runway = input.analysis.freeTier
    .filter((row) => row.percentUsed != null)
    .sort((a, b) => (b.percentUsed ?? 0) - (a.percentUsed ?? 0))
    .slice(0, 5)

  const budget = input.monthlyBudgetUsd
  const budgetLine =
    budget != null && budget > 0
      ? forecast.projected > budget
        ? `Projected ${money(forecast.projected - budget)} OVER your ${money(budget)} budget.`
        : `On track — ${money(budget - forecast.projected)} projected headroom on your ${money(budget)} budget.`
      : "No monthly budget set."

  const providerRows = topProviders
    .map(([label, cost]) => `<tr><td style="${EMAIL_STYLE.td}">${label}</td><td style="${EMAIL_STYLE.tdRight}">${money(cost)}</td></tr>`)
    .join("")
  const runwayRows = runway
    .map(
      (row) =>
        `<tr><td style="${EMAIL_STYLE.td}">${providerLabel(row)} · ${row.service}</td><td style="${EMAIL_STYLE.tdRight}">${Math.round(row.percentUsed ?? 0)}%</td></tr>`
    )
    .join("")

  const html = emailShell(
    `Weekly digest — ${monthLabel}`,
    `<table style="${EMAIL_STYLE.table}"><tr><td style="${EMAIL_STYLE.td}">Month-to-date spend</td><td style="${EMAIL_STYLE.tdRight}"><strong>${money(spent)}</strong></td></tr><tr><td style="${EMAIL_STYLE.td}">Projected month-end</td><td style="${EMAIL_STYLE.tdRight}">${money(forecast.projected)}</td></tr><tr><td style="${EMAIL_STYLE.td}">Budget</td><td style="${EMAIL_STYLE.tdRight}">${budgetLine}</td></tr><tr><td style="${EMAIL_STYLE.td}">Projects synced</td><td style="${EMAIL_STYLE.tdRight}">${input.syncedRepoCount}</td></tr></table>` +
      (providerRows ? `<h1 style="${EMAIL_STYLE.h1}">Spend by provider</h1><table style="${EMAIL_STYLE.table}">${providerRows}</table>` : "") +
      (runwayRows ? `<h1 style="${EMAIL_STYLE.h1}">Free-tier runway</h1><table style="${EMAIL_STYLE.table}">${runwayRows}</table>` : "")
  )
  const text = [
    `Ambrium weekly digest — ${monthLabel}`,
    "",
    `Month-to-date spend: ${money(spent)}`,
    `Projected month-end: ${money(forecast.projected)}`,
    `Budget: ${budgetLine}`,
    `Projects synced: ${input.syncedRepoCount}`,
    "",
    ...(topProviders.length ? ["Spend by provider:", ...topProviders.map(([label, cost]) => `  ${label}: ${money(cost)}`), ""] : []),
    ...(runway.length
      ? ["Free-tier runway:", ...runway.map((row) => `  ${providerLabel(row)} · ${row.service}: ${Math.round(row.percentUsed ?? 0)}%`)]
      : []),
  ].join("\n")
  return { subject: `Ambrium weekly digest — ${money(spent)} month-to-date`, html, text }
}

// ---------- sweep orchestration ----------

const DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
const SENT_KEY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

export interface AlertSweepResult {
  alertsSent: number
  digestSent: boolean
  skipped?: string
}

/**
 * Evaluates and delivers email alerts for one user: threshold alerts (each key
 * once per month) plus the weekly digest. Called from the cron sweep after a
 * user's snapshots refresh. Indie-plan only — the Free plan's advertised
 * feature set does not include alerts, and its data would be too stale to
 * alert on anyway.
 */
export async function runAlertSweepForUser(userId: string, options?: { now?: Date }): Promise<AlertSweepResult> {
  // The staging replica clones production users; it must never email them.
  if (process.env.AMBRIUM_STAGING_USER) return { alertsSent: 0, digestSent: false, skipped: "staging" }

  const user = await getUserById(userId)
  if (!user?.email) return { alertsSent: 0, digestSent: false, skipped: "no user email" }

  const workspace = await readWorkspace(userId)
  if (!planLimits(workspace).emailAlerts) return { alertsSent: 0, digestSent: false, skipped: "plan" }

  const settings = normalizeAlertSettings(workspace.alertSettings)
  if (!settings.enabled && settings.digest === "off") return { alertsSent: 0, digestSent: false, skipped: "disabled" }

  const snapshot = workspace.analysisSnapshots[OVERVIEW_SNAPSHOT_KEY]
  if (!snapshot) return { alertsSent: 0, digestSent: false, skipped: "no overview snapshot" }

  const now = options?.now ?? new Date()
  const state = normalizeAlertState(workspace.alertState)
  let stateChanged = false
  let alertsSent = 0
  let digestSent = false

  if (settings.enabled) {
    const firing = evaluateThresholdAlerts({
      analysis: snapshot.analysis,
      monthlyBudgetUsd: workspace.monthlyBudgetUsd,
      now,
    })
    const fresh = firing.filter((item) => !state.sentKeys[item.key])
    if (fresh.length > 0) {
      const monthLabel = new Date(snapshot.analysis.period.from).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
      const message = buildAlertEmail(fresh, monthLabel)
      const result = await sendEmail({ to: user.email, ...message })
      if (result.sent) {
        for (const item of fresh) state.sentKeys[item.key] = now.toISOString()
        alertsSent = fresh.length
        stateChanged = true
      } else if (result.skipped) {
        console.warn(`alerts: skipped sending ${fresh.length} alert(s) for ${userId}: ${result.skipped}`)
      }
    }
  }

  if (settings.digest === "weekly") {
    const last = state.lastDigestAt ? new Date(state.lastDigestAt).getTime() : 0
    if (now.getTime() - last >= DIGEST_INTERVAL_MS) {
      const message = buildDigestEmail({
        analysis: snapshot.analysis,
        monthlyBudgetUsd: workspace.monthlyBudgetUsd,
        syncedRepoCount: workspace.syncedRepoFullNames.length,
        now,
      })
      const result = await sendEmail({ to: user.email, ...message })
      if (result.sent) {
        state.lastDigestAt = now.toISOString()
        digestSent = true
        stateChanged = true
      } else if (result.skipped) {
        console.warn(`alerts: skipped digest for ${userId}: ${result.skipped}`)
      }
    }
  }

  if (stateChanged) {
    // Bound sentKeys so the settings row never grows without limit.
    const cutoff = now.getTime() - SENT_KEY_RETENTION_MS
    state.sentKeys = Object.fromEntries(
      Object.entries(state.sentKeys).filter(([, sentAt]) => new Date(sentAt).getTime() >= cutoff)
    )
    await saveAlertState(userId, state)
  }

  return { alertsSent, digestSent }
}
