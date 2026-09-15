import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, History, LoaderCircle, RefreshCw } from 'lucide-react'
import type { AgentSessionHistoryPage, AgentSessionHistorySource } from '@agentmux/core'
import type { AgentSessionControl } from '../../../shared/contracts'
import { api } from '../lib/api'
import { presentError } from '../lib/error-presentation'
import { AgentMarkdown, type LinkClickModifiers, type OpenWorkspaceFile } from './AgentMarkdown'

type ReadingAnchor = { id: string; offset: number }
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
  for (const row of viewport.querySelectorAll<HTMLElement>('[data-history-item-id]')) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
      return { id: row.dataset.historyItemId!, offset: rect.top - bounds.top }
    }
  }
  return null
}

/** Volatile reading window over Core-owned native records. This never controls the live Run. */
export function SessionHistoryView({
  control, label, onClose, workspaceRoot, openWorkspaceFile, openHttpLink
}: {
  control: AgentSessionControl
  label: string
  onClose(): void
  workspaceRoot: string
  openWorkspaceFile: OpenWorkspaceFile
  openHttpLink(url: string, event: LinkClickModifiers): void
}) {
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
    if (!viewport || !anchor) return
    const row = Array.from(viewport.querySelectorAll<HTMLElement>('[data-history-item-id]'))
      .find((candidate) => candidate.dataset.historyItemId === anchor.id)
    if (!row) return
    viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset
    lastScrollTopRef.current = viewport.scrollTop
  }
  async function readPage(direction: 'latest' | 'older'): Promise<void> {
    if (pendingRef.current) return
    const before = readingRef.current
    if (direction === 'older' && before.nextCursor === null) return
    pendingRef.current = true
    retryDirectionRef.current = direction
    const generation = generationRef.current
    const cursor = direction === 'older' ? before.nextCursor! : undefined
    update({ ...before, loading: true, error: null })
    try {
      const page = await api.sessions.historyPage(control, cursor === undefined ? undefined : { cursor })
      if (generation !== generationRef.current) return
      if (page.agentSessionId !== control.agentSessionId) throw new Error('History belongs to another Session.')
      if (before.source && !sameSource(before.source, page.source)) {
        throw new Error('The native history source changed. Return to Terminal and reopen conversation history.')
      }
      if (cursor !== undefined && page.nextCursor === cursor) throw new Error('The history cursor did not advance. Retry the read.')
      const viewport = viewportRef.current
      anchorRef.current = direction === 'older' && viewport ? readingAnchor(viewport) : null
      const existingIds = new Set(before.pages.flatMap((entry) => entry.items.map((item) => item.id)))
      const olderItems = direction === 'older' ? page.items.filter((item) => !existingIds.has(item.id)) : page.items
      const pages = direction === 'latest'
        ? [page]
        : olderItems.length ? [{ ...page, items: olderItems }, ...before.pages] : [...before.pages]
      let newerOutsideWindow = direction === 'older' && before.newerOutsideWindow
      if (pages.length > MAX_NEARBY_PAGES) {
        const newest = pages.at(-1)!
        if (anchorRef.current && newest.items.some((item) => item.id === anchorRef.current!.id)) {
          throw new Error('Scroll toward the beginning before loading more history to preserve your reading position.')
        }
        pages.pop()
        newerOutsideWindow = true
      }
      bottomRef.current = direction === 'latest'
      update({ pages, source: page.source, nextCursor: page.nextCursor, newerOutsideWindow, loading: true, error: null })
    } catch (cause) {
      if (generation === generationRef.current) update({ ...readingRef.current, error: presentError(cause) })
    } finally {
      if (generation === generationRef.current) {
        pendingRef.current = false
        update({ ...readingRef.current, loading: false })
      }
    }
  }

  useEffect(() => {
    generationRef.current += 1
    pendingRef.current = false
    anchorRef.current = null
    update(emptyReading)
    returnRef.current?.focus()
    void readPage('latest')
    return () => { generationRef.current += 1 }
  }, [control.hostId, control.agentSessionId, control.run.runId])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    if (bottomRef.current) {
      viewport.scrollTop = viewport.scrollHeight
      lastScrollTopRef.current = viewport.scrollTop
      bottomRef.current = false
    } else restoreAnchor()
  }, [reading.pages])

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !contentRef.current) return
    const observer = new ResizeObserver(restoreAnchor)
    observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [])

  const items = reading.pages.flatMap((page) => page.items)
  return <section className="session-history" aria-label="Conversation history" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    else anchorRef.current = null
  }}>
    <div className="session-history__toolbar">
      <button ref={returnRef} type="button" className="small-button" onClick={onClose}><ArrowLeft size={12} /> Terminal</button>
      <span><History size={12} /> Conversation history</span>
      <button type="button" className="small-button" disabled={reading.loading} onClick={() => void readPage('latest')}><ArrowDown size={12} /> Latest</button>
    </div>
    <div className="session-history__source" title={reading.source ? `${reading.source.providerId} · ${reading.source.nativeSessionId}` : undefined}>
      {reading.source ? 'Persisted native conversation · separate from terminal replay' : 'Reading persisted native conversation'}
    </div>
    {reading.error ? <div className="session-history__notice" role="status">
      <span>History read failed: {reading.error} Existing history and the Session are kept.</span>
      <button type="button" className="small-button" disabled={reading.loading} onClick={() => void readPage(retryDirectionRef.current)}><RefreshCw size={12} /> Retry</button>
    </div> : null}
    <div ref={viewportRef} className="session-history__viewport" tabIndex={0} aria-label="Native conversation records" onPointerDown={() => { anchorRef.current = null }} onWheel={(event) => {
      event.stopPropagation()
      anchorRef.current = null
      if (event.deltaY < 0 && event.currentTarget.scrollTop <= OLDER_THRESHOLD_PX) void readPage('older')
    }} onScroll={(event) => {
      const top = event.currentTarget.scrollTop
      if (top < lastScrollTopRef.current && top <= OLDER_THRESHOLD_PX) void readPage('older')
      lastScrollTopRef.current = top
    }}>
      <div ref={contentRef}>
        <div className="session-history__boundary" role="status">
          {reading.loading ? <><LoaderCircle size={12} className="spin" /> Reading history…</> : reading.source && reading.nextCursor === null ? 'Beginning of the available native history' : null}
          {!reading.loading && reading.nextCursor !== null ? <button type="button" className="small-button" onClick={() => void readPage('older')}>Load earlier records</button> : null}
        </div>
        {items.map((item) => <article key={item.id} className="session-history__item" data-history-item-id={item.id} data-history-kind={item.kind}>
          <header><strong>{item.kind === 'user-message' ? 'You' : item.kind === 'assistant-message' ? label : item.title ?? 'Activity'}</strong>
            {item.startedAt === undefined ? null : <time dateTime={new Date(item.startedAt).toISOString()}>{new Date(item.startedAt).toLocaleTimeString()}</time>}
          </header>
          {item.contentParts.map((part, index) => part.kind === 'text'
            ? <AgentMarkdown key={index} content={part.text} workspaceRoot={workspaceRoot} openWorkspaceFile={openWorkspaceFile} openHttpLink={openHttpLink} />
            : <div key={index} className="session-history__resource"><span>{part.label ?? `${part.resourceType} resource`}</span><code>{part.reference}</code><small>Resource reference; preview is not available here.</small></div>)}
        </article>)}
        {!reading.loading && reading.source && items.length === 0 ? <p className="session-history__empty">No records in this page.{reading.nextCursor !== null ? ' Earlier records can still be read.' : ''}</p> : null}
        {reading.newerOutsideWindow ? <div className="session-history__boundary" role="status">Newer records are outside this three-page reading window. <button type="button" className="small-button" disabled={reading.loading} onClick={() => void readPage('latest')}>Return to latest</button></div> : null}
      </div>
    </div>
  </section>
}
