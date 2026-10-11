import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { conversationRecordId, type ConversationProjectionInput } from '@agentmux/core/conversation'
import { projectConversationRecords, type ConversationRecord } from './conversation-records.js'

type Placement = { key: string; recordId: string; role: ConversationRecord['role'] }
const originalKey = (record: ConversationRecord) => conversationRecordId({ agentSessionId: record.agentSessionId,
  ...(record.sourceHostId ? { hostId: record.sourceHostId } : {}), source: record.source })

/** Committed placement only. Current original bodies stay with Core records, never in this ref. */
export function useConversationRecordLayout(records: readonly ConversationRecord[], input: ConversationProjectionInput, sourceKey: string) {
  const root = useRef<HTMLElement>(null)
  const committed = useRef<{ source: string; rows: Placement[] }>({ source: sourceKey, rows: [] })
  const [, selectionChanged] = useState(0)
  const prior = committed.current.source === sourceKey ? committed.current.rows : []
  const incoming = new Map(records.map(record => [record.id, record]))
  const selection = root.current?.ownerDocument.defaultView?.getSelection()
  let held = false
  const nodes = selection && !selection.isCollapsed && selection.rangeCount ? new Map([...root.current!.querySelectorAll<HTMLElement>('[data-conversation-layout-key]')].map(node => [node.dataset.conversationLayoutKey, node])) : new Map<string, HTMLElement>()
  if (selection && !selection.isCollapsed && selection.rangeCount) for (const row of prior) {
    const next = incoming.get(row.key)
    if (next && originalKey(next) === row.recordId && next.role === row.role) continue
    const node = nodes.get(row.key)
    if (!node) continue
    try { if (selection.getRangeAt(0).intersectsNode(node)) { held = true; break } } catch { held = true; break }
  }
  let presented = records
  if (held) {
    const originals = new Map(records.flatMap(record => (record.records ?? []).map(original => [original.id, original] as const)))
    presented = prior.flatMap(row => {
      const original = originals.get(row.recordId)
      if (!original) return []
      // Reuse Core for the exact retained original source view. Its canonical target may
      // be unread in this held view; no client reinterprets association, author or parts.
      const fresh = projectConversationRecords({ agentSessionId: input.agentSessionId, executionHostId: input.executionHostId,
        ...(original.original.kind === 'native' && input.historyPage ? { historyPage: { ...input.historyPage, items: [original.original.item] } }
          : original.original.kind === 'captured' ? { timeline: { ...(input.timeline?.agentSessionId === input.agentSessionId ? input.timeline : { revision: 0 }), ...(original.reference ? { sourceHostId: original.reference.hostId } : {}), agentSessionId: input.agentSessionId, items: [original.original.item] } } : {}) })[0]
      return fresh ? [{ ...fresh, presentationKey: row.key }] : []
    })
  }
  useLayoutEffect(() => {
    if (!held) committed.current = { source: sourceKey, rows: records.map(record => ({ key: record.id, recordId: originalKey(record), role: record.role })) }
  })
  useEffect(() => {
    const document = root.current?.ownerDocument
    if (!held || !document) return
    const update = () => selectionChanged(value => value + 1)
    document.addEventListener('selectionchange', update)
    return () => document.removeEventListener('selectionchange', update)
  }, [held])
  return { records: presented, root, held }
}
