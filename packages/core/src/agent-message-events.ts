import { AgentMuxError } from './errors.js'
import { isAgentDeliveryState } from './agent-message.js'
import { assertDispatchEventKind } from './agent-handoff.js'

export type AgentMuxMessageEventsQuery = {
  participantSessionId: string
  afterSequence?: number
  /** Select the newest related events, returned in original ascending order. */
  latest?: true
  /** Exclusive older-page position within the original frozen journal boundary. */
  beforeSequence?: number
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
  latest: boolean
  beforeSequence: number | null
  throughSequence: number
  incarnation: string
  messageId: string | null
  broadcastOperationId: string | null
  events: readonly AgentMuxMessageEvent[]
  nextAfterSequence: number | null
  nextBeforeSequence: number | null
}

/** One query contract for SDK, RPC and journal readers; no input or consumption effects. */
export function parseMessageEventsQuery(value: unknown): AgentMuxMessageEventsQuery {
  const invalid = (): never => { throw new AgentMuxError('Message events require one original participant, sequence direction and frozen continuation.', 'INVALID_CONTROL_REQUEST') }
  const keys = ['participantSessionId', 'afterSequence', 'latest', 'beforeSequence', 'throughSequence', 'incarnation', 'messageId', 'broadcastOperationId', 'limit']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return invalid()
  const p = value as Record<string, unknown>
  if (!id(p.participantSessionId) || p.latest !== undefined && p.latest !== true ||
      [p.afterSequence, p.latest, p.beforeSequence].filter(value => value !== undefined).length > 1 ||
      p.messageId !== undefined && p.broadcastOperationId !== undefined) return invalid()
  for (const key of ['incarnation', 'messageId', 'broadcastOperationId']) if (p[key] !== undefined && !id(p[key])) return invalid()
  for (const key of ['afterSequence', 'beforeSequence', 'throughSequence', 'limit']) if (p[key] !== undefined &&
    (!Number.isSafeInteger(p[key]) || Number(p[key]) < (key === 'beforeSequence' || key === 'limit' ? 1 : 0))) return invalid()
  if (p.limit !== undefined && Number(p.limit) > 100 || p.throughSequence !== undefined &&
      Number(p.throughSequence) < Number(p.afterSequence ?? 0) ||
      p.beforeSequence !== undefined && (p.throughSequence === undefined || Number(p.beforeSequence) > Number(p.throughSequence) + 1)) return invalid()
  if (p.throughSequence !== undefined && p.incarnation === undefined) throw new AgentMuxError(
    'Keep the original journal incarnation with its frozen message event boundary.', 'MESSAGE_EVENT_SOURCE_CHANGED')
  return { ...(p as AgentMuxMessageEventsQuery) }
}

const fail = (): never => { throw new AgentMuxError('The original message event page is malformed or belongs to another participant.', 'CONTROL_PROTOCOL_ERROR') }
const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/[\0\r\n]/u.test(value)
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return fail()
  return value as Record<string, unknown>
}

export function parseMessageEventsPage(value: unknown, input: AgentMuxMessageEventsQuery): AgentMuxMessageEventsPage {
  try { input = parseMessageEventsQuery(input) } catch { return fail() }
  const page = object(value, ['participantSessionId', 'afterSequence', 'latest', 'beforeSequence', 'throughSequence', 'incarnation', 'messageId', 'broadcastOperationId', 'events', 'nextAfterSequence', 'nextBeforeSequence'])
  if (page.messageId !== (input.messageId ?? null) || page.broadcastOperationId !== (input.broadcastOperationId ?? null) || !id(page.incarnation) || input.incarnation !== undefined && page.incarnation !== input.incarnation || page.participantSessionId !== input.participantSessionId || page.afterSequence !== (input.afterSequence ?? 0) ||
      page.latest !== (input.latest ?? false) || page.beforeSequence !== (input.beforeSequence ?? null) ||
      !Number.isSafeInteger(page.throughSequence) || (page.throughSequence as number) < (page.afterSequence as number) ||
      input.throughSequence !== undefined && page.throughSequence !== input.throughSequence || !Array.isArray(page.events) ||
      page.events.length > (input.limit ?? 50)) return fail()
  let previous = page.afterSequence as number
  for (const entry of page.events) {
    const event = object(entry, ['sequence', 'kind', 'at', 'messages', 'notificationId', 'state', 'reason', 'replyMessageId', 'eventKind'])
    if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) <= previous || (event.sequence as number) > (page.throughSequence as number) ||
        input.beforeSequence !== undefined && (event.sequence as number) >= input.beforeSequence ||
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
    if (!notification && event.at === null) return fail()
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
  const backward = input.latest === true || input.beforeSequence !== undefined
  if (backward ? page.nextAfterSequence !== null : page.nextBeforeSequence !== null) return fail()
  if (page.nextAfterSequence !== null && (!page.events.length || page.nextAfterSequence !== previous) ||
      page.nextBeforeSequence !== null && (!page.events.length || page.nextBeforeSequence !== (page.events[0] as AgentMuxMessageEvent).sequence)) return fail()
  return page as unknown as AgentMuxMessageEventsPage
}
