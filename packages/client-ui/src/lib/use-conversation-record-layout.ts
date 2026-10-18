import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { conversationRecordId, conversationRevision } from '@agentmux/core/conversation'
import type { ConversationRecord } from './conversation-records.js'
import { conversationPresentationKey, projectConversationRecordSequence, type ConversationSequence, type ConversationSequenceInsertion } from './conversation-record-sequence.js'

export type ConversationPresentationFrame = { records: readonly ConversationRecord[]; originalRecords: readonly ConversationRecord[] }
type Placement = { version: string; parent: string | undefined }
const version = (record: ConversationRecord): string => JSON.stringify([
  conversationRecordId({ agentSessionId: record.agentSessionId, ...(record.sourceHostId ? { hostId: record.sourceHostId } : {}), source: record.source }),
  record.role, record.event?.revision ?? conversationRevision(record.original.item), record.records?.map(original => [original.id, original.revision])
])
function placements(frame: ConversationPresentationFrame, sequence: ConversationSequence): Map<string, Placement> {
  const result = new Map(frame.records.map(record => {
    const key = conversationPresentationKey(record)
    return [key, { version: version(record), parent: sequence.groups.get(key) }] as const
  }))
  const anchor = (key: string, parent?: string) => result.set(JSON.stringify(['anchor', key]), { version: key, parent })
  for (const row of sequence.rows) {
    if (row.kind === 'process') {
      result.set(row.id, { version: JSON.stringify(row.entries.map(entry => entry.kind === 'record'
        ? [conversationPresentationKey(entry.record), version(entry.record)] : ['anchor', entry.insertion.key])), parent: undefined })
      for (const entry of row.entries) if (entry.kind === 'anchor') anchor(entry.insertion.key, row.id)
    } else if (row.kind === 'anchor') anchor(row.insertion.key)
    else if (row.kind === 'boundary') anchor('history-boundary')
  }
  return result
}
export type ConversationPresentationController = {
  canPresent: (frame: ConversationPresentationFrame, options?: { beforeRecordId?: string; preserveAnchor?: boolean }) => boolean
}
export type ConversationPresentationPort = {
  controller: { current: ConversationPresentationController | null }
  pending: boolean
  watchSelection?: boolean
  onRelease: () => void
  /** Explicit navigation invalidates anchor retention, never a selected version. */
  intent?: unknown
}
type Protection = 'selection' | 'focus' | 'anchor' | null
function readingNode(node: HTMLElement): HTMLElement | null {
  return node.dataset.conversationProcessKey ? node.querySelector<HTMLElement>('.wf-card--observation > .wf-head') : node
}
function protection(root: HTMLElement | null, previous: ReadonlyMap<string, Placement>, incoming: ReadonlyMap<string, Placement>, preserveAnchor: boolean): Protection {
  const document = root?.ownerDocument, selection = document?.defaultView?.getSelection()
  const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null
  const focused = document?.activeElement
  for (const node of root?.querySelectorAll<HTMLElement>('[data-conversation-layout-key]') ?? []) {
    const key = node.dataset.conversationLayoutKey!, prior = previous.get(key), next = incoming.get(key)
    if (prior && next && prior.version === next.version && prior.parent === next.parent) continue
    const protectedNode = readingNode(node) ?? node
    try { if (range?.intersectsNode(protectedNode)) return 'selection' } catch { return 'selection' }
    if (focused && focused !== document?.body && protectedNode.contains(focused)) return 'focus'
  }
  const anchor = preserveAnchor ? currentAnchor(root) : null
  if (anchor && !incoming.has(anchor.key)) return 'anchor'
  return null
}
function scrollParent(root: HTMLElement | null): HTMLElement | null {
  for (let node = root?.parentElement; node; node = node.parentElement)
    if (node.clientHeight > 0 && node.scrollHeight > node.clientHeight) return node
  return null
}
function currentAnchor(root: HTMLElement | null) {
  const viewport = scrollParent(root)
  if (!viewport || !root) return null
  const bounds = viewport.getBoundingClientRect()
  if (bounds.height <= 0) return null
  for (const node of root.querySelectorAll<HTMLElement>('[data-conversation-layout-key]')) {
    const rect = readingNode(node)?.getBoundingClientRect()
    if (!rect) continue
    if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom)
      return { viewport, key: node.dataset.conversationLayoutKey!, offset: rect.top - bounds.top }
  }
  return null
}

