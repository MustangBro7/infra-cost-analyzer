import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("macOS agent plist is valid XML and contains no shell-escaped tags", async () => {
  const { macAgentPlist } = await import("../cli/agent-install.mjs")
  const plist = macAgentPlist({ apiBase: "https://ambrium.io", npxPath: "/opt/homebrew/bin/npx", nodePath: "/opt/homebrew/bin/node" })
  assert.doesNotMatch(plist, /\\[<>]/)
  assert.match(plist, /<key>AMBRIUM_API<\/key><string>https:\/\/ambrium\.io<\/string>/)
  const dir = mkdtempSync(join(tmpdir(), "ambrium-plist-"))
  const path = join(dir, "agent.plist")
  try {
    writeFileSync(path, plist)
    if (process.platform === "darwin") execFileSync("plutil", ["-lint", path], { stdio: "ignore" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Linux service uses the same verified install target", async () => {
  const { linuxAgentService } = await import("../cli/agent-install.mjs")
  const service = linuxAgentService({ apiBase: "https://ambrium.io", npxPath: "/usr/bin/npx", nodePath: "/usr/bin/node" })
  assert.match(service, /Environment=AMBRIUM_API=https:\/\/ambrium\.io/)
  assert.match(service, /ExecStart=\/usr\/bin\/npx --yes github:MustangBro7\/infra-cost-analyzer serve/)
  assert.match(service, /Restart=always/)
})

test("macOS installation validates before replacing and verifies after starting", async () => {
  const { installUsageAgent } = await import("../cli/agent-install.mjs")
  const dir = mkdtempSync(join(tmpdir(), "ambrium-install-"))
  const calls: string[] = []
  try {
    const installed = installUsageAgent({
      apiBase: "https://ambrium.io",
      platformName: "darwin",
      home: dir,
      run: ((command: string, args: string[]) => {
        calls.push(`${command} ${args[0]}`)
      }) as (...args: unknown[]) => unknown,
    })
    assert.match(installed.path, /Library\/LaunchAgents\/io\.ambrium\.ai-usage\.plist$/)
    assert.deepEqual(calls, [
      "plutil -lint",
      "launchctl bootout",
      "launchctl bootstrap",
      "launchctl kickstart",
      "launchctl print",
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
