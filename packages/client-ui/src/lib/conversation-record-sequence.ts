import type { AgentSessionHistoryItem } from '@agentmux/core'

type ConversationRecordSequenceRow =
  | { kind: 'record'; item: AgentSessionHistoryItem }
  | { kind: 'process'; id: string; items: readonly AgentSessionHistoryItem[] }
  | { kind: 'boundary' }

/** One source-order projection for rendering and checking retained reading nodes. */
export function projectConversationRecordSequence(
  items: readonly AgentSessionHistoryItem[], sourceKey: string,
  previous: ReadonlyMap<string, string> = new Map(), beforeRecordId?: string
): { rows: ConversationRecordSequenceRow[]; groups: Map<string, string> } {
  const groups = new Map<string, string>()
  const usedGroups = new Set<string>()
  const seen = new Set<string>()
  const rows: ConversationRecordSequenceRow[] = []
  let process: AgentSessionHistoryItem[] = []
  let knownTurn: string | undefined
  let priorGroup: string | undefined

  function flush(): void {
    if (!process.length) return
    // A retained member keeps the card mounted when its old first record is clipped.
    const prior = process.map(item => previous.get(item.id)).find(id => id !== undefined && !usedGroups.has(id))
    const id = prior ?? JSON.stringify([sourceKey, 'process', process[0]!.id])
    usedGroups.add(id)
    for (const item of process) groups.set(item.id, id)
    rows.push({ kind: 'process', id, items: process })
    process = []
    knownTurn = undefined
    priorGroup = undefined
  }

  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    if (beforeRecordId === item.id) {
      flush()
      rows.push({ kind: 'boundary' })
    }
    if (item.kind !== 'activity') {
      flush()
      rows.push({ kind: 'record', item })
    } else {
      if (knownTurn !== undefined && item.turnId !== undefined && item.turnId !== knownTurn) flush()
      const itemGroup = previous.get(item.id)
      // Do not merge retained rows across two already mounted card parents.
      if (priorGroup !== undefined && itemGroup !== undefined && priorGroup !== itemGroup) flush()
      process.push(item)
      if (itemGroup !== undefined) priorGroup = itemGroup
      if (item.turnId !== undefined) knownTurn = item.turnId
    }
  }
  flush()
  return { rows, groups }
}
