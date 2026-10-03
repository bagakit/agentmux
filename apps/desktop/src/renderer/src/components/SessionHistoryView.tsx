import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowLeft, History, LoaderCircle, RefreshCw } from 'lucide-react'
import type { AgentSessionHistoryPage, AgentSessionHistorySource } from '@agentmux/core'
import type { SessionHistoryReference } from '../../../shared/contracts'
import { api } from '../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { type LinkClickModifiers, type OpenWorkspaceFile } from '@agentmux/client-ui/components/AgentMarkdown'
import { parseTraceDisclosureKey } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationNativeThread } from '@agentmux/client-ui/components/ConversationNativeThread'
import { NativeProcessObservation } from './NativeProcessObservation'
import type { ConversationAnnotationSelection } from '@agentmux/client-ui/conversation-annotation'
import { createSpeakerResolver, type DescribeSpeaker } from '@agentmux/client-ui/conversation-speaker'

type ReadingAnchor = { kind: 'record' | 'group'; id: string; offset: number }
type ReadingState = {
  pages: AgentSessionHistoryPage[]
  source: AgentSessionHistorySource | null
  nextCursor: string | null
  newerOutsideWindow: boolean
  loading: boolean
  error: string | null
}
const emptyReading: ReadingState = {
  pages: [], source: null, nextCursor: null, newerOutsideWindow: false, loading: false, error: null
}
const MAX_NEARBY_PAGES = 3
const OLDER_THRESHOLD_PX = 80

function sameSource(left: AgentSessionHistorySource, right: AgentSessionHistorySource): boolean {
  return left.providerId === right.providerId && left.nativeSessionId === right.nativeSessionId
}

function readingAnchor(viewport: HTMLElement): ReadingAnchor | null {
  const bounds = viewport.getBoundingClientRect()
  if (bounds.height <= 0) return null
  for (const row of viewport.querySelectorAll<HTMLElement>('[data-native-record-id]')) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
      return { kind: 'record', id: row.dataset.nativeRecordId!, offset: rect.top - bounds.top }
    }
  }
  // Only a truly collapsed group may provide geometry while its real raw rows are hidden.
  for (const group of viewport.querySelectorAll<HTMLElement>('[data-history-group-anchor]')) {
    const head = group.querySelector<HTMLElement>(':scope > .wf-card--observation > .wf-head[aria-expanded="false"]')
    if (!head) continue
    const rect = head.getBoundingClientRect()
    if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom) {
      return { kind: 'group', id: group.dataset.historyGroupAnchor!, offset: rect.top - bounds.top }
    }
  }
  return null
}

function nodeIntersectsElement(node: Node | null, el: HTMLElement): boolean {
  if (!node) return false
  return el === node || el.contains(node)
}

function rangeIntersectsElement(range: Range, el: HTMLElement): boolean {
  if (typeof range.intersectsNode === 'function') {
    try {
      return range.intersectsNode(el)
    } catch {
      // fallback
    }
  }
  const start = range.startContainer
  const end = range.endContainer
  if (el === start || el.contains(start) || el === end || el.contains(end)) return true
  try {
    const elRange = el.ownerDocument.createRange()
    elRange.selectNode(el)
    const startsAfterEnd = range.compareBoundaryPoints(Range.START_TO_END, elRange) <= 0
    const endsBeforeStart = range.compareBoundaryPoints(Range.END_TO_START, elRange) >= 0
    return !startsAfterEnd && !endsBeforeStart
  } catch {
    return false
  }
}

