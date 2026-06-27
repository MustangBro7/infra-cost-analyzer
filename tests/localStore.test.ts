import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"

function setStorePath() {
  const dir = mkdtempSync(path.join(tmpdir(), "infra-store-"))
  return { dir, filePath: path.join(dir, "connections.json") }
}

test("local store persists safe public provider state", async () => {
  const { dir, filePath } = setStorePath()
  try {
    const { appendEvent, publicStore, setStorePathForTests, upsertConnection } = await import("../src/lib/localStore")
    setStorePathForTests(filePath)
    await appendEvent("usr_a", {
      provider: "system",
      level: "info",
      message: "Started local test.",
    })
    await upsertConnection("usr_a", {
      provider: "vercel",
      status: "connected",
      accountLabel: "Acme",
      accessToken: "secret-token",
      connectedAt: "2026-06-12T00:00:00.000Z",
      lastVerifiedAt: "2026-06-12T00:00:00.000Z",
      lastError: null,
      metadata: { projectCount: 3 },
    })
    const state = await publicStore("usr_a")
    const otherState = await publicStore("usr_b")
    assert.equal(state.connections.vercel?.status, "connected")
    assert.equal(otherState.connections.vercel, undefined)
    assert.equal("accessToken" in (state.connections.vercel ?? {}), false)
    assert.equal(state.connections.vercel?.metadata.projectCount, 3)
    assert.equal(state.events.length, 2)
    assert.equal(state.events[0].level, "success")
  } finally {
    const { setStorePathForTests } = await import("../src/lib/localStore")
    setStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("local store tracks multiple synced GitHub repositories", async () => {
  const { dir, filePath } = setStorePath()
  try {
    const {
      publicStore,
      saveGitHubRepos,
      selectGitHubRepo,
      setCostAssignment,
      setRepoProviderLinks,
      setStorePathForTests,
      syncGitHubRepo,
      unsyncGitHubRepo,
    } = await import("../src/lib/localStore")
    setStorePathForTests(filePath)
    const repos = [
      {
        id: 1,
        owner: "acme",
        name: "api",
        fullName: "acme/api",
        private: true,
        defaultBranch: "main",
        htmlUrl: "https://github.com/acme/api",
      },
      {
        id: 2,
        owner: "acme",
        name: "web",
        fullName: "acme/web",
        private: false,
        defaultBranch: "main",
        htmlUrl: "https://github.com/acme/web",
      },
    ]

    await saveGitHubRepos("usr_multi", repos, "acme/api")
    await syncGitHubRepo("usr_multi", "acme/web")
    await selectGitHubRepo("usr_multi", "acme/web")
    await setRepoProviderLinks("usr_multi", "acme/web", ["aws"])
    await setCostAssignment("usr_multi", "aws::service::resource", "acme/web")

    let state = await publicStore("usr_multi")
    assert.deepEqual(state.syncedRepoFullNames.sort(), ["acme/api", "acme/web"])
    assert.equal(state.selectedRepoFullName, "acme/web")

    await unsyncGitHubRepo("usr_multi", "acme/web")
    state = await publicStore("usr_multi")
    assert.deepEqual(state.syncedRepoFullNames, ["acme/api"])
    assert.equal(state.selectedRepoFullName, "acme/api")
    assert.equal(state.repoProviderLinks["acme/web"], undefined)
    assert.equal(state.costAssignments["aws::service::resource"], undefined)
  } finally {
    const { setStorePathForTests } = await import("../src/lib/localStore")
    setStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("local store persists normalized dashboard layout per workspace", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "infra-cost-layout-"))
  const storePath = path.join(root, "tenant-store.json")
  const { createClerkUser, publicStore, setDashboardLayout, setStorePathForTests } = await import("../src/lib/localStore")
  setStorePathForTests(storePath)
  try {
    await createClerkUser({ id: "usr_layout", email: "layout@example.com", name: "Layout" })
    await setDashboardLayout("usr_layout", [
      { id: "ai", size: "compact" },
      { id: "usage", size: "wide" },
    ])
    const state = await publicStore("usr_layout")
    assert.deepEqual(state.dashboardLayout.slice(0, 2), [
      { id: "ai", span: 3 },
      { id: "usage", span: 8 },
    ])
    assert.equal(state.dashboardLayout.length, 6)
  } finally {
    setStorePathForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})
