import path from "node:path"
import type { Provider, RepoSignal, SignalType } from "./types"

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

export interface RepositoryFile {
  path: string
  content: string
}

export interface RepositoryIdentity {
  owner: string
  name: string
  path: string
  remoteUrl: string | null
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

export function shouldInspectRepoPath(repoPath: string): boolean {
  const normalized = repoPath.replaceAll("\\", "/")
  const base = path.posix.basename(normalized)
  const ext = path.posix.extname(normalized)
  if (INTERESTING_EXACT.has(base)) return true
  if (INTERESTING_EXTS.has(ext)) return true
  return normalized.includes("/.github/workflows/") || normalized.startsWith(".github/workflows/")
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

/**
 * The cost analysis runs over a set of repository files plus a repo identity.
 * Files come exclusively from a connected GitHub repository (see
 * scanInstallationRepository); this app does not read repositories from the
 * local filesystem. Use emptyRepoScan() for the no-repo "overview" view.
 */
export function scanRepositoryFiles(input: {
  repo: RepositoryIdentity
  files: RepositoryFile[]
}) {
  const signals: RepoSignal[] = []

  input.files.forEach((file) => {
    const normalized = file.path.replaceAll("\\", "/")
    const content = file.content

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
      ...input.repo,
      scannedAt: new Date().toISOString(),
    },
    signals: deduped.sort((a, b) => b.confidence - a.confidence || a.sourcePath.localeCompare(b.sourcePath)),
  }
}

/**
 * The "no repository selected" overview scan: no files, no repo signals. The
 * dashboard still renders connected provider costs; repo-specific attribution
 * appears once a GitHub repo is selected.
 */
export function emptyRepoScan(): ReturnType<typeof scanRepositoryFiles> {
  return scanRepositoryFiles({
    repo: { owner: "", name: "", path: "", remoteUrl: null },
    files: [],
  })
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
