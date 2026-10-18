import type { AgentSessionUserMessage } from './types.js'
import type { AgentInputMailboxItem } from './agent-input-mailbox.js'
import type { ConversationInputEntity } from './conversation.js'
import { recordedConversationAuthor } from './conversation-author.js'
import {
  conversationInputAdoptionEdges, conversationInputIdentity, conversationInputKey, conversationRecordAnchors,
  conversationRecordAuthor, conversationRecordId, conversationSameEventTarget, conversationValuesEqual,
  type ConversationAuthor, type ConversationInputRecord, type ConversationSourceRecord
} from './conversation-timeline.js'

export type SessionInputGroup = {
  id: string
  primary: AgentSessionUserMessage | null
  messages: readonly AgentSessionUserMessage[]
  mailbox: readonly AgentInputMailboxItem[]
  author: ConversationAuthor
}

/** Original typed attribution only; journal reading never authenticates an unknown sender. */
export function sessionInputMailboxAuthor(item: AgentInputMailboxItem): ConversationAuthor {
  if (item.kind === 'controlled') {
    if (item.intent.source.kind === 'prompt') return recordedConversationAuthor(item.intent.source)
    const sender = item.message?.sender
    return sender?.kind === 'agent-session' ? recordedConversationAuthor({ authorAgentSessionId: sender.agentSessionId })
      : sender?.kind === 'external' ? recordedConversationAuthor({ authorExternal: sender }) : { kind: 'unknown' }
  }
  const { key, record } = item, admission = record?.admission, inputKey = admission?.inputKey
  const message = admission?.intent?.message ?? record?.launch?.message
  // Only the original typed producer identifies a platform notice; authored wire remains an ordinary input.
  const isNotification = key.kind === 'prompt' && inputKey?.kind === 'prompt' &&
    inputKey.agentSessionId === key.agentSessionId && inputKey.expectedRun.runId === key.expectedRun.runId && inputKey.submissionId === key.submissionId &&
    record?.agentSessionId === key.agentSessionId && record.run.runId === key.expectedRun.runId && admission?.intent?.run.runId === key.expectedRun.runId &&
    message?.a2aNotificationId === key.submissionId && message.systemContext === admission.intent.prompt &&
    message.userContent === undefined && message.authorHuman === undefined && message.authorAgentSessionId === undefined && message.authorExternal === undefined
  return isNotification ? { kind: 'system' } : message ? recordedConversationAuthor(message) : { kind: 'unknown' }
}

/** Exact query facts only. This adapter does not manufacture original records or versions. */
function messageRecord(message: AgentSessionUserMessage, agentSessionId: string, sourceHostId?: string): ConversationInputRecord | undefined {
  const boundary = message.sourceRecord, reference = boundary?.record, source = message.source
  if (!reference || message.agentSessionId !== agentSessionId || reference.agentSessionId !== agentSessionId ||
    sourceHostId !== undefined && reference.hostId !== sourceHostId || reference.source.kind !== source.kind || reference.source.recordId !== message.rawId ||
    source.kind === 'native' && (reference.source.kind !== 'native' || source.providerId !== reference.source.providerId || source.nativeSessionId !== reference.source.nativeSessionId)) return undefined
  return { id: conversationRecordId(reference), reference, revision: boundary.revision,
    original: source.kind === 'native'
      ? { kind: 'native', item: { kind: 'user-message', ...(message.turnId !== undefined ? { turnId: message.turnId } : {}), ...(message.conversation ? { conversation: message.conversation } : {}) } }
      : { kind: 'captured', item: { kind: 'user_message', source: 'user',
        ...(message.publicContent === 'confirmed' && message.inputRef ? { inputRef: message.inputRef } : {}),
        ...(message.conversation ? { conversation: message.conversation } : {}) } } }
}

/** One reading projection over bounded, already-read sources. No IO, delivery or body matching.
 * Canonical records contribute current relationships, never additional query-result bodies. */
