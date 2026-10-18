import { AgentMuxError } from './errors.js'
import { parseAgentExternalMessageAuthor, type AgentExternalMessageAuthor } from './external-author.js'
import type { AgentMuxMessageTarget } from './control.js'
import { channelActorKey, parseChannelActorProfileObservation, type ChannelActorProfileObservation } from './channel-profile.js'

export type AgentMuxMessageIdentity =
  | AgentExternalMessageAuthor
  | { readonly kind: 'agent-session'; readonly agentSessionId: string }
  /** Unattributed local ingress. The established wire kind does not authenticate a human;
   * principal records the transport and must never be displayed as participant identity. */
  | { readonly kind: 'human'; readonly principal: 'local-cli' }

export type AgentMuxMessageRecipient =
  | { readonly kind: 'agent-session'; readonly agentSessionId: string }
  | { readonly kind: 'target'; readonly target: AgentMuxMessageTarget }

/** Versioned A2A facts. The body is intentionally opaque and retained byte-for-byte as a string. */
export type AgentMuxMessageEnvelope = {
  readonly schema: 'agentmux.a2a.v1'
  readonly messageId: string
  readonly operationId: string
  readonly createdAt: number
  readonly sender: AgentMuxMessageIdentity
  readonly recipient: AgentMuxMessageRecipient
  readonly threadId: string
  readonly correlationId: string
  readonly replyTo: string | null
  readonly workspaceId: string | null
  readonly senderSessionId: string | null
  readonly senderRunId: string | null
  readonly recipientSessionId: string | null
  readonly recipientRunId: string | null
  readonly body: string
  /** Frozen reading metadata, independent of the sender's original authorization. */
  readonly channelProfile?: ChannelActorProfileObservation
}

export function messageEnvelopeString(value: string, label: string): string {
  if (!value.trim() || /[\0\r\n]/u.test(value)) throw new AgentMuxError(`${label} is invalid.`, 'MESSAGE_ENVELOPE_INVALID')
  return value
}

export function messageEnvelopeTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new AgentMuxError(`${label} is invalid.`, 'MESSAGE_ENVELOPE_INVALID')
  return value
}

function identity(value: AgentMuxMessageIdentity, label: string): AgentMuxMessageIdentity {
  if (value.kind === 'agent-session') return { kind: value.kind, agentSessionId: messageEnvelopeString(value.agentSessionId, label) }
  if (value.kind === 'human' && value.principal === 'local-cli') return value
  if (value.kind === 'external') return parseAgentExternalMessageAuthor(value)
  throw new AgentMuxError(`${label} is invalid.`, 'MESSAGE_ENVELOPE_INVALID')
}

function recipient(value: AgentMuxMessageRecipient): AgentMuxMessageRecipient {
  if (value.kind === 'agent-session') return { kind: value.kind, agentSessionId: messageEnvelopeString(value.agentSessionId, 'Message recipient') }
  if (value.kind === 'target') {
    const target = value.target
    if (target.kind === 'self') return { kind: 'target', target }
    if (target.kind === 'agent-session') return { kind: 'target', target: { kind: target.kind, agentSessionId: messageEnvelopeString(target.agentSessionId, 'Message recipient') } }
    if (target.kind === 'region') return { kind: 'target', target: { kind: target.kind, regionId: messageEnvelopeString(target.regionId, 'Message recipient') } }
    if (target.kind === 'tab') return { kind: 'target', target: { kind: target.kind, tabId: messageEnvelopeString(target.tabId, 'Message recipient') } }
  }
  throw new AgentMuxError('Message recipient is invalid.', 'MESSAGE_ENVELOPE_INVALID')
}

/** Validate an envelope crossing the control socket without deriving identity from UI facts. */
export function validateAgentMuxMessageEnvelope(value: unknown): AgentMuxMessageEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Message envelope is invalid.', 'MESSAGE_ENVELOPE_INVALID')
  const source = value as AgentMuxMessageEnvelope
  if (source.schema !== 'agentmux.a2a.v1') throw new AgentMuxError('Message envelope schema is invalid.', 'MESSAGE_ENVELOPE_INVALID')
  const messageId = messageEnvelopeString(source.messageId, 'Message id')
  const operationId = messageEnvelopeString(source.operationId, 'Message operation id')
  if (messageId === operationId) throw new AgentMuxError('Message id must not be the Control request id.', 'MESSAGE_ID_REQUEST_ID_COLLISION')
  if (typeof source.body !== 'string') throw new AgentMuxError('Message body is invalid.', 'MESSAGE_ENVELOPE_INVALID')
  const sender = identity(source.sender, 'Message sender')
  const channelProfile = source.channelProfile === undefined ? undefined : parseChannelActorProfileObservation(source.channelProfile)
  if (channelProfile && (sender.kind !== 'external' || channelActorKey(sender.actor) !== channelActorKey(channelProfile.actor))) throw new AgentMuxError('Channel display metadata names another actor.', 'MESSAGE_ENVELOPE_INVALID')
  const target = recipient(source.recipient)
  return Object.freeze({
    schema: source.schema,
    messageId,
    operationId,
    createdAt: messageEnvelopeTimestamp(source.createdAt, 'Message createdAt'),
    sender,
    recipient: target,
    threadId: messageEnvelopeString(source.threadId, 'Message thread id'),
    correlationId: messageEnvelopeString(source.correlationId, 'Message correlation id'),
    replyTo: source.replyTo === null ? null : messageEnvelopeString(source.replyTo, 'Message replyTo'),
    workspaceId: source.workspaceId === null ? null : messageEnvelopeString(source.workspaceId, 'Message workspace id'),
    senderSessionId: source.senderSessionId === null ? null : messageEnvelopeString(source.senderSessionId, 'Message sender session id'),
    senderRunId: source.senderRunId === null ? null : messageEnvelopeString(source.senderRunId, 'Message sender run id'),
    recipientSessionId: source.recipientSessionId === null ? null : messageEnvelopeString(source.recipientSessionId, 'Message recipient session id'),
    recipientRunId: source.recipientRunId === null ? null : messageEnvelopeString(source.recipientRunId, 'Message recipient run id'),
    body: source.body,
    ...(channelProfile ? { channelProfile } : {})
  })
}

