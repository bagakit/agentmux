import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** Unsubmitted client-owned intent; this is not the Core envelope delivery queue. */
export type AgentMuxPendingMessage = {
  pendingId: string
  text: string
  runId: string | null
  enqueuedAt: number | null
  status: 'queued' | 'restoring' | 'deferred' | 'failed'
  phase: 'preparing' | 'submitting' | null
  editable: boolean
  delivery: 'not-submitted' | 'unconfirmed'
  errorCode: string | null
  error: string | null
}
type Base = { schemaVersion: 5; requestId: string; agentSessionId: string }
export type PendingMessageControlRequest =
  | Base & { operation: 'message.pending.ls' }
  | Base & { operation: 'message.pending.edit'; pendingId: string; expectedText: string; text: string }
  | Base & { operation: 'message.pending.send'; pendingId: string }
export type PendingMessageControlResult =
  | { operation: 'message.pending.ls'; agentSessionId: string; messages: AgentMuxPendingMessage[] }
  | { operation: 'message.pending.edit'; agentSessionId: string; message: AgentMuxPendingMessage; changed: boolean }
  | { operation: 'message.pending.send'; agentSessionId: string; pendingId: string; disposition: 'submitted' | 'unconfirmed'; message: AgentMuxPendingMessage | null }

export function isPendingMessageOperation(value: unknown): value is PendingMessageControlRequest['operation'] {
  return value === 'message.pending.ls' || value === 'message.pending.edit' || value === 'message.pending.send'
}

/** Validate the business result before a transport carries it to any client. */
export function parsePendingMessage(value: unknown): AgentMuxPendingMessage {
  const source = rpcRecord(value, ['pendingId', 'text', 'runId', 'enqueuedAt', 'status', 'phase', 'editable', 'delivery', 'errorCode', 'error'])
  const identifier = (input: unknown): input is string => typeof input === 'string' && Boolean(input.trim()) && !/[\0\r\n]/u.test(input)
  if (!identifier(source.pendingId) || typeof source.text !== 'string' || source.text.includes('\0') ||
      source.runId !== null && !identifier(source.runId) ||
      source.enqueuedAt !== null && (typeof source.enqueuedAt !== 'number' || !Number.isFinite(source.enqueuedAt)) ||
      !['queued', 'restoring', 'deferred', 'failed'].includes(source.status as string) ||
      ![null, 'preparing', 'submitting'].includes(source.phase as string | null) || typeof source.editable !== 'boolean' ||
      !['not-submitted', 'unconfirmed'].includes(source.delivery as string) ||
      source.errorCode !== null && !identifier(source.errorCode) || source.error !== null && typeof source.error !== 'string' ||
      source.editable && (source.phase !== null || source.delivery !== 'not-submitted')) {
    throw new AgentMuxError('Pending message facts are invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  return source as AgentMuxPendingMessage
}
