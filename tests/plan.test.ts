import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import type { GitHubRepoSummary, StoredConnection, WorkspaceStore } from "../src/lib/types"

function setStorePath() {
  const dir = mkdtempSync(path.join(tmpdir(), "infra-plan-"))
  return { dir, filePath: path.join(dir, "store.json") }
}

function connection(provider: StoredConnection["provider"]): StoredConnection {
  return {
    provider,
    status: "connected",
    accountLabel: `${provider} acct`,
    accessToken: "tok",
    connectedAt: "2026-07-01T00:00:00.000Z",
    lastVerifiedAt: null,
    lastError: null,
    metadata: {},
  }
}

function repo(name: string): GitHubRepoSummary {
  return {
    id: name.length,
    owner: "acme",
    name,
    fullName: `acme/${name}`,
    private: false,
    defaultBranch: "main",
    htmlUrl: `https://github.com/acme/${name}`,
  }
}

test("workspacePlan maps subscription status to the effective plan", async () => {
  const { workspacePlan } = await import("../src/lib/plan")
  const base = (billingSubscription: WorkspaceStore["billingSubscription"]) => ({ billingSubscription })
  assert.equal(workspacePlan(base(null)), "free")
  assert.equal(
    workspacePlan(base({ provider: "dodo", plan: "indie", status: "active", customerId: null, subscriptionId: null, checkoutSessionId: null, productId: null, currentPeriodEnd: null, updatedAt: "" })),
    "indie"
  )
  // Dunning keeps access while payment retries.
  assert.equal(
    workspacePlan(base({ provider: "dodo", plan: "indie", status: "past_due", customerId: null, subscriptionId: null, checkoutSessionId: null, productId: null, currentPeriodEnd: null, updatedAt: "" })),
    "indie"
  )
  // Cancelled keeps access until the paid period ends, then drops to free.
  const future = new Date(Date.now() + 86400000).toISOString()
  const past = new Date(Date.now() - 86400000).toISOString()
  assert.equal(
    workspacePlan(base({ provider: "dodo", plan: "indie", status: "cancelled", customerId: null, subscriptionId: null, checkoutSessionId: null, productId: null, currentPeriodEnd: future, updatedAt: "" })),
    "indie"
  )
  assert.equal(
    workspacePlan(base({ provider: "dodo", plan: "indie", status: "cancelled", customerId: null, subscriptionId: null, checkoutSessionId: null, productId: null, currentPeriodEnd: past, updatedAt: "" })),
    "free"
  )
  assert.equal(
    workspacePlan(base({ provider: "dodo", plan: "indie", status: "checkout_started", customerId: null, subscriptionId: null, checkoutSessionId: null, productId: null, currentPeriodEnd: null, updatedAt: "" })),
    "free"
  )
})

test("free plan blocks a third provider connection; reconnects and github stay allowed", async () => {
  const { dir, filePath } = setStorePath()
  try {
    const { setStorePathForTests, upsertConnection } = await import("../src/lib/localStore")
    const { PlanLimitError } = await import("../src/lib/plan")
    setStorePathForTests(filePath)
    const userId = "usr_plan_providers"

    await upsertConnection(userId, connection("vercel"))
    await upsertConnection(userId, connection("cloudflare"))
    // GitHub is the repo source, not a billing provider — never counted.
    await upsertConnection(userId, connection("github"))

    await assert.rejects(() => upsertConnection(userId, connection("gcp")), PlanLimitError)
    // Updating an existing connection is not a new connect.
    await upsertConnection(userId, { ...connection("vercel"), accountLabel: "rotated token" })
  } finally {
    const { setStorePathForTests } = await import("../src/lib/localStore")
    setStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("indie plan lifts provider and repo limits", async () => {
  const { dir, filePath } = setStorePath()
  try {
    const { setStorePathForTests, upsertConnection, upsertBillingSubscription, saveGitHubRepos, syncGitHubRepo } =
      await import("../src/lib/localStore")
    setStorePathForTests(filePath)
    const userId = "usr_plan_indie"

    await upsertBillingSubscription(userId, { plan: "indie", status: "active" })
    for (const provider of ["vercel", "cloudflare", "gcp", "aws"] as const) {
      await upsertConnection(userId, connection(provider))
    }

    await saveGitHubRepos(userId, [repo("a"), repo("b"), repo("c"), repo("d")], null)
    for (const name of ["a", "b", "c", "d"]) {
      await syncGitHubRepo(userId, `acme/${name}`)
    }
  } finally {
    const { setStorePathForTests } = await import("../src/lib/localStore")
    setStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("free plan blocks a third synced repo until one is unsynced or the plan upgrades", async () => {
  const { dir, filePath } = setStorePath()
  try {
    const {
      setStorePathForTests,
      saveGitHubRepos,
      syncGitHubRepo,
      unsyncGitHubRepo,
      upsertBillingSubscription,
      readWorkspace,
    } = await import("../src/lib/localStore")
    const { PlanLimitError } = await import("../src/lib/plan")
    setStorePathForTests(filePath)
    const userId = "usr_plan_repos"

    // saveGitHubRepos auto-selects and syncs the first repo.
    await saveGitHubRepos(userId, [repo("one"), repo("two"), repo("three")], "acme/one")
    await syncGitHubRepo(userId, "acme/two")
    await assert.rejects(() => syncGitHubRepo(userId, "acme/three"), PlanLimitError)
    // Re-syncing an already synced repo never trips the limit.
    await syncGitHubRepo(userId, "acme/two")

    await unsyncGitHubRepo(userId, "acme/two")
    await syncGitHubRepo(userId, "acme/three")
    await assert.rejects(() => syncGitHubRepo(userId, "acme/two"), PlanLimitError)

    await upsertBillingSubscription(userId, { plan: "indie", status: "active" })
    await syncGitHubRepo(userId, "acme/two")
    const workspace = await readWorkspace(userId)
    assert.equal(workspace.syncedRepoFullNames.length, 3)
  } finally {
    const { setStorePathForTests } = await import("../src/lib/localStore")
    setStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("free plan counts custom provider connections against the provider limit", async () => {
  const { dir, filePath } = setStorePath()
  try {
    const { setStorePathForTests, upsertConnection, upsertCustomProvider, setCustomConnection } =
      await import("../src/lib/localStore")
    const { PlanLimitError } = await import("../src/lib/plan")
    setStorePathForTests(filePath)
    const userId = "usr_plan_custom"

    await upsertConnection(userId, connection("vercel"))
    await upsertCustomProvider(userId, {
      id: "cpr_test1",
      name: "Railway",
      auth: { type: "bearer" },
      request: { method: "GET", url: "https://example.test" },
      cost: null,
      usage: null,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    })
    await setCustomConnection(userId, "cpr_test1", "secret")

    await assert.rejects(() => upsertConnection(userId, connection("cloudflare")), PlanLimitError)
    // Updating the existing custom connection secret is allowed at the limit.
    await setCustomConnection(userId, "cpr_test1", "rotated-secret")
  } finally {
    const { setStorePathForTests } = await import("../src/lib/localStore")
    setStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
