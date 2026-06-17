import test from "node:test"
import assert from "node:assert/strict"
import { scanRepositoryFiles, shouldInspectRepoPath, type RepositoryFile } from "../src/lib/repoScanner"

function fixtureFiles(): RepositoryFile[] {
  return [
    {
      path: ".github/workflows/deploy.yml",
      content: "name: deploy\non: push\njobs:\n  deploy:\n    steps:\n      - run: vercel --prod\n      - run: aws cloudformation deploy\n",
    },
    { path: "vercel.json", content: JSON.stringify({ name: "billing-api", framework: "nextjs" }) },
    { path: "wrangler.jsonc", content: '{ "name": "edge-worker", "d1_databases": [] }' },
    {
      path: "infra/main.tf",
      content: 'provider "google" {}\nresource "google_project" "app" {}\nresource "azurerm_resource_group" "app" {}\n',
    },
    { path: "Dockerfile", content: "FROM node:22\n" },
  ]
}

test("scanRepositoryFiles detects major provider signals from repo files", () => {
  const result = scanRepositoryFiles({
    repo: { owner: "acme", name: "billing", path: "acme/billing", remoteUrl: "https://github.com/acme/billing" },
    files: fixtureFiles(),
  })
  const providers = new Set(result.signals.map((signal) => signal.provider))
  assert.equal(result.repo.name, "billing")
  assert.equal(providers.has("github"), true)
  assert.equal(providers.has("vercel"), true)
  assert.equal(providers.has("cloudflare"), true)
  assert.equal(providers.has("aws"), true)
  assert.equal(providers.has("gcp"), true)
  assert.equal(providers.has("azure"), true)
  assert.equal(providers.has("docker"), true)
})

test("shouldInspectRepoPath selects infra-relevant files and skips noise", () => {
  assert.equal(shouldInspectRepoPath("vercel.json"), true)
  assert.equal(shouldInspectRepoPath("wrangler.jsonc"), true)
  assert.equal(shouldInspectRepoPath("infra/main.tf"), true)
  assert.equal(shouldInspectRepoPath(".github/workflows/deploy.yml"), true)
  assert.equal(shouldInspectRepoPath("Dockerfile"), true)
  assert.equal(shouldInspectRepoPath("src/index.ts"), false)
  assert.equal(shouldInspectRepoPath("node_modules/pkg/readme.txt"), false)
})
