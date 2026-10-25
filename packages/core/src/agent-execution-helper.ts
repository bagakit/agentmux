import type { AgentMuxPreparedTerminal } from './terminal-preparation.js'
import type { AgentLaunchPlan } from './types.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** Provider-owned informational qualification; never used to decide bridge or Agent health. */
export interface AgentExecutionNotice {
  providerId: string
  role: 'frontend' | 'executor'
  capability: 'hooks' | 'skills' | 'mcp' | 'agent-control'
  state: 'unqualified' | 'unverified' | 'unsupported' | 'unconfigured'
  code: string
  message: string
  action: string
}
export function parseAgentExecutionNotices(value: unknown, expected: { providerId?: string; role?: AgentExecutionNotice['role'] } = {}, code = 'INVALID_EXECUTION_HELPER'): AgentExecutionNotice[] {
  const fail = (): never => { throw new AgentMuxError('Execution notices must retain their original Provider and helper role.', code) }
  if (!Array.isArray(value)) fail()
  const seen = new Set<string>()
  return (value as unknown[]).map(item => {
    const notice = rpcRecord(item, ['providerId', 'role', 'capability', 'state', 'code', 'message', 'action'], code)
    if (['providerId', 'code', 'message', 'action'].some(key => typeof notice[key] !== 'string' || !notice[key]) ||
      !['frontend', 'executor'].includes(notice.role as string) ||
      !['hooks', 'skills', 'mcp', 'agent-control'].includes(notice.capability as string) ||
      !['unqualified', 'unverified', 'unsupported', 'unconfigured'].includes(notice.state as string) ||
      Object.entries(expected).some(([key, original]) => notice[key] !== original)) fail()
    const key = JSON.stringify([notice.providerId, notice.role, notice.capability])
    if (seen.has(key)) fail()
    seen.add(key)
    return { ...notice } as unknown as AgentExecutionNotice
  })
}

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
  notices?: AgentExecutionNotice[]
  prepared: AgentMuxPreparedTerminal
  /** Executor-only retained journal identity, captured during authorized preparation. */
  journalIdentity?: string
}
export interface AgentExecutionHelperContext extends AgentExecutionHelperInput {
  journalDirectory: string
  journalIdentity?: string
  executable: string
}
export type AgentExecutionHelperLaunchPlan = AgentLaunchPlan & { notices?: AgentExecutionNotice[] }
export type AgentExecutionHelperLaunch = (context: AgentExecutionHelperContext) => Promise<AgentExecutionHelperLaunchPlan>
