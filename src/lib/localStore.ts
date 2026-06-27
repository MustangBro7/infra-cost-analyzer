import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import type {
  AnalysisSnapshot,
  AppStore,
  ConnectionEvent,
  CustomProviderDef,
  GitHubRepoSummary,
  LocalSession,
  LocalUser,
  Provider,
  StoredConnection,
  WorkspaceStore,
  CliPairing,
} from "./types"
import { normalizeDashboardLayout } from "./dashboardLayout"
import { CONNECTABLE_PROVIDERS } from "./repoLinks"

const EMPTY_WORKSPACE: WorkspaceStore = {
  connections: {},
  githubRepos: [],
  selectedRepoFullName: null,
  syncedRepoFullNames: [],
  events: [],
  analysisSnapshots: {},
  repoProviderLinks: {},
  costAssignments: {},
  customProviders: {},
  customConnections: {},
}

const EMPTY_STORE: AppStore = {
  users: {},
  sessions: {},
  workspaces: {},
  cliPairings: {},
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
  if (testStorePath) return testStorePath
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, ".data", "tenant-store.json")
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return "/tmp/infra-cost-analyzer/.data/tenant-store.json"
  }
  const cwd = process.cwd().replaceAll(path.sep, "/")
  return cwd.endsWith(".next/standalone")
    ? path.join(/* turbopackIgnore: true */ process.cwd(), "..", "..", ".data", "tenant-store.json")
    : path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "tenant-store.json")
}

const STORE_KEY = "infra-cost-analyzer:app-store"

interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike
  first<T = unknown>(column?: string): Promise<T | null>
  all<T = unknown>(): Promise<{ results?: T[] }>
  run(): Promise<unknown>
}

interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike
}

let d1TableReady = false

type RuntimeEnv = {
  DB?: D1DatabaseLike
  APP_ENCRYPTION_KEY?: string
}

async function cloudflareRuntimeEnv(): Promise<RuntimeEnv | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare/cloudflare-context")
    return getCloudflareContext().env as RuntimeEnv
  } catch {
    return null
  }
}

async function runtimeEnv(): Promise<RuntimeEnv> {
  return {
    ...(process.env as RuntimeEnv),
    ...((await cloudflareRuntimeEnv()) ?? {}),
  }
}

async function requireEncryptionKey(): Promise<CryptoKey> {
  const secret = (await runtimeEnv()).APP_ENCRYPTION_KEY
  const keySecret =
    secret ||
    (process.env.NODE_ENV === "production"
      ? null
      : "ambrium-local-development-only-encryption-key")
  if (!keySecret) {
    throw new Error("APP_ENCRYPTION_KEY is required before storing provider credentials in D1.")
  }
  const keyMaterial = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keySecret))
  return crypto.subtle.importKey("raw", keyMaterial, "AES-GCM", false, ["encrypt", "decrypt"])
}

function bytesToBase64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64")
}

function base64ToBytes(value: string) {
  return new Uint8Array(Buffer.from(value, "base64"))
}

