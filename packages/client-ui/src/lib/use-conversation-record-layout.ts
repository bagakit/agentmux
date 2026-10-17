import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { conversationRecordId, conversationRevision } from '@agentmux/core/conversation'
import type { ConversationRecord } from './conversation-records.js'

type Placement = { key: string; recordId: string; role: ConversationRecord['role']; revision: string }
const originalKey = (record: ConversationRecord) => conversationRecordId({ agentSessionId: record.agentSessionId,
  ...(record.sourceHostId ? { hostId: record.sourceHostId } : {}), source: record.source })

const version = (record: ConversationRecord) => record.event?.revision ?? record.records?.find(original => original.id === originalKey(record))?.revision ?? conversationRevision(record.original.item)

/** Committed placement only. Current original bodies stay with Core records, never in this ref. */
export function useConversationRecordLayout(records: readonly ConversationRecord[], originals: readonly ConversationRecord[], sourceKey: string) {
  const root = useRef<HTMLElement>(null)
  const committed = useRef<{ source: string; rows: Placement[]; records: readonly ConversationRecord[]; originals: readonly ConversationRecord[] }>({ source: sourceKey, rows: [], records, originals })
  const [, selectionChanged] = useState(0)
  const prior = committed.current.source === sourceKey ? committed.current.rows : []
  const incoming = new Map(records.map(record => [record.id, record]))
  const selection = root.current?.ownerDocument.defaultView?.getSelection()
  let held = false
  const nodes = selection && !selection.isCollapsed && selection.rangeCount ? new Map([...root.current!.querySelectorAll<HTMLElement>('[data-conversation-layout-key]')].map(node => [node.dataset.conversationLayoutKey, node])) : new Map<string, HTMLElement>()
  if (selection && !selection.isCollapsed && selection.rangeCount) for (const row of prior) {
    const next = incoming.get(row.key)
    if (next && originalKey(next) === row.recordId && next.role === row.role && version(next) === row.revision) continue
    const node = nodes.get(row.key)
    if (!node) continue
    try { if (selection.getRangeAt(0).intersectsNode(node)) { held = true; break } } catch { held = true; break }
  }
  // Keep the previous accepted frame during a DOM Range. Never reproject raw
  // contributors or turn placement protection into a second semantic reader.
  const presented = held ? committed.current.records : records
  const originalRecords = held ? committed.current.originals : originals
  useLayoutEffect(() => {
    if (!held) committed.current = { source: sourceKey, records, originals, rows: records.map(record => ({ key: record.id, recordId: originalKey(record), role: record.role, revision: version(record) })) }
  })
  useEffect(() => {
    const document = root.current?.ownerDocument
    if (!held || !document) return
    const update = () => selectionChanged(value => value + 1)
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [held])
  return { records: presented, originalRecords, root, held }
}
