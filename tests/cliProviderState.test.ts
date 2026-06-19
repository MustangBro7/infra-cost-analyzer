import test from "node:test"
import assert from "node:assert/strict"
import { connectedProviderMap } from "../cli/provider-state.mjs"

test("CLI recognizes only currently connected cloud providers", () => {
  assert.deepEqual(
    connectedProviderMap({
      connections: {
        aws: { status: "connected", accountLabel: "AWS 123456789012" },
        gcp: { status: "error", accountLabel: "stale-project" },
        cloudflare: { status: "connected", accountLabel: "Acme" },
        github: { status: "connected", accountLabel: "2 repos" },
      },
    }),
    {
      aws: { accountLabel: "AWS 123456789012" },
      cloudflare: { accountLabel: "Acme" },
    }
  )
})

test("CLI treats missing connection state as no connected providers", () => {
  assert.deepEqual(connectedProviderMap({}), {})
})

