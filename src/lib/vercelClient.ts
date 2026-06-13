export interface VercelTeam {
  id: string
  slug: string
  name: string
}

export interface VercelProject {
  id: string
  name: string
  framework: string | null
  link?: {
    type?: string
    repo?: string
    repoId?: number
    org?: string
  }
}

export interface VercelOAuthToken {
  access_token: string
  token_type: string
  expires_in?: number
  scope?: string
  refresh_token?: string
  id_token?: string
}

export interface VercelUserInfo {
  sub?: string
  name?: string
  email?: string
  username?: string
  picture?: string
  [key: string]: unknown
}

async function vercelRequest<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.vercel.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Vercel request failed ${response.status}: ${body.slice(0, 300)}`)
  }
  return response.json() as Promise<T>
}

async function vercelTextRequest(path: string, token: string): Promise<string> {
  const response = await fetch(`https://api.vercel.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      "accept-encoding": "gzip",
    },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Vercel request failed ${response.status}: ${body.slice(0, 300)}`)
  }
  return response.text()
}

export async function verifyVercelToken(token: string) {
  const user = await vercelRequest<{ user: { id: string; username?: string; name?: string; email?: string } }>("/v2/user", token)
  let teams: VercelTeam[] = []
  try {
    const teamPayload = await vercelRequest<{ teams: VercelTeam[] }>("/v2/teams", token)
    teams = teamPayload.teams ?? []
  } catch {
    teams = []
  }
  return {
    accountLabel: user.user.name || user.user.username || user.user.email || user.user.id,
    user: user.user,
    teams,
  }
}

export async function exchangeVercelAuthorizationCode(input: {
  code: string
  codeVerifier: string
  redirectUri: string
  clientId: string
  clientSecret?: string
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
  })
  if (input.clientSecret) {
    body.set("client_secret", input.clientSecret)
  }

  const response = await fetch("https://api.vercel.com/login/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Vercel OAuth token exchange failed ${response.status}: ${text.slice(0, 300)}`)
  }
  return response.json() as Promise<VercelOAuthToken>
}

export async function fetchVercelUserInfo(accessToken: string) {
  const response = await fetch("https://api.vercel.com/login/oauth/userinfo", {
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Vercel userinfo failed ${response.status}: ${text.slice(0, 300)}`)
  }
  return response.json() as Promise<VercelUserInfo>
}

export async function listVercelProjects(token: string, teamId?: string | null): Promise<VercelProject[]> {
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : ""
  const payload = await vercelRequest<{ projects: VercelProject[] }>(`/v10/projects${query}`, token)
  return payload.projects ?? []
}

export interface VercelFocusCharge {
  ChargePeriodStart?: string
  ChargePeriodEnd?: string
  ServiceName?: string
  ResourceId?: string
  ResourceName?: string
  BillingCurrency?: string
  EffectiveCost?: number | string
  BilledCost?: number | string
  ListCost?: number | string
  ConsumedQuantity?: number | string
  ConsumedUnit?: string
  PricingQuantity?: number | string
  PricingUnit?: string
  ProviderName?: string
  Tags?: Record<string, string>
  [key: string]: unknown
}

export async function listVercelBillingCharges(
  token: string,
  input: { from: string; to: string; teamId?: string | null; slug?: string | null }
): Promise<VercelFocusCharge[]> {
  const params = new URLSearchParams({
    from: `${input.from}T00:00:00.000Z`,
    to: `${input.to}T23:59:59.999Z`,
  })
  if (input.teamId) params.set("teamId", input.teamId)
  if (input.slug) params.set("slug", input.slug)
  const body = await vercelTextRequest(`/v1/billing/charges?${params.toString()}`, token)
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as VercelFocusCharge)
}
