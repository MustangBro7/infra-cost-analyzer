import test from "node:test"
import assert from "node:assert/strict"
import { mapFactToCostRow } from "../src/lib/analytics/queries"
import { assignedCostRowForRepo, costItemKey, SPLIT_EQUAL_SENTINEL } from "../src/lib/costAttribution"

// A row as latest_cost_facts_compat returns it (snake_case, VARCHAR dates).
const fact = {
  provider: "aws",
  service_name: "Amazon Lightsail",
  resource_id: null,
  resource_name: "Amazon Lightsail",
  billing_period_start: "2026-06-01",
  billing_period_end: "2026-06-30",
  cost: 4.4486,
  currency: "USD",
  attribution: "verified",
  attribution_reason: "Live unblended cost from AWS Cost Explorer, grouped by service.",
  signal_id: "aws-live:0",
  attributed_repo: null,
}

test("mapFactToCostRow round-trips the stored item key so assignments still apply", () => {
  const row = mapFactToCostRow(fact)
  // The key the user's manual assignment was saved under (costItemKey at write
  // time) must be reproducible from the reconstructed row.
  assert.equal(costItemKey(row), "aws::amazon lightsail::amazon lightsail")
  assert.equal(row.billingPeriodStart, "2026-06-01")
  assert.equal(row.billingPeriodEnd, "2026-06-30")
  assert.equal(row.cost, 4.4486)
})

test("a manual assignment routes a reconstructed historical row to its repo", () => {
  const row = mapFactToCostRow(fact)
  const assignments = { "aws::amazon lightsail::amazon lightsail": "MustangBro7/Gpay-Cost-Analyser" }
  const forGpay = assignedCostRowForRepo(row, assignments, "MustangBro7/Gpay-Cost-Analyser", "gpay-cost-analyser", 3)
  assert.ok(forGpay)
  assert.equal(forGpay?.cost, 4.4486)
  const forOther = assignedCostRowForRepo(row, assignments, "MustangBro7/other", "other", 3)
  assert.equal(forOther, null)
})

test("an equal split divides a reconstructed row across synced repos", () => {
  const row = mapFactToCostRow({ ...fact, provider: "anthropic", service_name: "subscription", resource_name: "Claude", cost: 20 })
  const assignments = { [costItemKey(row)]: SPLIT_EQUAL_SENTINEL }
  const split = assignedCostRowForRepo(row, assignments, "MustangBro7/any", "any", 4)
  assert.ok(split)
  assert.equal(split?.cost, 5)
})

test("timestamp-style billing periods are normalized to dates", () => {
  const row = mapFactToCostRow({ ...fact, billing_period_start: "2026-06-01 00:00:00", billing_period_end: "2026-06-30 00:00:00" })
  assert.equal(row.billingPeriodStart, "2026-06-01")
  assert.equal(row.billingPeriodEnd, "2026-06-30")
})
