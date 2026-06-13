import type { AnalysisSnapshot, GitHubRepoSummary } from "./types"
import { buildAnalysisWithLiveData } from "./costEngine"
import { scanInstallationRepository } from "./githubClient"
import { readAnalysisSnapshot, readWorkspace, writeAnalysisSnapshot } from "./localStore"
import { scanRepositorySafe } from "./repoScanner"

export const LOCAL_SNAPSHOT_KEY = "__local__"

/**
 * Stable key under which a repo's analysis snapshot is persisted. The default
 * local scan uses a single shared key; remote repos are keyed by full name.
 */
export function snapshotKeyForRepo(repoFullName?: string | null): string {
  return repoFullName && repoFullName.length > 0 ? repoFullName : LOCAL_SNAPSHOT_KEY
}

async function scanForRepo(input: {
  userId: string
  requestedRepo?: string | null
  githubRepos: GitHubRepoSummary[]
  repoPath?: string | null
}): Promise<ReturnType<typeof import("./repoScanner").scanRepository>> {
  if (input.requestedRepo) {
    const repo = input.githubRepos.find((candidate) => candidate.fullName === input.requestedRepo)
    const workspace = await readWorkspace(input.userId)
    const installationId = workspace.connections.github?.installationId
    if (repo && installationId) {
      return scanInstallationRepository(repo, installationId)
    }
  }
  return scanRepositorySafe(input.repoPath)
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
  repoPath?: string | null
}): Promise<AnalysisSnapshot> {
  const scan = await scanForRepo(input)
  const analysis = await buildAnalysisWithLiveData(scan, process.env, input.userId)
  const snapshot: AnalysisSnapshot = {
    key: snapshotKeyForRepo(input.requestedRepo),
    analysis,
    computedAt: new Date().toISOString(),
  }
  await writeAnalysisSnapshot(input.userId, snapshot)
  return snapshot
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
  repoPath?: string | null
}): Promise<AnalysisSnapshot> {
  const existing = await readAnalysisSnapshot(input.userId, snapshotKeyForRepo(input.requestedRepo))
  if (existing) return existing
  return refreshAnalysisSnapshot(input)
}
