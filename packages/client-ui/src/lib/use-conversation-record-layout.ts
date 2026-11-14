import { selectedConversationReadingNode } from './conversation-reading-anchor.js'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useClientUiOwnerDocument } from '../platform.js'
import { ConversationBodyWork, conversationReadingNode, conversationScrollParent, type ConversationReadingGeometry } from './conversation-body-work.js'
import { conversationRecordId, conversationRevision } from '@agentmux/core/conversation'
import type { ConversationRecord } from './conversation-records.js'
import { conversationPresentationKey, projectConversationRecordSequence, type ConversationSequence, type ConversationSequenceInsertion } from './conversation-record-sequence.js'
import { useConversationReadingSelection } from './use-conversation-reading-selection.js'

export type ConversationPresentationFrame = { records: readonly ConversationRecord[]; originalRecords: readonly ConversationRecord[] }
/** Exact detail state remounts with its original versions; rendering and focus protection share this identity. */
export function conversationDeferredMountKey(record: ConversationRecord): string | undefined {
  return record.deferred ? JSON.stringify([record.executionHostId, record.sourceHostId,
    record.deferred.records.map(source => [source.id, source.revision])]) : undefined
}
type Placement = { version: string; parent: string | undefined; mount?: string | undefined }
const version = (record: ConversationRecord): string => JSON.stringify([
  conversationRecordId({ agentSessionId: record.agentSessionId, ...(record.sourceHostId ? { hostId: record.sourceHostId } : {}), source: record.source }),
  record.role, record.event?.revision ?? conversationRevision(record.original.item), record.records?.map(original => [original.id, original.revision])
])
function placements(frame: ConversationPresentationFrame, sequence: ConversationSequence): Map<string, Placement> {
  const result = new Map<string, Placement>(frame.records.map(record => {
    const key = conversationPresentationKey(record)
    return [key, { version: version(record), parent: sequence.groups.get(key), mount: conversationDeferredMountKey(record) }] as const
  }))
  const anchor = (key: string, parent?: string) => result.set(JSON.stringify(['anchor', key]), { version: key, parent })
  for (const row of sequence.rows) {
    if (row.kind === 'process') {
      result.set(row.id, { version: JSON.stringify(row.entries.map(entry => entry.kind === 'record'
        ? [conversationPresentationKey(entry.record), version(entry.record)] : ['anchor', entry.kind === 'boundary' ? 'history-boundary' : entry.insertion.key])), parent: undefined })
      for (const entry of row.entries) {
        if (entry.kind === 'anchor') anchor(entry.insertion.key, row.id)
        else if (entry.kind === 'boundary') anchor('history-boundary', row.id)
      }
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
  return conversationReadingNode(node)
}
function protection(root: HTMLElement | null, previous: ReadonlyMap<string, Placement>, incoming: ReadonlyMap<string, Placement>, preserveAnchor: boolean): Protection {
  const document = root?.ownerDocument, selection = document?.defaultView?.getSelection()
  const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null
  const focused = document?.activeElement
  if (range || focused && focused !== document?.body && root?.contains(focused)) {
    for (const node of root?.querySelectorAll<HTMLElement>('[data-conversation-layout-key]') ?? []) {
      const key = node.dataset.conversationLayoutKey!, prior = previous.get(key), next = incoming.get(key)
      if (prior && next && prior.version === next.version && prior.parent === next.parent && prior.mount === next.mount) continue
      const protectedNode = readingNode(node) ?? node
      try { if (range?.intersectsNode(protectedNode)) return 'selection' } catch { return 'selection' }
      // Ordinary same-node updates retain focus. Exact deferred detail state has a
      // versioned mount key: replacing it removes its controls even in the same parent.
      if (focused && focused !== document?.body && protectedNode.contains(focused) &&
        (!next || prior?.parent !== next.parent || prior?.mount !== next.mount)) return 'focus'
    }
  }
  if (preserveAnchor) {
    const displaced = (key: string) => {
      const prior = previous.get(key), next = incoming.get(key)
      return !next || prior?.parent !== next.parent || prior?.mount !== next.mount
    }
    // A frame retaining every mounted placement cannot retire the reading
    // anchor. Keep ordinary streamed appends out of the geometry path.
    for (const key of previous.keys()) {
      if (!displaced(key)) continue
      const anchor = currentAnchorKey(root, previous)
      if (anchor && displaced(anchor)) return 'anchor'
      break
    }
  }
  return null
}
const scrollParent = conversationScrollParent
const readingKeySelector = '[data-conversation-layout-key]'
function currentAnchorKey(root: HTMLElement | null, placements: ReadonlyMap<string, Placement>): string | null {
  const viewport = scrollParent(root)
  if (!viewport || !root) return null
  const bounds = viewport.getBoundingClientRect()
  if (bounds.height <= 0) return null
  const anchorFor = (node: HTMLElement): string | null => {
    const rect = readingNode(node)?.getBoundingClientRect()
    if (!rect || rect.height <= 0 || rect.bottom <= bounds.top || rect.top >= bounds.bottom) return null
    // Expanded deferred detail can supply visible nested rows, while its
    // owning shell determines whether that exact detail remains mounted.
    for (let shell: HTMLElement | null = node; shell && shell !== root && root.contains(shell); shell = shell.parentElement?.closest<HTMLElement>(readingKeySelector) ?? null) {
      const key = shell.dataset.conversationLayoutKey!
      if (placements.has(key)) return key
    }
    return null
  }
  const selected = selectedConversationReadingNode(root, readingKeySelector, node => anchorFor(node) !== null,
    () => root.querySelectorAll<HTMLElement>(readingKeySelector))
  if (selected) return anchorFor(selected)
  for (const node of root.querySelectorAll<HTMLElement>(readingKeySelector)) {
    const anchor = anchorFor(node)
    if (anchor) return anchor
  }
  return null
}

/** One complete presentation transaction; pending data is always the current props.
 * It retains accepted frame references, never another reader or copied message body. */
export function useConversationRecordLayout<T extends ConversationPresentationFrame>(frame: T, sourceKey: string, {
  beforeRecordId, anchors = [], active = true, intent, presentation, geometry
}: { beforeRecordId?: string; anchors?: readonly ConversationSequenceInsertion[]; active?: boolean; intent?: unknown; presentation?: ConversationPresentationPort; geometry?: ConversationReadingGeometry } = {}) {
  const root = useRef<HTMLElement>(null)
  const [bodyWork] = useState(() => new ConversationBodyWork())
  const ownerDocument = useClientUiOwnerDocument()
  const committed = useRef<{ source: string; frame: T; sequence: ConversationSequence; placements: Map<string, Placement>; intent: unknown } | null>(null)
  const [, changed] = useState(0)
  const pendingReason = useRef<Protection>(null)
  const prior = committed.current?.source === sourceKey ? committed.current : null
  const anchorPositions = JSON.stringify(anchors.map(({ key, beforeRecordId }) => [key, beforeRecordId]))
  // Committing this projection changes the retained groups, not its structural input.
  // Reuse it for local disclosure/selection updates; only new records or slots reproject.
  const sequence = useMemo(() => projectConversationRecordSequence(frame.records, sourceKey, prior?.sequence.groups, beforeRecordId, anchors,
    new Set(prior?.sequence.rows.flatMap(row => row.kind === 'record' ? [conversationPresentationKey(row.record)] : []))),
    [frame.records, sourceKey, beforeRecordId, anchorPositions])
  const incoming = useMemo(() => placements(frame, sequence), [frame.records, frame.originalRecords, sequence])
  const changedFrame = prior !== null && prior.frame !== frame
  const document = root.current?.ownerDocument
  const preserve = Boolean(active && prior && Object.is(prior.intent, intent) && !geometry?.following())
  const reason = prior && active && changedFrame ? protection(root.current, prior.placements, incoming, preserve) : null
  const held = reason !== null
  const accepted = held && prior ? prior : { source: sourceKey, frame, sequence, placements: incoming, intent }
  useLayoutEffect(() => { bodyWork.connect(root.current, active, geometry) })
  useLayoutEffect(() => { bodyWork.updateShells() }, [bodyWork, accepted.sequence, active, ownerDocument])
  useLayoutEffect(() => () => bodyWork.disconnect(), [bodyWork])
  useLayoutEffect(() => {
    committed.current = accepted
    if (presentation) presentation.controller.current = {
      canPresent: (candidate, options) => {
        if (!active) return true
        const boundary = candidate.records.find(record => conversationPresentationKey(record) === options?.beforeRecordId
          || record.source.kind === 'native' && record.rawId === options?.beforeRecordId)
        const next = projectConversationRecordSequence(candidate.records, sourceKey, accepted.sequence.groups,
          boundary ? conversationPresentationKey(boundary) : undefined, anchors,
          new Set(accepted.sequence.rows.flatMap(row => row.kind === 'record' ? [conversationPresentationKey(row.record)] : [])))
        pendingReason.current = protection(root.current, accepted.placements, placements(candidate, next), options?.preserveAnchor !== false && !geometry?.following())
        return pendingReason.current === null
      }
    }
  })
  useConversationReadingSelection(root, incoming, active, () => {
    if ((held || presentation?.pending || presentation?.watchSelection)
      && (held || presentation?.pending || root.current?.ownerDocument.defaultView?.getSelection()?.isCollapsed !== false)) presentation?.onRelease()
  })
  useEffect(() => {
    if (!active) return
    const viewport = reason === 'anchor' || presentation?.pending && pendingReason.current === 'anchor' ? scrollParent(root.current) : null
    if (!viewport) return
    const update = () => {
      if (held) changed(value => value + 1)
      presentation?.onRelease()
    }
    viewport.addEventListener('scroll', update)
    return () => viewport.removeEventListener('scroll', update)
  }, [held, reason, document, active, presentation?.pending, presentation?.watchSelection, presentation?.onRelease])
  useLayoutEffect(() => () => { if (presentation) presentation.controller.current = null }, [presentation?.controller])
  return { ...accepted.frame, sequence: accepted.sequence, root, bodyWork, preserve, held: held || Boolean(presentation?.pending), reason: reason ?? (presentation?.pending ? pendingReason.current : null) }
}
