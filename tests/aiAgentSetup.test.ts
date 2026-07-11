import test from "node:test"
import assert from "node:assert/strict"
import { aiAgentCommands, diagnoseAiAgent } from "../src/lib/aiAgentSetup"

test("diagnoses a stopped or unloaded local sync job", () => {
  const result = diagnoseAiAgent({ reachable: false })
  assert.equal(result?.kind, "not-running")
  assert.match(result?.detail ?? "", /stopped, unloaded, not installed/i)
})

test("turns rejected credentials into a re-pairing recovery", () => {
  const result = diagnoseAiAgent({ reachable: true, autoSync: true, error: "Request failed (401): CLI token expired" })
  assert.equal(result?.kind, "pairing-expired")
  assert.equal(result?.showPairCommand, true)
})

test("detects an agent running without continuous updates", () => {
  const result = diagnoseAiAgent({ reachable: true, autoSync: false })
  assert.equal(result?.kind, "continuous-off")
})

test("keeps the real upload error and targets setup commands at the current environment", () => {
  const result = diagnoseAiAgent({ reachable: true, autoSync: true, error: "Cloudflare gateway unavailable" })
  const commands = aiAgentCommands("https://staging.example")
  assert.equal(result?.kind, "upload-failed")
  assert.equal(result?.detail, "Cloudflare gateway unavailable")
  assert.match(commands.install, /AMBRIUM_API=https:\/\/staging\.example/)
  assert.match(commands.install, /install-agent$/)
  assert.match(commands.pair, /AMBRIUM_API=https:\/\/staging\.example/)
})
