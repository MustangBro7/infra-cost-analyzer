import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import type {
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
  events: [],
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
    return {
      users: parsed.users ?? {},
      sessions: parsed.sessions ?? {},
      workspaces: parsed.workspaces ?? {},
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
        events: parsed.events ?? [],
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
  return store.workspaces[userId] ?? structuredClone(EMPTY_WORKSPACE)
}

async function writeWorkspace(userId: string, workspace: WorkspaceStore) {
  const store = await readStore()
  store.workspaces[userId] = workspace
  await writeStore(store)
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
  if (selectedRepoFullName !== undefined) {
    workspace.selectedRepoFullName = selectedRepoFullName
  } else if (!workspace.selectedRepoFullName && repos[0]) {
    workspace.selectedRepoFullName = repos[0].fullName
  }
  workspace.events = withEvent(workspace.events, {
    provider: "github",
    level: "success",
    message: `GitHub repository list updated${workspace.selectedRepoFullName ? `; selected ${workspace.selectedRepoFullName}` : ""}.`,
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
    message: `Selected repository ${fullName}.`,
  })
  await writeWorkspace(userId, workspace)
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
    githubRepos: workspace.githubRepos,
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

function sanitizeMetadata(metadata: Record<string, unknown>) {
  const copy = { ...metadata }
  delete copy.refreshToken
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
