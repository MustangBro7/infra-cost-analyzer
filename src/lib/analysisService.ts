import { randomUUID } from "node:crypto"
import type { AnalysisSnapshot, GitHubRepoSummary } from "./types"
import { buildAnalysisWithLiveData } from "./costEngine"
import { scanInstallationRepository } from "./githubClient"
import { readAnalysisSnapshot, readStore, readWorkspace, writeAnalysisSnapshot } from "./localStore"
import { emptyRepoScan } from "./repoScanner"
import { analyticsRuntimeFlags } from "./analytics/connection"
import { drainAnalyticsOutbox, enqueueAnalyticsPayload } from "./analytics/outbox"
import { analyticsPayloadFromSnapshot } from "./analytics/payload"
import type { AnalyticsWriteResult } from "./analytics/types"
import { writeAnalyticsPayload } from "./analytics/writer"
import { autoConnectFromEnv } from "./connectors"
import { devPreviewSnapshot, isDevPreview } from "./devPreview"

export const OVERVIEW_SNAPSHOT_KEY = "__overview__"
export type RefreshedAnalysisSnapshot = AnalysisSnapshot & { analytics: AnalyticsWriteResult }

async function persistAnalyticsSnapshot(userId: string, snapshot: AnalysisSnapshot): Promise<AnalyticsWriteResult> {
  const flags = await analyticsRuntimeFlags()
  if (!flags.writes) return { status: "disabled", syncRunId: null }

  const workspace = await readWorkspace(userId)
  const payload = analyticsPayloadFromSnapshot({
    userId,
    snapshot,
    syncRunId: randomUUID(),
    costAssignments: workspace.costAssignments,
  })
  try {
    await writeAnalyticsPayload(payload)
    return { status: "written", syncRunId: payload.syncRunId }
  } catch (error) {
    await enqueueAnalyticsPayload(payload, error).catch(() => undefined)
    return { status: "queued", syncRunId: payload.syncRunId }
  }
}

/**
 * Stable key under which a repo's analysis snapshot is persisted. The no-repo
 * "overview" view uses a single shared key; GitHub repos are keyed by full name.
 */
export function snapshotKeyForRepo(repoFullName?: string | null): string {
  return repoFullName && repoFullName.length > 0 ? repoFullName : OVERVIEW_SNAPSHOT_KEY
}

async function scanForRepo(input: {
  userId: string
  requestedRepo?: string | null
  githubRepos: GitHubRepoSummary[]
}): Promise<ReturnType<typeof import("./repoScanner").scanRepositoryFiles>> {
  if (input.requestedRepo) {
    const repo = input.githubRepos.find((candidate) => candidate.fullName === input.requestedRepo)
    const workspace = await readWorkspace(input.userId)
    const installationId = workspace.connections.github?.installationId
    if (repo && installationId) {
      return scanInstallationRepository(repo, installationId)
    }
  }
  // No GitHub repo selected (or its installation is gone): show the overview
  // with connected provider costs only. Repos are connected via GitHub.
  return emptyRepoScan()
}

/**
 * Runs the live scan + cost computation for a repo and persists the result as a
 * snapshot so subsequent page loads read it straight from the store. This is
 * the only place that performs the slow live provider/GitHub work.
 */
export async function refreshAnalysisSnapshot(input: {
  userId: string
  requestedRepo?: string | null
  githubRepos: GitHubRepoSummary[]
  forceCostExplorer?: boolean
}): Promise<RefreshedAnalysisSnapshot> {
  // Staging replica: provider credentials cloned from production intentionally
  // do NOT decrypt here (different APP_ENCRYPTION_KEY), so a live recompute
  // would see every provider as not-connected and overwrite the cloned
  // snapshot with an empty one. Serve the cloned snapshot untouched instead —
  // staging data only changes via scripts/staging-sync-data.sh.
  if (process.env.AMBRIUM_STAGING_USER && process.env.AMBRIUM_STAGING_KEY) {
    const existing = await readAnalysisSnapshot(input.userId, snapshotKeyForRepo(input.requestedRepo))
    if (existing) return { ...existing, analytics: { status: "disabled", syncRunId: null } }
  }
  const scan = await scanForRepo(input)
  // Pass the existing snapshot so a provider whose live pull fails this time
  // keeps its last-known-good usage instead of being blanked.
  const previous = await readAnalysisSnapshot(input.userId, snapshotKeyForRepo(input.requestedRepo))
  const analysis = await buildAnalysisWithLiveData(scan, process.env, input.userId, {
    forceCostExplorer: input.forceCostExplorer === true,
    previousAnalysis: previous?.analysis,
  })
  const snapshot: AnalysisSnapshot = {
    key: snapshotKeyForRepo(input.requestedRepo),
    analysis,
    computedAt: new Date().toISOString(),
  }
  await writeAnalysisSnapshot(input.userId, snapshot)
  return { ...snapshot, analytics: await persistAnalyticsSnapshot(input.userId, snapshot) }
}

