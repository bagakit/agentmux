import type { AgentSessionHistoryItem } from '@agentmux/core'

/** Presentation only: opaque bodies and facts stay at the source renderer. */
export type ConversationSequenceInsertion = {
  key: string
  beforeRecordId?: string
  role?: 'process' | 'message' | 'anchor'
}
export type ConversationSequenceEntry =
  | { kind: 'native'; item: AgentSessionHistoryItem }
  | { kind: 'insertion'; insertion: ConversationSequenceInsertion }
type ConversationRecordSequenceRow =
  | { kind: 'record'; item: AgentSessionHistoryItem }
  | { kind: 'insertion'; insertion: ConversationSequenceInsertion }
  | { kind: 'process'; id: string; items: readonly AgentSessionHistoryItem[]; entries: readonly ConversationSequenceEntry[] }
  | { kind: 'boundary' }

/** One source-order projection for rendering and checking retained reading nodes. */
export function projectConversationRecordSequence(
  items: readonly AgentSessionHistoryItem[], sourceKey: string,
  previous: ReadonlyMap<string, string> = new Map(), beforeRecordId?: string,
  insertions: readonly ConversationSequenceInsertion[] = [],
  previousInsertions: ReadonlyMap<string, string> = new Map()
): { rows: ConversationRecordSequenceRow[]; groups: Map<string, string>; insertionGroups: Map<string, string> } {
  const groups = new Map<string, string>()
  const insertionGroups = new Map<string, string>()
  const usedGroups = new Set<string>()
  const seen = new Set<string>()
  const rows: ConversationRecordSequenceRow[] = []
  let process: ConversationSequenceEntry[] = []
  let knownTurn: string | undefined
  let priorGroup: string | undefined

  function flush(): void {
    if (!process.length) return
    // A retained member keeps the card mounted when its old first record is clipped.
    const prior = process.map(groupOf).find(id => id !== undefined && !usedGroups.has(id))
    const first = process.find(entry => entry.kind !== 'insertion' || entry.insertion.role !== 'anchor')!
    const identity = first.kind === 'native' ? ['native', first.item.id] : ['insertion', first.insertion.key]
    const id = prior ?? JSON.stringify([sourceKey, 'process', ...identity])
    usedGroups.add(id)
    for (const entry of process) {
      if (entry.kind === 'native') groups.set(entry.item.id, id)
      else if (entry.insertion.role !== 'anchor') insertionGroups.set(entry.insertion.key, id)
    }
    rows.push({ kind: 'process', id, items: process.flatMap(entry => entry.kind === 'native' ? [entry.item] : []), entries: process })
    process = []
    knownTurn = undefined
    priorGroup = undefined
  }

  function groupOf(entry: ConversationSequenceEntry): string | undefined {
    return entry.kind === 'native' ? previous.get(entry.item.id) : previousInsertions.get(entry.insertion.key)
  }
  function append(entry: ConversationSequenceEntry): void {
    const itemGroup = groupOf(entry)
    // Do not merge retained rows across two already mounted card parents.
    if (priorGroup !== undefined && itemGroup !== undefined && priorGroup !== itemGroup) flush()
    process.push(entry)
    if (itemGroup !== undefined) priorGroup = itemGroup
  }
  const recordIds = new Set(items.map(item => item.id))
  const insertBefore = new Map<string | undefined, ConversationSequenceInsertion[]>()
  for (const insertion of insertions) {
    const before = insertion.beforeRecordId && recordIds.has(insertion.beforeRecordId) ? insertion.beforeRecordId : undefined
    const bucket = insertBefore.get(before) ?? []
    bucket.push(insertion); insertBefore.set(before, bucket)
  }
  function insert(id?: string): void {
    for (const insertion of insertBefore.get(id) ?? []) {
      if (insertion.role === 'process') append({ kind: 'insertion', insertion })
      else if (insertion.role === 'anchor' && process.length) process.push({ kind: 'insertion', insertion })
      else { flush(); rows.push({ kind: 'insertion', insertion }) }
    }
  }

  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    insert(item.id)
    if (beforeRecordId === item.id) {
      flush()
      rows.push({ kind: 'boundary' })
    }
    if (item.kind !== 'activity') {
      flush()
      rows.push({ kind: 'record', item })
    } else {
      if (knownTurn !== undefined && item.turnId !== undefined && item.turnId !== knownTurn) flush()
      append({ kind: 'native', item })
      if (item.turnId !== undefined) knownTurn = item.turnId
    }
  }
  insert()
  flush()
  return { rows, groups, insertionGroups }
}
