export const CLI_PROVIDER_KEYS = ["aws", "gcp", "cloudflare", "motherduck"]

export function connectedProviderMap(payload) {
  const connections = payload?.connections ?? {}
  return Object.fromEntries(
    CLI_PROVIDER_KEYS.flatMap((provider) => {
      const connection = connections[provider]
      return connection?.status === "connected"
        ? [[provider, { accountLabel: connection.accountLabel ?? null }]]
        : []
    })
  )
}

