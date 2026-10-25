import { AgentMuxError } from './errors.js'

/** Machine launch state, not a permission or a heuristic derived from display text. */
export type AgentToolContextState = 'unconfigured'

/** Refuse only this Agent control operation; native tools and the original Agent stay available. */
export function assertAgentToolContextAvailable(env: NodeJS.ProcessEnv = process.env): void {
  if (env.AGENTMUX_TOOL_CONTEXT === ('unconfigured' satisfies AgentToolContextState)) {
    throw new AgentMuxError('Agent control is unavailable in this tool environment: the original Agent Host route and current credentials are not configured.', 'AGENT_TOOL_CONTEXT_UNAVAILABLE')
  }
}
