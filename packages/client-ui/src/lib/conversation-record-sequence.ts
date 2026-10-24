import type { ConversationRecord } from './conversation-records.js'

/** View-only slots never carry another source's conversation records. */
export type ConversationSequenceInsertion = { key: string; beforeRecordId?: string; role?: 'anchor' }
export type ConversationSequenceEntry =
  | { kind: 'record'; record: ConversationRecord }
  | { kind: 'anchor'; insertion: ConversationSequenceInsertion }
export type ConversationRecordSequenceRow = ConversationSequenceEntry
  | { kind: 'process'; id: string; records: readonly ConversationRecord[]; entries: readonly ConversationSequenceEntry[] }
  | { kind: 'boundary' }
export type ConversationSequence = { rows: readonly ConversationRecordSequenceRow[]; groups: ReadonlyMap<string, string> }
export const conversationPresentationKey = (record: ConversationRecord): string => record.presentationKey ?? record.id
/** Original peers stay exposed inside a process interval; their Core roles do not change. */
export const conversationProcessPeer = (record: ConversationRecord): boolean => record.role === 'observation'
  || record.role === 'message' && record.original.kind === 'native' && record.original.item.collaboration?.kind === 'message'

/** One presentation projection over Core's ordered records; no source merge. */
export function projectConversationRecordSequence(
  records: readonly ConversationRecord[], sourceKey: string,
  previous: ReadonlyMap<string, string> = new Map(), beforeRecordId?: string,
  anchors: readonly ConversationSequenceInsertion[] = []
): ConversationSequence {
  const groups = new Map<string, string>(), usedGroups = new Set<string>()
  const rows: ConversationRecordSequenceRow[] = []
  let process: ConversationSequenceEntry[] = []
  let knownSource: string | undefined, knownTurn: string | undefined, priorGroup: string | undefined
  function flush(): void {
    if (!process.length) return
    const members = process.flatMap(entry => entry.kind === 'record' ? [entry.record] : [])
    const prior = members.map(record => previous.get(conversationPresentationKey(record))).find(id => id !== undefined && !usedGroups.has(id))
    const id = prior ?? JSON.stringify([sourceKey, 'process', conversationPresentationKey(members[0]!)])
    usedGroups.add(id)
    for (const record of members) groups.set(conversationPresentationKey(record), id)
    rows.push({ kind: 'process', id, records: members, entries: process })
    process = []; knownSource = undefined; knownTurn = undefined; priorGroup = undefined
  }
  const before = new Map<string | undefined, ConversationSequenceInsertion[]>()
  const ids = new Set(records.map(conversationPresentationKey))
  for (const anchor of anchors) {
    const id = anchor.beforeRecordId && ids.has(anchor.beforeRecordId) ? anchor.beforeRecordId : undefined
    before.set(id, [...before.get(id) ?? [], anchor])
  }
  function insert(id?: string): void {
    for (const insertion of before.get(id) ?? []) {
      const entry = { kind: 'anchor' as const, insertion }
      if (process.length) process.push(entry); else rows.push(entry)
    }
  }
  for (const record of records) {
    const key = conversationPresentationKey(record)
    insert(key)
    if (beforeRecordId === key) { flush(); rows.push({ kind: 'boundary' }) }
    if (record.role === 'process' || record.role !== 'observation' && conversationProcessPeer(record)) {
      const native = record.original.kind === 'native' ? record.original.item : record.original.kind === 'deferred' && record.original.item.kind === 'native' ? record.original.item.item : undefined
      const source = record.source.kind === 'native'
        ? JSON.stringify([record.sourceHostId, record.source.providerId, record.source.nativeSessionId]) : undefined
      const turn = native?.turnId
      const prior = previous.get(key)
      // Never combine two already mounted parents. A retained member owns its group.
      if (knownSource !== undefined && source !== undefined && knownSource !== source
        || knownTurn !== undefined && turn !== undefined && knownTurn !== turn
        || priorGroup !== undefined && prior !== undefined && priorGroup !== prior) flush()
      // A report without a pending actual step stays an independent original record.
      if (record.role !== 'process' && !process.length) { rows.push({ kind: 'record', record }); continue }
      process.push({ kind: 'record', record })
      if (source !== undefined) knownSource = source
      if (turn !== undefined) knownTurn = turn
      if (prior !== undefined) priorGroup = prior
    } else if (record.role === 'observation' && process.length) process.push({ kind: 'record', record })
    else { flush(); rows.push({ kind: 'record', record }) }
  }
  insert(); flush()
  return { rows, groups }
}
