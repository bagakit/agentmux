import type { AgentSessionHistoryItem } from '@agentmux/core'
import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react'

/** The host keeps each raw record's original shell, anchor and message body. */
export type ConversationRecordRenderer = (
  item: AgentSessionHistoryItem,
  wrapBody?: (body: ReactNode) => ReactNode
) => ReactNode

export type ConversationProcessProps = {
  id: string
  items: readonly AgentSessionHistoryItem[]
  renderRecord: ConversationRecordRenderer
}

export type ConversationProcessRenderer = (props: ConversationProcessProps) => ReactNode
export type ConversationRecordBoundary = { beforeRecordId: string; content: ReactNode }

/** Source order only. Group identity remembers IDs, never another copy of record content. */
export function ConversationRecordSequence({
  items, sourceKey, renderRecord, renderProcess, recordBoundary
}: {
  items: readonly AgentSessionHistoryItem[]
  sourceKey: string
  renderRecord: ConversationRecordRenderer
  renderProcess?: ConversationProcessRenderer
  recordBoundary?: ConversationRecordBoundary
}) {
  const committed = useRef<{ source: string; groups: Map<string, string> }>({
    source: sourceKey, groups: new Map()
  })
  const previous = committed.current.source === sourceKey ? committed.current.groups : new Map<string, string>()
  const groups = new Map<string, string>()
  const usedGroups = new Set<string>()
  const seen = new Set<string>()
  const rows: ReactNode[] = []
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
    rows.push(renderProcess
      ? <div key={id} className="conversation-record-process" data-native-record-ids={JSON.stringify(process.map(item => item.id))}>{renderProcess({ id, items: process, renderRecord })}</div>
      : process.map(item => renderRecord(item)))
    process = []
    knownTurn = undefined
    priorGroup = undefined
  }

  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    if (recordBoundary?.beforeRecordId === item.id) {
      flush()
      rows.push(<Fragment key={JSON.stringify([sourceKey, 'boundary'])}>{recordBoundary.content}</Fragment>)
    }
    if (item.kind !== 'activity') {
      flush()
      rows.push(renderRecord(item))
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
  useLayoutEffect(() => { committed.current = { source: sourceKey, groups } })
  return <>{rows}</>
}