async function encryptJson(value: unknown): Promise<string> {
  const iv = randomBytes(12)
  const encoded = new TextEncoder().encode(JSON.stringify(value ?? null))
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await requireEncryptionKey(), encoded)
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`
}

async function decryptJson<T>(value: string | null | undefined, fallback: T): Promise<T> {
  if (!value) return fallback
  if (!value.startsWith("v1:")) return fallback
  const [, iv, ciphertext] = value.split(":")
  if (!iv || !ciphertext) return fallback
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(iv) },
      await requireEncryptionKey(),
      base64ToBytes(ciphertext)
    )
    return JSON.parse(new TextDecoder().decode(plaintext)) as T
  } catch {
    return fallback
  }
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

async function ensureD1Schema(db: D1DatabaseLike): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS app_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_signed_in_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS app_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS app_workspace_settings (
      user_id TEXT PRIMARY KEY,
      selected_repo_full_name TEXT,
      synced_repo_full_names_json TEXT NOT NULL,
      monthly_budget_usd REAL,
      dashboard_layout_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS app_provider_connections (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      account_label TEXT,
      installation_id INTEGER,
      selected_repo_full_name TEXT,
      connected_at TEXT NOT NULL,
      last_verified_at TEXT,
      last_error TEXT,
      encrypted_private_json TEXT NOT NULL,
      PRIMARY KEY (user_id, provider)
    )`,
    `CREATE TABLE IF NOT EXISTS app_custom_connections (
      user_id TEXT NOT NULL,
      custom_provider_id TEXT NOT NULL,
      status TEXT NOT NULL,
      account_label TEXT,
      connected_at TEXT NOT NULL,
      last_verified_at TEXT,
      last_error TEXT,
      encrypted_private_json TEXT NOT NULL,
      PRIMARY KEY (user_id, custom_provider_id)
    )`,
    `CREATE TABLE IF NOT EXISTS app_github_repos (
      user_id TEXT NOT NULL,
      full_name TEXT NOT NULL,
      repo_id INTEGER NOT NULL,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      private INTEGER NOT NULL,
      default_branch TEXT NOT NULL,
      html_url TEXT NOT NULL,
      pushed_at TEXT,
      updated_at TEXT,
      position INTEGER NOT NULL,
      PRIMARY KEY (user_id, full_name)
    )`,
    `CREATE TABLE IF NOT EXISTS app_repo_provider_links (
      user_id TEXT NOT NULL,
      repo_full_name TEXT NOT NULL,
      providers_json TEXT NOT NULL,
      PRIMARY KEY (user_id, repo_full_name)
    )`,
    `CREATE TABLE IF NOT EXISTS app_cost_assignments (
      user_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      target TEXT NOT NULL,
      PRIMARY KEY (user_id, item_key)
    )`,
    `CREATE TABLE IF NOT EXISTS app_custom_providers (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    )`,
    `CREATE TABLE IF NOT EXISTS app_events (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      provider TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    )`,
    `CREATE TABLE IF NOT EXISTS app_analysis_snapshots (
      user_id TEXT NOT NULL,
      snapshot_key TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (user_id, snapshot_key)
    )`,
    `CREATE TABLE IF NOT EXISTS app_cli_pairings (
      device_code TEXT PRIMARY KEY,
      user_code TEXT NOT NULL,
      user_id TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      cli_token TEXT,
      cli_token_expires_at TEXT
    )`,
  ]
  for (const statement of statements) {
    await db.prepare(statement).run()
  }
  for (const statement of [
    "ALTER TABLE app_github_repos ADD COLUMN pushed_at TEXT",
    "ALTER TABLE app_github_repos ADD COLUMN updated_at TEXT",
  ]) {
    try {
      await db.prepare(statement).run()
    } catch {
      // Existing deployments may already have these nullable columns.
    }
  }
}