/**
 * Returns the persisted snapshot for a repo, computing and storing one on the
 * first access so the page always has data to render without a live round-trip
 * on every load.
 */
export async function getOrCreateAnalysisSnapshot(input: {
  userId: string
  requestedRepo?: string | null
  githubRepos: GitHubRepoSummary[]
}): Promise<AnalysisSnapshot> {
  // Local preview: never touch live providers / DB — serve the seeded snapshot.
  if (isDevPreview()) return devPreviewSnapshot(snapshotKeyForRepo(input.requestedRepo))
  const existing = await readAnalysisSnapshot(input.userId, snapshotKeyForRepo(input.requestedRepo))
  if (existing) return existing
  return refreshAnalysisSnapshot(input)
}

/**
 * Background refresh for every user's existing snapshots: re-pulls live provider
 * data while REUSING each snapshot's repo scan (no GitHub re-scan) so it stays
 * cheap. Always skips Cost Explorer so a schedule can never incur AWS charges.
 * Driven by the cron worker via the protected /api/cron/refresh endpoint.
 */
export async function refreshAllSnapshotsLiveData(): Promise<{
  users: number
  snapshots: number
  analyticsOutbox: { delivered: number; failed: number }
}> {
  const analyticsOutbox = await drainAnalyticsOutbox()
  const store = await readStore()
  let users = 0
  let snapshots = 0
  for (const [userId] of Object.entries(store.workspaces)) {
    await autoConnectFromEnv(userId)
    const workspace = await readWorkspace(userId)
    const snaps = Object.values(workspace.analysisSnapshots ?? {})
    // A newly migrated or newly created production user may have connected
    // accounts but no snapshot yet. Seed the overview during the scheduled sweep
    // so data starts flowing without requiring an interactive dashboard visit.
    if (snaps.length === 0) {
      try {
        const seeded = {
          key: OVERVIEW_SNAPSHOT_KEY,
          analysis: await buildAnalysisWithLiveData(emptyRepoScan(), process.env, userId, { skipCostExplorer: true }),
          computedAt: new Date().toISOString(),
        }
        await writeAnalysisSnapshot(userId, seeded)
        await persistAnalyticsSnapshot(userId, seeded)
        users += 1
        snapshots += 1
      } catch {
        // Continue with other users if one account's initial sync fails.
      }
      continue
    }
    users += 1
    // A free-plan Worker is capped at 50 subrequests per invocation. Each
    // snapshot fans out to several provider APIs, so prioritize the two surfaces
    // the user actually lands on: account overview and the selected repository.
    const prioritized = [...snaps].sort((a, b) => {
      const rank = (key: string) =>
        key === OVERVIEW_SNAPSHOT_KEY ? 0 : key === workspace.selectedRepoFullName ? 1 : 2
      return rank(a.key) - rank(b.key) || b.computedAt.localeCompare(a.computedAt)
    }).slice(0, 2)
    for (const snap of prioritized) {
      try {
        const repoScan = { repo: snap.analysis.repo, signals: snap.analysis.signals }
        const analysis = await buildAnalysisWithLiveData(repoScan, process.env, userId, {
          skipCostExplorer: true,
          previousAnalysis: snap.analysis,
        })
        const refreshed = { key: snap.key, analysis, computedAt: new Date().toISOString() }
        await writeAnalysisSnapshot(userId, refreshed)
        await persistAnalyticsSnapshot(userId, refreshed)
        snapshots += 1
      } catch {
        // One user's failure shouldn't stop the rest of the sweep.
      }
    }
  }
  return { users, snapshots, analyticsOutbox }
}
