import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, originalMessageInputKey, type AgentMuxMessageNotification, type AgentMuxMessageReadView, type AgentPromptInputKey, type AgentInputJournalCut } from '@agentmux/core'
import { conversationA2ANotificationId, isCompleteConversationRecord, type ConversationCheckpoint, type ConversationContentRef, type ConversationItemRef, type ConversationRef, type ConversationUnit } from '@agentmux/core/conversation'
import type { PublicationSpeaker } from './publication-speaker.js'

/** Read only the original journal on the exact conversation Host. No notification or consumption. */
export interface PublicationOriginalMessagePort {
  notification(reference: ConversationRef, notificationId: string, signal: AbortSignal): Promise<{ notification: AgentMuxMessageNotification | null; inputOrigin: AgentInputJournalCut | null }>
  message(reference: ConversationRef, messageId: string, notificationId: string | undefined, signal: AbortSignal): Promise<AgentMuxMessageReadView | null>
}
export type PublicationOriginalMessage = {
  messageId: string; senderSessionId: string; notificationId?: string
  body: string; createdAt: number; speaker?: PublicationSpeaker
}
export type PublicationA2A = {
  key: AgentPromptInputKey; notificationId?: string; record: ConversationItemRef; revision: string; part?: ConversationContentRef
  messages: PublicationOriginalMessage[]
  unavailable: boolean
  startUnconfirmed?: true
  originalAgentInput?: true
}

/** Only Core's qualified producer identity opens the journal; declarations and body text cannot. */
export function publicationMessageTargets(unit: ConversationUnit, start?: ConversationCheckpoint) {
  const cut = start?.frontier.cuts.find(value => value.kind === 'captured')
  const startUnconfirmed = !cut || !cut.inputJournal
  const targets = unit.records.filter(isCompleteConversationRecord).flatMap(record => {
    if (!record.reference) return []
    const original = record.original
    const key = original.kind === 'native' ? original.item.conversation?.adoptedInput?.key : original.item.inputRef
    const notificationId = conversationA2ANotificationId(record)
    const senderSessionId = original.kind === 'captured' ? original.item.authorAgentSessionId : undefined
    if (!key || (key.kind === 'prompt' ? !notificationId || key.submissionId !== notificationId : original.kind === 'captured' && !senderSessionId)) return []
    const selector = original.kind === 'captured' ? { kind: 'captured-field' as const, field: 'content' as const }
      : original.item.contentParts.length ? { kind: 'native-part' as const, partIndex: 0 } : undefined
    const origin = original.kind === 'captured' ? original.item.inputOrigin : undefined
    const beforeStart = original.kind === 'captured' && start !== undefined && (!cut || cut.kind !== 'captured' ||
      record.order.kind !== 'captured-stream' || record.order.epoch !== cut.epoch || record.order.firstSequence <= cut.sequence ||
      origin !== undefined && (!cut.inputJournal || origin.queueId !== cut.inputJournal.queueId || origin.incarnation !== cut.inputJournal.incarnation || origin.sequence <= cut.inputJournal.sequence))
    return [{ ...(notificationId ? { notificationId } : {}), ...(senderSessionId ? { senderSessionId } : {}), key, record: record.reference, revision: record.revision, beforeStart, ...(startUnconfirmed ? { startUnconfirmed: true as const } : {}),
      ...(selector ? { part: { record: record.reference, recordRevision: record.revision, selector } satisfies ConversationContentRef } : {}) }]
  })
  // A canonical native alias cannot reopen a captured notification known to precede this shared boundary.
  const excluded = new Set(targets.filter(target => target.beforeStart).map(target => JSON.stringify(target.key)))
  return targets.filter(target => !excluded.has(JSON.stringify(target.key)))
}

