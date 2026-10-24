import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { conversationPresentationKey, type ConversationSequence, type ConversationSequenceInsertion } from '../lib/conversation-record-sequence.js'
import type { ConversationRecord } from '../lib/conversation-records.js'
import { projectConversationMetrics, type ConversationMetricsObservation } from '../lib/conversation-metrics.js'
import { ConversationMetrics } from './ConversationMetrics.js'
import { conversationItemRef, type ConversationItemRef } from '@agentmux/core/conversation'

/** Accepted presentation identity and the exact original records it represents. */
export type ConversationProcessMember = { id: string; sources: readonly ConversationItemRef[] }

function processMembers(records: readonly ConversationRecord[]): ConversationProcessMember[] {
  return records.map(record => {
    const originals = (record.deferred?.records ?? record.records)?.flatMap(source => source.reference ? [source.reference] : [])
    const primary = conversationItemRef(record)
    return { id: record.id, sources: originals?.length ? originals : primary ? [primary] : [] }
  })
}

export type ConversationRecordRenderer = (record: ConversationRecord, wrapBody?: (body: ReactNode) => ReactNode,
  disclosure?: NonNullable<ConversationProcessProps['disclosure']>) => ReactNode
export type ConversationProcessProps = {
  id: string
  records: readonly ConversationRecord[]
  renderRecord: ConversationRecordRenderer
  entries: readonly ({ kind: 'record'; record: ConversationRecord } | { kind: 'anchor'; key: string; content: ReactNode })[]
  metrics?: ConversationMetricsObservation
  disclosure?: {
    expanded?: boolean
    onExpandedChange: (expanded: boolean) => void
    steps: ReadonlyMap<string, boolean>
    onStepExpandedChange: (recordId: string, expanded: boolean) => void
    onStepsPresented?: (recordIds: readonly string[]) => void
  }
}
export type ConversationProcessRenderer = (props: ConversationProcessProps) => ReactNode
export type ConversationRecordBoundary = { beforeRecordId: string; content: ReactNode }
export type ConversationRecordInsertion = ConversationSequenceInsertion & { content: ReactNode }

