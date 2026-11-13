import { AgentMuxError } from './errors.js'
import { agentCreationIntentDigest } from './agent-creation-authority.js'
import { validateAgentMuxMessageEnvelope, type AgentMuxMessageEnvelope } from './agent-message-envelope.js'
import { normalizeMessageChannel } from './message-origin.js'
import type { AgentMessageChannel } from './types.js'
import type { AgentMuxCreationAuthorityIdentity, AgentMuxCreationTrust, AgentMuxCreationTrustInput } from './agent-creation-admission.js'
import { assertDispatchEventKind, type DispatchEventKind } from './agent-handoff.js'

export type AgentMuxMessageAuthorityIdentity = AgentMuxCreationAuthorityIdentity
export type AgentMuxMessageTrustInput = AgentMuxCreationTrustInput
export type AgentMuxMessageTrust = AgentMuxCreationTrust & { purpose: 'agent-message' }
export type AgentMuxMessageParticipant = { runtimeId: string; agentSessionId: string; runId: string }
export type AgentMuxMessageProvenance = {
  schema: 'agentmux.agent-message-admission.v1'; purpose: 'agent-message';
  source: AgentMuxMessageParticipant; target: AgentMuxMessageParticipant; intentDigest: string; signature: string
  sourceKeyFingerprint: string; targetKeyFingerprint: string
}
export type AgentMuxSignedMessage = { envelope: AgentMuxMessageEnvelope; execution: 'default'; sourceChannel: AgentMessageChannel; provenance: AgentMuxMessageProvenance }
export type AgentMuxMessageReadAuthority = {
  schema: 'agentmux.agent-message-read.v1'; purpose: 'agent-message'; source: AgentMuxMessageParticipant;
  reader: { kind: 'host' } | { kind: 'agent'; agentSessionId: string; runId: string };
  targetRuntimeId: string; sourceMessageId: string; sourceIntentDigest: string; signature: string
  sourceKeyFingerprint: string; targetKeyFingerprint: string
}
export type AgentMuxSignedDispatchEvent = { schema: 'agentmux.agent-dispatch-event.v1'; sourceMessageId: string; replyMessageId: string;
  sourceIntentDigest: string; replyIntentDigest: string; kind: DispatchEventKind; at: number; provenance: AgentMuxMessageProvenance }
export type AgentMuxDispatchEventSubmission = { kind: 'dispatch-event-submission'; sourceMessageId: string; replyMessageId: string;
  event: AgentMuxSignedDispatchEvent; diskDurability: 'confirmed' }
export type AgentMuxRecipientInboxReceipt = { kind: 'recipient-inbox'; runtimeId: string; keyFingerprint: string; messageId: string;
  operationId: string; intentDigest: string; sequence: number; deliveryMode: 'reference'; diskDurability: 'confirmed' }
