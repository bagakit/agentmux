import type { AgentMuxPreparedTerminal } from './terminal-preparation.js'
import type { AgentLaunchPlan } from './types.js'

/** Explicit authorization for one resource Host's native execution endpoint. */
export type AgentExecutionResourceGrant = { scope: 'host-user'; bindingId: string }
export interface AgentExecutionHelperInput {
  bindingId: string
  agentSessionId?: string
  role: 'frontend' | 'executor'
  providerId: string
  workspacePath: string
  createOperationId: string
  toolExecution?: import('./agent-tool-execution.js').AgentToolExecutionBinding
  grant?: AgentExecutionResourceGrant
}
export interface AgentExecutionHelperPreparation {
  bindingId: string
  role: 'frontend' | 'executor'
  providerId: string
  prepared: AgentMuxPreparedTerminal
  /** Executor-only retained journal identity, captured during authorized preparation. */
  journalIdentity?: string
}
export interface AgentExecutionHelperContext extends AgentExecutionHelperInput {
  journalDirectory: string
  journalIdentity?: string
  executable: string
}
export type AgentExecutionHelperLaunch = (context: AgentExecutionHelperContext) => Promise<AgentLaunchPlan>
