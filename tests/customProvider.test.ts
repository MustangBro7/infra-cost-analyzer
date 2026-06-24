import test from "node:test"
import assert from "node:assert/strict"
import {
  CustomProviderError,
  getPath,
  monthPeriod,
  runCustomProvider,
  validateCustomProviderDef,
} from "../src/lib/customProvider"
import type { CustomProviderDef } from "../src/lib/types"

test("getPath resolves dot and bracket paths", () => {
  const source = { data: { charges: [{ amount: 12.5 }, { amount: 3 }] } }
  assert.deepEqual(getPath(source, "data.charges"), [{ amount: 12.5 }, { amount: 3 }])
  assert.equal(getPath(source, "data.charges[1].amount"), 3)
  assert.equal(getPath(source, "data.missing.deep"), undefined)
  assert.equal(getPath(source, ""), source)
})

test("validateCustomProviderDef accepts a well-formed definition", () => {
  const def = validateCustomProviderDef({
    name: "Render",
    auth: { type: "bearer" },
    request: { method: "get", url: "https://api.render.com/v1/billing?from={{periodStart}}" },
    cost: { itemsPath: "items", amountField: "amount", serviceField: "name" },
  })
  assert.equal(def.name, "Render")
  assert.equal(def.request.method, "GET")
  assert.equal(def.auth.type, "bearer")
  assert.equal(def.cost?.amountField, "amount")
})

test("validateCustomProviderDef rejects bad input", () => {
  assert.throws(() => validateCustomProviderDef({ name: "", auth: { type: "bearer" }, request: { url: "https://x.com" }, cost: { amountField: "a" } }), CustomProviderError)
  assert.throws(
    () => validateCustomProviderDef({ name: "X", auth: { type: "bearer" }, request: { method: "GET", url: "http://insecure.com" }, cost: { amountField: "a" } }),
    CustomProviderError
  )
  assert.throws(
    () => validateCustomProviderDef({ name: "X", auth: { type: "bearer" }, request: { method: "GET", url: "https://localhost/x" }, cost: { amountField: "a" } }),
    CustomProviderError
  )
  // Must provide at least one of cost/usage.
  assert.throws(
    () => validateCustomProviderDef({ name: "X", auth: { type: "bearer" }, request: { method: "GET", url: "https://api.x.com" } }),
    CustomProviderError
  )
})

test("runCustomProvider maps a JSON response into cost + usage rows", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    // Auth + placeholder interpolation should have happened by now.
    assert.ok(u.startsWith("https://api.example.com/v1/billing"))
    assert.match(u, /from=\d{4}-\d{2}-\d{2}/)
    const headers = new Headers(init?.headers)
    assert.equal(headers.get("authorization"), "Bearer secret-token")
    return new Response(
      JSON.stringify({ data: { charges: [
        { amount: 12.5, quantity: 1000, service_name: "Web", unit: "requests" },
        { amount: 0, quantity: 0, service_name: "Idle", unit: "requests" },
        { amount: 4, quantity: 50, service_name: "DB", unit: "GB" },
      ] } }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  }) as typeof fetch

  try {
    const def: CustomProviderDef = {
      id: "cpr_x",
      name: "Example",
      auth: { type: "bearer" },
      request: { method: "GET", url: "https://api.example.com/v1/billing?from={{periodStart}}&to={{periodEnd}}" },
      cost: { itemsPath: "data.charges", amountField: "amount", serviceField: "service_name", currency: "USD" },
      usage: { itemsPath: "data.charges", quantityField: "quantity", serviceField: "service_name", unitField: "unit" },
      createdAt: "now",
      updatedAt: "now",
    }
    const result = await runCustomProvider(def, "secret-token", monthPeriod())
    // Zero-amount / zero-quantity rows are dropped.
    assert.equal(result.costRows.length, 2)
    assert.deepEqual(result.costRows[0], { service: "Web", cost: 12.5, currency: "USD" })
    assert.equal(result.usage.length, 2)
    assert.deepEqual(result.usage[0], { service: "Web", quantity: 1000, unit: "requests" })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("runCustomProvider supports amountInCents and header auth", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    assert.equal(headers.get("x-api-key"), "k1")
    return new Response(JSON.stringify({ results: [{ spend_cents: 2599, project: "p1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  try {
    const def: CustomProviderDef = {
      id: "cpr_y",
      name: "Cents",
      auth: { type: "header", headerName: "X-Api-Key" },
      request: { method: "GET", url: "https://api.example.com/spend" },
      cost: { itemsPath: "results", amountField: "spend_cents", amountInCents: true, serviceField: "project", currency: "USD" },
      createdAt: "now",
      updatedAt: "now",
    }
    const result = await runCustomProvider(def, "k1", monthPeriod())
    assert.deepEqual(result.costRows[0], { service: "p1", cost: 25.99, currency: "USD" })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("runCustomProvider throws a clean error on a non-2xx upstream", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response("nope", { status: 403 })) as typeof fetch
  try {
    const def: CustomProviderDef = {
      id: "cpr_z",
      name: "Err",
      auth: { type: "bearer" },
      request: { method: "GET", url: "https://api.example.com/x" },
      cost: { itemsPath: "", amountField: "amount" },
      createdAt: "now",
      updatedAt: "now",
    }
    await assert.rejects(() => runCustomProvider(def, "t", monthPeriod()), /403/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