/** One bounded page's related notifications only; no Inbox scan, wire parser or second history. */
export async function readPublicationA2A(reference: ConversationRef, units: readonly ConversationUnit[], port: PublicationOriginalMessagePort, signal: AbortSignal, start?: ConversationCheckpoint): Promise<Map<string, PublicationA2A[]>> {
  const notices = new Map<string, Promise<Awaited<ReturnType<typeof port.notification>>>>(), messages = new Map<string, Promise<AgentMuxMessageReadView | null>>()
  const result = new Map<string, PublicationA2A[]>()
  const cut = start?.frontier.cuts.find(value => value.kind === 'captured')
  const afterStart = (origin: AgentInputJournalCut | null) => {
    if (!cut || !cut.inputJournal || !origin || cut.inputJournal.queueId !== origin.queueId || cut.inputJournal.incarnation !== origin.incarnation) throw new AgentMuxError('The original input membership is unconfirmed.', 'PUBLICATION_A2A_ASSOCIATION_UNCONFIRMED')
    return origin.sequence > cut.inputJournal.sequence
  }
  for (const unit of units) {
    const resolved: PublicationA2A[] = []
    for (const target of publicationMessageTargets(unit, start)) {
      signal.throwIfAborted()
      const value: PublicationA2A = { key: target.key, ...(target.notificationId ? { notificationId: target.notificationId } : {}), record: target.record, revision: target.revision, ...(target.part ? { part: target.part } : {}), messages: [], unavailable: false, ...(target.startUnconfirmed ? { startUnconfirmed: true as const } : {}) }
      resolved.push(value)
      if (target.startUnconfirmed) { value.unavailable = true; continue }
      try {
        let notice: AgentMuxMessageNotification | undefined
        if (target.key.kind === 'prompt') {
          const id = target.notificationId!
          if (!notices.has(id)) notices.set(id, port.notification(reference, id, signal))
          const inspection = await notices.get(id)!
          if (!inspection.notification || inspection.notification.notificationId !== id || inspection.notification.key.agentSessionId !== reference.agentSessionId || !isDeepStrictEqual(inspection.notification.key, target.key)) throw new AgentMuxError('The original notification association is unavailable.', 'PUBLICATION_A2A_ASSOCIATION_UNCONFIRMED')
          notice = inspection.notification
          if (!afterStart(inspection.inputOrigin)) continue
        }
        const messageIds = notice ? notice.messageIds : [target.key.kind === 'message' ? target.key.messageId : '']
        for (const messageId of messageIds) {
          signal.throwIfAborted()
          const key = JSON.stringify([notice?.notificationId, messageId])
          try {
            if (!messages.has(key)) messages.set(key, port.message(reference, messageId, notice?.notificationId, signal))
            const message = await messages.get(key)!, envelope = message?.envelope
            if (!envelope || envelope.messageId !== messageId || envelope.recipientSessionId !== reference.agentSessionId || envelope.recipient.kind !== 'agent-session' || envelope.recipient.agentSessionId !== reference.agentSessionId) throw new AgentMuxError('The original message recipient is unavailable.', 'PUBLICATION_A2A_ASSOCIATION_UNCONFIRMED')
            if (notice && (message!.notification?.notificationId !== notice.notificationId || message!.notification?.state === 'unassociated' || !isDeepStrictEqual(message!.notification?.key, notice.key))) throw new AgentMuxError('The original notification association is unavailable.', 'PUBLICATION_A2A_ASSOCIATION_UNCONFIRMED')
            if (envelope.sender.kind !== 'agent-session') {
              if (target.senderSessionId) throw new AgentMuxError('The original Agent sender is unconfirmed.', 'PUBLICATION_A2A_ASSOCIATION_UNCONFIRMED')
              continue // A human/external message is still owned by ordinary publication, never Agent attribution.
            }
            if (envelope.senderSessionId !== envelope.sender.agentSessionId || !envelope.senderSessionId || target.senderSessionId && target.senderSessionId !== envelope.senderSessionId) throw new AgentMuxError('The original Agent sender is unconfirmed.', 'PUBLICATION_A2A_ASSOCIATION_UNCONFIRMED')
            if (target.key.kind === 'message') {
              if (!isDeepStrictEqual(originalMessageInputKey(message!), target.key)) throw new AgentMuxError('The original input key is unconfirmed.', 'PUBLICATION_A2A_ASSOCIATION_UNCONFIRMED')
              const visible = afterStart(message!.inputOrigin)
              value.originalAgentInput = true
              if (!visible) continue
            }
            value.messages.push({ messageId, senderSessionId: envelope.senderSessionId, ...(notice ? { notificationId: notice.notificationId } : {}), body: envelope.body, createdAt: envelope.createdAt,
              speaker: { kind: 'agent', reference: { ...reference, agentSessionId: envelope.senderSessionId } } })
          } catch { signal.throwIfAborted(); value.unavailable = true }
        }
      } catch { signal.throwIfAborted(); value.unavailable = true }
    }
    if (resolved.length) result.set(unit.event.id, resolved)
  }
  return result
}
