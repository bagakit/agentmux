import type { AgentSessionHistoryItem, AgentSessionHistorySource } from './types.js'
import type { ConversationInvocation, ConversationRecordProvenance, ConversationSelector } from './conversation-stream.js'
import { AgentMuxError } from './errors.js'
import { parseConversationLandmarkRef } from './conversation-landmarks.js'
import { validateAgentPromptInputKey } from './agent-prompt-condition.js'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Invalid recorded conversation provenance.', 'INVALID_CONVERSATION_PROVENANCE')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 16_384) throw new AgentMuxError('Invalid recorded conversation identity.', 'INVALID_CONVERSATION_PROVENANCE')
  return value
}
function invocationScope(value: unknown): Omit<ConversationInvocation, 'callId'> {
  const p = object(value), source = object(p.source), scope = object(p.scope)
  if (scope.kind !== 'session' && scope.kind !== 'turn') throw new AgentMuxError('Invalid recorded invocation scope.', 'INVALID_CONVERSATION_PROVENANCE')
  const child = p.subject === 'main' ? undefined : object(p.subject)
  if (child && child.kind !== 'child') throw new AgentMuxError('Invalid recorded invocation subject.', 'INVALID_CONVERSATION_PROVENANCE')
  return { source: { providerId: text(source.providerId), nativeSessionId: text(source.nativeSessionId) },
    subject: child ? { kind: 'child', nativeActorId: text(child.nativeActorId) } : 'main',
    scope: scope.kind === 'session' ? { kind: 'session' } : { kind: 'turn', nativeTurnId: text(scope.nativeTurnId) } }
}
export function parseConversationProvenance(value: unknown): ConversationRecordProvenance {
  const p = object(value)
  const native = p.nativeInput === undefined ? undefined : object(p.nativeInput)
  const source = native === undefined ? undefined : object(native.source)
  const adopted = p.adoptedInput === undefined ? undefined : object(p.adoptedInput)
  if (native && Object.keys(native).some(key => !['source', 'semanticItemId', 'turnId', 'clientCorrelation'].includes(key)) ||
      source && Object.keys(source).some(key => !['providerId', 'nativeSessionId'].includes(key)) ||
      adopted && (Object.keys(adopted).some(key => !['key', 'purpose'].includes(key)) || adopted.purpose !== undefined && adopted.purpose !== 'a2a-notification' || !native)) throw new AgentMuxError('Invalid native input provenance.', 'INVALID_CONVERSATION_PROVENANCE')
  if (p.invocations !== undefined && (!Array.isArray(p.invocations) || p.invocations.length > 4096)) throw new AgentMuxError('Invalid recorded invocation extent.', 'INVALID_CONVERSATION_PROVENANCE')
  const nativeScope = p.nativeInvocationScope === undefined ? undefined : invocationScope(p.nativeInvocationScope)
  return {
    ...(native && source ? { nativeInput: { source: { providerId: text(source.providerId), nativeSessionId: text(source.nativeSessionId) },
      semanticItemId: text(native.semanticItemId), turnId: text(native.turnId), clientCorrelation: text(native.clientCorrelation) } } : {}),
    ...(adopted ? { adoptedInput: { key: validateAgentPromptInputKey(adopted.key), ...(adopted.purpose === 'a2a-notification' ? { purpose: 'a2a-notification' as const } : {}) } } : {}),
    ...(nativeScope ? { nativeInvocationScope: { source: nativeScope.source, subject: nativeScope.subject, scope: nativeScope.scope } } : {}),
    ...(p.sameEvent === undefined ? {} : { sameEvent: parseConversationLandmarkRef(p.sameEvent) }),
    ...(p.observes === undefined ? {} : { observes: parseConversationLandmarkRef(p.observes) }),
    ...(p.invocations === undefined ? {} : { invocations: (p.invocations as unknown[]).map(value => {
      const fact = object(value), selector = object(fact.selector), original = object(fact.invocation)
      let selected: ConversationSelector
      if (selector.kind === 'native-part' && Number.isSafeInteger(selector.partIndex) && Number(selector.partIndex) >= 0) selected = { kind: 'native-part', partIndex: Number(selector.partIndex) }
      else if (selector.kind === 'captured-field' && ['content', 'toolInput', 'toolOutput'].includes(String(selector.field))) selected = { kind: 'captured-field', field: selector.field as 'content' | 'toolInput' | 'toolOutput' }
      else throw new AgentMuxError('Invalid recorded content selector.', 'INVALID_CONVERSATION_PROVENANCE')
      const invocation: ConversationInvocation = { ...invocationScope(original), callId: text(original.callId) }
      return { selector: selected, invocation }
    }) })
  }
}

/** Optional reading metadata cannot consume the original body when its shape is unavailable. */
export function conversationProvenanceFields(value: { conversation?: unknown; conversationDiagnostic?: unknown }): Pick<AgentSessionHistoryItem, 'conversation' | 'conversationDiagnostic'> {
  if (value.conversation === undefined) return value.conversationDiagnostic === undefined ? {} : { conversationDiagnostic: value.conversationDiagnostic as NonNullable<AgentSessionHistoryItem['conversationDiagnostic']> }
  try { return { conversation: parseConversationProvenance(value.conversation),
    ...(value.conversationDiagnostic === undefined ? {} : { conversationDiagnostic: value.conversationDiagnostic as NonNullable<AgentSessionHistoryItem['conversationDiagnostic']> }) } }
  catch (error) {
    if (!(error instanceof AgentMuxError)) throw error
    return { conversationDiagnostic: { code: error.code, message: error.message, original: value.conversation } }
  }
}

/** Called only by Providers whose native protocol scopes call IDs to this native Session. */
export function nativeConversationProvenance(parts: readonly { kind: string; callId?: string }[], source: AgentSessionHistorySource): ConversationRecordProvenance | undefined {
  return parts.some(part => (part.kind === 'tool-call' || part.kind === 'tool-result') && part.callId)
    ? { nativeInvocationScope: { source, subject: 'main', scope: { kind: 'session' } } } : undefined
}
