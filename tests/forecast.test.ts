import test from "node:test"
import assert from "node:assert/strict"
import { isFlatMonthlyCost, projectedSpend } from "../src/lib/forecast"

const subscription = (provider: string, serviceName: string, cost: number) =>
  ({ provider, serviceName, cost }) as Parameters<typeof projectedSpend>[0][number]

test("subscriptions are flat; metered rows are not", () => {
  assert.equal(isFlatMonthlyCost({ provider: "anthropic", serviceName: "Max subscription" }), true)
  assert.equal(isFlatMonthlyCost({ provider: "openai", serviceName: "Plus subscription" }), true)
  assert.equal(isFlatMonthlyCost({ provider: "cursor", serviceName: "subscription" }), true)
  // Cloudflare cost rows are normalized monthly plan prices, never usage.
  assert.equal(isFlatMonthlyCost({ provider: "cloudflare", serviceName: "Workers Paid" }), true)
  assert.equal(isFlatMonthlyCost({ provider: "aws", serviceName: "Amazon Lightsail" }), false)
  assert.equal(isFlatMonthlyCost({ provider: "gcp", serviceName: "Cloud Run" }), false)
  assert.equal(isFlatMonthlyCost({ provider: "openai", serviceName: "gpt-4o (API)" }), false)
})

test("a $40 subscription on day 1 projects as $40, not $40 x 31", () => {
  const rows = [subscription("anthropic", "Max subscription", 20), subscription("openai", "Plus subscription", 20)]
  const out = projectedSpend(rows, 1, 31)
  assert.equal(out.projected, 40)
  assert.equal(out.flatTotal, 40)
  assert.equal(out.usageTotal, 0)
  assert.equal(out.dailyRate, 0)
})

test("usage rows still extrapolate on the run rate", () => {
  const rows = [subscription("aws", "Amazon Lightsail", 4)]
  const out = projectedSpend(rows, 2, 30)
  assert.equal(out.projected, 60)
  assert.equal(out.dailyRate, 2)
})

test("mixed bill: flat counts once, usage extrapolates", () => {
  const rows = [
    subscription("anthropic", "subscription", 40),
    subscription("aws", "Amazon Lightsail", 10),
  ]
  const out = projectedSpend(rows, 5, 30)
  assert.equal(out.projected, 40 + (10 / 5) * 30)
})

test("a finished period projects exactly the observed total", () => {
  const rows = [subscription("anthropic", "subscription", 40), subscription("aws", "Tax", 6)]
  const out = projectedSpend(rows, 30, 30)
  assert.equal(out.projected, 46)
})

test("zero elapsed days yields the flat total, not NaN/Infinity", () => {
  const rows = [subscription("openai", "Plus subscription", 20), subscription("aws", "S3", 1)]
  const out = projectedSpend(rows, 0, 31)
  assert.equal(out.projected, 20)
  assert.equal(Number.isFinite(out.projected), true)
})
