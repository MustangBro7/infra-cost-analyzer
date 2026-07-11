import { execFileSync } from "node:child_process"
import { accessSync, chmodSync, constants, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { delimiter, dirname, join } from "node:path"

export const AGENT_LABEL = "io.ambrium.ai-usage"
const RUNNER_REPO = "github:MustangBro7/infra-cost-analyzer"

function xml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

function executable(name) {
  for (const dir of String(process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`${name} is required but was not found in PATH.`)
}

export function macAgentPlist({ apiBase, npxPath, nodePath = process.execPath }) {
  const path = [dirname(nodePath), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].join(":")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>EnvironmentVariables</key><dict>
    <key>AMBRIUM_API</key><string>${xml(apiBase)}</string>
    <key>PATH</key><string>${xml(path)}</string>
  </dict>
  <key>ProgramArguments</key><array>
    <string>${xml(npxPath)}</string><string>--yes</string><string>${RUNNER_REPO}</string><string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/ambrium-ai-usage.log</string>
  <key>StandardErrorPath</key><string>/tmp/ambrium-ai-usage.log</string>
</dict></plist>
`
}

export function linuxAgentService({ apiBase, npxPath, nodePath = process.execPath }) {
  const path = [dirname(nodePath), "/usr/local/bin", "/usr/bin", "/bin"].join(":")
  return `[Unit]
Description=Ambrium continuous AI usage sync
After=network-online.target

[Service]
Type=simple
Environment=AMBRIUM_API=${apiBase}
Environment=PATH=${path}
ExecStart=${npxPath} --yes ${RUNNER_REPO} serve
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`
}

function atomicWrite(path, contents) {
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, contents, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, path)
}

/** Installs, starts, and verifies the per-user continuous usage agent. */
export function installUsageAgent({ apiBase, platformName = platform(), home = homedir(), run = execFileSync } = {}) {
  if (!apiBase) throw new Error("AMBRIUM_API is required to install the usage agent.")
  const npxPath = executable("npx")
  if (platformName === "darwin") {
    const directory = join(home, "Library", "LaunchAgents")
    const plistPath = join(directory, `${AGENT_LABEL}.plist`)
    const target = `gui/${process.getuid()}/${AGENT_LABEL}`
    mkdirSync(directory, { recursive: true })
    atomicWrite(plistPath, macAgentPlist({ apiBase, npxPath }))

    // Validate before touching a currently-running job. A malformed replacement
    // can therefore never unload the last known-good agent.
    run("plutil", ["-lint", plistPath], { stdio: "ignore" })
    try {
      run("launchctl", ["bootout", target], { stdio: "ignore" })
    } catch {
      // It was not loaded; bootstrap below is still the correct next step.
    }
    run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], { stdio: "inherit" })
    run("launchctl", ["kickstart", "-k", target], { stdio: "inherit" })
    run("launchctl", ["print", target], { stdio: "ignore" })
    return { platform: "macOS", path: plistPath, target }
  }

  if (platformName === "linux") {
    const directory = join(home, ".config", "systemd", "user")
    const servicePath = join(directory, "ambrium-ai-usage.service")
    mkdirSync(directory, { recursive: true })
    atomicWrite(servicePath, linuxAgentService({ apiBase, npxPath }))
    run("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" })
    run("systemctl", ["--user", "enable", "--now", "ambrium-ai-usage.service"], { stdio: "inherit" })
    run("systemctl", ["--user", "is-active", "--quiet", "ambrium-ai-usage.service"], { stdio: "ignore" })
    return { platform: "Linux", path: servicePath, target: "ambrium-ai-usage.service" }
  }

  throw new Error(`Automatic agent installation is not supported on ${platformName}. Run the foreground serve command instead.`)
}
