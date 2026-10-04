import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { api } from './api'
import type { AgentTimelineItem } from '../../../shared/contracts'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { readSessionConversationPage } from './session-user-messages'

type ReadingAnchor = { kind: 'record' | 'group'; id: string; offset: number }
export type ConversationReading = {
  reference: SessionHistoryReference
  /** A live Run fences the window; a retired Session needs no invented Run. */
  identity: string
  enabled: boolean
  opened?: boolean
  onClose?: (() => void) | undefined
  readCaptured?: boolean
  returnLabel?: string
}
type ReadingWindow = { page: AgentSessionHistoryPage; newerOutside: boolean }
const PAGE_COUNT = 3
const RECORD_COUNT = 400
const PAGE_BYTES = 12 * 1024 * 1024

export function conversationReadingAnchor(viewport: HTMLElement): ReadingAnchor | null {
  const bounds = viewport.getBoundingClientRect()
  if (bounds.height <= 0) return null
  for (const row of viewport.querySelectorAll<HTMLElement>('[data-native-record-id]')) {
    const rect = row.getBoundingClientRect()
    if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) {
      return { kind: 'record', id: row.dataset.nativeRecordId!, offset: rect.top - bounds.top }
    }
  }
  // Only a truly collapsed group may provide geometry while its real raw rows are hidden.
  for (const group of viewport.querySelectorAll<HTMLElement>('[data-native-record-ids]')) {
    const head = group.querySelector<HTMLElement>('.wf-card--observation > .wf-head[aria-expanded="false"]')
    if (!head) continue
    const rect = head.getBoundingClientRect()
    if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) {
      const id = head.parentElement?.dataset.observationId
      if (id) return { kind: 'group', id, offset: rect.top - bounds.top }
    }
  }
  return null
}

function rangeIntersectsElement(range: Range, el: HTMLElement): boolean {
  if (!el.isConnected || !range.startContainer.isConnected || !range.endContainer.isConnected) return true
  try { return range.intersectsNode(el) }
  catch { return true }
}

/** Check real retained nodes before replacing any displayed raw record, including a cross-page Range. */
export function protectsConversationWindow(viewport: HTMLElement | null, next: AgentSessionHistoryPage, preserveAnchor = true, currentOriginal?: AgentSessionHistoryPage): boolean {
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
  for (const row of viewport.querySelectorAll<HTMLElement>('[data-native-record-id]')) {
    if ((!sameSource(row) || !retained.has(row.dataset.nativeRecordId!)) && rangeIntersectsElement(selection.getRangeAt(0), row)) return true
  }
  for (const group of viewport.querySelectorAll<HTMLElement>('[data-native-record-ids]')) {
    const head = group.querySelector<HTMLElement>('.wf-card--observation > .wf-head')
    if (head && rangeIntersectsElement(selection.getRangeAt(0), head)) return true
  }
  return false
}

export function restoreConversationAnchor(viewport: HTMLElement, anchor: ReadingAnchor): void {
  const row = anchor.kind === 'record'
    ? [...viewport.querySelectorAll<HTMLElement>('[data-native-record-id]')].find(node => node.dataset.nativeRecordId === anchor.id)
    : [...viewport.querySelectorAll<HTMLElement>('[data-observation-id]')].find(node => node.dataset.observationId === anchor.id)
      ?.querySelector<HTMLElement>(':scope > .wf-head[aria-expanded="false"]')
  if (!row) return
  const bounds = viewport.getBoundingClientRect(), rect = row.getBoundingClientRect()
  if (bounds.height > 0 && rect.height > 0) viewport.scrollTop += rect.top - bounds.top - anchor.offset
}

function preserveRecords(page: AgentSessionHistoryPage, before: AgentSessionHistoryPage | null): AgentSessionHistoryPage {
  const old = new Map(before?.items.map(item => [item.id, item]))
  return { ...page, items: page.items.map(item => {
    const original = old.get(item.id)
    return original && JSON.stringify(original) === JSON.stringify(item) ? original : item
  }) }
}

