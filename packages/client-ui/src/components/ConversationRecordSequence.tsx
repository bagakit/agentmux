import type { AgentSessionHistoryItem } from '@agentmux/core'
import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react'
import { projectConversationRecordSequence } from '../lib/conversation-record-sequence.js'

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
  const projection = projectConversationRecordSequence(items, sourceKey, previous, recordBoundary?.beforeRecordId)
  useLayoutEffect(() => { committed.current = { source: sourceKey, groups: projection.groups } })
  return <>{projection.rows.map(row => row.kind === 'record' ? renderRecord(row.item)
    : row.kind === 'boundary' ? <Fragment key={JSON.stringify([sourceKey, 'boundary'])}>{recordBoundary?.content}</Fragment>
    : renderProcess ? <div key={row.id} className="conversation-record-process" data-native-record-ids={JSON.stringify(row.items.map(item => item.id))}>
      {renderProcess({ id: row.id, items: row.items, renderRecord })}
    </div> : row.items.map(item => renderRecord(item)))}</>
}