/** One complete presentation transaction; pending data is always the current props.
 * It retains accepted frame references, never another reader or copied message body. */
export function useConversationRecordLayout<T extends ConversationPresentationFrame>(frame: T, sourceKey: string, {
  beforeRecordId, anchors = [], active = true, intent, presentation
}: { beforeRecordId?: string; anchors?: readonly ConversationSequenceInsertion[]; active?: boolean; intent?: unknown; presentation?: ConversationPresentationPort } = {}) {
  const root = useRef<HTMLElement>(null)
  const committed = useRef<{ source: string; frame: T; sequence: ConversationSequence; placements: Map<string, Placement>; intent: unknown } | null>(null)
  const [, changed] = useState(0)
  const pendingReason = useRef<Protection>(null)
  const prior = committed.current?.source === sourceKey ? committed.current : null
  const anchorPositions = JSON.stringify(anchors.map(({ key, beforeRecordId }) => [key, beforeRecordId]))
  // Committing this projection changes the retained groups, not its structural input.
  // Reuse it for local disclosure/selection updates; only new records or slots reproject.
  const sequence = useMemo(() => projectConversationRecordSequence(frame.records, sourceKey, prior?.sequence.groups, beforeRecordId, anchors),
    [frame.records, sourceKey, beforeRecordId, anchorPositions])
  const incoming = useMemo(() => placements(frame, sequence), [frame.records, frame.originalRecords, sequence])
  const changedFrame = prior !== null && prior.frame !== frame
  const document = root.current?.ownerDocument
  const anchor = active && changedFrame && prior && Object.is(prior.intent, intent) ? currentAnchor(root.current) : null
  const reason = prior && active && changedFrame ? protection(root.current, prior.placements, incoming, Boolean(anchor)) : null
  const held = reason !== null
  const accepted = held && prior ? prior : { source: sourceKey, frame, sequence, placements: incoming, intent }
  useLayoutEffect(() => {
    committed.current = accepted
    if (presentation) presentation.controller.current = {
      canPresent: (candidate, options) => {
        if (!active) return true
        const boundary = candidate.records.find(record => conversationPresentationKey(record) === options?.beforeRecordId
          || record.original.kind === 'native' && record.rawId === options?.beforeRecordId)
        const next = projectConversationRecordSequence(candidate.records, sourceKey, accepted.sequence.groups,
          boundary ? conversationPresentationKey(boundary) : undefined, anchors)
        pendingReason.current = protection(root.current, accepted.placements, placements(candidate, next), options?.preserveAnchor !== false)
        return pendingReason.current === null
      }
    }
    if (held || !anchor) return
    const node = [...root.current?.querySelectorAll<HTMLElement>('[data-conversation-layout-key]') ?? []]
      .find(node => node.dataset.conversationLayoutKey === anchor.key)
    const target = node ? readingNode(node) : null
    if (target) anchor.viewport.scrollTop += target.getBoundingClientRect().top - anchor.viewport.getBoundingClientRect().top - anchor.offset
  })
  useEffect(() => {
    const ownerDocument = root.current?.ownerDocument
    if ((!held && !presentation?.pending && !presentation?.watchSelection) || !ownerDocument || !active) return
    const update = () => {
      if (held) changed(value => value + 1)
      if (held || presentation?.pending || ownerDocument.defaultView?.getSelection()?.isCollapsed !== false) presentation?.onRelease()
    }
    ownerDocument.addEventListener('selectionchange', update)
    ownerDocument.addEventListener('focusout', update)
    const viewport = reason === 'anchor' || presentation?.pending && pendingReason.current === 'anchor' ? scrollParent(root.current) : null
    viewport?.addEventListener('scroll', update)
    return () => { ownerDocument.removeEventListener('selectionchange', update); ownerDocument.removeEventListener('focusout', update); viewport?.removeEventListener('scroll', update) }
  }, [held, reason, document, active, presentation?.pending, presentation?.watchSelection, presentation?.onRelease])
  useLayoutEffect(() => () => { if (presentation) presentation.controller.current = null }, [presentation?.controller])
  return { ...accepted.frame, sequence: accepted.sequence, root, held: held || Boolean(presentation?.pending), reason: reason ?? (presentation?.pending ? pendingReason.current : null) }
}
