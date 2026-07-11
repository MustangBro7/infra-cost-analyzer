export const AGENT_LABEL: string

export interface AgentTemplateOptions {
  apiBase: string
  npxPath: string
  nodePath?: string
}

export function macAgentPlist(options: AgentTemplateOptions): string
export function linuxAgentService(options: AgentTemplateOptions): string

export function installUsageAgent(options?: {
  apiBase?: string
  platformName?: string
  home?: string
  run?: (...args: unknown[]) => unknown
}): { platform: string; path: string; target: string }
