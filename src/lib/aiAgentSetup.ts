export type AiAgentRecoveryKind = "not-running" | "pairing-expired" | "continuous-off" | "upload-failed"

export interface AiAgentRecovery {
  kind: AiAgentRecoveryKind
  title: string
  detail: string
  showPairCommand: boolean
}

const AUTH_FAILURE = /(?:401|403|unauthori[sz]ed|forbidden|token|credential|pair(?:ing)?|expired)/i

/** Converts the local agent's low-level failure into an actionable dashboard diagnosis. */
export function diagnoseAiAgent(input: {
  reachable: boolean
  autoSync?: boolean | null
  error?: string | null
}): AiAgentRecovery | null {
  if (!input.reachable) {
    return {
      kind: "not-running",
      title: "The background sync job is not responding.",
      detail: "It is stopped, unloaded, not installed on this device, or blocked by the browser's local-network permission.",
      showPairCommand: false,
    }
  }
  if (input.error && AUTH_FAILURE.test(input.error)) {
    return {
      kind: "pairing-expired",
      title: "The agent is running, but its saved pairing no longer works.",
      detail: input.error,
      showPairCommand: true,
    }
  }
  if (input.autoSync === false) {
    return {
      kind: "continuous-off",
      title: "The agent is running, but continuous updates are turned off.",
      detail: "Reinstall the background job below to keep it running and checking every minute.",
      showPairCommand: false,
    }
  }
  if (input.error) {
    return {
      kind: "upload-failed",
      title: "The agent is running, but its latest upload failed.",
      detail: input.error,
      showPairCommand: false,
    }
  }
  return null
}

export function aiAgentCommands(origin: string) {
  const runner = "npx --yes github:MustangBro7/infra-cost-analyzer"
  const pair = `AMBRIUM_API=${origin} ${runner} --ai-only`
  const serve = `AMBRIUM_API=${origin} ${runner} serve`
  const install = `AMBRIUM_API=${origin} ${runner} install-agent`

  return { pair, serve, install }
}
