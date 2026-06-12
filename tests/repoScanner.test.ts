import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import assert from "node:assert/strict"
import { scanRepository } from "../src/lib/repoScanner"

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "infra-scan-"))
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true })
  mkdirSync(path.join(root, "infra"), { recursive: true })
  writeFileSync(
    path.join(root, ".github", "workflows", "deploy.yml"),
    "name: deploy\non: push\njobs:\n  deploy:\n    steps:\n      - run: vercel --prod\n      - run: aws cloudformation deploy\n"
  )
  writeFileSync(path.join(root, "vercel.json"), JSON.stringify({ name: "billing-api", framework: "nextjs" }))
  writeFileSync(path.join(root, "wrangler.jsonc"), '{ "name": "edge-worker", "d1_databases": [] }')
  writeFileSync(
    path.join(root, "infra", "main.tf"),
    'provider "google" {}\nresource "google_project" "app" {}\nresource "azurerm_resource_group" "app" {}\n'
  )
  writeFileSync(path.join(root, "Dockerfile"), "FROM node:22\n")
  return root
}

test("scanRepository detects major provider signals from repo files", () => {
  const root = fixture()
  try {
    const result = scanRepository(root)
    const providers = new Set(result.signals.map((signal) => signal.provider))
    assert.equal(result.repo.name.startsWith("infra-scan-"), true)
    assert.equal(providers.has("github"), true)
    assert.equal(providers.has("vercel"), true)
    assert.equal(providers.has("cloudflare"), true)
    assert.equal(providers.has("aws"), true)
    assert.equal(providers.has("gcp"), true)
    assert.equal(providers.has("azure"), true)
    assert.equal(providers.has("docker"), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("scanRepository skips oversized or irrelevant generated folders", () => {
  const root = fixture()
  try {
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true })
    writeFileSync(path.join(root, "node_modules", "pkg", "wrangler.jsonc"), '{ "name": "ignored" }')
    const result = scanRepository(root)
    assert.equal(result.signals.some((signal) => signal.sourcePath.includes("node_modules")), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
