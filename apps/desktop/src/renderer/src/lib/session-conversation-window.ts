import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionHistoryPage, AgentSessionHistorySource } from '@agentmux/core'
import { api } from './api'
import type { AgentTimelineItem } from '../../../shared/contracts'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { readSessionConversationPage } from './session-user-messages'
import { nativeBindingKey, type AgentNativeSourceFacts } from '../../../shared/agent-native-source'
import { projectConversationRecordSequence } from '@agentmux/client-ui/conversation-record-sequence'

type ReadingAnchor = { kind: 'record' | 'group' | 'segment'; id: string; offset: number }
export type ConversationReading = {
  reference: SessionHistoryReference
  /** A live Run fences the window; a retired Session needs no invented Run. */
  identity: string
  enabled: boolean
  opened?: boolean
  onClose?: (() => void) | undefined
  readCaptured?: boolean
  returnLabel?: string
  /** Core-confirmed sources; a new binding does not replace an open reading window. */
  nativeSourceFacts?: AgentNativeSourceFacts
}
type PagePosition = { cursor: string | null; limit: number; first: string | null; last: string | null; count: number; next: string | null }
type WindowPart = { index: number; page: AgentSessionHistoryPage; bytes: number; headBytes: number }
type ReadingWindow = {
  bindingKey: string
  page: AgentSessionHistoryPage
  parts: WindowPart[]
  positions: PagePosition[]
  positionBytes: number
  head: WindowPart
  records: Map<string, { part: number; offset: number }>
  newerOutside: boolean
  /** The first raw record actually displayed before earlier navigation, never a time/body match. */
  boundary: { recordId: string; confirmed: boolean } | null
}
export type ConversationReadingIntent = 'current' | 'seed' | 'earlier' | 'newer' | 'coverage' | 'live'
/** Exact committed DOM source and the next renderer boundary, independent of seed context. */
export type ConversationWindowProjection = {
  current: AgentSessionHistoryPage | null
  recordBoundary?: { beforeRecordId: string }
}
const PAGE_COUNT = 3
const PAGE_LIMIT = 100
const RECORD_COUNT = 1200
const PAGE_BYTES = 12 * 1024 * 1024
const byteError = 'This original-sequence window and its return positions exceed their byte budget. The displayed records and return path are kept.'
const positionError = 'The original page range changed. The displayed records and return path are kept; use Current to refresh.'
const protectedError = 'Move your reading position or clear the selection before changing this window. Your reading position, selected content, records and cursor are kept.'
const coverageLimit = 'The requested time range exceeds this bounded reading window. Loaded records are kept; scroll earlier to continue.'
const sourceError = 'Native source changed. The displayed records are kept; explicitly open Current source or Previous source.'

function handleSource(handle: AgentNativeSourceFacts['nativeHandle']): AgentSessionHistorySource | undefined {
  return handle?.kind === 'provider' ? { providerId: handle.providerId, nativeSessionId: handle.sessionId } : undefined
}
function matchesSource(a: AgentSessionHistorySource, b: AgentSessionHistorySource | undefined): boolean {
  return !!b && a.providerId === b.providerId && a.nativeSessionId === b.nativeSessionId
}
function nativeSourceOption(source: AgentSessionHistorySource | undefined, facts: AgentNativeSourceFacts | undefined): 'previous' | undefined {
  const current = handleSource(facts?.nativeHandle)
  if (!source || !current || matchesSource(source, current)) return undefined
  if (matchesSource(source, handleSource(facts?.nativeConfirmation?.previousNativeHandle))) return 'previous'
  throw new Error('This original conversation window is retained. Its source is no longer available for paging; explicitly open Current source or Previous source.')
}

