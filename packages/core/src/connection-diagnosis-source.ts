import { sha256 } from '@noble/hashes/sha2.js'
import type { ConversationCheckpoint } from './conversation-changes.js'
import type { ConversationItemRef, ConversationRef } from './conversation.js'
import { conversationRecordId, type ConversationContentRef, type ConversationSourceRef } from './conversation-stream.js'

/** Original Core reader codes admitted at the cross-Session diagnostic edge. Never exception text. */
export const connectionDiagnosisSourceCodes = [
  'AGENT_CONVERSATION_SOURCE_UNAVAILABLE', 'AGENT_CONVERSATION_READ_CUT_UNAVAILABLE',
  'AGENT_CONVERSATION_VERSION_UNAVAILABLE', 'AGENT_CONVERSATION_CAPTURED_GAP',
  'AGENT_CONVERSATION_CHANGES_UNSUPPORTED', 'AGENT_CONVERSATION_NATIVE_UNAVAILABLE',
  'AGENT_SESSION_HISTORY_SOURCE_CHANGED', 'AGENT_SESSION_HISTORY_INVALID_CURSOR',
  'AGENT_SESSION_HISTORY_TIMEOUT', 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT',
  'AGENT_SESSION_HISTORY_TOO_LARGE', 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE',
  'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE',
  'CONVERSATION_AUTHOR_CONFLICT', 'CONVERSATION_INPUT_ADOPTION_AMBIGUOUS',
  'CONVERSATION_INPUT_ADOPTION_COVERAGE_UNKNOWN', 'CONVERSATION_INPUT_ADOPTION_UNCONFIRMED', 'CONVERSATION_RELATION_CYCLE',
  'CONVERSATION_SOURCE_HOST_CONFLICT', 'CONVERSATION_RELATION_SCOPE', 'CONVERSATION_ANCHOR_UNREAD',
  'CONVERSATION_OBSERVED_TARGET_UNREAD', 'CONVERSATION_QUESTION_TARGET_UNREAD', 'CONVERSATION_ORDER_CONFLICT',
  'PUBLICATION_REPRESENTATION_RELATION_UNCONFIRMED'
] as const
export type ConnectionDiagnosisSourceCode = typeof connectionDiagnosisSourceCodes[number]
export const connectionDiagnosisSourceCode = (value: unknown): ConnectionDiagnosisSourceCode | null => connectionDiagnosisSourceCodes.find(code => code === value) ?? null
export type ConnectionDeliverySourceObservation = {
  state: 'ready' | 'unavailable'
  reason?: 'source-unconfirmed' | 'source-gap' | 'storage-unconfirmed'
  code: ConnectionDiagnosisSourceCode | null
  codeRecorded: boolean
  /** Fingerprint of the original attempted/committed cut, never a resumable cursor or proof of delivery. */
  checkpointKey: string | null
}
/** Diagnostic equality only. These fingerprints grant no read, sharing, retry or ordering authority. */
export function connectionDiagnosisCheckpointKey(checkpoint: ConversationCheckpoint): string { return hash(['checkpoint', checkpoint]) }
export function connectionDiagnosisEventKey(record: ConversationItemRef, event: { id: string; revision: string }): string {
  return hash(['event', connectionDiagnosisRecordKey(record), event.id, event.revision])
}
function hash(value: unknown): string {
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify(['connection-diagnosis-v1', value]))), byte => byte.toString(16).padStart(2, '0')).join('')
}
export function connectionDiagnosisRecordKey(record: ConversationItemRef): string { return hash(['record', conversationRecordId(record)]) }
export function connectionDiagnosisSourceKey(reference: ConversationRef, source: ConversationSourceRef | ConversationItemRef['source']): string {
  return hash(['source', reference.hostId ?? null, reference.agentSessionId, source.kind,
    source.kind === 'native' ? [source.providerId, source.nativeSessionId] : source.kind === 'native-unavailable' ? source.providerId : 'epoch' in source ? source.epoch ?? null : null])
}
export function connectionDiagnosisPartKey(part: ConversationContentRef): string {
  return hash(['part', connectionDiagnosisRecordKey(part.record), part.recordRevision, part.selector.kind,
    part.selector.kind === 'native-part' ? part.selector.partIndex : part.selector.field])
}
