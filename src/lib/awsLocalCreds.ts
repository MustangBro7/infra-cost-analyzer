import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { AwsCredentials } from "./awsClient"

export interface LocalAwsCredentials extends AwsCredentials {
  region: string | null
  profile: string
  source: string
}

type IniSections = Record<string, Record<string, string>>

/**
 * Minimal INI parser for the AWS shared config/credentials files. Handles
 * `[section]` headers and `key = value` lines, ignoring comments and blanks.
 * Exposed for unit testing.
 */
export function parseIni(content: string): IniSections {
  const sections: IniSections = {}
  let current: string | null = null
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/[;#].*$/, "").trim()
    if (!line) continue
    const header = line.match(/^\[(.+)\]$/)
    if (header) {
      current = header[1].trim()
      sections[current] = sections[current] ?? {}
      continue
    }
    if (!current) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    const value = line.slice(eq + 1).trim()
    if (key) sections[current][key] = value
  }
  return sections
}

/**
 * Resolves the config-file section name for a profile. The credentials file
 * uses `[name]`, while the config file uses `[profile name]` (except default,
 * which stays `[default]`).
 */
function configSectionName(profile: string): string {
  return profile === "default" ? "default" : `profile ${profile}`
}

function awsDir(): string {
  return process.env.AWS_SHARED_CREDENTIALS_FILE
    ? path.dirname(process.env.AWS_SHARED_CREDENTIALS_FILE)
    : path.join(homedir(), ".aws")
}

/**
 * Reads static AWS credentials for a profile from the shared credentials/config
 * files (what `aws configure` writes). Returns null when no usable static
 * credentials are present (e.g. only SSO is configured). Best-effort and
 * filesystem-based, so it only works where a real home directory exists.
 */
export function readLocalAwsCredentials(profileInput?: string | null): LocalAwsCredentials | null {
  const profile = profileInput?.trim() || process.env.AWS_PROFILE || "default"
  const dir = awsDir()
  const credentialsPath = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(dir, "credentials")
  const configPath = process.env.AWS_CONFIG_FILE || path.join(dir, "config")

  const credentialsIni = existsSync(credentialsPath) ? parseIni(readFileSync(credentialsPath, "utf8")) : {}
  const configIni = existsSync(configPath) ? parseIni(readFileSync(configPath, "utf8")) : {}

  const fromCredentials = credentialsIni[profile] ?? {}
  const fromConfig = configIni[configSectionName(profile)] ?? {}
  // Credentials file wins over config for overlapping keys.
  const merged = { ...fromConfig, ...fromCredentials }

  const accessKeyId = merged.aws_access_key_id
  const secretAccessKey = merged.aws_secret_access_key
  if (!accessKeyId || !secretAccessKey) return null

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: merged.aws_session_token || null,
    region: merged.region || null,
    profile,
    source: credentialsPath,
  }
}

/**
 * Resolves usable credentials from the AWS CLI for the active/SSO session by
 * running `aws configure export-credentials`. This handles SSO, assumed roles,
 * and session tokens that are not written as static keys. Returns null when the
 * CLI is missing, not logged in, or the command fails. Local-only (shells out to
 * the aws CLI); never runs on Workers.
 */
export async function resolveAwsCliCredentials(profile?: string | null): Promise<AwsCredentials | null> {
  try {
    const { execFileSync } = await import("node:child_process")
    const env = { ...process.env }
    if (profile) env.AWS_PROFILE = profile
    const out = execFileSync("aws", ["configure", "export-credentials", "--format", "process"], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    })
    const json = JSON.parse(out) as { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string }
    if (!json.AccessKeyId || !json.SecretAccessKey) return null
    return {
      accessKeyId: json.AccessKeyId,
      secretAccessKey: json.SecretAccessKey,
      sessionToken: json.SessionToken ?? null,
    }
  } catch {
    return null
  }
}

/** Lists profile names available across the shared credentials/config files. */
export function listLocalAwsProfiles(): string[] {
  const dir = awsDir()
  const credentialsPath = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(dir, "credentials")
  const configPath = process.env.AWS_CONFIG_FILE || path.join(dir, "config")
  const names = new Set<string>()
  if (existsSync(credentialsPath)) {
    for (const section of Object.keys(parseIni(readFileSync(credentialsPath, "utf8")))) names.add(section)
  }
  if (existsSync(configPath)) {
    for (const section of Object.keys(parseIni(readFileSync(configPath, "utf8")))) {
      names.add(section.replace(/^profile\s+/, ""))
    }
  }
  return [...names]
}
