import { AgentMuxError } from './errors.js'
import { isAgentDeliveryState } from './agent-message.js'
import { assertDispatchEventKind } from './agent-handoff.js'

export type AgentMuxMessageEventsQuery = {
  participantSessionId: string
  afterSequence?: number
  /** Freeze the original journal boundary while traversing this result. */
  throughSequence?: number
  incarnation?: string
  messageId?: string
  broadcastOperationId?: string
  limit?: number
}

export type AgentMuxMessageEventReference = {
  messageId: string
  senderSessionId: string
  recipientSessionId: string
  threadId: string
  replyTo: string | null
  broadcast?: { operationId: string; sequence: number }
}

/** Metadata from one original journal record; never a reconstructed message or body. */
export type AgentMuxMessageEvent = {
  sequence: number
  kind: 'message' | 'delivery' | 'delivery-issue' | 'dispatch-open' | 'dispatch-event' |
    'a2a-notification' | 'a2a-notification-result'
  at: number | null
  messages: readonly AgentMuxMessageEventReference[]
  notificationId?: string
  state?: string
  reason?: string
  replyMessageId?: string
  eventKind?: string
}

export type AgentMuxMessageEventsPage = {
  participantSessionId: string
  afterSequence: number
  throughSequence: number
  incarnation: string
  messageId: string | null
  broadcastOperationId: string | null
  events: readonly AgentMuxMessageEvent[]
  nextAfterSequence: number | null
}

const fail = (): never => { throw new AgentMuxError('The original message event page is malformed or belongs to another participant.', 'CONTROL_PROTOCOL_ERROR') }
const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/[\0\r\n]/u.test(value)
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return fail()
  return value as Record<string, unknown>
}

export function parseMessageEventsPage(value: unknown, input: AgentMuxMessageEventsQuery): AgentMuxMessageEventsPage {
  const page = object(value, ['participantSessionId', 'afterSequence', 'throughSequence', 'incarnation', 'messageId', 'broadcastOperationId', 'events', 'nextAfterSequence'])
  if (page.messageId !== (input.messageId ?? null) || page.broadcastOperationId !== (input.broadcastOperationId ?? null) || !id(page.incarnation) || input.incarnation !== undefined && page.incarnation !== input.incarnation || page.participantSessionId !== input.participantSessionId || page.afterSequence !== (input.afterSequence ?? 0) ||
      !Number.isSafeInteger(page.throughSequence) || (page.throughSequence as number) < (page.afterSequence as number) ||
      input.throughSequence !== undefined && page.throughSequence !== input.throughSequence || !Array.isArray(page.events) ||
      page.events.length > (input.limit ?? 50)) return fail()
  let previous = page.afterSequence as number
  for (const entry of page.events) {
    const event = object(entry, ['sequence', 'kind', 'at', 'messages', 'notificationId', 'state', 'reason', 'replyMessageId', 'eventKind'])
    if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) <= previous || (event.sequence as number) > (page.throughSequence as number) ||
        !['message', 'delivery', 'delivery-issue', 'dispatch-open', 'dispatch-event', 'a2a-notification', 'a2a-notification-result'].includes(String(event.kind)) ||
        event.at !== null && (typeof event.at !== 'number' || !Number.isFinite(event.at)) || !Array.isArray(event.messages) || !event.messages.length) return fail()
    previous = event.sequence as number
    const seen = new Set<string>()
    for (const value of event.messages) {
      const ref = object(value, ['messageId', 'senderSessionId', 'recipientSessionId', 'threadId', 'replyTo', 'broadcast'])
      if (!id(ref.messageId) || !id(ref.senderSessionId) || !id(ref.recipientSessionId) || !id(ref.threadId) ||
          ref.replyTo !== null && !id(ref.replyTo) || seen.has(ref.messageId) ||
          ref.senderSessionId !== input.participantSessionId && ref.recipientSessionId !== input.participantSessionId) return fail()
      if (ref.broadcast !== undefined) {
        const batch = object(ref.broadcast, ['operationId', 'sequence'])
        if (!id(batch.operationId) || !Number.isSafeInteger(batch.sequence) || (batch.sequence as number) < 1 || (batch.sequence as number) >= (event.sequence as number)) return fail()
      }
      if (input.messageId !== undefined && ref.messageId !== input.messageId || input.broadcastOperationId !== undefined &&
          (!ref.broadcast || (ref.broadcast as { operationId?: unknown }).operationId !== input.broadcastOperationId)) return fail()
      seen.add(ref.messageId)
    }
    for (const key of ['notificationId', 'state', 'replyMessageId', 'eventKind']) if (event[key] !== undefined && !id(event[key])) return fail()
    if (event.reason !== undefined && typeof event.reason !== 'string') return fail()
    if (String(event.kind).startsWith('a2a-notification') && !id(event.notificationId)) return fail()
    const notification = event.kind === 'a2a-notification' || event.kind === 'a2a-notification-result'
    if (notification ? event.at !== null : event.at === null) return fail()
    if (event.notificationId !== undefined && !notification || event.state !== undefined && !notification && event.kind !== 'delivery' ||
        event.reason !== undefined && !['delivery', 'delivery-issue', 'a2a-notification-result'].includes(String(event.kind)) ||
        (event.replyMessageId !== undefined || event.eventKind !== undefined) && event.kind !== 'dispatch-event') return fail()
    if (event.kind === 'a2a-notification' && event.state !== 'pending' || event.kind === 'a2a-notification-result' && !['submitted', 'unconfirmed', 'not-applied'].includes(String(event.state)) ||
        event.kind === 'delivery' && !isAgentDeliveryState(event.state) || event.kind === 'delivery-issue' && typeof event.reason !== 'string') return fail()
    if (event.kind === 'dispatch-event') {
      if (!id(event.replyMessageId)) return fail()
      try { assertDispatchEventKind(event.eventKind) } catch { return fail() }
    }
  }
  if (page.nextAfterSequence !== null && (!page.events.length || page.nextAfterSequence !== previous)) return fail()
  return page as unknown as AgentMuxMessageEventsPage
}
