import type { LaunchOptionSelection } from '../agent-launch-option.js'
export type AgentMuxAgentResumeInput = {
  agentSessionId: string
  operationId: string
  /** Explicit host-generated context, separate from original user text. */
  agentMuxNote?: string
  prompt: string
  /** Frozen with this original input; reconnect cannot renew it. */
  inputEpoch?: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  commandOverride?: string
  cols?: number
  rows?: number
}

export type AgentMuxAgentReopenInput = Omit<AgentMuxAgentResumeInput, 'prompt' | 'agentMuxNote' | 'inputEpoch'> & {
  expectedRetiredAt: number
  launchOptions?: LaunchOptionSelection
}

export type AgentMuxAgentResumeOperationInput = Omit<AgentMuxAgentResumeInput, 'prompt'> & {
  prompt?: string
}
