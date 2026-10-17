import { AgentMuxError } from './errors.js'
import { validateAgentPromptCondition, validateAgentPromptInputKey, type AgentPromptCondition, type AgentPromptInputKey } from './agent-prompt-condition.js'
import { messageEnvelopeString } from './agent-message-envelope.js'
import { isDeepStrictEqual } from 'node:util'
import type { AgentPromptSubmissionRecord } from './types.js'

export const MAX_A2A_NOTIFICATION_BYTES = 64 * 1024

/** A platform input referencing original Inbox records; never another A2A message. */
export type AgentMuxMessageNotification = {
  notificationId: string
  key: Extract<AgentPromptInputKey, { kind: 'prompt' }>
  messageIds: readonly string[]
  wire: string
  condition: AgentPromptCondition
  mode: 'idle' | 'steer'
  /** An automatic producer's exact observed opportunity, not a saved user intent. */
  idle?: { completionId: string; inputByte: number }
  state: 'pending' | 'submitted' | 'unconfirmed' | 'not-applied'
  reason?: string
}

/** Read-only journal projection. Notification is independent of body read or task acceptance. */
export type AgentMuxMessageNotificationStatus = {
  state: 'pending' | 'submitted' | 'unconfirmed'
  notificationId?: string
  key?: Extract<AgentPromptInputKey, { kind: 'prompt' }>
  reason?: string
}

/** Only the original platform producer can supply a notification's input outcome. */
export function isMessageNotificationInput(notice: AgentMuxMessageNotification, record: AgentPromptSubmissionRecord | null): record is AgentPromptSubmissionRecord {
  const admission = record?.admission, intent = admission?.intent
  return record?.agentSessionId === notice.key.agentSessionId && isDeepStrictEqual(record.run, notice.key.expectedRun) &&
    isDeepStrictEqual(admission?.inputKey, notice.key) && admission?.submissionId === notice.notificationId &&
    isDeepStrictEqual(intent?.run, notice.key.expectedRun) && intent?.prompt === notice.wire &&
    isDeepStrictEqual(intent.message, { systemContext: notice.wire, a2aNotificationId: notice.notificationId }) &&
    (notice.mode === 'idle'
      ? intent.execution === 'default' && isDeepStrictEqual(intent.admissionIntent, { kind: 'exact-condition', condition: notice.condition }) &&
        admission.completionId === notice.idle?.completionId && intent.plan.kind === 'native-rpc' && intent.plan.operation === 'queue-idle'
      : intent.execution === 'immediate' && isDeepStrictEqual(intent.admissionIntent, { kind: 'manual-actor', expectedRun: notice.key.expectedRun }))
}

export function validateMessageNotification(value: AgentMuxMessageNotification): AgentMuxMessageNotification {
  const key = validateAgentPromptInputKey(value.key)
  const condition = validateAgentPromptCondition(value.condition)
  messageEnvelopeString(value.notificationId, 'Notification ID')
  if (key.kind !== 'prompt' || key.submissionId !== value.notificationId || key.expectedRun.runId !== condition.expectedRun.runId ||
      !Array.isArray(value.messageIds) || value.messageIds.length < 1 || value.messageIds.length > 100 ||
      new Set(value.messageIds).size !== value.messageIds.length || value.messageIds.includes(value.notificationId) ||
      typeof value.wire !== 'string' || !value.wire || Buffer.byteLength(value.wire) > MAX_A2A_NOTIFICATION_BYTES ||
      !['idle', 'steer'].includes(value.mode) || !['pending', 'submitted', 'unconfirmed', 'not-applied'].includes(value.state) ||
      value.reason !== undefined && typeof value.reason !== 'string') throw new AgentMuxError('The original A2A notification is invalid.', 'INVALID_A2A_NOTIFICATION')
  for (const id of value.messageIds) messageEnvelopeString(id, 'Original message ID')
  if (value.mode === 'idle') {
    if (!value.idle || typeof value.idle.completionId !== 'string' || !value.idle.completionId ||
        !Number.isSafeInteger(value.idle.inputByte) || value.idle.inputByte < 0) throw new AgentMuxError(
      'The automatic notification has no original idle input boundary.', 'INVALID_A2A_NOTIFICATION')
  } else if (value.idle !== undefined) throw new AgentMuxError('A manual notification cannot invent an automatic idle boundary.', 'INVALID_A2A_NOTIFICATION')
  return structuredClone({ ...value, key, condition })
}
