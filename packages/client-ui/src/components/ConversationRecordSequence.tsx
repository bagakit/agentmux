import type { AgentSessionHistoryItem } from '@agentmux/core'
import { Fragment, useLayoutEffect, useRef, type ReactNode } from 'react'
import { projectConversationRecordSequence } from '../lib/conversation-record-sequence.js'
import { projectConversationMetrics, type ConversationMetricsObservation } from '../lib/conversation-metrics.js'
import { ConversationMetrics } from './ConversationMetrics.js'

/** The host keeps each raw record's original shell, anchor and message body. */
export type ConversationRecordRenderer = (
  item: AgentSessionHistoryItem,
  wrapBody?: (body: ReactNode) => ReactNode
) => ReactNode

export type ConversationProcessProps = {
  id: string
  items: readonly AgentSessionHistoryItem[]
  renderRecord: ConversationRecordRenderer
  metrics?: ConversationMetricsObservation
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
  const metrics = projectConversationMetrics(items)
  const renderOne = (item: AgentSessionHistoryItem, wrapBody?: (body: ReactNode) => ReactNode, showDiagnostic = true, showMetrics = true) => <Fragment key={item.id}>
    {renderRecord(item, wrapBody)}
    {showMetrics && metrics.has(item.id) ? <ConversationMetrics observation={metrics.get(item.id)!} /> : null}
    {showDiagnostic && item.metricsDiagnostic ? <p className="conversation-metrics__notice" role="status">{item.metricsDiagnostic.message}</p> : null}
  </Fragment>
  useLayoutEffect(() => { committed.current = { source: sourceKey, groups: projection.groups } })
  return <>{projection.rows.map(row => row.kind === 'record' ? renderOne(row.item)
    : row.kind === 'boundary' ? <Fragment key={JSON.stringify([sourceKey, 'boundary'])}>{recordBoundary?.content}</Fragment>
    : renderProcess ? <div key={row.id} className="conversation-record-process" data-native-record-ids={JSON.stringify(row.items.map(item => item.id))}>
      {(() => {
        const observed = row.items.flatMap(item => metrics.has(item.id) ? [metrics.get(item.id)!] : [])
        const summary = observed.length === 1 ? observed[0] : undefined
        return renderProcess({ id: row.id, items: row.items, renderRecord: (item, wrapBody) => renderOne(item, wrapBody, false, !summary),
          ...(summary ? { metrics: summary } : {}) })
      })()}
    </div> : row.items.map(item => renderOne(item)))}</>
}
