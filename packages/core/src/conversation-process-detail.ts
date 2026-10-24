import type { AgentSessionHistoryContentPart, AgentSessionHistoryItem, AgentTimelineItem } from './types.js'
import type { ConversationSourceRecord } from './conversation-stream.js'
import { conversationRevision } from './conversation-stream.js'

/** A reading header, never a complete original record or an execution receipt. */
export type ConversationProcessPart = (
  | { kind: 'text' }
  | { kind: 'reasoning'; redacted?: boolean }
  | { kind: 'tool-call'; name: string; callId?: string }
  | { kind: 'tool-result'; name?: string; callId?: string; failed?: boolean }
  | { kind: 'resource'; resourceType: Extract<AgentSessionHistoryContentPart, { kind: 'resource' }>['resourceType']; label?: string;
      content?: NonNullable<Extract<AgentSessionHistoryContentPart, { kind: 'resource' }>['content']> }
) & Pick<AgentSessionHistoryContentPart, 'contentEligibility' | 'contentRole'>
export type ConversationProcessHeader =
  | { kind: 'native'; item: Pick<AgentSessionHistoryItem, 'id' | 'kind' | 'turnId' | 'title' | 'startedAt' | 'completedAt' | 'conversation' | 'metrics' | 'metricsDiagnostic'>;
      parts: ConversationProcessPart[]; collaboration?: AgentSessionHistoryItem['collaboration'] }
  | { kind: 'captured'; item: Pick<AgentTimelineItem, 'id' | 'agentSessionId' | 'kind' | 'status' | 'source' | 'createdAt' | 'updatedAt' | 'title' | 'toolName' | 'eventName' | 'activityState' | 'conversation' | 'authorAgentSessionId' | 'authorHuman' | 'authorExternal' | 'sourceChannel'>;
      fields: Array<'content' | 'toolInput' | 'toolOutput'> }
export type ConversationDeferredRecord = Omit<ConversationSourceRecord, 'original'> & {
  original: { kind: 'deferred'; item: ConversationProcessHeader }
  /** Integrity of this distinct header representation, not the original body revision. */
  summaryRevision: string
}
export type ConversationReadRecord = ConversationSourceRecord | ConversationDeferredRecord
export function isCompleteConversationRecord(record: ConversationReadRecord): record is ConversationSourceRecord { return record.original.kind !== 'deferred' }

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]])) as Pick<T, K>
}
export function deferConversationProcessRecord(record: ConversationSourceRecord): ConversationDeferredRecord {
  const original = record.original
  let header: ConversationProcessHeader
  if (original.kind === 'native') {
    const item = original.item, collaboration = item.collaboration
    header = { kind: 'native', item: pick(item, ['id', 'kind', 'turnId', 'title', 'startedAt', 'completedAt', 'conversation', 'metrics', 'metricsDiagnostic']),
      parts: item.contentParts.map(part => part.kind === 'tool-call' ? pick(part, ['kind', 'name', 'callId', 'contentEligibility', 'contentRole'])
        : part.kind === 'tool-result' ? pick(part, ['kind', 'name', 'callId', 'failed', 'contentEligibility', 'contentRole'])
        : part.kind === 'reasoning' ? pick(part, ['kind', 'redacted', 'contentEligibility', 'contentRole'])
        : part.kind === 'resource' ? pick(part, ['kind', 'resourceType', 'label', 'content', 'contentEligibility', 'contentRole']) : pick(part, ['kind', 'contentEligibility', 'contentRole'])),
      ...(collaboration ? { collaboration: collaboration.kind === 'operation'
        ? (({ prompt: _prompt, ...operation }) => ({ ...operation, agentStates: operation.agentStates.map(({ message: _message, ...state }) => state) }))(collaboration)
        : collaboration } : {}) }
  } else header = { kind: 'captured', item: pick(original.item, ['id', 'agentSessionId', 'kind', 'status', 'source', 'createdAt', 'updatedAt', 'title', 'toolName', 'eventName', 'activityState', 'conversation', 'authorAgentSessionId', 'authorHuman', 'authorExternal', 'sourceChannel']),
    fields: (['content', 'toolInput', 'toolOutput'] as const).filter(field => original.item[field] !== undefined) }
  // JSON also drops optional undefined properties from collaboration metadata.
  header = JSON.parse(JSON.stringify(header)) as ConversationProcessHeader
  return { id: record.id, reference: record.reference, revision: record.revision, order: record.order,
    original: { kind: 'deferred', item: header }, summaryRevision: conversationRevision(header) }
}

/** Internal semantic witness only. Empty slots preserve presence and typed invocation
 * facts for the existing validator; this value is never emitted as an original. */
export function conversationProcessWitness(record: ConversationDeferredRecord): ConversationSourceRecord {
  const header = record.original.item
  const original: ConversationSourceRecord['original'] = header.kind === 'native'
    ? { kind: 'native', item: { ...header.item, ...(header.collaboration ? { collaboration: header.collaboration } : {}),
      contentParts: header.parts.map(part => part.kind === 'text' ? { ...part, text: '' }
        : part.kind === 'reasoning' ? { ...part, text: '' }
        : part.kind === 'tool-call' ? { ...part, input: '' }
        : part.kind === 'tool-result' ? { ...part, output: '' }
        : { ...part, reference: 'deferred-content' }) } }
    : { kind: 'captured', item: { ...header.item, ...Object.fromEntries(header.fields.map(field => [field, ''])) } }
  return { id: record.id, reference: record.reference, revision: record.revision, order: record.order, original }
}
