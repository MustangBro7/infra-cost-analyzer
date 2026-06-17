import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import type {
  AnalysisSnapshot,
  AppStore,
  ConnectionEvent,
  GitHubRepoSummary,
  LocalSession,
  LocalUser,
  Provider,
  StoredConnection,
  WorkspaceStore,
} from "./types"

const EMPTY_WORKSPACE: WorkspaceStore = {
  connections: {},
  githubRepos: [],
  selectedRepoFullName: null,
  syncedRepoFullNames: [],
  events: [],
  analysisSnapshots: {},
  repoProviderLinks: {},
  costAssignments: {},
}

const EMPTY_STORE: AppStore = {
  users: {},
  sessions: {},
  workspaces: {},
}

let testStorePath: string | null = null

export function setStorePathForTests(filePath: string | null) {
  testStorePath = filePath
}

// ---------- storage backends ----------
// Default: JSON file on disk (local development).
// On Cloudflare Workers, the same JSON document lives in a D1 key-value table
// reached through the DB binding, since Workers have no writable filesystem.

function storePath() {
  return testStorePath || path.join(dataRoot(), ".data", "tenant-store.json")
}

function dataRoot() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return "/tmp/infra-cost-analyzer"
  const cwd = process.cwd().replaceAll(path.sep, "/")
  return cwd.endsWith(".next/standalone") ? path.resolve(process.cwd(), "../..") : process.cwd()
}

const STORE_KEY = "infra-cost-analyzer:app-store"

interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  first<T = unknown>(column?: string): Promise<T | null>
  run(): Promise<unknown>
}

interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike
}

let d1TableReady = false

async function d1Binding(): Promise<D1DatabaseLike | null> {
  if (testStorePath) return null
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare")
    const context = getCloudflareContext()
    const db = (context.env as { DB?: D1DatabaseLike }).DB ?? null
    if (db && !d1TableReady) {
      await db.prepare("CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run()
      d1TableReady = true
    }
    return db
  } catch {
    // Not running inside the Cloudflare adapter (plain node, tests, CI).
    return null
  }
}

