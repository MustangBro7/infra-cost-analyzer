import test from "node:test"
import assert from "node:assert/strict"
import {
  fetchAnthropicCostUsage,
  fetchOpenAiCostUsage,
  fetchCursorCostUsage,
  type AiPeriod,
} from "../src/lib/aiClients"

const PERIOD: AiPeriod = { from: "2026-06-01", to: "2026-06-30" }

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = handler(String(url), init)
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

test("fetchAnthropicCostUsage aggregates cost by description and sums tokens", async () => {
  const restore = stubFetch((url, init) => {
    assert.equal(new Headers(init?.headers).get("x-api-key"), "sk-ant-admin-x")
    if (url.includes("/cost_report")) {
      return {
        data: [
          { results: [{ amount: "1.50", currency: "USD", description: "claude-opus" }] },
          { results: [{ amount: "0.50", currency: "USD", description: "claude-opus" }, { amount: "2", currency: "USD", description: "claude-haiku" }] },
        ],
        has_more: false,
      }
    }
    // usage_report/messages
    return {
      data: [{ results: [{ uncached_input_tokens: 1000, output_tokens: 200 }, { cache_read_input_tokens: 500, output_tokens: 50 }] }],
      has_more: false,
    }
  })
  try {
    const result = await fetchAnthropicCostUsage("sk-ant-admin-x", PERIOD)
    const opus = result.costRows.find((row) => row.service === "claude-opus")
    assert.equal(opus?.cost, 2)
    assert.equal(result.costRows.find((row) => row.service === "claude-haiku")?.cost, 2)
    assert.deepEqual(
      result.usage.find((row) => row.service === "Input tokens"),
      { service: "Input tokens", quantity: 1500, unit: "tokens" }
    )
    assert.equal(result.usage.find((row) => row.service === "Output tokens")?.quantity, 250)
  } finally {
    restore()
  }
})

test("fetchOpenAiCostUsage reads amount.value and bearer auth", async () => {
  const restore = stubFetch((url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk-admin-y")
    if (url.includes("/costs")) {
      return {
        data: [{ results: [{ amount: { value: 3.25, currency: "usd" }, line_item: "gpt-5-codex" }] }],
        has_more: false,
      }
    }
    return { data: [{ results: [{ input_tokens: 800, output_tokens: 120 }] }], has_more: false }
  })
  try {
    const result = await fetchOpenAiCostUsage("sk-admin-y", PERIOD)
    assert.deepEqual(result.costRows[0], { service: "gpt-5-codex", cost: 3.25, currency: "USD" })
    assert.equal(result.usage.find((row) => row.service === "Input tokens")?.quantity, 800)
  } finally {
    restore()
  }
})

test("fetchCursorCostUsage sums member spend cents and basic auth", async () => {
  const restore = stubFetch((url, init) => {
    const auth = new Headers(init?.headers).get("authorization") ?? ""
    assert.ok(auth.startsWith("Basic "))
    if (url.endsWith("/teams/members")) return { teamMembers: [{ name: "a" }, { name: "b" }] }
    if (url.endsWith("/teams/spend")) return { teamMemberSpend: [{ spendCents: 2000 }, { spendCents: 500 }] }
    return { data: [{ composerRequests: 10, totalLinesAdded: 100 }] }
  })
  try {
    const result = await fetchCursorCostUsage("key123", PERIOD)
    assert.equal(result.accountLabel, "Cursor team · 2 members")
    assert.deepEqual(result.costRows[0], { service: "Cursor usage", cost: 25, currency: "USD" })
    assert.equal(result.usage.find((row) => row.service === "AI requests")?.quantity, 10)
  } finally {
    restore()
  }
})
