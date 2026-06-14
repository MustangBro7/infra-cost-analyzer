import test from "node:test"
import assert from "node:assert/strict"
import { ACCOUNT_SENTINEL, attributeRepoForName, attributeRepoForRow, costItemKey, isAssignedHere, isKeyAssignedHere, manualTarget } from "../src/lib/costAttribution"
import type { NormalizedCostRow } from "../src/lib/types"

function row(partial: Partial<NormalizedCostRow>): NormalizedCostRow {
  return {
    provider: "vercel",
    serviceName: "Service",
    resourceId: null,
    resourceName: null,
    billingPeriodStart: "2026-06-01",
    billingPeriodEnd: "2026-06-30",
    cost: 1,
    currency: "USD",
    attribution: "verified",
    attributionReason: "live",
    signalId: null,
    source: "live",
    ...partial,
  }
}

const ctx = {
  repoShortNames: ["gpay-cost-analyzer", "other-app"],
  vercelProjects: [{ id: "prj_123", name: "gpay-web", repo: "gpay-cost-analyzer", org: "acme" }],
}

test("Vercel charge maps to its repo via the linked project (by id)", () => {
  assert.equal(attributeRepoForRow(row({ resourceId: "prj_123" }), ctx), "gpay-cost-analyzer")
})

test("Vercel charge maps to its repo via the linked project (by name)", () => {
  assert.equal(attributeRepoForRow(row({ resourceName: "gpay-web" }), ctx), "gpay-cost-analyzer")
})

test("a resource named after a known repo is attributed to it (any provider)", () => {
  assert.equal(attributeRepoForRow(row({ provider: "aws", resourceName: "other-app-bucket" }), ctx), "other-app")
})

test("a row that mentions no known repo stays account-level (null)", () => {
  assert.equal(attributeRepoForRow(row({ provider: "cloudflare", serviceName: "Workers Paid", resourceName: "acct" }), ctx), null)
})

test("a Vercel project linking to an unknown repo is not attributed", () => {
  const otherCtx = { repoShortNames: ["gpay-cost-analyzer"], vercelProjects: [{ id: "prj_9", repo: "some-other-repo" }] }
  assert.equal(attributeRepoForRow(row({ resourceId: "prj_9" }), otherCtx), null)
})

test("manual assignment overrides auto-attribution", () => {
  const r = row({ provider: "cloudflare", serviceName: "Workers Paid", attributedRepo: null })
  const assignments = { [costItemKey(r)]: "acme/gpay-cost-analyzer" }
  assert.equal(isAssignedHere(r, assignments, "acme/gpay-cost-analyzer", "gpay-cost-analyzer"), true)
  assert.equal(isAssignedHere(r, assignments, "acme/other-app", "other-app"), false)
  assert.equal(manualTarget(r, assignments), "acme/gpay-cost-analyzer")
})

test("the account sentinel detaches an auto-matched row from its repo", () => {
  const r = row({ attributedRepo: "gpay-cost-analyzer" })
  assert.equal(isAssignedHere(r, {}, "acme/gpay-cost-analyzer", "gpay-cost-analyzer"), true)
  const assignments = { [costItemKey(r)]: ACCOUNT_SENTINEL }
  assert.equal(isAssignedHere(r, assignments, "acme/gpay-cost-analyzer", "gpay-cost-analyzer"), false)
  assert.equal(manualTarget(r, assignments), null)
})

test("with no assignment, falls back to auto-attribution", () => {
  const r = row({ attributedRepo: "gpay-cost-analyzer" })
  assert.equal(isAssignedHere(r, {}, "acme/gpay-cost-analyzer", "gpay-cost-analyzer"), true)
  assert.equal(isAssignedHere(r, {}, "acme/other-app", "other-app"), false)
})

test("attributeRepoForName matches a resource named after a repo", () => {
  assert.equal(attributeRepoForName("infra-cost-analyzer-cron", ["infra-cost-analyzer", "other"]), "infra-cost-analyzer")
  assert.equal(attributeRepoForName("gpayanalyze.co.in", ["infra-cost-analyzer"]), null)
})

test("isKeyAssignedHere works for resource items (manual wins, sentinel detaches)", () => {
  const key = "cloudflare::worker::infra-cost-analyzer"
  // auto-matched
  assert.equal(isKeyAssignedHere(key, "infra-cost-analyzer", {}, "me/infra-cost-analyzer", "infra-cost-analyzer"), true)
  // manually moved to another repo
  assert.equal(isKeyAssignedHere(key, "infra-cost-analyzer", { [key]: "me/other" }, "me/infra-cost-analyzer", "infra-cost-analyzer"), false)
  // sentinel detaches
  assert.equal(isKeyAssignedHere(key, "infra-cost-analyzer", { [key]: ACCOUNT_SENTINEL }, "me/infra-cost-analyzer", "infra-cost-analyzer"), false)
})