export function projectSessionInputs(input: {
  hostId: string
  sourceHostId?: string
  agentSessionId: string
  messages: readonly AgentSessionUserMessage[]
  inputs?: readonly ConversationInputEntity[]
  mailbox?: readonly AgentInputMailboxItem[]
}): readonly SessionInputGroup[] {
  const { hostId, sourceHostId, agentSessionId, messages } = input
  const canonical = (input.inputs ?? []).filter(entity => entity.hostId === hostId && entity.agentSessionId === agentSessionId &&
    entity.sourceHostId != null && (sourceHostId === undefined || entity.sourceHostId === sourceHostId))
  const originals = new Map<string, ConversationSourceRecord>()
  for (const entity of canonical) for (const record of entity.records) {
    if (record.reference && record.reference.hostId === entity.sourceHostId && record.reference.agentSessionId === agentSessionId) originals.set(record.id, record)
  }
  const records = new Map<string, ConversationInputRecord>(originals)
  const queries = messages.map(message => {
    const record = messageRecord(message, agentSessionId, sourceHostId)
    if (!record) return undefined
    const current = originals.get(record.id)
    // A changed/withdrawn current original cannot lend its new proof to an old query body.
    if (current && current.revision !== record.revision) return undefined
    if (!current) records.set(record.id, record)
    return record
  })
  const contexts = canonical.flatMap(entity => entity.event.inputAdoption ? [entity.event.inputAdoption] : [])
  const known = [...records.values()]
  const adoption = conversationInputAdoptionEdges(known, {
    witnesses: contexts.flatMap(context => context.witnesses), ...(contexts.some(context => context.unconfirmed) ? { unconfirmed: true } : {})
  })
  const targets = new Map<string, string>()
  for (const record of known) {
    const target = conversationSameEventTarget(record, record.reference?.source.kind === 'native' ? record.reference.source : undefined, adoption.targets.get(record.id))
    if (target) targets.set(record.id, conversationRecordId(target))
  }
  const { anchors } = conversationRecordAnchors(known, targets)
  const keys = new Map<string, Set<string>>()
  const addKey = (recordId: string, key: string) => {
    const anchor = anchors.get(recordId) ?? recordId, values = keys.get(anchor) ?? new Set<string>()
    values.add(key); keys.set(anchor, values)
  }
  for (const record of known) {
    const key = record.original.kind === 'captured' ? conversationInputKey(record) : undefined
    if (key) addKey(record.id, key)
  }
  // Native adoption remains qualified by the shared matcher, including unseen retained witnesses.
  if (!adoption.unconfirmed) for (const [key, candidates] of adoption.byKey) {
    if (!adoption.ambiguous.has(key) && candidates.length === 1 && candidates[0]!.key) addKey(conversationRecordId(candidates[0]!.record), key)
  }
  const groupId = (record: ConversationInputRecord): string => {
    const anchor = anchors.get(record.id) ?? record.id, identities = keys.get(anchor)
    return identities?.size === 1 ? `input:${identities.values().next().value!}` : `record:${anchor}`
  }
  type Group = { id: string; messages: AgentSessionUserMessage[]; mailbox: AgentInputMailboxItem[]; authors: ConversationAuthor[] }
  const groups = new Map<string, Group>()
  const group = (id: string) => {
    let value = groups.get(id)
    if (!value) { value = { id, messages: [], mailbox: [], authors: [] }; groups.set(id, value) }
    return value
  }
  messages.forEach((message, index) => {
    const record = queries[index], id = record ? groupId(record) : `message:${JSON.stringify([hostId, message.agentSessionId, message.id, message.sourceRecord ?? null])}`
    const value = group(id)
    value.messages.push(message); value.authors.push(message.author)
  })
  for (const record of originals.values()) {
    const value = groups.get(groupId(record))
    if (value) value.authors.push(conversationRecordAuthor(record, agentSessionId))
  }
  for (const item of input.mailbox ?? []) {
    const key = item.kind === 'controlled' ? item.intent.key : item.key
    const id = sourceHostId && key.agentSessionId === agentSessionId ? `input:${conversationInputIdentity(sourceHostId, key)}`
      : `mailbox:${JSON.stringify([hostId, key, item.sequence])}`
    const value = group(id); value.mailbox.push(item)
    value.authors.push(sessionInputMailboxAuthor(item))
  }
  return [...groups.values()].map(value => {
    const authors: ConversationAuthor[] = []
    for (const author of value.authors) {
      if (author.kind !== 'unknown' && !authors.some(known => conversationValuesEqual(author, known))) authors.push(author)
      if (authors.length > 1) break
    }
    return { id: value.id, primary: value.messages.find(message => message.source.kind === 'native') ?? value.messages[0] ?? null,
      messages: value.messages, mailbox: value.mailbox, author: authors.length === 1 ? authors[0]! : { kind: 'unknown' as const } }
  })
}
