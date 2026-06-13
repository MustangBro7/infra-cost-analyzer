import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/**
 * Locates the wrangler OAuth config written by `wrangler login`. Path differs by
 * platform: macOS uses ~/Library/Preferences/.wrangler, Linux uses
 * ~/.config/.wrangler (or ~/.wrangler), and WRANGLER_HOME overrides all.
 */
function wranglerConfigPaths(): string[] {
  // WRANGLER_HOME, when set, is authoritative — do not fall back to OS defaults.
  if (process.env.WRANGLER_HOME) {
    return [path.join(process.env.WRANGLER_HOME, "config", "default.toml")]
  }
  const home = homedir()
  return [
    path.join(home, "Library", "Preferences", ".wrangler", "config", "default.toml"),
    path.join(home, ".config", ".wrangler", "config", "default.toml"),
    path.join(home, ".wrangler", "config", "default.toml"),
  ]
}

export interface WranglerOAuth {
  token: string
  expiresAt: Date | null
  expired: boolean
}

/**
 * Reads the wrangler OAuth access token from the local config so a user who has
 * already run `wrangler login` can connect Cloudflare with one click. Returns
 * null when no config is present. Best-effort and filesystem-based.
 */
export function readWranglerOAuth(): WranglerOAuth | null {
  for (const configPath of wranglerConfigPaths()) {
    if (!existsSync(configPath)) continue
    const toml = readFileSync(configPath, "utf8")
    const token = toml.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1]
    if (!token) continue
    const expirationRaw = toml.match(/expiration_time\s*=\s*"([^"]+)"/)?.[1]
    const expiresAt = expirationRaw ? new Date(expirationRaw) : null
    const expired = expiresAt ? expiresAt.getTime() <= Date.now() : false
    return { token, expiresAt, expired }
  }
  return null
}
