import type { AgentSessionHistoryItem } from '@agentmux/core'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
  /** Reading choices survive a process being split by another source's input. */
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
/** Already read records from another source; keys retain that original source identity. */
export type ConversationRecordInsertion = {
  key: string
  beforeRecordId?: string
  /** Original IDs for process disclosure only; record bodies remain at their owner. */
  recordIds?: readonly string[]
  content: ReactNode | ((disclosure: NonNullable<ConversationProcessProps['disclosure']>) => ReactNode)
}

/** Source order only. Group identity remembers IDs, never another copy of record content. */
export function ConversationRecordSequence({
  items, sourceKey, renderRecord, renderProcess, recordBoundary, insertions = [], nativeSourceKey
}: {
  items: readonly AgentSessionHistoryItem[]
  sourceKey: string
  renderRecord: ConversationRecordRenderer
  renderProcess?: ConversationProcessRenderer
  recordBoundary?: ConversationRecordBoundary
  insertions?: readonly ConversationRecordInsertion[]
  nativeSourceKey?: string
}) {
  const committed = useRef<{ source: string; groups: Map<string, string>; positions: Omit<ConversationRecordInsertion, 'content'>[] }>({
    source: sourceKey, groups: new Map(), positions: []
  })
  const groupNodes = useRef(new Map<string, HTMLDivElement>())
  const [, selectionChanged] = useState(0)
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
  const previous = committed.current.source === sourceKey ? committed.current.groups : new Map<string, string>()
  const recordIds = new Set(items.map(item => item.id))
  const choiceKey = (kind: 'native' | 'insertion', id: string) => JSON.stringify([kind, id])
  const choiceIds = new Set([...items.map(item => choiceKey('native', item.id)), ...insertions.flatMap(entry => (entry.recordIds ?? []).map(id => choiceKey('insertion', id)))])
  const disclosureFor = (ids: readonly string[], kind: 'native' | 'insertion'): NonNullable<ConversationProcessProps['disclosure']> => {
    const expanded = ids.map(id => choices.groups.get(choiceKey(kind, id))).find(value => value !== undefined)
    return { ...(expanded === undefined ? {} : { expanded }),
      steps: new Map(ids.flatMap(id => { const value = choices.steps.get(choiceKey(kind, id)); return value === undefined ? [] : [[id, value] as const] })),
      onExpandedChange: open => disclose(ids.map(id => choiceKey(kind, id)), open, 'groups'),
      onStepExpandedChange: (id, open) => disclose([choiceKey(kind, id)], open, 'steps'),
      onStepsPresented: presented => disclose(presented.map(id => choiceKey(kind, id)), false, 'steps', true) }
  }
  let acceptedInsertions = insertions
  let projection = projectConversationRecordSequence(items, sourceKey, previous, recordBoundary?.beforeRecordId,
    new Set(insertions.flatMap(entry => entry.beforeRecordId ? [entry.beforeRecordId] : [])))
  // An arriving cross-source input can split an expanded process parent. Defer only
  // its placement metadata while a Range uses that parent; bodies stay at their owner.
  const document = groupNodes.current.values().next().value?.ownerDocument
  const selection = document?.defaultView?.getSelection()
  let held = false
  const splitGroups = new Set([...previous].flatMap(([record, group]) => projection.groups.has(record) && projection.groups.get(record) !== group ? [group] : []))
  if (selection && !selection.isCollapsed && selection.rangeCount) for (const [id, node] of groupNodes.current) {
    if (!splitGroups.has(id)) continue
    try { if (selection.getRangeAt(0).intersectsNode(node)) { held = true; break } }
    catch { held = true; break }
  }
  if (held) {
    const incoming = new Map(insertions.map(entry => [entry.key, entry]))
    acceptedInsertions = committed.current.positions.flatMap(position => {
      const entry = incoming.get(position.key)
      if (!entry) return []
      const { beforeRecordId: _, ...rest } = entry
      return [{ ...rest, ...(position.beforeRecordId === undefined ? {} : { beforeRecordId: position.beforeRecordId }) }]
    })
    projection = projectConversationRecordSequence(items, sourceKey, previous, recordBoundary?.beforeRecordId,
      new Set(acceptedInsertions.flatMap(entry => entry.beforeRecordId ? [entry.beforeRecordId] : [])))
  }
  useEffect(() => {
    if (!held || !document) return
    const update = () => selectionChanged(value => value + 1)
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [held, document])
  const metrics = projectConversationMetrics(items)
  const renderOne = (item: AgentSessionHistoryItem, wrapBody?: (body: ReactNode) => ReactNode, showDiagnostic = true, showMetrics = true) => <Fragment key={item.id}>
    {renderRecord(item, wrapBody)}
    {showMetrics && metrics.has(item.id) ? <ConversationMetrics observation={metrics.get(item.id)!} /> : null}
    {showDiagnostic && item.metricsDiagnostic ? <p className="conversation-metrics__notice" role="status">{item.metricsDiagnostic.message}</p> : null}
  </Fragment>
  useLayoutEffect(() => { committed.current = { source: sourceKey, groups: projection.groups,
    positions: acceptedInsertions.map(({ key, beforeRecordId }) => ({ key, ...(beforeRecordId === undefined ? {} : { beforeRecordId }) })) } })
  useLayoutEffect(() => {
    setDisclosure(previous => {
      if (previous.source !== sourceKey) return { source: sourceKey, groups: new Map(), steps: new Map() }
      const groups = new Map([...previous.groups].filter(([id]) => choiceIds.has(id)))
      const steps = new Map([...previous.steps].filter(([id]) => choiceIds.has(id)))
      return groups.size === previous.groups.size && steps.size === previous.steps.size ? previous : { source: sourceKey, groups, steps }
    })
  }, [items, sourceKey, insertions])
  const insertBefore = new Map<string | undefined, ConversationRecordInsertion[]>()
  for (const entry of acceptedInsertions) {
    const before = entry.beforeRecordId && recordIds.has(entry.beforeRecordId) ? entry.beforeRecordId : undefined
    const bucket = insertBefore.get(before) ?? []
    bucket.push(entry); insertBefore.set(before, bucket)
  }
  const renderInserted = (id?: string) => (insertBefore.get(id) ?? []).map(entry => <Fragment key={JSON.stringify(['insertion', entry.key])}>{typeof entry.content === 'function' ? entry.content(disclosureFor(entry.recordIds ?? [], 'insertion')) : entry.content}</Fragment>)
  return <>{held ? <p className="conversation-metrics__notice" role="status">保留选区，取消选择后更新消息顺序。</p> : null}{projection.rows.flatMap(row => [
    ...('item' in row ? renderInserted(row.item.id) : row.kind === 'process' ? renderInserted(row.items[0]?.id) : []),
    row.kind === 'record' ? renderOne(row.item)
    : row.kind === 'boundary' ? <Fragment key={JSON.stringify([sourceKey, 'boundary'])}>{recordBoundary?.content}</Fragment>
    : renderProcess ? <div key={row.id} ref={node => { if (node) groupNodes.current.set(row.id, node); else groupNodes.current.delete(row.id) }}
      className="conversation-record-process" data-native-source={nativeSourceKey} data-native-record-ids={JSON.stringify(row.items.map(item => item.id))}>
      {(() => {
        const observed = row.items.flatMap(item => metrics.has(item.id) ? [metrics.get(item.id)!] : [])
        const summary = observed.length === 1 ? observed[0] : undefined
        return renderProcess({ id: row.id, items: row.items, renderRecord: (item, wrapBody) => renderOne(item, wrapBody, false, !summary),
          disclosure: disclosureFor(row.items.map(item => item.id), 'native'),
          ...(summary ? { metrics: summary } : {}) })
      })()}
    </div> : row.items.map(item => renderOne(item))])}{renderInserted()}</>
}
