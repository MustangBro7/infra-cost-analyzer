export interface CliConnectionState {
  status?: string
  accountLabel?: string | null
}

export interface CliStatusPayload {
  connections?: Record<string, CliConnectionState | null | undefined>
}

export const CLI_PROVIDER_KEYS: readonly ["aws", "gcp", "cloudflare", "motherduck"]

export function connectedProviderMap(
  payload: CliStatusPayload,
): Partial<Record<(typeof CLI_PROVIDER_KEYS)[number], { accountLabel: string | null }>>

