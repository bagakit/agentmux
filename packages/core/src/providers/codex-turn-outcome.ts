import type { AgentTurnOutcome } from '../types.js'
import { codexFailure } from './codex-errors.js'

/** One native result decoder for observation, history and changes. No presentation inference. */
export function codexTurnOutcome(record: Record<string, unknown>, nativeSessionId: string): AgentTurnOutcome | undefined {
  const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown> : undefined
  if (record.type !== 'event_msg' || !payload || typeof payload.turn_id !== 'string' || !payload.turn_id ||
    payload.thread_id !== undefined && payload.thread_id !== nativeSessionId ||
    payload.session_id !== undefined && payload.session_id !== nativeSessionId) return undefined
  if (payload.type !== 'task_complete' && payload.type !== 'turn_aborted') return undefined
  if (payload.error != null) return { status: 'failed', failure: codexFailure(payload.error, payload.turn_id) }
  if (payload.type === 'task_complete') return { status: 'completed' }
  if (payload.reason === 'interrupted') return { status: 'interrupted' }
  return undefined
}

/** Use the same physical identity as saved history; observation hashes remain separate. */
export function codexTurnRecordId(value: unknown, offset: number): string {
  const payload = (value as { payload?: { id?: unknown } })?.payload
  return typeof payload?.id === 'string' && payload.id ? payload.id : `codex-record:${offset}`
}
