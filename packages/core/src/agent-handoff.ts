import type { AgentMuxMessageEnvelope } from './agent-global-message-queue.js'
import { AgentMuxError } from './errors.js'

/** A caller's declared communication handoff; this does not transfer an external Task. */
export type HandoffResult = {
  readonly ownerAgentSessionId: string
  readonly originAwaits: false
  readonly taskId: string
  readonly at: number
}

export function handOff(input: {
  fromAgentSessionId: string
  toAgentSessionId: string
  taskId: string
  at: number
}): HandoffResult {
  return Object.freeze({
    ownerAgentSessionId: input.toAgentSessionId,
    originAwaits: false as const,
    taskId: input.taskId,
    at: input.at
  })
}

export type DispatchEventKind = 'question' | 'escalation' | 'worker_done' | 'cleanup'

export type DispatchEvent = {
  readonly kind: DispatchEventKind
  /** The actual reply is the event identity; separate questions remain separate events. */
  readonly replyMessageId: string
  readonly at: number
}

/** Communication supervision only. Delivery/consumption never settles this waiting fact. */
export type Dispatch = {
  readonly sourceMessageId: string
  readonly ownerAgentSessionId: string
  readonly workerAgentSessionId: string
  readonly threadId: string
  readonly openedAt: number
  readonly originAwaits: boolean
  readonly events: readonly DispatchEvent[]
}

export function assertDispatchEventKind(value: unknown): asserts value is DispatchEventKind {
  if (value !== 'question' && value !== 'escalation' && value !== 'worker_done' && value !== 'cleanup') {
    throw new AgentMuxError('Dispatch event kind is invalid.', 'DISPATCH_MESSAGE_INVALID')
  }
}

/** These are envelope facts, not authentication. The public Client separately admits the caller. */
export function assertDispatchMessage(message: AgentMuxMessageEnvelope): void {
  if (message.sender.kind !== 'agent-session' || message.recipient.kind !== 'agent-session' ||
    message.sender.agentSessionId !== message.senderSessionId ||
    message.recipient.agentSessionId !== message.recipientSessionId ||
    message.senderRunId === null || message.recipientRunId === null) {
    throw new AgentMuxError('Dispatch requires resolved Agent-authored Session/Run message facts.', 'DISPATCH_MESSAGE_INVALID')
  }
}

export function openDispatch(source: AgentMuxMessageEnvelope, at: number): Dispatch {
  assertDispatchMessage(source)
  return Object.freeze({
    sourceMessageId: source.messageId,
    ownerAgentSessionId: source.senderSessionId!,
    workerAgentSessionId: source.recipientSessionId!,
    threadId: source.threadId,
    openedAt: at,
    originAwaits: true,
    events: Object.freeze([])
  })
}

export function recordDispatchEvent(
  dispatch: Dispatch,
  reply: AgentMuxMessageEnvelope,
  kind: DispatchEventKind,
  at: number
): Dispatch {
  assertDispatchEventKind(kind)
  assertDispatchMessage(reply)
  const sender = kind === 'cleanup' ? dispatch.ownerAgentSessionId : dispatch.workerAgentSessionId
  const recipient = kind === 'cleanup' ? dispatch.workerAgentSessionId : dispatch.ownerAgentSessionId
  if (reply.replyTo !== dispatch.sourceMessageId || reply.threadId !== dispatch.threadId ||
    reply.senderSessionId !== sender || reply.recipientSessionId !== recipient) {
    throw new AgentMuxError('Dispatch reply does not match its source, thread and participants.', 'DISPATCH_MESSAGE_INVALID')
  }
  const existing = dispatch.events.find((event) => event.replyMessageId === reply.messageId)
  if (existing) {
    if (existing.kind !== kind) throw new AgentMuxError('Dispatch reply already names a different event kind.', 'DISPATCH_EVENT_CONFLICT')
    return dispatch
  }
  return Object.freeze({
    ...dispatch,
    originAwaits: kind === 'worker_done' ? false : dispatch.originAwaits,
    events: Object.freeze([...dispatch.events, Object.freeze({ kind, replyMessageId: reply.messageId, at })])
  })
}
