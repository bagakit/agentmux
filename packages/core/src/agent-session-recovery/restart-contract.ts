import { AgentMuxError } from '../errors.js'
import type { AgentMuxAgentSession, AgentMuxRunRef } from '../types.js'

/** Explicit interruption and native restoration, with no authored or replayed input. */
export type AgentMuxAgentRestartIdentity = { agentSessionId: string; expectedRun: AgentMuxRunRef; operationId: string }
export type AgentMuxAgentRestartInput = AgentMuxAgentRestartIdentity & {
  args?: readonly string[]; env?: Readonly<Record<string, string>>; commandOverride?: string; cols?: number; rows?: number
}
export type AgentMuxAgentRestartInspection = AgentMuxAgentRestartIdentity & {
  previousRun: AgentMuxRunRef
  /** An explicit retry may advance this same operation. A known failed result requires a separately confirmed new intent; unknown results retain this operation. */
  canRetry: boolean
  phase: 'not-found' | 'stopping' | 'starting' | 'restarted' | 'failed' | 'unconfirmed'
  session?: AgentMuxAgentSession
  newRun?: AgentMuxRunRef
  observedAt: number
  detail?: string
  failure?: { code: string; message: string; observedAt: number }
}
export function parseAgentRestartInput(value: unknown, identityOnly = false): AgentMuxAgentRestartInput {
  const input = value as AgentMuxAgentRestartInput
  const fields = ['agentSessionId', 'expectedRun', 'operationId', ...(identityOnly ? [] : ['args', 'env', 'commandOverride', 'cols', 'rows'])]
  const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key)) ||
    !id(input.agentSessionId) || input.agentSessionId === 'self' || !id(input.operationId) ||
    !input.expectedRun || Object.keys(input.expectedRun).join() !== 'runId' || !id(input.expectedRun.runId) ||
    input.args !== undefined && (!Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) ||
    input.env !== undefined && (!input.env || typeof input.env !== 'object' || Array.isArray(input.env) || Object.entries(input.env).some(([key, value]) => !key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0'))) ||
    input.commandOverride !== undefined && (typeof input.commandOverride !== 'string' || !input.commandOverride || input.commandOverride.includes('\0')) ||
    [input.cols, input.rows].some(size => size !== undefined && (!Number.isSafeInteger(size) || size < 1))) {
    throw new AgentMuxError('Restart requires its complete original Session, Run, operation and valid launch configuration.', 'INVALID_AGENT_RESTART', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
  }
  return structuredClone(input)
}