async function loadRaw(): Promise<unknown> {
  const db = await d1Binding()
  if (db) {
    const value = await db
      .prepare("SELECT value FROM app_kv WHERE key = ?1")
      .bind(STORE_KEY)
      .first<string>("value")
    if (!value) return null
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  const filePath = storePath()
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

async function persistRaw(store: AppStore) {
  const db = await d1Binding()
  if (db) {
    await db
      .prepare(
        "INSERT INTO app_kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .bind(STORE_KEY, JSON.stringify(store))
      .run()
    return
  }
  mkdirSync(path.dirname(storePath()), { recursive: true })
  writeFileSync(storePath(), JSON.stringify(store, null, 2))
}

// ---------- store API ----------

function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

function userIdForEmail(email: string) {
  return `usr_${createHash("sha256").update(normalizeEmail(email)).digest("hex").slice(0, 16)}`
}

function newSessionId() {
  return `sess_${randomBytes(32).toString("base64url")}`
}

export async function readStore(): Promise<AppStore> {
  const parsed = (await loadRaw()) as Partial<AppStore & WorkspaceStore> | null
  if (!parsed) return structuredClone(EMPTY_STORE)
  if (parsed.users || parsed.sessions || parsed.workspaces) {
    const workspaces = Object.fromEntries(
      Object.entries(parsed.workspaces ?? {}).map(([userId, workspace]) => [userId, normalizeWorkspace(workspace)])
    )
    return {
      users: parsed.users ?? {},
      sessions: parsed.sessions ?? {},
      workspaces,
    }
  }

  // Legacy single-tenant store migration for local prototypes created before auth existed.
  const legacyUserId = "usr_local_legacy"
  return {
    users: {
      [legacyUserId]: {
        id: legacyUserId,
        email: "local@example.test",
        name: "Local User",
        createdAt: new Date().toISOString(),
        lastSignedInAt: new Date().toISOString(),
      },
    },
    sessions: {},
    workspaces: {
      [legacyUserId]: {
        connections: parsed.connections ?? {},
        githubRepos: parsed.githubRepos ?? [],
        selectedRepoFullName: parsed.selectedRepoFullName ?? null,
        syncedRepoFullNames: parsed.selectedRepoFullName ? [parsed.selectedRepoFullName] : [],
        events: parsed.events ?? [],
        analysisSnapshots: {},
        repoProviderLinks: {},
        costAssignments: {},
      },
    },
  }
}

export async function writeStore(store: AppStore) {
  await persistRaw(store)
}

export async function createOrUpdateUserSession(input: { email: string; name?: string | null }) {
  const store = await readStore()
  const now = new Date().toISOString()
  const email = normalizeEmail(input.email)
  const userId = userIdForEmail(email)
  const user: LocalUser = {
    id: userId,
    email,
    name: input.name?.trim() || email.split("@")[0] || "Local User",
    createdAt: store.users[userId]?.createdAt ?? now,
    lastSignedInAt: now,
  }
  const session: LocalSession = {
    id: newSessionId(),
    userId,
    createdAt: now,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(),
  }
  store.users[userId] = user
  store.sessions[session.id] = session
  store.workspaces[userId] = store.workspaces[userId] ?? structuredClone(EMPTY_WORKSPACE)
  store.workspaces[userId].events = withEvent(store.workspaces[userId].events, {
    provider: "system",
    level: "success",
    message: `${user.email} signed in.`,
  })
  await writeStore(store)
  return { user, session }
}

export async function getUserById(id: string | undefined | null): Promise<LocalUser | null> {
  if (!id) return null
  const store = await readStore()
  return store.users[id] ?? null
}

/**
 * Upserts a user keyed by their Clerk user id. Auth is owned by Clerk; this
 * keeps a lightweight local mirror so the existing per-user workspace/connection
 * model keeps working. Returns the user; the caller checks getUserById first to
 * decide whether this is a first sign-in (and should run provider auto-connect).
 */
export async function createClerkUser(input: { id: string; email: string; name?: string | null }): Promise<LocalUser> {
  const store = await readStore()
  const now = new Date().toISOString()
  const email = normalizeEmail(input.email)
  const existing = store.users[input.id]
  const user: LocalUser = {
    id: input.id,
    email,
    name: input.name?.trim() || email.split("@")[0] || "User",
    createdAt: existing?.createdAt ?? now,
    lastSignedInAt: now,
  }
  store.users[input.id] = user
  store.workspaces[input.id] = store.workspaces[input.id] ?? structuredClone(EMPTY_WORKSPACE)
  if (!existing) {
    store.workspaces[input.id].events = withEvent(store.workspaces[input.id].events, {
      provider: "system",
      level: "success",
      message: `${user.email} signed in.`,
    })
  }
  await writeStore(store)
  return user
}

export async function getUserBySessionId(sessionId: string | undefined | null): Promise<LocalUser | null> {
  if (!sessionId) return null
  const store = await readStore()
  const session = store.sessions[sessionId]
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return null
  return store.users[session.userId] ?? null
}

export async function deleteSession(sessionId: string | undefined | null) {
  if (!sessionId) return
  const store = await readStore()
  delete store.sessions[sessionId]
  await writeStore(store)
}

export async function readWorkspace(userId: string): Promise<WorkspaceStore> {
  const store = await readStore()
  return normalizeWorkspace(store.workspaces[userId])
}

async function writeWorkspace(userId: string, workspace: WorkspaceStore) {
  const store = await readStore()
  store.workspaces[userId] = workspace
  await writeStore(store)
}

export async function readAnalysisSnapshot(userId: string, key: string): Promise<AnalysisSnapshot | null> {
  const workspace = await readWorkspace(userId)
  return workspace.analysisSnapshots[key] ?? null
}

export async function writeAnalysisSnapshot(userId: string, snapshot: AnalysisSnapshot) {
  const workspace = await readWorkspace(userId)
  // Keep the snapshot map bounded so the persisted store stays small.
  const entries = Object.values(workspace.analysisSnapshots)
    .filter((existing) => existing.key !== snapshot.key)
    .concat(snapshot)
    .sort((a, b) => b.computedAt.localeCompare(a.computedAt))
    .slice(0, 25)
  workspace.analysisSnapshots = Object.fromEntries(entries.map((entry) => [entry.key, entry]))
  await writeWorkspace(userId, workspace)
}

export async function upsertConnection(userId: string, connection: StoredConnection) {
  const workspace = await readWorkspace(userId)
  workspace.connections[connection.provider] = connection
  workspace.events = withEvent(workspace.events, {
    provider: connection.provider,
    level: connection.status === "connected" ? "success" : connection.status === "error" ? "error" : "warning",
    message:
      connection.status === "connected"
        ? `${labelProvider(connection.provider)} connected${connection.accountLabel ? `: ${connection.accountLabel}` : ""}.`
        : `${labelProvider(connection.provider)} needs attention.`,
  })
  await writeWorkspace(userId, workspace)
  return connection
}

export async function removeConnection(userId: string, provider: Provider) {
  const workspace = await readWorkspace(userId)
  delete workspace.connections[provider]
  workspace.events = withEvent(workspace.events, {
    provider,
    level: "warning",
    message: `${labelProvider(provider)} disconnected.`,
  })
  await writeWorkspace(userId, workspace)
}

export async function saveGitHubRepos(userId: string, repos: GitHubRepoSummary[], selectedRepoFullName?: string | null) {
  const workspace = await readWorkspace(userId)
  workspace.githubRepos = repos
  const available = new Set(repos.map((repo) => repo.fullName))
  workspace.syncedRepoFullNames = workspace.syncedRepoFullNames.filter((fullName) => available.has(fullName))
  if (selectedRepoFullName !== undefined) {
    workspace.selectedRepoFullName = selectedRepoFullName
  } else if (!workspace.selectedRepoFullName && repos[0]) {
    workspace.selectedRepoFullName = repos[0].fullName
  }
  if (workspace.selectedRepoFullName && !workspace.syncedRepoFullNames.includes(workspace.selectedRepoFullName)) {
    workspace.syncedRepoFullNames.push(workspace.selectedRepoFullName)
  }
  workspace.events = withEvent(workspace.events, {
    provider: "github",
    level: "success",
    message: `GitHub repository list updated; ${workspace.syncedRepoFullNames.length} synced.`,
  })
  await writeWorkspace(userId, workspace)
}

export async function selectGitHubRepo(userId: string, fullName: string) {
  const workspace = await readWorkspace(userId)
  if (!workspace.githubRepos.some((repo) => repo.fullName === fullName)) {
    throw new Error("Repository is not available in the connected GitHub installation.")
  }
  workspace.selectedRepoFullName = fullName
  workspace.events = withEvent(workspace.events, {
    provider: "github",
    level: "success",
    message: `Opened repository ${fullName}.`,
  })
  await writeWorkspace(userId, workspace)
}

export async function syncGitHubRepo(userId: string, fullName: string) {
  const workspace = await readWorkspace(userId)
  if (!workspace.githubRepos.some((repo) => repo.fullName === fullName)) {
    throw new Error("Repository is not available in the connected GitHub installation.")
  }
  if (!workspace.syncedRepoFullNames.includes(fullName)) {
    workspace.syncedRepoFullNames.push(fullName)
  }
  workspace.selectedRepoFullName = workspace.selectedRepoFullName ?? fullName
  workspace.events = withEvent(workspace.events, {
    provider: "github",
    level: "success",
    message: `Synced repository ${fullName}.`,
  })
  await writeWorkspace(userId, workspace)
}

export async function unsyncGitHubRepo(userId: string, fullName: string) {
  const workspace = await readWorkspace(userId)
  workspace.syncedRepoFullNames = workspace.syncedRepoFullNames.filter((repo) => repo !== fullName)
  if (workspace.selectedRepoFullName === fullName) {
    workspace.selectedRepoFullName = workspace.syncedRepoFullNames[0] ?? workspace.githubRepos[0]?.fullName ?? null
  }
  workspace.events = withEvent(workspace.events, {
    provider: "github",
    level: "warning",
    message: `Stopped syncing repository ${fullName}.`,
  })
  await writeWorkspace(userId, workspace)
}

/**
 * Sets which connected provider accounts a repo is linked to. An empty list
 * clears the link (the repo falls back to its derived default).
 */
export async function setRepoProviderLinks(userId: string, repoFullName: string, providers: Provider[]) {
  const workspace = await readWorkspace(userId)
  const unique = [...new Set(providers)]
  if (unique.length === 0) {
    delete workspace.repoProviderLinks[repoFullName]
  } else {
    workspace.repoProviderLinks[repoFullName] = unique
  }
  workspace.events = withEvent(workspace.events, {
    provider: "github",
    level: "success",
    message: `Updated provider accounts for ${repoFullName}.`,
  })
  await writeWorkspace(userId, workspace)
  return workspace.repoProviderLinks[repoFullName] ?? []
}

/**
 * Manually assigns a billing line item (by its stable key) to a repo, or clears
 * the assignment (target === null). Lets the user split an account's cost across
 * repos by hand.
 */
export async function setCostAssignment(userId: string, itemKey: string, target: string | null) {
  const workspace = await readWorkspace(userId)
  if (target === null) {
    delete workspace.costAssignments[itemKey]
  } else {
    workspace.costAssignments[itemKey] = target
  }
  await writeWorkspace(userId, workspace)
  return workspace.costAssignments[itemKey] ?? null
}

export async function appendEvent(userId: string, event: Omit<ConnectionEvent, "id" | "createdAt">) {
  const workspace = await readWorkspace(userId)
  workspace.events = withEvent(workspace.events, event)
  await writeWorkspace(userId, workspace)
}

export async function publicStore(userId: string) {
  const workspace = await readWorkspace(userId)
  const events =
    workspace.events.length > 0
      ? workspace.events
      : Object.values(workspace.connections)
          .filter((connection): connection is StoredConnection => Boolean(connection))
          .map((connection) => ({
            id: `loaded-${connection.provider}`,
            provider: connection.provider,
            level: connection.status === "connected" ? "success" as const : "warning" as const,
            message: `${labelProvider(connection.provider)} connection loaded from local state${connection.accountLabel ? `: ${connection.accountLabel}` : ""}.`,
            createdAt: connection.connectedAt,
          }))
  return {
    selectedRepoFullName: workspace.selectedRepoFullName,
    syncedRepoFullNames: workspace.syncedRepoFullNames,
    githubRepos: workspace.githubRepos,
    repoProviderLinks: workspace.repoProviderLinks,
    costAssignments: workspace.costAssignments,
    events: events.slice(0, 30),
    connections: Object.fromEntries(
      Object.entries(workspace.connections).map(([provider, connection]) => [
        provider,
        connection
          ? {
              provider: connection.provider,
              status: connection.status,
              accountLabel: connection.accountLabel,
              installationId: connection.installationId,
              selectedRepoFullName: connection.selectedRepoFullName,
              connectedAt: connection.connectedAt,
              lastVerifiedAt: connection.lastVerifiedAt,
              lastError: connection.lastError,
              metadata: sanitizeMetadata(connection.metadata),
            }
          : null,
      ])
    ),
  }
}

function normalizeWorkspace(workspace?: Partial<WorkspaceStore>): WorkspaceStore {
  if (!workspace) return structuredClone(EMPTY_WORKSPACE)
  const selectedRepoFullName = workspace.selectedRepoFullName ?? null
  const syncedRepoFullNames = Array.isArray(workspace.syncedRepoFullNames)
    ? [...new Set(workspace.syncedRepoFullNames.filter((value): value is string => typeof value === "string" && value.length > 0))]
    : selectedRepoFullName
      ? [selectedRepoFullName]
      : []
  return {
    connections: workspace.connections ?? {},
    githubRepos: workspace.githubRepos ?? [],
    selectedRepoFullName,
    syncedRepoFullNames,
    events: workspace.events ?? [],
    analysisSnapshots: workspace.analysisSnapshots ?? {},
    repoProviderLinks: workspace.repoProviderLinks ?? {},
    costAssignments: workspace.costAssignments ?? {},
  }
}

function sanitizeMetadata(metadata: Record<string, unknown>) {
  const copy = { ...metadata }
  delete copy.refreshToken
  // Don't ship the cached AWS cost rows to the client; expose only when they
  // were last fetched so the UI can show "last pulled X ago".
  const cache = copy.costExplorerCache as { fetchedAt?: string } | undefined
  if (cache) {
    copy.costExplorerLastFetchedAt = cache.fetchedAt ?? null
    delete copy.costExplorerCache
  }
  return copy
}

function withEvent(
  events: ConnectionEvent[],
  event: Omit<ConnectionEvent, "id" | "createdAt">
): ConnectionEvent[] {
  return [
    {
      ...event,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: new Date().toISOString(),
    },
    ...events,
  ].slice(0, 50)
}

function labelProvider(provider: Provider | "system") {
  if (provider === "system") return "System"
  return provider === "github"
    ? "GitHub"
    : provider === "gcp"
      ? "Google Cloud"
      : provider.charAt(0).toUpperCase() + provider.slice(1)
}
