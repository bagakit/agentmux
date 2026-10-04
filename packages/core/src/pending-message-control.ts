import type { AgentPromptPreparationRetryProgress } from './prompt-preparation.js'
import { validateDeliveryLogId } from './delivery-attempt.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** Client-owned intent, including archived records; this is not the Core envelope delivery queue. */
export type AgentMuxPendingMessage = {
  pendingId: string
  text: string
  runId: string | null
  enqueuedAt: number | null
  status: 'queued' | 'restoring' | 'deferred' | 'failed'
  phase: 'preparing' | 'submitting' | null
  editable: boolean
  delivery: 'not-submitted' | 'unconfirmed' | 'confirmed'
  errorCode: string | null
  error: string | null
  logId?: string
  preparationWait?: AgentPromptPreparationRetryProgress
  /** The original intent is retained, but is not eligible for active queue delivery. */
  archived: boolean
}
type Base = { schemaVersion: 5; requestId: string; agentSessionId: string }
export type PendingMessageControlRequest =
  | Base & { operation: 'message.pending.ls' }
  | Base & { operation: 'message.pending.edit'; pendingId: string; expectedText: string; text: string }
  | Base & { operation: 'message.pending.send'; pendingId: string }
  | Base & { operation: 'message.pending.stop'; pendingId: string }
  | Base & { operation: 'message.pending.archive'; pendingId: string; expectedText: string }
  | Base & { operation: 'message.pending.restore'; pendingId: string; expectedText: string }
export type PendingMessageControlResult =
  | { operation: 'message.pending.ls'; agentSessionId: string; messages: AgentMuxPendingMessage[] }
  | { operation: 'message.pending.edit'; agentSessionId: string; message: AgentMuxPendingMessage; changed: boolean }
  | { operation: 'message.pending.stop'; agentSessionId: string; message: AgentMuxPendingMessage; changed: boolean }
  | { operation: 'message.pending.send'; agentSessionId: string; pendingId: string; disposition: 'submitted' | 'unconfirmed'; message: AgentMuxPendingMessage | null }
  | { operation: 'message.pending.archive'; agentSessionId: string; message: AgentMuxPendingMessage; changed: boolean }
  | { operation: 'message.pending.restore'; agentSessionId: string; message: AgentMuxPendingMessage; changed: boolean }

export function isPendingMessageOperation(value: unknown): value is PendingMessageControlRequest['operation'] {
  return value === 'message.pending.ls' || value === 'message.pending.edit' || value === 'message.pending.send' || value === 'message.pending.stop' ||
    value === 'message.pending.archive' || value === 'message.pending.restore'
}

/** Validate the business result before a transport carries it to any client. */
export function parsePendingMessage(value: unknown): AgentMuxPendingMessage {
  const source = rpcRecord(value, ['pendingId', 'text', 'runId', 'enqueuedAt', 'status', 'phase', 'editable', 'delivery', 'errorCode', 'error', 'logId', 'preparationWait', 'archived'])
  const identifier = (input: unknown): input is string => typeof input === 'string' && Boolean(input.trim()) && !/[\0\r\n]/u.test(input)
  if (!identifier(source.pendingId) || typeof source.text !== 'string' || source.text.includes('\0') ||
      source.runId !== null && !identifier(source.runId) ||
      source.enqueuedAt !== null && (typeof source.enqueuedAt !== 'number' || !Number.isFinite(source.enqueuedAt)) ||
      !['queued', 'restoring', 'deferred', 'failed'].includes(source.status as string) ||
      ![null, 'preparing', 'submitting'].includes(source.phase as string | null) || typeof source.editable !== 'boolean' ||
      !['not-submitted', 'unconfirmed', 'confirmed'].includes(source.delivery as string) ||
      source.errorCode !== null && !identifier(source.errorCode) || source.error !== null && typeof source.error !== 'string' ||
      typeof source.archived !== 'boolean' || source.archived && source.phase !== null ||
      source.editable && (source.archived || source.phase !== null || source.delivery !== 'not-submitted')) {
    throw new AgentMuxError('Pending message facts are invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  if (source.preparationWait !== undefined) {
    const wait = rpcRecord(source.preparationWait, ['reason', 'state', 'attempt', 'maxAttempts', 'nextAttemptAt'])
    if (!['context-compaction', 'native-busy'].includes(wait.reason as string) ||
        !['waiting', 'preparing', 'stopped', 'exhausted'].includes(wait.state as string) ||
        !Number.isSafeInteger(wait.attempt) || Number(wait.attempt) < 1 || Number(wait.attempt) > 3 || wait.maxAttempts !== 3 ||
        wait.nextAttemptAt !== null && (!Number.isSafeInteger(wait.nextAttemptAt) || Number(wait.nextAttemptAt) < 0) ||
        (wait.state === 'waiting') !== (wait.nextAttemptAt !== null)) {
      throw new AgentMuxError('Pending preparation retry facts are invalid.', 'CONTROL_PROTOCOL_ERROR')
    }
  }
  if (source.logId !== undefined) validateDeliveryLogId(source.logId)
  return source as AgentMuxPendingMessage
}
