import test from "node:test"
import assert from "node:assert/strict"
import { repoScopeTerms, scopeCostRow } from "../src/lib/costEngine"
import type { NormalizedCostRow } from "../src/lib/types"

const repo = { name: "gpay-cost-analyzer", owner: "MustangBro7", path: "/x", remoteUrl: null, scannedAt: "2026-06-14T00:00:00Z" }

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

test("repoScopeTerms drops short tokens but keeps name and owner/name", () => {
  const terms = repoScopeTerms(repo)
  assert.ok(terms.includes("gpay-cost-analyzer"))
  assert.ok(terms.includes("mustangbro7/gpay-cost-analyzer"))
})

test("a resource named after the repo is scoped to the repo", () => {
  const terms = repoScopeTerms(repo)
  assert.equal(scopeCostRow(row({ resourceName: "gpay-cost-analyzer" }), terms), "repo")
  assert.equal(scopeCostRow(row({ resourceId: "prj_gpay-cost-analyzer_123" }), terms), "repo")
  assert.equal(scopeCostRow(row({ serviceName: "gpay-cost-analyzer functions" }), terms), "repo")
})

test("an account-wide line that doesn't mention the repo is account-level", () => {
  const terms = repoScopeTerms(repo)
  assert.equal(scopeCostRow(row({ serviceName: "Workers Paid", resourceName: "acct" }), terms), "account")
  assert.equal(scopeCostRow(row({ serviceName: "Amazon EC2" }), terms), "account")
})
