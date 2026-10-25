import type { AgentExternalConversationAuthorityPort } from './external-conversation.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConnectionActor } from './room-binding-codec.js'
import type { ConnectionActor } from './connections-contract.js'
import type { AgentMuxAgentInteractionInput, AgentMuxSessionQuestionReplyInput } from './client.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { agentInteractionRequestTarget } from './agent-interaction-state.js'

/** Original semantic owners, never an endpoint, credential or reusable input grant. */
export type AgentExternalAuthoritySource = { hostingRuntimeId: string; executionRuntimeId: string }
export function parseAgentExternalAuthoritySource(value: unknown): AgentExternalAuthoritySource {
  const source = rpcRecord(value, ['hostingRuntimeId', 'executionRuntimeId'], 'INVALID_EXTERNAL_AUTHOR')
  for (const id of [source.hostingRuntimeId, source.executionRuntimeId]) {
    if (typeof id !== 'string' || !id.trim() || id.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(id)) throw new AgentMuxError('External authority source is malformed.', 'INVALID_EXTERNAL_AUTHOR')
  }
  return { hostingRuntimeId: source.hostingRuntimeId as string, executionRuntimeId: source.executionRuntimeId as string }
}

/** Recorded external attribution, never a serialized authorization or a local human identity. */
export type AgentExternalMessageAuthor = {
  kind: 'external'
  connectionId: string
  actor: ConnectionActor
  externalConversationId: string
  externalMessageId: string
  bindingId: string
  bindingRevision: number
  grantId: string
  grantRevision: number
  /** Absence is the original room reference; application grants have an explicit source. */
  grantSource?: 'application'
  authoritySource?: AgentExternalAuthoritySource
}
export type AgentExternalInputIntent = {
  agentSessionId: string; expectedRun: { runId: string }; operationId: string; messageId: string; body: string
  admissionIntent?: import('./agent-prompt-condition.js').AgentPromptAdmissionIntent
  channelQuote?: import('./channel-quote.js').ChannelTranscriptQuote
}

/** Original Host-owned claim/current-authority reader. Never serialized or inferred from a wire author. */
export interface AgentExternalInputAuthorityPort extends Partial<AgentExternalConversationAuthorityPort> {
  assertCurrent(author: AgentExternalMessageAuthor, intent: AgentExternalInputIntent): void | Promise<void>
  /** The same original intake authority, with a distinct exact interaction intent. */
  assertInteractionCurrent?(author: AgentExternalInteractionAuthor, intent: AgentMuxAgentInteractionInput): void | Promise<void>
  assertQuestionCurrent?(author: AgentExternalInteractionAuthor, intent: AgentMuxSessionQuestionReplyInput): void | Promise<void>
}

/** Platform attribution is not permission; the executing Host resolves its original durable claim. */
export type AgentExternalInteractionAuthor = {
  kind: 'external-action'
  connectionId: string
  actor: ConnectionActor
  externalConversationId: string
  sourceMessageId: string
  actionRef: string
  bindingId: string
  bindingRevision: number
  grantId: string
  grantRevision: number
  /** Absence is the original room reference; application grants have an explicit source. */
  grantSource?: 'application'
  authoritySource?: AgentExternalAuthoritySource
}

export function parseAgentExternalInteractionAuthor(value: unknown): AgentExternalInteractionAuthor {
  const p = rpcRecord(value, ['kind', 'connectionId', 'actor', 'externalConversationId', 'sourceMessageId', 'actionRef', 'bindingId', 'bindingRevision', 'grantId', 'grantRevision', 'grantSource', 'authoritySource'], 'INVALID_EXTERNAL_AUTHOR')
  const fail = (): never => { throw new AgentMuxError('External interaction attribution is malformed.', 'INVALID_EXTERNAL_AUTHOR') }
  const text = (v: unknown): string => { if (typeof v !== 'string' || !v.trim() || v.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(v)) fail(); return v as string }
  const revision = (v: unknown): number => { if (!Number.isSafeInteger(v) || Number(v) < 1) fail(); return v as number }
  if (p.kind !== 'external-action' || p.grantSource !== undefined && p.grantSource !== 'application') fail()
  return { kind: 'external-action', connectionId: text(p.connectionId), actor: parseConnectionActor(p.actor), externalConversationId: text(p.externalConversationId), sourceMessageId: text(p.sourceMessageId), actionRef: text(p.actionRef), bindingId: text(p.bindingId), bindingRevision: revision(p.bindingRevision), grantId: text(p.grantId), grantRevision: revision(p.grantRevision), ...(p.grantSource === undefined ? {} : { grantSource: 'application' as const }), ...(p.authoritySource === undefined ? {} : { authoritySource: parseAgentExternalAuthoritySource(p.authoritySource) }) }
}

/** Exact machine intent correlation. Mutable observations and JSON key order cannot change the original target. */
function canonicalDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).filter(([, child]) => child !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : item
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)))
  return Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
export function agentInteractionRequestDigest(request: import('./types.js').AgentMuxInteractionRequest): string { return canonicalDigest(agentInteractionRequestTarget(request)) }
export function agentInteractionIntentDigest(input: AgentMuxAgentInteractionInput): string {
  return canonicalDigest({ agentSessionId: input.agentSessionId, expectedRun: input.expectedRun,
    operationId: input.operationId, expectedRequest: agentInteractionRequestTarget(input.expectedRequest), response: input.response })
}

/** A historical question answer retains its exact source, predecessor and authored answers. */
export function agentQuestionReplyIntentDigest(input: AgentMuxSessionQuestionReplyInput): string {
  return canonicalDigest({ agentSessionId: input.agentSessionId, expectedRun: input.expectedRun,
    afterSubmissionId: input.afterSubmissionId, operationId: input.operationId, source: input.source,
    turnId: input.turnId, recordId: input.recordId, answers: input.answers.map(({ questionId, answer }) => ({ questionId, answer })) })
}

export function parseAgentExternalMessageAuthor(value: unknown): AgentExternalMessageAuthor {
  const p = rpcRecord(value, ['kind', 'connectionId', 'actor', 'externalConversationId', 'externalMessageId', 'bindingId', 'bindingRevision', 'grantId', 'grantRevision', 'grantSource', 'authoritySource'], 'INVALID_EXTERNAL_AUTHOR')
  const fail = (): never => { throw new AgentMuxError('External attribution is malformed.', 'INVALID_EXTERNAL_AUTHOR') }
  const text = (v: unknown): string => { if (typeof v !== 'string' || !v.trim() || v.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(v)) fail(); return v as string }
  const revision = (v: unknown): number => { if (!Number.isSafeInteger(v) || Number(v) < 1) fail(); return v as number }
  if (p.kind !== 'external' || p.grantSource !== undefined && p.grantSource !== 'application') fail()
  return { kind: 'external', connectionId: text(p.connectionId), actor: parseConnectionActor(p.actor), externalConversationId: text(p.externalConversationId), externalMessageId: text(p.externalMessageId), bindingId: text(p.bindingId), bindingRevision: revision(p.bindingRevision), grantId: text(p.grantId), grantRevision: revision(p.grantRevision), ...(p.grantSource === undefined ? {} : { grantSource: 'application' as const }), ...(p.authoritySource === undefined ? {} : { authoritySource: parseAgentExternalAuthoritySource(p.authoritySource) }) }
}
