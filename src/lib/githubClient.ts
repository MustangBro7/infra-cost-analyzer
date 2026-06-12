import { createPrivateKey, createSign } from "node:crypto"
import type { GitHubRepoSummary } from "./types"

const GITHUB_API = "https://api.github.com"

function base64Url(input: string | Buffer) {
  return Buffer.from(input).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

export function hasGitHubAppConfig(env = process.env) {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY)
}

export function githubInstallUrl(env = process.env) {
  const appSlug = env.GITHUB_APP_SLUG
  const clientId = env.GITHUB_APP_CLIENT_ID
  if (appSlug) return `https://github.com/apps/${appSlug}/installations/new`
  if (clientId) return `https://github.com/apps/${clientId}/installations/new`
  return null
}

export function createGitHubAppJwt(env = process.env) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required.")
  }
  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }))
  const signer = createSign("RSA-SHA256")
  signer.update(`${header}.${payload}`)
  const privateKey = createPrivateKey(env.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n"))
  const signature = base64Url(signer.sign(privateKey))
  return `${header}.${payload}.${signature}`
}

async function githubRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub request failed ${response.status}: ${body.slice(0, 300)}`)
  }
  return response.json() as Promise<T>
}

export async function createInstallationToken(installationId: number) {
  const jwt = createGitHubAppJwt()
  const payload = await githubRequest<{ token: string; expires_at: string }>(
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    { method: "POST" }
  )
  return payload
}

export async function listInstallationRepos(installationToken: string): Promise<GitHubRepoSummary[]> {
  const payload = await githubRequest<{
    repositories: Array<{
      id: number
      name: string
      full_name: string
      private: boolean
      default_branch: string
      html_url: string
      owner: { login: string }
    }>
  }>("/installation/repositories?per_page=100", installationToken)

  return payload.repositories.map((repo) => ({
    id: repo.id,
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    defaultBranch: repo.default_branch,
    htmlUrl: repo.html_url,
  }))
}
