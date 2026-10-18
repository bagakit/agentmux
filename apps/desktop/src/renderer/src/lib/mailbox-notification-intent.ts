import type { AgentMuxMessageEvent, AgentPromptInputKey } from '@agentmux/core'

/** Only the user's original request identity is durable. Outcomes remain with Core. */
export type MailboxNotificationIntent = {
  hostId: string
  participantSessionId: string
  messageId: string
  recipientSessionId: string
  recipientRunId?: string
  operationId: string
  createdAt: number
}

/** A transient projection of a read or call, never persisted as an input outcome. */
export type MailboxNotificationFeedback = {
  state: 'pending' | 'submitted' | 'unconfirmed' | 'not-applied'
  sending?: boolean | undefined
  checking?: string | undefined
  key?: AgentPromptInputKey | undefined
  wire?: string | undefined
  reason?: string | undefined
  preservationIssue?: string | undefined
  older?: { beforeSequence: number; throughSequence: number; incarnation: string } | undefined
}

export type MailboxNotificationHistory = {
  events: readonly AgentMuxMessageEvent[]
  loading?: string | undefined
  error?: string | undefined
  incarnation?: string | undefined
  older?: MailboxNotificationFeedback['older']
}

export type MailboxNotificationIntents = Record<string, Record<string, MailboxNotificationIntent>>
export type MailboxNotificationFeedbackBySubject = Record<string, Record<string, MailboxNotificationFeedback>>
export type MailboxNotificationHistoryBySubject = Record<string, Record<string, MailboxNotificationHistory>>

export const mailboxNotificationSubject = (intent: Pick<MailboxNotificationIntent, 'hostId' | 'participantSessionId'>) =>
  JSON.stringify([intent.hostId, intent.participantSessionId])
export const mailboxNotificationScope = (intent: Pick<MailboxNotificationIntent, 'hostId' | 'participantSessionId' | 'messageId'>) =>
  JSON.stringify([intent.hostId, intent.participantSessionId, intent.messageId])
export const mailboxNotificationIntentKey = (intent: Pick<MailboxNotificationIntent, 'hostId' | 'participantSessionId' | 'messageId' | 'operationId'>) =>
  JSON.stringify([intent.hostId, intent.participantSessionId, intent.messageId, intent.operationId])

export function restoredMailboxNotificationIntents(value: unknown): MailboxNotificationIntents {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: MailboxNotificationIntents = {}
  const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/[\0\r\n]/u.test(value)
  for (const [subject, entries] of Object.entries(value)) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue
    for (const [key, raw] of Object.entries(entries)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const item = raw as MailboxNotificationIntent
      if (![item.hostId, item.participantSessionId, item.messageId, item.recipientSessionId, item.operationId].every(id) ||
          item.recipientRunId !== undefined && !id(item.recipientRunId) || !Number.isFinite(item.createdAt)) continue
      const intent: MailboxNotificationIntent = { hostId: item.hostId, participantSessionId: item.participantSessionId,
        messageId: item.messageId, recipientSessionId: item.recipientSessionId, operationId: item.operationId, createdAt: item.createdAt,
        ...(item.recipientRunId ? { recipientRunId: item.recipientRunId } : {}) }
      if (subject === mailboxNotificationSubject(intent) && key === mailboxNotificationIntentKey(intent)) (result[subject] ??= {})[key] = intent
    }
  }
  return result
}
