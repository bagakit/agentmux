import { act } from 'react'
import { vi } from 'vitest'
import type { AgentMuxMessageMetadata, DurableAgentMuxMessage } from '@agentmux/core'
import { api } from '../../src/renderer/src/lib/api'

/** Explicit original journal facts, never inferred from a timeline or equal text. */
export function journalMessage({ id, body = `Original ${id}`, sender = 'reviewer', recipient = 'agent-1', sequence = 1,
  createdAt = sequence, delivery = { state: 'delivered', at: createdAt } }: {
  id: string; body?: string; sender?: string; recipient?: string; sequence?: number; createdAt?: number
  delivery?: DurableAgentMuxMessage['delivery']
}): DurableAgentMuxMessage {
  return { sequence, envelope: { schema: 'agentmux.a2a.v1', messageId: id, operationId: 'operation-' + id, createdAt,
    sender: { kind: 'agent-session', agentSessionId: sender }, recipient: { kind: 'agent-session', agentSessionId: recipient },
    senderSessionId: sender, senderRunId: 'run-' + sender, recipientSessionId: recipient, recipientRunId: null,
    threadId: 'thread-' + id, correlationId: 'correlation-' + id, replyTo: null, workspaceId: null, body }, delivery }
}
export function journalMetadata(record: DurableAgentMuxMessage): AgentMuxMessageMetadata {
  const { body, ...envelope } = record.envelope
  return { sequence: record.sequence, envelope, delivery: record.delivery,
    ...(record.deliveryMode ? { deliveryMode: record.deliveryMode } : {}), ...(record.notification ? { notification: record.notification } : {}),
    bodyPreview: body.slice(0, 240), bodyBytes: new TextEncoder().encode(body).byteLength }
}

/** Only the native API port is controlled; SessionMailbox and its query hook remain real. */
export function mailboxJournal() {
  const listeners = new Set<Parameters<typeof api.sessions.onEvent>[0]>()
  let originals: Array<{ hostId: string; record: DurableAgentMuxMessage }> = []
  const list = vi.spyOn(api.sessions, 'listMessages').mockImplementation(async (reference, query) => {
    const matching = originals.filter(item => item.hostId === reference.hostId &&
      (query.direction === 'incoming' ? item.record.envelope.recipientSessionId : item.record.envelope.senderSessionId) === reference.agentSessionId &&
      (query.beforeSequence === undefined || item.record.sequence < query.beforeSequence)).sort((a, b) => b.record.sequence - a.record.sequence)
    const selected = matching.slice(0, query.limit ?? 25)
    return { hostId: reference.hostId, participantSessionId: reference.agentSessionId, direction: query.direction,
      messages: selected.map(item => journalMetadata(item.record)), nextBeforeSequence: matching.length > selected.length ? selected.at(-1)!.record.sequence : null }
  })
  const read = vi.spyOn(api.sessions, 'readMessage').mockImplementation(async (reference, messageId) => ({ hostId: reference.hostId,
    message: originals.find(item => item.hostId === reference.hostId && item.record.envelope.messageId === messageId)?.record ?? null }))
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => {
    listeners.add(listener)
    queueMicrotask(() => { if (listeners.has(listener)) listener({ type: 'core', hostId: 'local', event: { type: 'agent-message-observation', state: 'available' } }) })
    return () => { listeners.delete(listener) }
  })
  const set = (records: readonly DurableAgentMuxMessage[], hostId = 'local') => { originals = [...originals.filter(item => item.hostId !== hostId), ...records.map(record => ({ hostId, record }))] }
  const changed = async (record: DurableAgentMuxMessage, hostId = 'local') => {
    await act(async () => {
      for (const listener of listeners) {
        listener({ type: 'core', hostId, event: { type: 'agent-message-observation', state: 'available' } })
        listener({ type: 'core', hostId, event: { type: 'agent-message-changed', messageId: record.envelope.messageId, sequence: record.sequence,
          messageSequence: record.sequence, recordKind: 'message', live: true,
          senderSessionId: record.envelope.senderSessionId!, recipientSessionId: record.envelope.recipientSessionId! } })
      }
    })
  }
  const publish = async (records: readonly DurableAgentMuxMessage[], hostId = 'local') => {
    set(records, hostId)
    if (records.length) await changed(records.at(-1)!, hostId)
  }
  return { list, read, set, changed, publish }
}