/** Local navigation only. Recent shared facts/observation, Provider parsing and opaque cursors keep their owners. */
export function useSessionConversationWindow(reading: ConversationReading | undefined, recent: AgentSessionHistoryPage | null,
  beforeCommit: (page: AgentSessionHistoryPage, intent: 'current' | 'earlier', currentOriginal?: AgentSessionHistoryPage) => boolean,
  contextItems?: AgentSessionHistoryPage['items']) {
  const currentContext = useMemo(() => recent && contextItems ? { ...recent, items: contextItems } : recent, [recent, contextItems])
  const key = reading ? JSON.stringify([reading.reference.hostId, reading.reference.agentSessionId, reading.identity]) : ''
  const live = useRef({ key, reading, recent, currentContext, beforeCommit }); live.current = { key, reading, recent, currentContext, beforeCommit }
  const [state, setState] = useState<{ key: string; window: ReadingWindow | null; loading: boolean; error: string | null }>({ key, window: null, loading: false, error: null })
  const [captured, setCaptured] = useState<{ key: string; items: AgentTimelineItem[]; error: string | null } | null>(null)
  useEffect(() => {
    if (!reading?.enabled || !reading.readCaptured) return
    let active = true
    void api.sessions.timeline(reading.reference).then(snapshot => {
      if (active && live.current.key === key && live.current.reading?.enabled) setCaptured({ key, items: snapshot.items, error: null })
    }).catch(cause => {
      if (active && live.current.key === key && live.current.reading?.enabled) setCaptured(previous => ({
        key, items: previous?.key === key ? previous.items : [], error: presentError(cause) }))
    })
    return () => { active = false }
  }, [key, reading?.enabled, reading?.readCaptured])
  const stateRef = useRef(state); stateRef.current = state
  const generation = useRef(0), pending = useRef(false), retry = useRef<'current' | 'earlier'>('current')
  const window = state.key === key ? state.window : null
  const historicalPage = useMemo(() => window?.page ?? null, [window])
  const page = historicalPage ?? currentContext
  const pageRef = useRef(page); pageRef.current = page
  function update(next: typeof state) { stateRef.current = next; setState(next) }
  async function read(direction: 'current' | 'earlier'): Promise<void> {
    const start = live.current
    if (!start.reading?.enabled || pending.current) return
    const before = stateRef.current.key === start.key ? stateRef.current.window : null
    const baseline = direction === 'earlier' ? before?.page ?? start.recent : null
    if (baseline && !baseline.nextCursor) return
    const attempt = ++generation.current
    pending.current = true; retry.current = direction
    update({ key: start.key, window: before, loading: true, error: null })
    const current = () => generation.current === attempt && live.current.key === start.key && live.current.reading?.enabled
    try {
      const source = baseline?.source
      const pages: AgentSessionHistoryPage[] = []
      let cursor = baseline?.nextCursor ?? undefined
      let bytes = 0
      const count = PAGE_COUNT
      for (let i = 0; i < count; i++) {
        const next = await readSessionConversationPage(start.reading.reference, {
          ...(cursor ? { cursor } : {}), ...(source ?? pages[0]?.source ? { source: source ?? pages[0]!.source } : {}) })
        if (!current()) return
        bytes += JSON.stringify(next.items).length * 2
        if (bytes > PAGE_BYTES) throw new Error('This original-sequence window exceeds its byte budget. The displayed records are kept.')
        pages.unshift(next); cursor = next.nextCursor ?? undefined
        if (!cursor) break
      }
      const first = pages[0]!
      const nextPage = preserveRecords({ ...first, nextCursor: cursor ?? null,
        items: [...pages.flatMap(page => page.items), ...(baseline?.items ?? [])].slice(0, RECORD_COUNT)
      }, pageRef.current)
      const nextWindow: ReadingWindow = { page: nextPage,
        newerOutside: Boolean(baseline && nextPage.items.at(-1)?.id !== baseline.items.at(-1)?.id) }
      if (JSON.stringify(nextPage.items).length * 2 > PAGE_BYTES) throw new Error('This original-sequence window exceeds its byte budget. The displayed records are kept.')
      if (!live.current.beforeCommit(nextPage, direction, direction === 'earlier' && !before ? start.recent ?? undefined : undefined)) throw new Error('Move your reading position or clear the selection before changing this window. Your reading position, selected content, records and cursor are kept.')
      update({ key: start.key, window: nextWindow, loading: false, error: null })
    } catch (cause) {
      if (current()) update({ key: start.key, window: before, loading: false, error: presentError(cause) })
    } finally {
      if (generation.current === attempt) pending.current = false
    }
  }
  function showCurrent(): void {
    if (!live.current.reading?.enabled) return
    const latest = live.current.currentContext
    if (latest && live.current.beforeCommit(latest, 'current')) {
      generation.current++; pending.current = false
      update({ key, window: null, loading: false, error: null })
    } else if (!latest) void read('current')
    else update({ ...stateRef.current, error: 'The current window is kept to preserve selected content.' })
  }
  useEffect(() => {
    generation.current++; pending.current = false
    update({ key, window: null, loading: false, error: null })
  }, [key])
  useEffect(() => {
    if (!reading?.enabled) {
      generation.current++; pending.current = false
      if (stateRef.current.loading) update({ ...stateRef.current, loading: false })
      return
    }
    if (reading.opened && !stateRef.current.window) void read('current')
  }, [key, reading?.enabled, reading?.opened])
  useEffect(() => () => { generation.current++; pending.current = false }, [])
  return { page, captured: captured?.key === key ? captured.items : null, capturedError: captured?.key === key ? captured.error : null, historical: Boolean(window), loading: state.key === key && state.loading, error: state.key === key ? state.error : null,
    newerOutside: window?.newerOutside ?? false, hasMore: Boolean(page?.nextCursor),
    readEarlier: () => void read('earlier'), retry: () => void read(retry.current), showCurrent }
}