export type AgentMuxFederatedThread = { source: AgentMuxSignedMessage; replies: AgentMuxSignedMessage[]; dispatchEvents?: AgentMuxSignedDispatchEvent[]; sourceReceipt?: AgentMuxRecipientInboxReceipt }
export type AgentMuxMessageTransport = { state: 'outbox' | 'received'; targetRuntimeId: string }

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}
function invalid(): never { throw new AgentMuxError('The exact signed message authority is invalid. Original messages and Agents are retained.', 'AGENT_MESSAGE_AUTHORITY_INVALID') }
function id(value: unknown): string { if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) invalid(); return value }
function fingerprint(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid(); return value }
export function parseMessageParticipant(value: unknown): AgentMuxMessageParticipant {
  const p = object(value, ['runtimeId', 'agentSessionId', 'runId'])
  return { runtimeId: id(p.runtimeId), agentSessionId: id(p.agentSessionId), runId: id(p.runId) }
}
export function parseMessageProvenance(value: unknown): AgentMuxMessageProvenance {
  const p = object(value, ['schema', 'purpose', 'source', 'target', 'intentDigest', 'signature', 'sourceKeyFingerprint', 'targetKeyFingerprint'])
  if (p.schema !== 'agentmux.agent-message-admission.v1' || p.purpose !== 'agent-message' || typeof p.intentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(p.intentDigest) || typeof p.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(p.signature)) invalid()
  return { schema: p.schema, purpose: p.purpose, source: parseMessageParticipant(p.source), target: parseMessageParticipant(p.target), sourceKeyFingerprint: fingerprint(p.sourceKeyFingerprint), targetKeyFingerprint: fingerprint(p.targetKeyFingerprint), intentDigest: p.intentDigest, signature: p.signature }
}
export function parseMessageReadAuthority(value: unknown): AgentMuxMessageReadAuthority {
  const p = object(value, ['schema', 'purpose', 'source', 'reader', 'targetRuntimeId', 'sourceMessageId', 'sourceIntentDigest', 'signature', 'sourceKeyFingerprint', 'targetKeyFingerprint'])
  if (p.schema !== 'agentmux.agent-message-read.v1' || p.purpose !== 'agent-message' || typeof p.sourceIntentDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(p.sourceIntentDigest) || typeof p.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(p.signature)) invalid()
  const r = object(p.reader, ['kind', 'agentSessionId', 'runId'])
  if (r.kind !== 'host' && r.kind !== 'agent' || r.kind === 'host' && Object.keys(r).length !== 1) invalid()
  const reader: AgentMuxMessageReadAuthority['reader'] = r.kind === 'host' ? { kind: 'host' } : { kind: 'agent', agentSessionId: id(r.agentSessionId), runId: id(r.runId) }
  return { schema: p.schema, purpose: p.purpose, source: parseMessageParticipant(p.source), reader, sourceKeyFingerprint: fingerprint(p.sourceKeyFingerprint), targetKeyFingerprint: fingerprint(p.targetKeyFingerprint), targetRuntimeId: id(p.targetRuntimeId), sourceMessageId: id(p.sourceMessageId), sourceIntentDigest: p.sourceIntentDigest, signature: p.signature }
}
export function messagePacketDigest(packet: Omit<AgentMuxSignedMessage, 'provenance'>): string { return agentCreationIntentDigest(packet) }
export function parseSignedMessage(value: unknown): AgentMuxSignedMessage {
  const p = object(value, ['envelope', 'execution', 'sourceChannel', 'provenance'])
  if (p.execution !== 'default') invalid()
  const envelope = validateAgentMuxMessageEnvelope(p.envelope), provenance = parseMessageProvenance(p.provenance)
  const sourceChannel = normalizeMessageChannel(p.sourceChannel)
  if (envelope.sender.kind !== 'agent-session' || envelope.recipient.kind !== 'agent-session' ||
      envelope.sender.agentSessionId !== provenance.source.agentSessionId || envelope.senderSessionId !== provenance.source.agentSessionId || envelope.senderRunId !== provenance.source.runId || envelope.senderRuntimeId !== provenance.source.runtimeId ||
      envelope.recipient.agentSessionId !== provenance.target.agentSessionId || envelope.recipientSessionId !== provenance.target.agentSessionId || envelope.recipientRunId !== provenance.target.runId || envelope.recipientRuntimeId !== provenance.target.runtimeId ||
      messagePacketDigest({ envelope, execution: 'default', sourceChannel }) !== provenance.intentDigest) invalid()
  return { envelope, execution: 'default', sourceChannel, provenance }
}
export function dispatchEventDigest(value: Omit<AgentMuxSignedDispatchEvent, 'provenance'>): string { return agentCreationIntentDigest(value) }
export function parseSignedDispatchEvent(value: unknown): AgentMuxSignedDispatchEvent {
  const p = object(value, ['schema', 'sourceMessageId', 'replyMessageId', 'sourceIntentDigest', 'replyIntentDigest', 'kind', 'at', 'provenance'])
  if (p.schema !== 'agentmux.agent-dispatch-event.v1' || typeof p.at !== 'number' || !Number.isFinite(p.at) || p.at < 0) invalid()
  assertDispatchEventKind(p.kind)
  const payload = { schema: 'agentmux.agent-dispatch-event.v1' as const, sourceMessageId: id(p.sourceMessageId), replyMessageId: id(p.replyMessageId),
    sourceIntentDigest: fingerprint(p.sourceIntentDigest), replyIntentDigest: fingerprint(p.replyIntentDigest), kind: p.kind, at: p.at }
  const provenance = parseMessageProvenance(p.provenance)
  if (dispatchEventDigest(payload) !== provenance.intentDigest) invalid()
  return { ...payload, provenance }
}
export function assertSignedDispatchLineage(source: AgentMuxSignedMessage, reply: AgentMuxSignedMessage, value: AgentMuxSignedDispatchEvent): void {
  const event = parseSignedDispatchEvent(value), cleanup = event.kind === 'cleanup'
  const actor = cleanup ? source.provenance.source : source.provenance.target, peer = cleanup ? source.provenance.target : source.provenance.source
  const actorKey = cleanup ? source.provenance.sourceKeyFingerprint : source.provenance.targetKeyFingerprint
  const peerKey = cleanup ? source.provenance.targetKeyFingerprint : source.provenance.sourceKeyFingerprint
  const same = (left: AgentMuxMessageParticipant, right: AgentMuxMessageParticipant) => left.runtimeId === right.runtimeId && left.agentSessionId === right.agentSessionId && left.runId === right.runId
  if (event.sourceMessageId !== source.envelope.messageId || event.replyMessageId !== reply.envelope.messageId ||
    event.sourceIntentDigest !== source.provenance.intentDigest || event.replyIntentDigest !== reply.provenance.intentDigest ||
    reply.envelope.replyTo !== source.envelope.messageId || reply.envelope.threadId !== source.envelope.threadId ||
    !same(reply.provenance.source, actor) || !same(reply.provenance.target, peer) || !same(event.provenance.source, actor) || !same(event.provenance.target, peer) ||
    event.provenance.sourceKeyFingerprint !== actorKey || event.provenance.targetKeyFingerprint !== peerKey) invalid()
}
export function parseFederatedThread(value: unknown): AgentMuxFederatedThread {
  const p = object(value, ['source', 'replies', 'dispatchEvents', 'sourceReceipt']), source = parseSignedMessage(p.source)
  if (!Array.isArray(p.replies)) invalid()
  const replies = p.replies.map(parseSignedMessage), byId = new Map<string, AgentMuxSignedMessage>()
  const same = (left: AgentMuxMessageParticipant, right: AgentMuxMessageParticipant) => left.runtimeId === right.runtimeId && left.agentSessionId === right.agentSessionId && left.runId === right.runId
  for (const reply of replies) {
    if (reply.envelope.messageId === source.envelope.messageId || byId.has(reply.envelope.messageId) || reply.envelope.threadId !== source.envelope.threadId ||
      !(same(reply.provenance.source, source.provenance.source) && same(reply.provenance.target, source.provenance.target) || same(reply.provenance.source, source.provenance.target) && same(reply.provenance.target, source.provenance.source))) invalid()
    byId.set(reply.envelope.messageId, reply)
  }
  for (const reply of replies) {
    const seen = new Set<string>(); let cursor = reply
    while (cursor.envelope.replyTo !== source.envelope.messageId) {
      if (seen.has(cursor.envelope.messageId) || !cursor.envelope.replyTo) invalid()
      seen.add(cursor.envelope.messageId)
      const parent = byId.get(cursor.envelope.replyTo)
      if (!parent) invalid()
      cursor = parent
    }
  }
  if (p.dispatchEvents !== undefined && !Array.isArray(p.dispatchEvents)) invalid()
  const dispatchEvents = (p.dispatchEvents as unknown[] | undefined)?.map(parseSignedDispatchEvent)
  for (const event of dispatchEvents ?? []) {
    const reply = byId.get(event.replyMessageId)
    if (!reply) invalid()
    assertSignedDispatchLineage(source, reply, event)
  }
  const sourceReceipt = p.sourceReceipt === undefined ? undefined : parseRecipientInboxReceipt(p.sourceReceipt, source)
  return { source, replies, ...(dispatchEvents === undefined ? {} : { dispatchEvents }), ...(sourceReceipt ? { sourceReceipt } : {}) }
}
export function parseRecipientInboxReceipt(value: unknown, source: AgentMuxSignedMessage): AgentMuxRecipientInboxReceipt {
  const p = object(value, ['kind', 'runtimeId', 'keyFingerprint', 'messageId', 'operationId', 'intentDigest', 'sequence', 'deliveryMode', 'diskDurability'])
  if (p.kind !== 'recipient-inbox' || p.deliveryMode !== 'reference' || p.diskDurability !== 'confirmed' ||
    p.runtimeId !== source.provenance.target.runtimeId || p.keyFingerprint !== source.provenance.targetKeyFingerprint || p.messageId !== source.envelope.messageId ||
    p.operationId !== source.envelope.operationId || p.intentDigest !== source.provenance.intentDigest || !Number.isSafeInteger(p.sequence) || Number(p.sequence) < 1) invalid()
  return p as AgentMuxRecipientInboxReceipt
}