/** Volatile reading window over Core-owned native records. This never controls the live Run. */
export function SessionHistoryView({
  control, readingKey, label, onClose, visible, workspaceRoot, openWorkspaceFile, openHttpLink, returnLabel = 'Terminal', serviceNotice, primaryAction, describeSpeaker,
  expandedTraces: expandedTracesProp, onToggleTrace: onToggleTraceProp, onSelectAnnotation
}: {
  control: SessionHistoryReference
  /** A live caller fences its reading window when its retained Run changes. Retired readers have no Run. */
  readingKey?: string
  label: string
  onClose?(): void
  onSelectAnnotation?: (selection: ConversationAnnotationSelection) => void
  visible: boolean
  returnLabel?: string
  serviceNotice?: ReactNode
  /** An explicit Session action supplied by its owner; reading itself never starts a Run. */
  primaryAction?: ReactNode
  workspaceRoot: string
  openWorkspaceFile: OpenWorkspaceFile
  openHttpLink(url: string, event: LinkClickModifiers): void
  expandedTraces?: ReadonlySet<string>
  onToggleTrace?: (traceId: string, open: boolean) => void
  describeSpeaker?: DescribeSpeaker
}) {
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const [reading, setReading] = useState<ReadingState>(emptyReading)
  const readingRef = useRef(reading)
  readingRef.current = reading
  const generationRef = useRef(0)
  const pendingRef = useRef(false)
  const retryDirectionRef = useRef<'latest' | 'older'>('latest')
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const returnRef = useRef<HTMLButtonElement>(null)
  const anchorRef = useRef<ReadingAnchor | null>(null)
  const bottomRef = useRef(false)
  const lastScrollTopRef = useRef(0)

  function update(next: ReadingState): void {
    readingRef.current = next
    setReading(next)
  }
  function restoreAnchor(): void {
    const viewport = viewportRef.current
    const anchor = anchorRef.current
    if (!visibleRef.current || !viewport || !anchor) return
    const row = anchor.kind === 'record'
      ? Array.from(viewport.querySelectorAll<HTMLElement>('[data-native-record-id]'))
        .find(candidate => candidate.dataset.nativeRecordId === anchor.id)
      : Array.from(viewport.querySelectorAll<HTMLElement>('[data-history-group-anchor]'))
        .find(candidate => candidate.dataset.historyGroupAnchor === anchor.id)
        ?.querySelector<HTMLElement>(':scope > .wf-card--observation > .wf-head[aria-expanded="false"]')
    if (!row) return
    const bounds = viewport.getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    if (bounds.height <= 0 || rect.height <= 0) return
    viewport.scrollTop += rect.top - bounds.top - anchor.offset
    lastScrollTopRef.current = viewport.scrollTop
  }
  async function readPage(direction: 'latest' | 'older'): Promise<void> {
    if (!visibleRef.current) return
    if (direction === 'latest' && pendingRef.current && retryDirectionRef.current === 'older') {
      generationRef.current += 1
      pendingRef.current = false
    } else if (pendingRef.current) {
      return
    }
    const before = readingRef.current
    if (direction === 'older' && before.nextCursor === null) return
    pendingRef.current = true
    retryDirectionRef.current = direction
    const generation = generationRef.current
    const cursor = direction === 'older' ? before.nextCursor! : undefined
    const requestedAnchor = direction === 'older' && viewportRef.current ? readingAnchor(viewportRef.current) : null
    update({ ...before, loading: true, error: null })
    try {
      const page = await api.sessions.historyPage(control, cursor === undefined ? undefined : { cursor })
      if (generation !== generationRef.current || !visibleRef.current) return
      if (page.agentSessionId !== control.agentSessionId) throw new Error('History belongs to another Session.')
      if (before.source && !sameSource(before.source, page.source)) {
        throw new Error('The native history source changed. Return to Terminal and reopen conversation history.')
      }
      if (cursor !== undefined && page.nextCursor === cursor) throw new Error('The history cursor did not advance. Retry the read.')
      const viewport = viewportRef.current
      anchorRef.current = direction === 'older'
        ? (visibleRef.current && viewport ? readingAnchor(viewport) : requestedAnchor)
        : null
      const existingIds = new Set(before.pages.flatMap((entry) => entry.items.map((item) => item.id)))
      const olderItems = direction === 'older' ? page.items.filter((item) => !existingIds.has(item.id)) : page.items
      const pages = direction === 'latest'
        ? [page]
        : olderItems.length ? [{ ...page, items: olderItems }, ...before.pages] : [...before.pages]
      let newerOutsideWindow = direction === 'older' && before.newerOutsideWindow
      if (pages.length > MAX_NEARBY_PAGES) {
        const newest = pages.at(-1)!
        const currentAnchor = anchorRef.current ?? (viewportRef.current ? readingAnchor(viewportRef.current) : null)
        const anchorGroup = currentAnchor?.kind === 'group' && viewportRef.current
          ? Array.from(viewportRef.current.querySelectorAll<HTMLElement>('[data-history-group-anchor]'))
            .find(group => group.dataset.historyGroupAnchor === currentAnchor.id)
          : undefined
        const anchorInNewest = currentAnchor?.kind === 'record'
          ? newest.items.some(item => item.id === currentAnchor.id)
          : anchorGroup && Array.from(anchorGroup.querySelectorAll<HTMLElement>('[data-native-record-id]'))
            .some(row => newest.items.some(item => item.id === row.dataset.nativeRecordId))
        const sel = typeof window !== 'undefined' ? window.getSelection() : null
        const hasActiveSelection = Boolean(
          sel &&
            !sel.isCollapsed &&
            sel.rangeCount > 0 &&
            viewportRef.current &&
            (viewportRef.current.contains(sel.anchorNode) || viewportRef.current.contains(sel.focusNode))
        )
        const historyRows = viewportRef.current
          ? Array.from(viewportRef.current.querySelectorAll<HTMLElement>('[data-native-record-id]'))
          : []
        const selectionInNewest = Boolean(
          hasActiveSelection &&
            newest.items.some((item) => {
              const el = historyRows.find((row) => row.dataset.nativeRecordId === item.id)
              if (!el) return false
              if (nodeIntersectsElement(sel!.anchorNode, el)) return true
              if (nodeIntersectsElement(sel!.focusNode, el)) return true
              const range = sel!.getRangeAt(0)
              if (range && rangeIntersectsElement(range, el)) return true
              return false
            })
        )
        if (anchorInNewest || selectionInNewest) {
          throw new Error('Scroll toward the beginning before loading more history to preserve your reading position.')
        }
        pages.pop()
        newerOutsideWindow = true
      }
      bottomRef.current = direction === 'latest'
      update({ pages, source: page.source, nextCursor: page.nextCursor, newerOutsideWindow, loading: false, error: null })
    } catch (cause) {
      if (generation === generationRef.current && visibleRef.current) update({ ...readingRef.current, error: presentError(cause) })
    } finally {
      if (generation === generationRef.current) {
        pendingRef.current = false
        update({ ...readingRef.current, loading: false })
      }
    }
  }

  const [localDisclosures, setLocalDisclosures] = useState<Set<string>>(() => {
    return new Set<string>()
  })

  useEffect(() => {
    setLocalDisclosures(new Set<string>())
  }, [control.hostId, control.agentSessionId, readingKey])

  useEffect(() => {
    generationRef.current += 1
    pendingRef.current = false
    anchorRef.current = null
    update(emptyReading)
    if (visibleRef.current) returnRef.current?.focus()
    void readPage('latest')
    return () => {
      generationRef.current += 1
    }
  }, [control.hostId, control.agentSessionId, readingKey])


  useEffect(() => {
    if (visible && !readingRef.current.source && !readingRef.current.error) void readPage('latest')
    if (!visible) {
      generationRef.current += 1
      pendingRef.current = false
      if (readingRef.current.loading) {
        update({ ...readingRef.current, loading: false })
      }
    }
  }, [visible])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!visible || !viewport) return
    if (bottomRef.current) {
      viewport.scrollTop = viewport.scrollHeight
      lastScrollTopRef.current = viewport.scrollTop
      bottomRef.current = false
    } else restoreAnchor()
  }, [reading.pages, visible])

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !contentRef.current) return
    const observer = new ResizeObserver(restoreAnchor)
    observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [])

  const page = useMemo<AgentSessionHistoryPage | null>(() => reading.source ? {
    agentSessionId: control.agentSessionId,
    source: reading.source,
    items: reading.pages.flatMap((entry) => entry.items),
    nextCursor: reading.nextCursor
  } : null, [reading.pages, reading.source, reading.nextCursor, control.agentSessionId])
  const items = page?.items ?? []
  const boundaryRecord = items.at(-1)
  const boundaryTime = boundaryRecord?.completedAt ?? boundaryRecord?.startedAt

  const fallbackResolver = useMemo(
    () =>
      createSpeakerResolver({
        currentSession: {
          id: control.agentSessionId,
          label,
          ...(reading.source ? { providerId: reading.source.providerId } : {})
        }
      }),
    [control.agentSessionId, label, reading.source?.providerId]
  )
  const resolveSpeaker = describeSpeaker ?? fallbackResolver
  const openedTraces = expandedTracesProp ?? localDisclosures
  const handleToggleTrace = (traceId: string, open: boolean) => {
    if (onToggleTraceProp) {
      onToggleTraceProp(traceId, open)
    } else {
      setLocalDisclosures((prev) => {
        const next = new Set(prev)
        if (open) next.add(traceId)
        else next.delete(traceId)
        return next
      })
    }
  }

  useEffect(() => {
    if (items.length === 0) return
    const currentItemIds = new Set(items.map((it) => it.id))
    if (onToggleTraceProp && expandedTracesProp) {
      for (const traceId of expandedTracesProp) {
        if (!traceId || typeof traceId !== 'string') continue
        const tuple = parseTraceDisclosureKey(traceId)
        if (tuple && !currentItemIds.has(tuple[0])) {
          onToggleTraceProp(traceId, false)
        }
      }
    } else if (!onToggleTraceProp && localDisclosures.size > 0) {
      let changed = false
      const next = new Set(localDisclosures)
      for (const traceId of next) {
        if (!traceId || typeof traceId !== 'string') {
          next.delete(traceId)
          changed = true
          continue
        }
        const tuple = parseTraceDisclosureKey(traceId)
        if (tuple && !currentItemIds.has(tuple[0])) {
          next.delete(traceId)
          changed = true
        }
      }
      if (changed) {
        setLocalDisclosures(next)
      }
    }
  }, [items, expandedTracesProp, onToggleTraceProp, localDisclosures, control])
  return <section className={`session-history${onClose ? '' : ' session-history--inline'}`} hidden={!visible} aria-label={visible ? 'Conversation history' : undefined} onKeyDown={(event) => {
    if (event.key === 'Escape' && onClose) { event.stopPropagation(); onClose() }
  }}>
    <div className="session-history__toolbar">
      {onClose ? <button ref={returnRef} type="button" className="small-button" onClick={onClose}><ArrowLeft size={12} /> {returnLabel}</button> : null}
      <span><History size={12} /> Conversation history</span>
      <div className="session-history__actions">
        {primaryAction}
        <button type="button" className="small-button" disabled={reading.loading && retryDirectionRef.current === 'latest'} onClick={() => void readPage('latest')}><ArrowDown size={12} /> Latest</button>
      </div>
    </div>
    {serviceNotice ? <div className="session-history__notice" role="status">{serviceNotice}</div> : null}
    {reading.error ? <div className="session-history__notice" role="status">
      <span>History read failed: {reading.error} Existing history and the Session are kept.</span>
      <button type="button" className="small-button" disabled={reading.loading} onClick={() => void readPage(retryDirectionRef.current)}><RefreshCw size={12} /> Retry</button>
    </div> : null}
    <div ref={viewportRef} className="session-history__viewport" tabIndex={0} aria-label="Native conversation records" onWheel={(event) => {
      event.stopPropagation()
      if (event.deltaY < 0 && event.currentTarget.scrollTop <= OLDER_THRESHOLD_PX) void readPage('older')
    }} onScroll={(event) => {
      const top = event.currentTarget.scrollTop
      if (top < lastScrollTopRef.current && top <= OLDER_THRESHOLD_PX) void readPage('older')
      lastScrollTopRef.current = top
      if (visibleRef.current && viewportRef.current) {
        const current = readingAnchor(viewportRef.current)
        if (current) anchorRef.current = current
      }
    }}>
      <div ref={contentRef}>
        <div className="session-history__boundary" role="status">
          {reading.loading ? <><LoaderCircle size={12} className="spin" /> Reading history…</> : reading.source && reading.nextCursor === null ? 'Beginning of the available native history' : null}
          {!reading.loading && reading.nextCursor !== null ? <button type="button" className="small-button" onClick={() => void readPage('older')}>Load earlier records</button> : null}
        </div>
        {page ? <ConversationNativeThread page={page} sessionId={control.agentSessionId}
          describeSpeaker={resolveSpeaker} showSource={false} messageIdForRecord={rawMessageId}
          workspaceRoot={workspaceRoot} openWorkspaceFile={openWorkspaceFile} openHttpLink={openHttpLink}
          expandedTraces={openedTraces} onToggleTrace={handleToggleTrace}
          {...(onSelectAnnotation ? { onSelectAnnotation } : {})}
          renderProcess={props => <div data-history-group-anchor={props.id}>
            <NativeProcessObservation {...props} />
          </div>} /> : null}
        {items.length > 0 ? <div className="session-history__divider" role="separator"
          aria-label={boundaryTime === undefined ? '以上是历史消息 (时间未记录)' : `以上是历史消息 (${new Date(boundaryTime).toLocaleString()})`}>
          <span>以上是历史消息 (<time {...(boundaryTime === undefined ? {} : { dateTime: new Date(boundaryTime).toISOString() })}>
            {boundaryTime === undefined ? '时间未记录' : new Date(boundaryTime).toLocaleString()}</time>)</span>
        </div> : null}
        {!reading.loading && reading.source && items.length === 0 ? <p className="session-history__empty">No records in this page.{reading.nextCursor !== null ? ' Earlier records can still be read.' : ''}</p> : null}
        {reading.newerOutsideWindow ? <div className="session-history__boundary" role="status">Newer records are outside this three-page reading window. <button type="button" className="small-button" disabled={reading.loading && retryDirectionRef.current === 'latest'} onClick={() => void readPage('latest')}>Return to latest</button></div> : null}
      </div>
    </div>
  </section>
}

function rawMessageId(item: AgentSessionHistoryPage['items'][number]): string {
  return item.id
}