async function d1Binding(): Promise<D1DatabaseLike | null> {
  if (testStorePath) return null
  try {
    const db = (await cloudflareRuntimeEnv())?.DB ?? null
    if (db && !d1TableReady) {
      await ensureD1Schema(db)
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
    return loadD1Store(db)
  }
  const filePath = storePath()
  if (!existsSync(/* turbopackIgnore: true */ filePath)) return null
  try {
    return JSON.parse(readFileSync(/* turbopackIgnore: true */ filePath, "utf8"))
  } catch {
    return null
  }
}

async function persistRaw(store: AppStore) {
  const db = await d1Binding()
  if (db) {
    await persistD1Store(db, store)
    return
  }
  mkdirSync(path.dirname(storePath()), { recursive: true })
  writeFileSync(storePath(), JSON.stringify(store, null, 2))
}

async function loadD1Store(db: D1DatabaseLike): Promise<AppStore> {
  const legacyValue = await db
    .prepare("SELECT value FROM app_kv WHERE key = ?1")
    .bind(STORE_KEY)
    .first<string>("value")
  if (legacyValue) {
    const migrated = parseJson<AppStore | null>(legacyValue, null)
    if (migrated) {
      await persistD1Store(db, migrated)
      await db.prepare("DELETE FROM app_kv WHERE key = ?1").bind(STORE_KEY).run()
      return migrated
    }
  }

  const store: AppStore = {
    users: {},
    sessions: {},
    workspaces: {},
    cliPairings: {},
  }

  const users = (await db.prepare("SELECT * FROM app_users").all<Record<string, string>>()).results ?? []
  for (const row of users) {
    store.users[row.id] = {
      id: row.id,
      email: row.email,
      name: row.name,
      createdAt: row.created_at,
      lastSignedInAt: row.last_signed_in_at,
    }
  }

  const sessions = (await db.prepare("SELECT * FROM app_sessions").all<Record<string, string>>()).results ?? []
  for (const row of sessions) {
    store.sessions[row.id] = {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }

  const settings = (await db.prepare("SELECT * FROM app_workspace_settings").all<Record<string, string | number | null>>()).results ?? []
  for (const row of settings) {
    store.workspaces[String(row.user_id)] = {
      ...structuredClone(EMPTY_WORKSPACE),
      selectedRepoFullName: row.selected_repo_full_name ? String(row.selected_repo_full_name) : null,
      syncedRepoFullNames: parseJson(String(row.synced_repo_full_names_json ?? "[]"), []),
      monthlyBudgetUsd: typeof row.monthly_budget_usd === "number" ? row.monthly_budget_usd : null,
      dashboardLayout: parseJson(String(row.dashboard_layout_json ?? "[]"), []),
    }
  }

  for (const userId of Object.keys(store.users)) {
    store.workspaces[userId] = store.workspaces[userId] ?? structuredClone(EMPTY_WORKSPACE)
  }

  const connectionRows = (await db.prepare("SELECT * FROM app_provider_connections").all<Record<string, string | number | null>>()).results ?? []
  for (const row of connectionRows) {
    const userId = String(row.user_id)
    const privatePayload = await decryptJson<{ accessToken?: string; metadata?: Record<string, unknown> }>(
      row.encrypted_private_json ? String(row.encrypted_private_json) : null,
      { metadata: {} }
    )
    const connection: StoredConnection = {
      provider: String(row.provider) as Provider,
      status: String(row.status) as StoredConnection["status"],
      accountLabel: row.account_label ? String(row.account_label) : null,
      accessToken: privatePayload.accessToken,
      installationId: typeof row.installation_id === "number" ? row.installation_id : undefined,
      selectedRepoFullName: row.selected_repo_full_name ? String(row.selected_repo_full_name) : undefined,
      connectedAt: String(row.connected_at),
      lastVerifiedAt: row.last_verified_at ? String(row.last_verified_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      metadata: privatePayload.metadata ?? {},
    }
    store.workspaces[userId] = store.workspaces[userId] ?? structuredClone(EMPTY_WORKSPACE)
    store.workspaces[userId].connections[connection.provider] = connection
  }

  const customConnectionRows = (await db.prepare("SELECT * FROM app_custom_connections").all<Record<string, string | null>>()).results ?? []
  for (const row of customConnectionRows) {
    const userId = String(row.user_id)
    const privatePayload = await decryptJson<{ accessToken?: string; metadata?: Record<string, unknown> }>(
      row.encrypted_private_json ? String(row.encrypted_private_json) : null,
      { metadata: {} }
    )
    store.workspaces[userId] = store.workspaces[userId] ?? structuredClone(EMPTY_WORKSPACE)
    store.workspaces[userId].customConnections[String(row.custom_provider_id)] = {
      provider: "custom",
      status: String(row.status) as StoredConnection["status"],
      accountLabel: row.account_label ? String(row.account_label) : null,
      accessToken: privatePayload.accessToken,
      connectedAt: String(row.connected_at),
      lastVerifiedAt: row.last_verified_at ? String(row.last_verified_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      metadata: { ...(privatePayload.metadata ?? {}), customProviderId: String(row.custom_provider_id) },
    }
  }

  const repos = (await db.prepare("SELECT * FROM app_github_repos ORDER BY user_id, position").all<Record<string, string | number>>()).results ?? []
  for (const row of repos) {
    const userId = String(row.user_id)
    store.workspaces[userId] = store.workspaces[userId] ?? structuredClone(EMPTY_WORKSPACE)
    store.workspaces[userId].githubRepos.push({
      id: Number(row.repo_id),
      owner: String(row.owner),
      name: String(row.name),
      fullName: String(row.full_name),
      private: Number(row.private) === 1,
      defaultBranch: String(row.default_branch),
      htmlUrl: String(row.html_url),
      pushedAt: row.pushed_at ? String(row.pushed_at) : null,
      updatedAt: row.updated_at ? String(row.updated_at) : null,
    })
  }

  const repoLinks = (await db.prepare("SELECT * FROM app_repo_provider_links").all<Record<string, string>>()).results ?? []
  for (const row of repoLinks) {
    const userId = row.user_id
    store.workspaces[userId] = store.workspaces[userId] ?? structuredClone(EMPTY_WORKSPACE)
    store.workspaces[userId].repoProviderLinks[row.repo_full_name] = parseJson(row.providers_json, [])
  }

  const assignments = (await db.prepare("SELECT * FROM app_cost_assignments").all<Record<string, string>>()).results ?? []
  for (const row of assignments) {
    store.workspaces[row.user_id] = store.workspaces[row.user_id] ?? structuredClone(EMPTY_WORKSPACE)
    store.workspaces[row.user_id].costAssignments[row.item_key] = row.target
  }

  const customProviders = (await db.prepare("SELECT * FROM app_custom_providers").all<Record<string, string>>()).results ?? []
  for (const row of customProviders) {
    store.workspaces[row.user_id] = store.workspaces[row.user_id] ?? structuredClone(EMPTY_WORKSPACE)
    const def = parseJson<CustomProviderDef | null>(row.definition_json, null)
    if (def) store.workspaces[row.user_id].customProviders[row.id] = def
  }

  const events = (await db.prepare("SELECT * FROM app_events ORDER BY user_id, position").all<Record<string, string>>()).results ?? []
  for (const row of events) {
    store.workspaces[row.user_id] = store.workspaces[row.user_id] ?? structuredClone(EMPTY_WORKSPACE)
    store.workspaces[row.user_id].events.push({
      id: row.id,
      provider: row.provider as Provider | "system",
      level: row.level as ConnectionEvent["level"],
      message: row.message,
      createdAt: row.created_at,
    })
  }

  const snapshots = (await db.prepare("SELECT * FROM app_analysis_snapshots").all<Record<string, string>>()).results ?? []
  for (const row of snapshots) {
    store.workspaces[row.user_id] = store.workspaces[row.user_id] ?? structuredClone(EMPTY_WORKSPACE)
    const snapshot = parseJson<AnalysisSnapshot | null>(row.snapshot_json, null)
    if (snapshot) store.workspaces[row.user_id].analysisSnapshots[row.snapshot_key] = snapshot
  }

  const pairings = (await db.prepare("SELECT * FROM app_cli_pairings").all<Record<string, string | null>>()).results ?? []
  for (const row of pairings) {
    store.cliPairings[String(row.device_code)] = {
      deviceCode: String(row.device_code),
      userCode: String(row.user_code),
      userId: row.user_id ? String(row.user_id) : null,
      status: String(row.status) as CliPairing["status"],
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      cliToken: row.cli_token ? String(row.cli_token) : null,
      cliTokenExpiresAt: row.cli_token_expires_at ? String(row.cli_token_expires_at) : null,
    }
  }

  return store
}

async function persistD1Store(db: D1DatabaseLike, store: AppStore): Promise<void> {
  const tables = [
    "app_users",
    "app_sessions",
    "app_workspace_settings",
    "app_provider_connections",
    "app_custom_connections",
    "app_github_repos",
    "app_repo_provider_links",
    "app_cost_assignments",
    "app_custom_providers",
    "app_events",
    "app_analysis_snapshots",
    "app_cli_pairings",
  ]
  for (const table of tables) {
    await db.prepare(`DELETE FROM ${table}`).run()
  }

  for (const user of Object.values(store.users)) {
    await db.prepare(
      `INSERT INTO app_users (id, email, name, created_at, last_signed_in_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(user.id, user.email, user.name, user.createdAt, user.lastSignedInAt).run()
  }

  for (const session of Object.values(store.sessions)) {
    await db.prepare(
      `INSERT INTO app_sessions (id, user_id, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4)`
    ).bind(session.id, session.userId, session.createdAt, session.expiresAt).run()
  }

  for (const [userId, rawWorkspace] of Object.entries(store.workspaces)) {
    const workspace = normalizeWorkspace(rawWorkspace)
    await db.prepare(
      `INSERT INTO app_workspace_settings (
        user_id, selected_repo_full_name, synced_repo_full_names_json, monthly_budget_usd, dashboard_layout_json
      ) VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(
      userId,
      workspace.selectedRepoFullName,
      JSON.stringify(workspace.syncedRepoFullNames),
      workspace.monthlyBudgetUsd ?? null,
      JSON.stringify(normalizeDashboardLayout(workspace.dashboardLayout))
    ).run()

    for (const connection of Object.values(workspace.connections).filter((value): value is StoredConnection => Boolean(value))) {
      await db.prepare(
        `INSERT INTO app_provider_connections (
          user_id, provider, status, account_label, installation_id, selected_repo_full_name,
          connected_at, last_verified_at, last_error, encrypted_private_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
      ).bind(
        userId,
        connection.provider,
        connection.status,
        connection.accountLabel,
        connection.installationId ?? null,
        connection.selectedRepoFullName ?? null,
        connection.connectedAt,
        connection.lastVerifiedAt,
        connection.lastError,
        await encryptJson({ accessToken: connection.accessToken, metadata: connection.metadata ?? {} })
      ).run()
    }

    for (const [id, connection] of Object.entries(workspace.customConnections)) {
      await db.prepare(
        `INSERT INTO app_custom_connections (
          user_id, custom_provider_id, status, account_label, connected_at,
          last_verified_at, last_error, encrypted_private_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      ).bind(
        userId,
        id,
        connection.status,
        connection.accountLabel,
        connection.connectedAt,
        connection.lastVerifiedAt,
        connection.lastError,
        await encryptJson({ accessToken: connection.accessToken, metadata: connection.metadata ?? {} })
      ).run()
    }

    for (const [position, repo] of workspace.githubRepos.entries()) {
      await db.prepare(
        `INSERT INTO app_github_repos (
          user_id, full_name, repo_id, owner, name, private, default_branch, html_url, pushed_at, updated_at, position
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
      ).bind(
        userId,
        repo.fullName,
        repo.id,
        repo.owner,
        repo.name,
        repo.private ? 1 : 0,
        repo.defaultBranch,
        repo.htmlUrl,
        repo.pushedAt ?? null,
        repo.updatedAt ?? null,
        position
      ).run()
    }

    for (const [repoFullName, providers] of Object.entries(workspace.repoProviderLinks)) {
      await db.prepare(
        `INSERT INTO app_repo_provider_links (user_id, repo_full_name, providers_json)
         VALUES (?1, ?2, ?3)`
      ).bind(userId, repoFullName, JSON.stringify(providers)).run()
    }

    for (const [itemKey, target] of Object.entries(workspace.costAssignments)) {
      await db.prepare(
        `INSERT INTO app_cost_assignments (user_id, item_key, target)
         VALUES (?1, ?2, ?3)`
      ).bind(userId, itemKey, target).run()
    }

    for (const [id, def] of Object.entries(workspace.customProviders)) {
      await db.prepare(
        `INSERT INTO app_custom_providers (user_id, id, definition_json)
         VALUES (?1, ?2, ?3)`
      ).bind(userId, id, JSON.stringify(def)).run()
    }

    for (const [position, event] of workspace.events.slice(0, 50).entries()) {
      await db.prepare(
        `INSERT INTO app_events (user_id, id, provider, level, message, created_at, position)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      ).bind(userId, event.id, event.provider, event.level, event.message, event.createdAt, position).run()
    }

    for (const snapshot of Object.values(workspace.analysisSnapshots)) {
      await db.prepare(
        `INSERT INTO app_analysis_snapshots (user_id, snapshot_key, snapshot_json, computed_at)
         VALUES (?1, ?2, ?3, ?4)`
      ).bind(userId, snapshot.key, JSON.stringify(snapshot), snapshot.computedAt).run()
    }
  }

  for (const pairing of Object.values(store.cliPairings)) {
    await db.prepare(
      `INSERT INTO app_cli_pairings (
        device_code, user_code, user_id, status, created_at, expires_at, cli_token, cli_token_expires_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(
      pairing.deviceCode,
      pairing.userCode,
      pairing.userId,
      pairing.status,
      pairing.createdAt,
      pairing.expiresAt,
      pairing.cliToken,
      pairing.cliTokenExpiresAt
    ).run()
  }
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
      cliPairings: parsed.cliPairings ?? {},
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
        customProviders: {},
        customConnections: {},
      },
    },
    cliPairings: {},
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
  delete workspace.analysisSnapshots[fullName]
  delete workspace.repoProviderLinks[fullName]
  workspace.costAssignments = Object.fromEntries(
    Object.entries(workspace.costAssignments).filter(([, target]) => target !== fullName)
  )
  if (workspace.selectedRepoFullName === fullName) {
    workspace.selectedRepoFullName = workspace.syncedRepoFullNames[0] ?? null
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

// ---------- custom (user/agent-defined) providers ----------

export async function listCustomProviders(userId: string): Promise<CustomProviderDef[]> {
  const workspace = await readWorkspace(userId)
  return Object.values(workspace.customProviders)
}

export async function upsertCustomProvider(userId: string, def: CustomProviderDef) {
  const workspace = await readWorkspace(userId)
  const existing = workspace.customProviders[def.id]
  workspace.customProviders[def.id] = { ...def, createdAt: existing?.createdAt ?? def.createdAt, updatedAt: new Date().toISOString() }
  workspace.events = withEvent(workspace.events, {
    provider: "custom",
    level: "success",
    message: `${existing ? "Updated" : "Added"} custom provider ${def.name}.`,
  })
  await writeWorkspace(userId, workspace)
  return workspace.customProviders[def.id]
}

export async function removeCustomProvider(userId: string, id: string) {
  const workspace = await readWorkspace(userId)
  const def = workspace.customProviders[id]
  delete workspace.customProviders[id]
  delete workspace.customConnections[id]
  workspace.events = withEvent(workspace.events, {
    provider: "custom",
    level: "warning",
    message: `Removed custom provider ${def?.name ?? id}.`,
  })
  await writeWorkspace(userId, workspace)
}

/** Saves the pasted secret for a custom provider (server-side only). */
export async function setCustomConnection(userId: string, id: string, secret: string, accountLabel?: string | null) {
  const workspace = await readWorkspace(userId)
  const def = workspace.customProviders[id]
  if (!def) throw new Error("Unknown custom provider.")
  const now = new Date().toISOString()
  workspace.customConnections[id] = {
    provider: "custom",
    status: "connected",
    accountLabel: accountLabel ?? def.name,
    accessToken: secret,
    connectedAt: now,
    lastVerifiedAt: now,
    lastError: null,
    metadata: { customProviderId: id },
  }
  workspace.events = withEvent(workspace.events, {
    provider: "custom",
    level: "success",
    message: `${def.name} secret saved.`,
  })
  await writeWorkspace(userId, workspace)
}

export async function removeCustomConnection(userId: string, id: string) {
  const workspace = await readWorkspace(userId)
  delete workspace.customConnections[id]
  await writeWorkspace(userId, workspace)
}

/** Sets (or clears, with null) the workspace's monthly spend budget in USD. */
export async function setMonthlyBudget(userId: string, amount: number | null) {
  const workspace = await readWorkspace(userId)
  workspace.monthlyBudgetUsd = amount != null && Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : null
  await writeWorkspace(userId, workspace)
  return workspace.monthlyBudgetUsd
}

export async function setDashboardLayout(userId: string, layout: unknown) {
  const workspace = await readWorkspace(userId)
  workspace.dashboardLayout = normalizeDashboardLayout(layout)
  await writeWorkspace(userId, workspace)
  return workspace.dashboardLayout
}

export async function appendEvent(userId: string, event: Omit<ConnectionEvent, "id" | "createdAt">) {
  const workspace = await readWorkspace(userId)
  workspace.events = withEvent(workspace.events, event)
  await writeWorkspace(userId, workspace)
}

export async function publicStore(userId: string) {
  const workspace = await readWorkspace(userId)
  return publicStoreFromWorkspace(workspace)
}

/**
 * Loads the dashboard's private and public workspace views from one backend
 * read. The dashboard used to call publicStore(), readWorkspace(), and then
 * readAnalysisSnapshot(), which fetched and parsed the same D1 JSON document
 * three times on every navigation.
 */
export async function readDashboardStore(userId: string) {
  const workspace = await readWorkspace(userId)
  return {
    workspace,
    publicState: publicStoreFromWorkspace(workspace),
  }
}

function publicStoreFromWorkspace(workspace: WorkspaceStore) {
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
    suggestedProviders: computeSuggestedProviders(workspace),
    repoProviderLinks: workspace.repoProviderLinks,
    costAssignments: workspace.costAssignments,
    monthlyBudgetUsd: workspace.monthlyBudgetUsd ?? null,
    dashboardLayout: normalizeDashboardLayout(workspace.dashboardLayout),
    // Custom provider definitions (no secrets) plus whether each has a saved
    // secret, so the UI can render and prompt to connect them.
    customProviders: Object.values(workspace.customProviders).map((def) => ({
      ...def,
      connected: workspace.customConnections[def.id]?.status === "connected",
      accountLabel: workspace.customConnections[def.id]?.accountLabel ?? null,
    })),
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

/**
 * Connectable providers detected in the user's synced repos that aren't yet
 * connected, ranked by how strongly they were detected (signal count across
 * repos). Drives the "we found these in your repos — connect them" onboarding:
 * the UI promotes exactly the providers a user actually uses instead of showing
 * every provider equally.
 */
function computeSuggestedProviders(workspace: WorkspaceStore): Provider[] {
  const connectable = new Set<Provider>(CONNECTABLE_PROVIDERS)
  const syncedKeys = new Set(workspace.syncedRepoFullNames)
  const connected = new Set<Provider>(
    Object.values(workspace.connections)
      .filter((connection): connection is StoredConnection => Boolean(connection) && connection!.status === "connected")
      .map((connection) => connection.provider)
  )
  const counts = new Map<Provider, number>()
  for (const [key, snapshot] of Object.entries(workspace.analysisSnapshots)) {
    if (!syncedKeys.has(key)) continue
    for (const signal of snapshot.analysis.signals) {
      if (!connectable.has(signal.provider) || connected.has(signal.provider)) continue
      counts.set(signal.provider, (counts.get(signal.provider) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([provider]) => provider)
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
    customProviders: workspace.customProviders ?? {},
    customConnections: workspace.customConnections ?? {},
    monthlyBudgetUsd: workspace.monthlyBudgetUsd ?? null,
    dashboardLayout: normalizeDashboardLayout(workspace.dashboardLayout),
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
      id: `${Date.now()}-${randomBytes(12).toString("base64url")}`,
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
      : provider === "motherduck"
        ? "MotherDuck"
      : provider.charAt(0).toUpperCase() + provider.slice(1)
}
