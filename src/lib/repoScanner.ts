import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { Provider, RepoSignal, SignalType } from "./types"

const MAX_FILE_BYTES = 350_000
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
])

const INTERESTING_EXACT = new Set([
  "package.json",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "vercel.json",
  "wrangler.json",
  "wrangler.jsonc",
  "netlify.toml",
  "render.yaml",
  "render.yml",
  "fly.toml",
  "railway.json",
  "Pulumi.yaml",
  "Pulumi.yml",
  "serverless.yml",
  "serverless.yaml",
])

const INTERESTING_EXTS = new Set([".tf", ".tfvars", ".yaml", ".yml", ".json", ".toml", ".md"])

interface Rule {
  provider: Provider
  signalType: SignalType
  title: string
  confidence: number
  file?: RegExp
  content?: RegExp
}

const RULES: Rule[] = [
  { provider: "github", signalType: "workflow", title: "GitHub Actions workflow", confidence: 0.92, file: /^\.github\/workflows\/.+\.ya?ml$/ },
  { provider: "vercel", signalType: "deployment", title: "Vercel project configuration", confidence: 0.98, file: /(^|\/)vercel\.json$/ },
  { provider: "vercel", signalType: "deployment", title: "Vercel deployment reference", confidence: 0.78, content: /\b(vercel --prod|vercel\.app|@vercel\/|VERCEL_PROJECT_ID|VERCEL_ORG_ID)\b/i },
  { provider: "cloudflare", signalType: "deployment", title: "Cloudflare Worker or Pages config", confidence: 0.99, file: /(^|\/)wrangler\.jsonc?$/ },
  { provider: "cloudflare", signalType: "deployment", title: "Cloudflare service reference", confidence: 0.82, content: /\b(wrangler|cloudflare|workers_dev|D1Database|R2Bucket|pages\.dev)\b/i },
  { provider: "aws", signalType: "iac", title: "AWS infrastructure declaration", confidence: 0.88, content: /\b(aws_[a-z0-9_]+|provider\s+"aws"|AWS_ACCESS_KEY_ID|arn:aws|cloudformation|cdk deploy)\b/i },
  { provider: "gcp", signalType: "iac", title: "Google Cloud infrastructure declaration", confidence: 0.86, content: /\b(google_[a-z0-9_]+|provider\s+"google"|gcloud |GOOGLE_APPLICATION_CREDENTIALS|run\.app|cloudbuild)\b/i },
  { provider: "azure", signalType: "iac", title: "Azure infrastructure declaration", confidence: 0.86, content: /\b(azurerm_[a-z0-9_]+|provider\s+"azurerm"|AZURE_CLIENT_ID|azurewebsites\.net|az deployment)\b/i },
  { provider: "digitalocean", signalType: "deployment", title: "DigitalOcean deployment reference", confidence: 0.82, content: /\b(digitalocean|doctl|DIGITALOCEAN_TOKEN|app_platform|droplet)\b/i },
  { provider: "docker", signalType: "container", title: "Containerized deployment", confidence: 0.84, file: /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/ },
  { provider: "docker", signalType: "container", title: "Container runtime reference", confidence: 0.7, content: /\b(docker build|docker compose|container_name|FROM node:|FROM python:)\b/i },
]

function safeRelative(root: string, input: string): string {
  const relative = path.relative(root, input).replaceAll(path.sep, "/")
  return relative || "."
}

function shouldInspect(filePath: string): boolean {
  const base = path.basename(filePath)
  const ext = path.extname(filePath)
  if (INTERESTING_EXACT.has(base)) return true
  if (INTERESTING_EXTS.has(ext)) return true
  return filePath.includes(`${path.sep}.github${path.sep}workflows${path.sep}`)
}

function walk(root: string, dir = root, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      walk(root, full, files)
      continue
    }
    if (stats.isFile() && stats.size <= MAX_FILE_BYTES && shouldInspect(full)) {
      files.push(full)
    }
  }
  return files
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8")
  } catch {
    return ""
  }
}

function firstEvidence(content: string, rule: Rule, relativePath: string): string {
  if (!rule.content) return relativePath
  const match = content.match(rule.content)
  if (!match?.[0]) return relativePath
  return match[0].replace(/\s+/g, " ").slice(0, 120)
}

