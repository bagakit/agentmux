import { AgentMuxError } from './errors.js'
import type { AgentFailure, AgentSessionHistoryItem, AgentTurnOutcome } from './types.js'

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit
const invalid = (): never => { throw new AgentMuxError('The original native turn outcome is malformed.', 'INVALID_AGENT_TURN_OUTCOME') }

/** Shared structural contract, not a classifier for any Provider's protocol. */
export function parseAgentTurnOutcome(value: unknown, turnId?: string): AgentTurnOutcome {
  const outcome = object(value)
  if (!outcome) return invalid()
  if (outcome.status === 'completed' || outcome.status === 'interrupted') {
    if (Object.keys(outcome).some(key => key !== 'status')) return invalid()
    return { status: outcome.status }
  }
  if (outcome.status !== 'failed' || Object.keys(outcome).some(key => key !== 'status' && key !== 'failure')) return invalid()
  const failure = object(outcome.failure)
  if (!failure || Object.keys(failure).some(key => !['code', 'message', 'nativeCode', 'httpStatusCode', 'recovery', 'nativeTurnId', 'publicMessage'].includes(key)) ||
    !text(failure.code, 256) || !text(failure.message, 16_384) || !text(failure.recovery, 4096) || !text(failure.nativeTurnId, 4096) ||
    turnId !== undefined && failure.nativeTurnId !== turnId ||
    failure.nativeCode !== undefined && !text(failure.nativeCode, 1024) ||
    failure.publicMessage !== undefined && !text(failure.publicMessage, 2048) ||
    failure.httpStatusCode !== undefined && (!Number.isInteger(failure.httpStatusCode) || Number(failure.httpStatusCode) < 100 || Number(failure.httpStatusCode) > 599)) return invalid()
  return { status: 'failed', failure: { ...failure } as AgentFailure }
}

/** Optional reading interpretation cannot remove original history or adjacent records. */
export function normalizeTurnOutcome(item: { turnOutcome?: unknown; turnOutcomeDiagnostic?: unknown; turnId?: unknown }):
  Pick<AgentSessionHistoryItem, 'turnOutcome' | 'turnOutcomeDiagnostic'> {
  const result: Pick<AgentSessionHistoryItem, 'turnOutcome' | 'turnOutcomeDiagnostic'> = {}
  try {
    if (item.turnOutcomeDiagnostic !== undefined) {
      const diagnostic = object(item.turnOutcomeDiagnostic)
      if (!diagnostic || !text(diagnostic.code, 256) || !text(diagnostic.message, 1024) || Object.keys(diagnostic).some(key => key !== 'code' && key !== 'message')) return invalid()
      result.turnOutcomeDiagnostic = { code: diagnostic.code, message: diagnostic.message }
    }
    if (item.turnOutcome !== undefined) {
      if (!text(item.turnId, 4096)) return invalid()
      result.turnOutcome = parseAgentTurnOutcome(item.turnOutcome, item.turnId)
    }
  } catch {
    return { turnOutcomeDiagnostic: { code: 'NATIVE_TURN_OUTCOME_UNCONFIRMED',
      message: 'The native turn result is unconfirmed. The original record remains readable; inspect its exact source.' } }
  }
  return result
}