/** Only accepted rows enter this renderer. Disclosure uses one presentation identity. */
export function ConversationRecordSequence({ records, sequence, sourceKey, renderRecord, renderProcess, recordBoundary,
  insertions = [], nativeSourceKey, locatedRecordId
}: {
  records: readonly ConversationRecord[]
  sequence: ConversationSequence
  sourceKey: string
  renderRecord: ConversationRecordRenderer
  renderProcess?: ConversationProcessRenderer
  recordBoundary?: ConversationRecordBoundary
  insertions?: readonly ConversationRecordInsertion[]
  nativeSourceKey?: string
  locatedRecordId?: string | undefined
}) {
  const [disclosure, setDisclosure] = useState<{ source: string; groups: ReadonlyMap<string, boolean>; steps: ReadonlyMap<string, boolean> }>({ source: sourceKey, groups: new Map(), steps: new Map() })
  const choices = disclosure.source === sourceKey ? disclosure : { groups: new Map<string, boolean>(), steps: new Map<string, boolean>() }
  function disclose(ids: readonly string[], expanded: boolean, type: 'groups' | 'steps', onlyUnseen = false): void {
    setDisclosure(previous => {
      const current = previous.source === sourceKey ? previous : { source: sourceKey, groups: new Map<string, boolean>(), steps: new Map<string, boolean>() }
      if (ids.every(id => onlyUnseen ? current[type].has(id) : current[type].get(id) === expanded)) return previous
      const next = new Map(current[type])
      for (const id of ids) if (!onlyUnseen || !next.has(id)) next.set(id, expanded)
      return { ...current, [type]: next }
    })
  }
  const disclosureFor = (members: readonly ConversationRecord[]): NonNullable<ConversationProcessProps['disclosure']> => {
    const ids = members.map(conversationPresentationKey)
    const expanded = ids.map(id => choices.groups.get(id)).find(value => value !== undefined)
    return { ...(expanded === undefined ? {} : { expanded }), steps: choices.steps,
      onExpandedChange: open => disclose(ids, open, 'groups'),
      onStepExpandedChange: (id, open) => disclose([id], open, 'steps'),
      onStepsPresented: ids => disclose(ids, false, 'steps', true) }
  }
  const located = useRef('')
  useEffect(() => {
    const key = JSON.stringify([sourceKey, locatedRecordId])
    if (!locatedRecordId || key === located.current) return
    const row = sequence.rows.find(row => row.kind === 'process' && row.records.some(record => conversationPresentationKey(record) === locatedRecordId))
    if (!row || row.kind !== 'process') return
    located.current = key
    disclose(row.records.map(conversationPresentationKey), true, 'groups')
    disclose([locatedRecordId], true, 'steps')
  }, [locatedRecordId, sourceKey, sequence])
  useLayoutEffect(() => {
    const ids = new Set(records.map(conversationPresentationKey))
    setDisclosure(previous => {
      if (previous.source !== sourceKey) return { source: sourceKey, groups: new Map(), steps: new Map() }
      const groups = new Map([...previous.groups].filter(([id]) => ids.has(id)))
      const steps = new Map([...previous.steps].filter(([id]) => ids.has(id)))
      return groups.size === previous.groups.size && steps.size === previous.steps.size ? previous : { source: sourceKey, groups, steps }
    })
  }, [records, sourceKey])
  // Metrics belong to exact native records; this is a leaf adaptation, never ordering.
  const metrics = projectConversationMetrics(records.flatMap(record => record.original.kind === 'native' ? [record.original.item] : record.original.kind === 'deferred' && record.original.item.kind === 'native' ? [record.original.item.item] : []))
  const renderOne = (record: ConversationRecord, wrapBody?: (body: ReactNode) => ReactNode,
    disclosure?: NonNullable<ConversationProcessProps['disclosure']>, showDiagnostic = true, showMetrics = true) => {
    const item = record.original.kind === 'native' ? record.original.item : record.original.kind === 'deferred' && record.original.item.kind === 'native' ? record.original.item.item : undefined
    return <Fragment key={conversationPresentationKey(record)}>{renderRecord(record, wrapBody, disclosure)}
      {showMetrics && item && metrics.has(item.id) ? <ConversationMetrics observation={metrics.get(item.id)!} /> : null}
      {showDiagnostic && item?.metricsDiagnostic ? <p className="conversation-metrics__notice" role="status">{item.metricsDiagnostic.message}</p> : null}
    </Fragment>
  }
  const anchors = new Map(insertions.map(entry => [entry.key, entry]))
  const renderAnchor = (key: string) => <div key={JSON.stringify(['anchor', key])} data-conversation-layout-key={JSON.stringify(['anchor', key])}>{anchors.get(key)?.content}</div>
  return <>{sequence.rows.map(row => row.kind === 'record' ? renderOne(row.record)
    : row.kind === 'anchor' ? renderAnchor(row.insertion.key)
    : row.kind === 'boundary' ? <div key={JSON.stringify([sourceKey, 'boundary'])} data-conversation-layout-key={JSON.stringify(['anchor', 'history-boundary'])}>{recordBoundary?.content}</div>
    : <div key={row.id} className="conversation-record-process" data-conversation-layout-key={row.id} data-conversation-process-key={row.id}
      data-native-source={nativeSourceKey} data-conversation-process-members={JSON.stringify(processMembers(row.records))}>
      {(() => {
        const disclosure = disclosureFor(row.records)
        if (!renderProcess) return row.entries.map(entry => entry.kind === 'record' ? renderOne(entry.record, undefined, disclosure) : renderAnchor(entry.insertion.key))
        const observed = row.records.flatMap(record => record.source.kind === 'native' && metrics.has(record.rawId) ? [metrics.get(record.rawId)!] : [])
        const summary = observed.length === 1 && row.records.every(record => record.source.kind === 'native') ? observed[0] : undefined
        return renderProcess({ id: row.id, records: row.records,
          renderRecord: (record, wrapBody) => renderOne(record, wrapBody, disclosure, false, !summary),
          entries: row.entries.map(entry => entry.kind === 'record' ? entry : { kind: 'anchor', key: entry.insertion.key, content: renderAnchor(entry.insertion.key) }),
          disclosure, ...(summary ? { metrics: summary } : {}) })
      })()}
    </div>)}</>
}