export function conversationReadingAnchor(viewport: HTMLElement, observedScope?: HTMLElement | null): ReadingAnchor | null {
  const bounds = viewport.getBoundingClientRect()
  if (bounds.height <= 0) return null
  if (observedScope) for (const row of observedScope.querySelectorAll<HTMLElement>('[data-segment-key]')) {
    const rect = row.getBoundingClientRect()
    if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) {
      return { kind: 'segment', id: row.dataset.segmentKey!, offset: rect.top - bounds.top }
    }
  }
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
export function protectsConversationWindow(viewport: HTMLElement | null, next: AgentSessionHistoryPage, preserveAnchor = true, currentOriginal?: AgentSessionHistoryPage, projection?: ConversationWindowProjection): boolean {
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

export function restoreConversationAnchor(viewport: HTMLElement, anchor: ReadingAnchor): void {
  const row = anchor.kind === 'segment'
    ? [...viewport.querySelectorAll<HTMLElement>('[data-segment-key]')].find(node => node.dataset.segmentKey === anchor.id)
    : anchor.kind === 'record'
    ? [...viewport.querySelectorAll<HTMLElement>('[data-native-record-id]')].find(node => node.dataset.nativeRecordId === anchor.id)
    : [...viewport.querySelectorAll<HTMLElement>('[data-observation-id]')].find(node => node.dataset.observationId === anchor.id)
      ?.querySelector<HTMLElement>(':scope > .wf-head[aria-expanded="false"]')
  if (!row) return
  const bounds = viewport.getBoundingClientRect(), rect = row.getBoundingClientRect()
  if (bounds.height > 0 && rect.height > 0) viewport.scrollTop += rect.top - bounds.top - anchor.offset
}

function sameSource(a: AgentSessionHistoryPage, b: AgentSessionHistoryPage): boolean {
  return a.agentSessionId === b.agentSessionId && a.source.providerId === b.source.providerId && a.source.nativeSessionId === b.source.nativeSessionId
}
function recordBytes(item: AgentSessionHistoryPage['items'][number]): number { return JSON.stringify(item).length * 2 }
function position(page: AgentSessionHistoryPage, cursor: string | null, limit = PAGE_LIMIT): PagePosition {
  return { cursor, limit, first: page.items[0]?.id ?? null, last: page.items.at(-1)?.id ?? null, count: page.items.length, next: page.nextCursor }
}
function verifies(page: AgentSessionHistoryPage, expected: PagePosition): boolean {
  return page.items.length === expected.count && page.items[0]?.id === (expected.first ?? undefined)
    && page.items.at(-1)?.id === (expected.last ?? undefined) && page.nextCursor === expected.next
}
function part(page: AgentSessionHistoryPage, index: number, before?: ReadingWindow): WindowPart {
  let bytes = 0
  const items = page.items.map(item => {
    const at = before?.records.get(item.id)
    const original = at ? before!.parts[at.part]!.page.items[at.offset] : undefined
    const size = recordBytes(item); bytes += size
    return original && (original === item || JSON.stringify(original) === JSON.stringify(item)) ? original : item
  })
  return { index, page: { ...page, items }, bytes, headBytes: 0 }
}
function assemble(parts: WindowPart[], positions: PagePosition[], head: WindowPart,
  boundary: ReadingWindow['boundary'], newerOutside: boolean, trim: 'earlier' | 'newer' | null, positionBytes: number, bindingKey: string): ReadingWindow {
  const count = () => parts.reduce((sum, p) => sum + p.page.items.length, 0) + (parts.some(p => p.index === 0) ? 0 : head.page.items.length)
  while (count() > RECORD_COUNT && parts.length > 1 && trim) parts = trim === 'earlier' ? parts.slice(1) : parts.slice(0, -1)
  if (count() > RECORD_COUNT) throw new Error(byteError)
  const bytes = parts.reduce((sum, p) => sum + p.bytes - p.headBytes, head.bytes) + positionBytes
  if (bytes > PAGE_BYTES) throw new Error(byteError)
  const records = new Map<string, { part: number; offset: number }>()
  parts.forEach((p, index) => p.page.items.forEach((item, offset) => {
    if (records.has(item.id)) throw new Error(positionError)
    records.set(item.id, { part: index, offset })
  }))
  const oldest = parts.at(-1)!
  const page = { ...oldest.page, items: [...parts].reverse().flatMap(p => p.page.items) }
  return { bindingKey, page, parts, positions, positionBytes, head, records, newerOutside,
    boundary: boundary ? { ...boundary, confirmed: boundary.confirmed || records.has(boundary.recordId) } : null }
}

/** Local navigation only. Recent shared facts/observation, Provider parsing and opaque cursors keep their owners. */
/** A recorded span is not proof of complete time coverage. Untimed pages keep source order. */
function needsTimeCoverage(page: AgentSessionHistoryPage, duration: number): boolean {
  if (!page.nextCursor) return false
  if (duration === Infinity) return true
  let first = Infinity, last = -Infinity
  for (const item of page.items) if (item.startedAt !== undefined && Number.isFinite(item.startedAt)) {
    first = Math.min(first, item.startedAt); last = Math.max(last, item.startedAt)
  }
  return Number.isFinite(first) && last - first < duration
}

export function useSessionConversationWindow(reading: ConversationReading | undefined, recent: AgentSessionHistoryPage | null,
  beforeCommit: (page: AgentSessionHistoryPage, intent: ConversationReadingIntent, currentOriginal?: AgentSessionHistoryPage, projection?: ConversationWindowProjection) => boolean,
  contextItems?: AgentSessionHistoryPage['items'], coverageDuration = 24 * 3_600_000) {
  const currentContext = useMemo(() => recent && contextItems ? { ...recent, items: contextItems } : recent, [recent, contextItems])
  const key = reading ? JSON.stringify([reading.reference.hostId, reading.reference.agentSessionId, reading.identity]) : ''
  const bindingKey = reading?.nativeSourceFacts ? nativeBindingKey(reading.nativeSourceFacts) : ''
  const live = useRef({ key, bindingKey, reading, recent, currentContext, beforeCommit, coverageDuration }); live.current = { key, bindingKey, reading, recent, currentContext, beforeCommit, coverageDuration }
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
  type ReadDirection = 'current' | 'seed' | 'earlier' | 'newer' | 'coverage'
  const generation = useRef(0), pending = useRef(false), retry = useRef<{ direction: ReadDirection; source?: AgentSessionHistorySource }>({ direction: 'seed' })
  const appliedRecent = useRef<AgentSessionHistoryPage | null>(null)
  const automaticSeedBlocked = useRef(false)
  // One attempt per exact observed page and native binding, never a render-driven retry.
  const automaticLatest = useRef<{ key: string; bindingKey: string; recent: AgentSessionHistoryPage; interrupted: boolean } | null>(null)
  const coverageDemand = useRef(false)
  const window = state.key === key ? state.window : null
  const committedPage = useRef<{ key: string; bindingKey: string; page: AgentSessionHistoryPage | null }>({ key, bindingKey, page: null })
  const retained = committedPage.current.key === key ? committedPage.current : null
  // A failed/unfinished initial read has the same preservation contract as a full window.
  const keepContext = !window && reading && retained?.page && (retained.bindingKey !== bindingKey || currentContext && !sameSource(retained.page, currentContext))
  const page = window?.page ?? (keepContext ? retained.page : currentContext)
  useLayoutEffect(() => {
    committedPage.current = { key, bindingKey: window?.bindingKey ?? (keepContext ? retained!.bindingKey : bindingKey), page }
  }, [key, bindingKey, window, page, keepContext])
  const pageRef = useRef(page); pageRef.current = page
  function update(next: typeof state) { stateRef.current = next; setState(next) }
  function allowsWindow(next: ReadingWindow, intent: ConversationReadingIntent, currentOriginal?: AgentSessionHistoryPage): boolean {
    const committed = committedPage.current
    return live.current.beforeCommit(next.page, intent, currentOriginal, {
      current: committed.key === live.current.key ? committed.page : null,
      ...(next.boundary?.confirmed && next.records.has(next.boundary.recordId)
        ? { recordBoundary: { beforeRecordId: next.boundary.recordId } } : {})
    })
  }
  async function read(direction: ReadDirection, selectedSource?: AgentSessionHistorySource, retryPage = false): Promise<void> {
    const start = live.current
    if (!start.reading?.enabled) return
    if (direction === 'earlier' || direction === 'newer') {
      coverageDemand.current = false
      if (pending.current && retry.current.direction === 'coverage') { generation.current++; pending.current = false }
    }
    if (pending.current) return
    const before = stateRef.current.key === start.key ? stateRef.current.window : null
    const displayed = pageRef.current
    const navigation = before && (direction === 'earlier' || direction === 'newer' || direction === 'coverage')
    if (navigation && direction !== 'newer' && !before.page.nextCursor) return
    if (navigation && direction === 'newer' && before.parts[0]!.index === 0) return
    const attempt = ++generation.current
    pending.current = true; retry.current = { direction, ...(selectedSource ? { source: selectedSource } : {}) }
    update({ key: start.key, window: before, loading: true, error: null })
    const current = () => generation.current === attempt && live.current.key === start.key && live.current.reading?.enabled
      && live.current.bindingKey === start.bindingKey
      && (start.reading?.nativeSourceFacts || !start.recent || !live.current.recent || sameSource(start.recent, live.current.recent))
    try {
      let parts = navigation ? [...before.parts] : []
      const positions = navigation ? [...before.positions] : []
      let positionBytes = navigation ? before.positionBytes : 0
      let head = navigation ? before.head : undefined
      if (navigation && direction === 'earlier' && before.parts[0]!.index === 0) {
        // Freeze the real current head, including continuous live updates already read in this epoch.
        // This is a snapshot object, never another null-cursor request.
        head = { ...parts[0]!, headBytes: parts[0]!.bytes }
        parts[0] = head
        const frozen = position(head.page, null)
        positionBytes += (JSON.stringify(frozen).length - JSON.stringify(positions[0]).length) * 2
        positions[0] = frozen
      }
      let index = navigation ? direction !== 'newer' ? parts.at(-1)!.index + 1 : parts[0]!.index - 1 : 0
      let cursor = navigation && direction !== 'newer' ? parts.at(-1)!.page.nextCursor : null
      const source = selectedSource ?? (navigation ? before.page.source : start.reading.nativeSourceFacts
        ? before?.page.source ?? displayed?.source ?? handleSource(start.reading.nativeSourceFacts.nativeHandle) ?? start.recent?.source
        : direction === 'seed' ? start.recent?.source : undefined)
      const nativeSource = nativeSourceOption(source, start.reading.nativeSourceFacts)
      let incomingBytes = 0
      let accepted = before
      for (let i = 0; i < PAGE_COUNT; i++) {
        if (direction === 'coverage' && accepted && !(retryPage && i === 0) && !needsTimeCoverage(accepted.page, live.current.coverageDuration)) break
        const retainedCount = parts.reduce((sum, p) => sum + p.page.items.length, 0)
          + (head && !parts.some(p => p.index === 0) ? head.page.items.length : 0)
        if (direction === 'coverage' && retainedCount >= RECORD_COUNT) throw new Error(coverageLimit)
        const expected = positions[index]
        const input = expected?.cursor ?? cursor
        const limit = expected?.limit ?? (direction === 'coverage' ? Math.min(PAGE_LIMIT, RECORD_COUNT - retainedCount) : PAGE_LIMIT)
        const next = index === 0 && head ? head.page : await readSessionConversationPage(start.reading.reference, {
          limit, ...(input ? { cursor: input } : {}),
          ...(nativeSource ? { nativeSource } : {}),
          ...(source ?? parts[0]?.page.source ? { source: source ?? parts[0]!.page.source } : {}) })
        if (!current()) return
        if (source && !matchesSource(source, next.source)) throw new Error(sourceError)
        if (parts.length && !sameSource(parts[0]!.page, next)) throw new Error(sourceError)
        if (expected && !verifies(next, expected)) throw new Error(positionError)
        const nextPart = index === 0 && head ? head : part(next, index, before ?? undefined)
        incomingBytes += nextPart.bytes
        if (incomingBytes > PAGE_BYTES) throw new Error(byteError)
        if (!head) { head = nextPart; head.headBytes = head.bytes }
        if (!expected) {
          const entry = position(next, input, limit)
          positions.push(entry); positionBytes += JSON.stringify(entry).length * 2
        }
        if (direction === 'newer' && navigation) parts.unshift(nextPart)
        else parts.push(nextPart)
        if (!navigation || direction === 'coverage') {
          const prefix = assemble([...parts], [...positions], head, navigation ? before.boundary : null,
            navigation ? before.newerOutside : false, null, positionBytes, start.bindingKey)
          if (!allowsWindow(prefix, direction, !before ? start.recent ?? undefined : undefined)) throw new Error(protectedError)
          accepted = prefix
          appliedRecent.current = start.recent
          update({ key: start.key, window: prefix, loading: true, error: null })
          if (needsTimeCoverage(prefix.page, live.current.coverageDuration) === false && prefix.page.items.some(item => item.startedAt !== undefined)) break
        }
        if (navigation && direction === 'newer') {
          if (index === 0) break
          index--
        } else {
          cursor = next.nextCursor
          if (!cursor) break
          index++
        }
      }
      if (!head || !parts.length) throw new Error('No original conversation page was returned. The displayed records are kept.')
      const boundary = navigation && direction === 'earlier' ? before.boundary ?? (displayed && sameSource(displayed, parts[0]!.page) && displayed.items[0]
        ? { recordId: displayed.items[0].id, confirmed: false } : null) : navigation ? before.boundary : null
      const nextWindow = assemble(parts, positions, head, boundary,
        navigation ? direction === 'coverage' ? before.newerOutside : parts[0]!.index > 0 : false,
        navigation && direction !== 'coverage' ? direction as 'earlier' | 'newer' : null, positionBytes, start.bindingKey)
      if (!allowsWindow(nextWindow, direction, !before ? start.recent ?? undefined : undefined)) throw new Error(protectedError)
      appliedRecent.current = navigation && direction === 'newer' ? null : start.recent
      automaticSeedBlocked.current = false
      if (direction === 'seed' || direction === 'current') coverageDemand.current = true
      update({ key: start.key, window: nextWindow, loading: false, error: null })
    } catch (cause) {
      if (current()) {
        coverageDemand.current = false
        const retained = direction === 'seed' || direction === 'current' || direction === 'coverage' ? stateRef.current.window : before
        if ((direction === 'seed' || direction === 'current') && retained && retained !== before)
          retry.current = { direction: 'coverage', source: retained.page.source }
        update({ key: start.key, window: retained, loading: false, error: presentError(cause) })
      }
    } finally {
      if (generation.current === attempt) {
        pending.current = false
        if (live.current.key === start.key && live.current.reading?.enabled && stateRef.current.loading)
          update({ ...stateRef.current, loading: false, error: sourceError })
      }
    }
  }
  function showCurrent(source?: AgentSessionHistorySource): void {
    if (!live.current.reading?.enabled) return
    generation.current++; pending.current = false; automaticSeedBlocked.current = false
    void read('current', source)
  }
  function showLatestAutomatically(): void {
    const start = live.current
    const before = stateRef.current.key === start.key ? stateRef.current.window : null
    const attempt = automaticLatest.current
    if (!start.reading?.enabled || pending.current || !before || before.parts[0]!.index !== 0
      || before.bindingKey !== start.bindingKey || !start.recent || !sameSource(before.page, start.recent)) return
    if (stateRef.current.error && !attempt?.interrupted) return
    if (attempt?.key === start.key && attempt.bindingKey === start.bindingKey
      && attempt.recent === start.recent && !attempt.interrupted) return
    automaticLatest.current = { key: start.key, bindingKey: start.bindingKey, recent: start.recent,
      interrupted: false }
    void read('seed')
  }
  useEffect(() => {
    automaticLatest.current = null
    generation.current++; pending.current = false; appliedRecent.current = null; automaticSeedBlocked.current = false; coverageDemand.current = false
    update({ key, window: null, loading: false, error: null })
  }, [key])
  useEffect(() => {
    if (!reading?.enabled) {
      // Hiding is cancellation, not a failed native read. A visible current-tail
      // consumer may resume this seed once; genuine failures still require Retry.
      if (pending.current && retry.current.direction === 'seed' && live.current.recent) automaticLatest.current = {
        key, bindingKey, recent: live.current.recent, interrupted: true }
      coverageDemand.current = false
      generation.current++; pending.current = false
      if (stateRef.current.loading) update({ ...stateRef.current, loading: false,
        error: 'Reading paused while hidden. The displayed records are kept; use Current or Retry.' })
      return
    }
    if (!stateRef.current.window) void read('seed')
  }, [key, reading?.enabled])
  useEffect(() => {
    if (page && (window && window.bindingKey !== bindingKey || keepContext)) update({ ...stateRef.current, error: sourceError })
  }, [key, bindingKey, keepContext])
  // Only the original continuous shared page can extend a current tail; sparse presentation facts cannot.
  useEffect(() => {
    const before = stateRef.current.key === key ? stateRef.current.window : null
    if (!reading?.enabled || !recent?.items.length || !before || before.parts[0]!.index !== 0 || pending.current || appliedRecent.current === recent) return
    appliedRecent.current = recent
    if (before.bindingKey !== bindingKey || !sameSource(recent, before.page)) {
      // Explicitly selected previous sources have no live tail to follow.
      if (before.bindingKey !== bindingKey || !matchesSource(before.page.source, handleSource(reading?.nativeSourceFacts?.nativeConfirmation?.previousNativeHandle)))
        update({ ...stateRef.current, error: reading?.nativeSourceFacts ? sourceError : 'Native source changed. The current window is kept; use Current to refresh.' })
      return
    }
    const tail = before.page.items.at(-1)?.id
    const tailAt = tail ? recent.items.findIndex(item => item.id === tail) : -1
    if (tailAt < 0 && !before.records.has(recent.items.at(-1)?.id ?? '')) {
      if (tail && !before.newerOutside) update({ ...stateRef.current, window: { ...before, newerOutside: true } })
      return
    }
    const changed = new Map<number, Map<number, AgentSessionHistoryPage['items'][number]>>()
    let changedBytes = 0, changedHeadBytes = 0
    for (const item of recent.items) {
      const at = before.records.get(item.id)
      if (!at) continue
      const original = before.parts[at.part]!.page.items[at.offset]!
      if (original === item || JSON.stringify(original) === JSON.stringify(item)) continue
      if (!changed.has(at.part)) changed.set(at.part, new Map())
      changed.get(at.part)!.set(at.offset, item)
    }
    const appended = tailAt < 0 ? [] : recent.items.slice(tailAt + 1)
    if (!changed.size && !appended.length) return
    const parts = before.parts.map((p, index) => {
      const changes = changed.get(index)
      if (!changes && (index !== 0 || !appended.length)) return p
      changedBytes = 0; changedHeadBytes = 0
      const items = p.page.items.map((item, offset) => {
        const incoming = changes?.get(offset)
        if (!incoming) return item
        const oldSize = recordBytes(item); changedBytes += recordBytes(incoming) - oldSize
        if (p.index === 0 && before.head.page.items[offset] === item) changedHeadBytes -= oldSize
        return incoming
      })
      if (index === 0) { items.push(...appended); changedBytes += appended.reduce((sum, item) => sum + recordBytes(item), 0) }
      return { ...p, page: { ...p.page, items }, bytes: p.bytes + changedBytes, headBytes: p.headBytes + changedHeadBytes }
    })
    if (parts[0]!.page.items.length > PAGE_LIMIT * PAGE_COUNT) {
      if (!automaticSeedBlocked.current) { automaticSeedBlocked.current = true; void read('seed') }
      else if (!before.newerOutside) update({ ...stateRef.current, window: { ...before, newerOutside: true } })
      return
    }
    try {
      const next = assemble(parts, before.positions, before.head, before.boundary, false, 'newer', before.positionBytes, before.bindingKey)
      if (!allowsWindow(next, 'live')) throw new Error(protectedError)
      update({ ...stateRef.current, window: next })
    } catch (cause) { update({ ...stateRef.current, error: presentError(cause), window: { ...before, newerOutside: true } }) }
  }, [key, bindingKey, reading?.enabled, recent, state.window, state.loading])
  // Selection creates one demand. Page commits, scrolling and unrelated renders cannot restart it.
  useEffect(() => { coverageDemand.current = true }, [key, coverageDuration])
  useEffect(() => {
    const before = stateRef.current.key === key ? stateRef.current.window : null
    if (!reading?.enabled || pending.current || !before || !coverageDemand.current) return
    if (before.bindingKey !== bindingKey || !needsTimeCoverage(before.page, coverageDuration)) { coverageDemand.current = false; return }
    void read('coverage')
  }, [key, bindingKey, coverageDuration, reading?.enabled, state.window, state.loading])
  const newerOutside = useMemo(() => {
    if (!window) return false
    if (window.newerOutside) return true
    const currentTail = recent?.items.at(-1)
    if (!currentTail || !sameSource(window.page, recent!)) return false
    const at = window.records.get(currentTail.id)
    const retained = at ? window.parts[at.part]!.page.items[at.offset] : undefined
    return !retained || (retained !== currentTail && JSON.stringify(retained) !== JSON.stringify(currentTail))
  }, [window, recent])
  const currentSource = handleSource(reading?.nativeSourceFacts?.nativeHandle)
  const previousSource = Boolean(page && currentSource && !matchesSource(page.source, currentSource))
  useEffect(() => () => { generation.current++; pending.current = false; coverageDemand.current = false }, [])
  return { page, captured: captured?.key === key ? captured.items : null, capturedError: captured?.key === key ? captured.error : null,
    historical: Boolean(window && window.parts[0]!.index > 0) || previousSource || Boolean(window && window.bindingKey !== bindingKey) || Boolean(keepContext),
    hasEarlierNavigation: Boolean(window?.boundary) || previousSource || Boolean(keepContext),
    previousSource, coverageLoading: state.key === key && state.loading && retry.current.direction === 'coverage', loading: state.key === key && state.loading, error: state.key === key ? state.error : null,
    loadingEarlier: state.key === key && state.loading && retry.current.direction === 'earlier',
    historyBoundary: window?.boundary?.confirmed && window.records.has(window.boundary.recordId) ? { beforeRecordId: window.boundary.recordId } : null,
    newerOutside, hasNewer: Boolean(window && window.parts[0]!.index > 0), hasMore: Boolean(page?.nextCursor),
    readEarlier: () => void read('earlier'), readNewer: () => void read('newer'), retry: () => { automaticSeedBlocked.current = false; if (retry.current.direction === 'coverage') coverageDemand.current = true; void read(retry.current.direction, retry.current.source, true) },
    showLatestAutomatically, showCurrent: () => showCurrent(), showCurrentSource: () => showCurrent(handleSource(live.current.reading?.nativeSourceFacts?.nativeHandle)),
    showPreviousSource: () => showCurrent(handleSource(live.current.reading?.nativeSourceFacts?.nativeConfirmation?.previousNativeHandle)) }
}
