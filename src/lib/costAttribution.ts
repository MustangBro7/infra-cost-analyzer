import type { NormalizedCostRow } from "./types"

export interface VercelProjectLink {
  id?: string
  name?: string
  repo?: string | null
  org?: string | null
}

export interface AttributionContext {
  // Short names of the repos we know about (e.g. "gpay-cost-analyzer").
  repoShortNames: string[]
  // Vercel projects from the connection metadata, each linked to a repo.
  vercelProjects: VercelProjectLink[]
}

/**
 * Attributes an account-wide billing row to a specific repo WITHIN its account,
 * so a linked account can be split into "this project" vs "rest of the account".
 *
 *  - Vercel: the strongest signal — a charge's resource maps to a Vercel project,
 *    which links to a GitHub repo (connection metadata `linkedProjects`).
 *  - Everyone else: best-effort — the row's resource/service text contains a
 *    known repo's short name (e.g. an AWS resource or Worker named after it).
 *
 * Returns the matched repo's lowercased short name, or null when the row can't
 * be tied to one repo (it stays account-level / shared).
 */
export function attributeRepoForRow(row: NormalizedCostRow, ctx: AttributionContext): string | null {
  const shortNames = ctx.repoShortNames.map((name) => name.toLowerCase().trim()).filter((name) => name.length > 2)

  if (row.provider === "vercel") {
    const project = ctx.vercelProjects.find(
      (candidate) =>
        (candidate.id && (row.resourceId === candidate.id || row.resourceName === candidate.id)) ||
        (candidate.name && (row.resourceName === candidate.name || row.resourceId === candidate.name))
    )
    const repo = project?.repo?.toLowerCase().trim()
    if (repo && shortNames.includes(repo)) return repo
  }

  const haystack = `${row.serviceName} ${row.resourceName ?? ""} ${row.resourceId ?? ""}`.toLowerCase()
  return shortNames.find((name) => haystack.includes(name)) ?? null
}

export function attributeCostRows(rows: NormalizedCostRow[], ctx: AttributionContext): NormalizedCostRow[] {
  return rows.map((row) => {
    const attributedRepo = attributeRepoForRow(row, ctx)
    return attributedRepo ? { ...row, attributedRepo } : { ...row, attributedRepo: null }
  })
}