function idFor(provider: Provider, relativePath: string, index: number): string {
  return `${provider}:${relativePath}:${index}`.replace(/[^a-z0-9:._/-]/gi, "-")
}

function remoteUrl(repoPath: string): string | null {
  try {
    return execFileSync("git", ["-C", repoPath, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null
  } catch {
    return null
  }
}

function repoName(repoPath: string): { owner: string; name: string; remoteUrl: string | null } {
  const remote = remoteUrl(repoPath)
  const fallbackName = path.basename(repoPath)
  if (!remote) return { owner: "local", name: fallbackName, remoteUrl: null }
  const githubMatch = remote.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/)
  if (!githubMatch) return { owner: "remote", name: fallbackName, remoteUrl: remote }
  return { owner: githubMatch[1], name: githubMatch[2], remoteUrl: remote }
}

export function resolveScanRoot(input?: string | null): string {
  const configured = input || process.env.REPO_SCAN_ROOT || defaultScanRoot()
  const resolved = path.resolve(/*turbopackIgnore: true*/ process.cwd(), configured)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Repository path is not readable: ${resolved}`)
  }
  return resolved
}

function defaultScanRoot(): string {
  const cwd = process.cwd().replaceAll(path.sep, "/")
  return cwd.endsWith(".next/standalone") ? "../../.." : ".."
}

/**
 * Like resolveScanRoot + scanRepository, but never throws. On serverless
 * runtimes without a real filesystem (Cloudflare Workers), returns an empty
 * scan so the dashboard still renders with live provider data only.
 */
export function scanRepositorySafe(repoPath?: string | null): ReturnType<typeof scanRepository> {
  try {
    return scanRepository(resolveScanRoot(repoPath))
  } catch {
    return {
      repo: {
        owner: process.env.REPO_OWNER || "MustangBro7",
        name: process.env.REPO_NAME || "infra-cost-analyzer",
        remoteUrl: null,
        path: "(no filesystem on this runtime — live provider data only)",
        scannedAt: new Date().toISOString(),
      },
      signals: [],
    }
  }
}

export function scanRepository(repoPath: string) {
  const root = path.resolve(repoPath)
  const files = walk(root)
  const signals: RepoSignal[] = []

  files.forEach((filePath) => {
    const relativePath = safeRelative(root, filePath)
    const normalized = relativePath.replaceAll(path.sep, "/")
    const content = readText(filePath)

    RULES.forEach((rule) => {
      const fileMatched = rule.file?.test(normalized) ?? false
      const contentMatched = rule.content?.test(content) ?? false
      if (!fileMatched && !contentMatched) return

      signals.push({
        id: idFor(rule.provider, normalized, signals.length),
        provider: rule.provider,
        signalType: rule.signalType,
        sourcePath: normalized,
        title: rule.title,
        evidence: fileMatched ? normalized : firstEvidence(content, rule, normalized),
        confidence: rule.confidence,
        matchedResource: inferResourceName(normalized, content),
      })
    })
  })

  const deduped = dedupeSignals(signals)
  return {
    repo: {
      ...repoName(root),
      path: root,
      scannedAt: new Date().toISOString(),
    },
    signals: deduped.sort((a, b) => b.confidence - a.confidence || a.sourcePath.localeCompare(b.sourcePath)),
  }
}

function inferResourceName(relativePath: string, content: string): string | undefined {
  const nameMatch =
    content.match(/"name"\s*:\s*"([^"]+)"/) ??
    content.match(/^name\s*=\s*"([^"]+)"/m) ??
    content.match(/^name\s*=\s*"?([a-z0-9._-]+)"?/im) ??
    content.match(/^service:\s*([a-z0-9._-]+)/im)
  if (nameMatch?.[1]) return nameMatch[1]
  const parts = relativePath.split("/")
  if (parts.length > 1) return parts.at(-2)
  return path.basename(relativePath, path.extname(relativePath))
}

function dedupeSignals(signals: RepoSignal[]): RepoSignal[] {
  const map = new Map<string, RepoSignal>()
  for (const signal of signals) {
    const key = `${signal.provider}:${signal.signalType}:${signal.sourcePath}:${signal.title}`
    const existing = map.get(key)
    if (!existing || signal.confidence > existing.confidence) {
      map.set(key, signal)
    }
  }
  return [...map.values()]
}
