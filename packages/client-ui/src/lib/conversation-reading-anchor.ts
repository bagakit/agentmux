import type { AgentSessionHistoryPage, AgentSessionUserMessage } from '@agentmux/core'
import { projectConversationRecordSequence } from './conversation-record-sequence'
import { conversationMessageSourceKey } from './conversation-message-location'

export type ConversationWindowProjection = { current: AgentSessionHistoryPage | null; recordBoundary?: { beforeRecordId: string } }
type ReadingAnchor = { kind: 'record' | 'group' | 'segment'; id: string; offset: number }
export function conversationReadingAnchor(viewport: HTMLElement, observedScope?: HTMLElement | null, nativeOnly = false): ReadingAnchor | null {
  const bounds = viewport.getBoundingClientRect()
  if (bounds.height <= 0) return null
  // Read the actual mixed DOM order. Source priority would choose a later native
  // row over an earlier captured message once the sources share one sequence.
  for (const row of (observedScope ?? viewport).querySelectorAll<HTMLElement>(nativeOnly
    ? '[data-native-record-id], [data-native-record-ids]' : '[data-segment-key], [data-native-record-id], [data-native-record-ids]')) {
    const rect = row.getBoundingClientRect()
    if (rect.height <= 0 || rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue
    if (row.dataset.segmentKey) return { kind: 'segment', id: row.dataset.segmentKey, offset: rect.top - bounds.top }
    if (row.dataset.nativeRecordId) return { kind: 'record', id: row.dataset.nativeRecordId, offset: rect.top - bounds.top }
    const head = row.querySelector<HTMLElement>('.wf-card--observation > .wf-head[aria-expanded="false"]')
    const headRect = head?.getBoundingClientRect(), id = head?.parentElement?.dataset.observationId
    if (id && headRect && headRect.height > 0 && headRect.bottom > bounds.top && headRect.top < bounds.bottom)
      return { kind: 'group', id, offset: headRect.top - bounds.top }
  }
  return null
}

function rangeIntersectsElement(range: Range, el: HTMLElement): boolean {
  if (!el.isConnected || !range.startContainer.isConnected || !range.endContainer.isConnected) return true
  try { return range.intersectsNode(el) }
  catch { return true }
}

/** Check real retained nodes before replacing any displayed raw record, including a cross-page Range. */
export function protectsConversationWindow(viewport: HTMLElement | null, next: AgentSessionHistoryPage, preserveAnchor = true, currentOriginal?: AgentSessionHistoryPage, projection?: ConversationWindowProjection, nativeInputs?: readonly AgentSessionUserMessage[]): boolean {
  if (!viewport) return false
  const retained = new Set(next.items.map(item => item.id))
  // Entering the original window can leave unselected context outside that window.
  const original = currentOriginal ? new Set(currentOriginal.items.map(item => item.id)) : null
  const source = JSON.stringify([next.source.providerId, next.source.nativeSessionId])
  const sameSource = (node: HTMLElement): boolean => node.closest<HTMLElement>('[data-native-source]')?.dataset.nativeSource === source
  const anchor = conversationReadingAnchor(viewport)
  if (preserveAnchor && anchor?.kind === 'record' && (!original || original.has(anchor.id)) && !retained.has(anchor.id)) return true
  if (preserveAnchor && anchor?.kind === 'group') {
    const article = [...viewport.querySelectorAll<HTMLElement>('[data-observation-id]')].find(node => node.dataset.observationId === anchor.id)
    const ids: string[] = JSON.parse(article?.closest<HTMLElement>('[data-native-record-ids]')?.dataset.nativeRecordIds ?? '[]')
    if (ids.length && (!original || ids.some(id => original.has(id))) && !ids.some(id => retained.has(id))) return true
  }
  const selection = viewport.ownerDocument.defaultView?.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false
  // Taking over a fallback input moves it to another parent even if its raw ID is retained.
  const inputKeys = new Set(nativeInputs?.filter(message => message.agentSessionId === next.agentSessionId
    && message.source.kind === 'native' && message.source.providerId === next.source.providerId
    && message.source.nativeSessionId === next.source.nativeSessionId)
    .map(message => conversationMessageSourceKey(message.agentSessionId, message.source)))
  if (next.items.length && inputKeys.size) for (const row of viewport.querySelectorAll<HTMLElement>('[data-segment-key] .log-turn[data-message-source-key]')) {
    if (inputKeys.has(row.dataset.messageSourceKey) && rangeIntersectsElement(selection.getRangeAt(0), row)) return true
  }
  for (const row of viewport.querySelectorAll<HTMLElement>('[data-native-record-id]')) {
    const id = row.dataset.nativeRecordId!, original = projection?.current?.items.find(item => item.id === id), nextItem = next.items.find(item => item.id === id)
    if ((!sameSource(row) || !retained.has(id) || original && nextItem && original !== nextItem && JSON.stringify(original) !== JSON.stringify(nextItem)) && rangeIntersectsElement(selection.getRangeAt(0), row)) return true
  }
  const selectedGroups = [...viewport.querySelectorAll<HTMLElement>('[data-native-record-ids]')].filter(group => {
    const head = group.querySelector<HTMLElement>('.wf-card--observation > .wf-head')
    return head && rangeIntersectsElement(selection.getRangeAt(0), head)
  })
  if (!selectedGroups.length) return false
  const current = projection?.current
  if (!current || current.agentSessionId !== next.agentSessionId || current.source.providerId !== next.source.providerId
    || current.source.nativeSessionId !== next.source.nativeSessionId) return true
  const previous = new Map<string, string>()
  for (const group of viewport.querySelectorAll<HTMLElement>('[data-native-record-ids]')) {
    if (!sameSource(group)) continue
    const id = group.querySelector<HTMLElement>('[data-observation-id]')?.dataset.observationId
    if (id) for (const recordId of JSON.parse(group.dataset.nativeRecordIds ?? '[]') as string[]) previous.set(recordId, id)
  }
  const sourceKey = JSON.stringify([next.agentSessionId, next.source.providerId, next.source.nativeSessionId])
  const projected = projectConversationRecordSequence(next.items, sourceKey, previous, projection?.recordBoundary?.beforeRecordId)
  const nextGroups = new Map(projected.rows.flatMap(row => row.kind === 'process' ? [[row.id, row.items] as const] : []))
  const currentItems = new Map(current.items.map(item => [item.id, item]))
  for (const group of selectedGroups) {
    if (!sameSource(group)) return true
    const id = group.querySelector<HTMLElement>('[data-observation-id]')?.dataset.observationId
    const ids = JSON.parse(group.dataset.nativeRecordIds ?? '[]') as string[]
    const items = id ? nextGroups.get(id) : undefined
    if (!items || items.length !== ids.length || items.some((item, index) => {
      const original = currentItems.get(ids[index]!)
      return item.id !== ids[index] || !original || original !== item && JSON.stringify(original) !== JSON.stringify(item)
    })) return true
  }
  return false
}

export function restoreConversationAnchor(viewport: HTMLElement, anchor: ReadingAnchor, tailSpace?: HTMLElement | null): void {
  const row = anchor.kind === 'segment'
    ? [...viewport.querySelectorAll<HTMLElement>('[data-segment-key]')].find(node => node.dataset.segmentKey === anchor.id)
    : anchor.kind === 'record'
    ? [...viewport.querySelectorAll<HTMLElement>('[data-native-record-id]')].find(node => node.dataset.nativeRecordId === anchor.id)
    : [...viewport.querySelectorAll<HTMLElement>('[data-observation-id]')].find(node => node.dataset.observationId === anchor.id)
      ?.querySelector<HTMLElement>(':scope > .wf-head[aria-expanded="false"]')
  if (!row) return
  const bounds = viewport.getBoundingClientRect(), rect = row.getBoundingClientRect()
  if (bounds.height <= 0 || rect.height <= 0) return
  const target = viewport.scrollTop + rect.top - bounds.top - anchor.offset
  viewport.scrollTop = target
  if (tailSpace && (viewport.scrollTop < target || tailSpace.style.height)) {
    // A folded, underfilled page otherwise clamps the accepted Earlier anchor at zero.
    // Keep only the blank extent needed for this position, outside both reading tails.
    const end = viewport.scrollTop + tailSpace.getBoundingClientRect().top - bounds.top
      + (Number.parseFloat(getComputedStyle(viewport).paddingBottom) || 0)
    const height = Math.min(viewport.clientHeight, Math.max(0, target + viewport.clientHeight - end))
    const value = height ? `${height}px` : ''
    if (tailSpace.style.height !== value) tailSpace.style.height = value
    viewport.scrollTop = target
  }
}
