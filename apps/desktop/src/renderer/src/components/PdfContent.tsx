import { TextInput } from '@agentmux/client-ui/input'
import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ListTree, Minus, Plus, Search, X } from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { FilePreviewState } from './FilePreviewState'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'
import '../styles/pdf-content.css'

type ScaleMode = 'page-width' | 'page-fit' | 'custom'
type Reading = {
  owner: Uint8Array
  phase: 'loading' | 'rendering' | 'ready' | 'password' | 'cancelled' | 'error'
  pages: number; page: number; scale: number; mode: ScaleMode
  message?: string | undefined
}
const MIN_SCALE = 0.1, MAX_SCALE = 5
type OutlineNode = Awaited<ReturnType<PDFDocumentProxy['getOutline']>>[number]
type OutlineEntry = { title: string; dest: OutlineNode['dest']; depth: number; external: boolean }
type OutlineReading = { owner: Uint8Array; phase: 'loading' | 'ready' | 'error'; entries: OutlineEntry[]; limited: boolean; message?: string }
type SearchReading = { owner: Uint8Array; query: string; caseSensitive: boolean; current: number; total: number; state: number }

function outlineEntries(items: OutlineNode[], entries: OutlineEntry[] = [], depth = 0): { entries: OutlineEntry[]; limited: boolean } {
  let limited = false
  for (const item of items) {
    if (entries.length >= 500 || depth > 20) { limited = true; break }
    entries.push({ title: item.title || 'Untitled section', dest: item.dest, depth, external: Boolean(item.url || item.unsafeUrl) })
    if (item.items?.length) limited = outlineEntries(item.items, entries, depth + 1).limited || limited
  }
  return { entries, limited }
}

/** Owns the reader, never the File or its byte snapshot. Hidden readers release their worker. */
export function PdfContent({ data, name, visible = true }: { data: Uint8Array; name: string; visible?: boolean }) {
  const container = useRef<HTMLDivElement>(null), pages = useRef<HTMLDivElement>(null)
  const viewer = useRef<PDFViewer | null>(null)
  const password = useRef<((value: string) => void) | null>(null)
  const cancel = useRef<(() => void) | null>(null)
  const mode = useRef<ScaleMode>('page-width')
  const [reading, setReading] = useState<Reading | null>(null)
  const [outline, setOutline] = useState<OutlineReading | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [search, setSearch] = useState<SearchReading | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const outlineButton = useRef<HTMLButtonElement>(null)
  const finder = useRef<{ owner: Uint8Array; execute(query: string, caseSensitive: boolean, again?: boolean, previous?: boolean): void; close(): void } | null>(null)
  const outlineNavigation = useRef<{ owner: Uint8Array; go(dest: string | unknown[]): Promise<void> } | null>(null)
  const current = visible && reading?.owner === data ? reading : null
  const currentOutline = visible && outline?.owner === data ? outline : null
  const currentSearch = visible && search?.owner === data ? search : null
  const ready = current?.phase === 'ready'
  const readable = !!current?.pages

  useEffect(() => {
    const viewport = container.current, pageContainer = pages.current
    if (!visible) { setReading(null); setOutline(null); setSearch(null); return }
    if (!viewport || !pageContainer) return
    let disposed = false, loading: PDFDocumentLoadingTask | null = null
    let reader: PDFViewer | null = null, removeListeners: (() => void) | null = null
    let observer: ResizeObserver | null = null
    const lifetime = new AbortController()
    mode.current = 'page-width'
    setOutlineOpen(false)
    setOutline({ owner: data, phase: 'loading', entries: [], limited: false })
    setSearch({ owner: data, query: '', caseSensitive: false, current: 0, total: 0, state: 0 })
    const update = (facts: Partial<Omit<Reading, 'owner'>>) => {
      if (!disposed) setReading(previous => ({ phase: 'loading', pages: 0, page: 1, scale: 1, mode: 'page-width', ...(previous?.owner === data ? previous : {}), ...facts, owner: data }))
    }
    setReading({ owner: data, phase: 'loading', pages: 0, page: 1, scale: 1, mode: 'page-width' })
    const release = () => {
      if (disposed) return
      disposed = true
      password.current = null; cancel.current = null
      finder.current?.close()
      if (finder.current?.owner === data) finder.current = null
      if (outlineNavigation.current?.owner === data) outlineNavigation.current = null
      removeListeners?.(); observer?.disconnect()
      // The runtime accepts null for teardown; PDF.js 6's declaration omits it.
      reader?.setDocument(null as unknown as PDFDocumentProxy)
      lifetime.abort()
      if (viewer.current === reader) viewer.current = null
      void loading?.destroy().catch(() => {})
    }
    cancel.current = () => { update({ phase: 'cancelled' }); release() }
    // PDF.js's viewer reads globalThis.pdfjsLib during module evaluation.
    // The engine must finish initializing before the viewer can be imported.
    void import('pdfjs-dist').then(async engine => {
      if (disposed) return
      const components = await import('pdfjs-dist/web/pdf_viewer.mjs')
      if (disposed) return
      engine.GlobalWorkerOptions.workerSrc = workerUrl
      const eventBus = new components.EventBus()
      const failedPages = new Set<number>()
      const linkService = new components.PDFLinkService({ eventBus, externalLinkTarget: 2, externalLinkRel: 'noopener noreferrer' })
      const findController = new components.PDFFindController({ eventBus, linkService })
      let query = '', caseSensitive = false
      const updateSearch = (facts: Partial<Omit<SearchReading, 'owner'>>) => {
        if (!disposed) setSearch(previous => ({ owner: data, query, caseSensitive, current: 0, total: 0, state: 0, ...(previous?.owner === data ? previous : {}), ...facts }))
      }
      finder.current = { owner: data, execute(value, sensitive, again = false, previous = false) {
        if (disposed) return
        query = value; caseSensitive = sensitive
        updateSearch({ query, caseSensitive, ...(!again ? { current: 0, total: 0 } : {}) })
        eventBus.dispatch('find', { source: reader, type: again ? 'again' : '', query, caseSensitive, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false })
      }, close() {
        eventBus.dispatch('findbarclose', { source: reader })
        // setDocument(null) cancels PDF.js's pending find timeout and text extraction publication.
        findController.setDocument(null as unknown as PDFDocumentProxy)
      } }
      outlineNavigation.current = { owner: data, go: dest => linkService.goToDestination(dest) }
      const options = {
        container: viewport, viewer: pageContainer, eventBus, linkService, findController,
        textLayerMode: 1, annotationMode: 1, removePageBorders: true,
        maxCanvasPixels: 16 * 1024 * 1024, maxCanvasDim: 8192, capCanvasAreaFactor: 200,
        // Supported by the runtime; it releases PDFViewer's own observer and scroll listeners.
        abortSignal: lifetime.signal
      }
      reader = new components.PDFViewer(options)
      viewer.current = reader
      linkService.setViewer(reader)
      const initialized = () => {
        if (disposed || !reader) return
        reader.currentScaleValue = mode.current === 'custom' ? String(reader.currentScale) : mode.current
        reader.update()
      }
      const rendered = (event: { pageNumber: number; error?: unknown; cssTransform?: boolean; isDetailView?: boolean }) => {
        if (event.cssTransform || event.isDetailView) return
        if (event.error) failedPages.add(event.pageNumber)
        else failedPages.delete(event.pageNumber)
        if (event.pageNumber !== reader?.currentPageNumber) return
        if (event.error) update({ phase: 'error', message: 'The PDF engine could not render this page. Reload the file preview to try again.' })
        else update({ phase: 'ready', message: undefined })
      }
      const changedPage = (event: { pageNumber: number }) => {
        // Cached finished pages do not emit pagerendered again when revisited.
        const finished = reader?.getPageView(event.pageNumber - 1)?.renderingState === components.RenderingStates.FINISHED
        const failed = finished && failedPages.has(event.pageNumber)
        update({ page: event.pageNumber, phase: failed ? 'error' : finished ? 'ready' : 'rendering',
          message: failed ? 'The PDF engine could not render this page. Reload the file preview to try again.' : undefined })
      }
      const changedScale = (event: { scale: number }) => update({ scale: event.scale, mode: mode.current })
      const matches = (event: { source: unknown; matchesCount: { current: number; total: number }; rawQuery?: string; state?: number }) => {
        if (event.source !== findController || (event.rawQuery !== undefined && event.rawQuery !== query)) return
        updateSearch({ current: event.matchesCount.current, total: event.matchesCount.total, ...(event.state !== undefined ? { state: event.state } : {}) })
      }
      const listeners = { pagesinit: initialized, pagerendered: rendered, pagechanging: changedPage, scalechanging: changedScale, updatefindmatchescount: matches, updatefindcontrolstate: matches }
      for (const [type, listener] of Object.entries(listeners)) eventBus.on(type, listener)
      removeListeners = () => {
        for (const [type, listener] of Object.entries(listeners)) eventBus.off(type, listener)
        linkService.setDocument(null)
      }
      observer = new ResizeObserver(() => {
        if (!disposed && reader?.pdfDocument && mode.current !== 'custom') initialized()
      })
      observer.observe(viewport)
      loading = engine.getDocument({
        data: data.slice(), cMapUrl: new URL('pdfjs/cmaps/', document.baseURI).href, cMapPacked: true,
        standardFontDataUrl: new URL('pdfjs/standard_fonts/', document.baseURI).href,
        iccUrl: new URL('pdfjs/iccs/', document.baseURI).href,
        wasmUrl: new URL('pdfjs/wasm/', document.baseURI).href, stopAtErrors: true,
        maxImageSize: 16 * 1024 * 1024, enableXfa: false
      })
      loading.onPassword = (unlock: (value: string) => void, reason: number) => {
        if (disposed) return
        password.current = unlock
        update({ phase: 'password', message: reason === 2 ? 'The password was incorrect. Try again.' : 'Enter the password to read this PDF.' })
      }
      return loading.promise.then(async document => {
        if (disposed) return
        // PDFViewer logs a rejected first-page fetch without a render event; surface that failure here.
        await document.getPage(1)
        if (disposed || !reader) return
        password.current = null
        update({ phase: 'rendering', pages: document.numPages })
        linkService.setDocument(document)
        reader.setDocument(document)
        // Outline metadata can fail without disabling a healthy page reader.
        void Promise.resolve().then(() => document.getOutline()).then(items => {
          if (!disposed) setOutline({ owner: data, phase: 'ready', ...outlineEntries(items ?? []) })
        }, () => { if (!disposed) setOutline({ owner: data, phase: 'error', entries: [], limited: false, message: 'The PDF outline could not be read. Pages and text search remain available.' }) })
      })
    }).catch(error => {
      update({ phase: 'error', pages: 0, message: error?.name === 'PasswordException' ? 'This PDF is password protected.' : 'The PDF engine could not decode this file. Reload the file preview or open it in a system application.' })
      release()
    })
    return release
  }, [data, visible])

  const scale = (value: number | Exclude<ScaleMode, 'custom'>) => {
    const reader = viewer.current
    if (!reader || !readable) return
    mode.current = typeof value === 'number' ? 'custom' : value
    if (typeof value === 'number') reader.currentScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, value))
    else reader.currentScaleValue = value
    reader.update()
  }
  const page = (value: number) => {
    if (!viewer.current || !current?.pages || !Number.isFinite(value)) return
    viewer.current.currentPageNumber = Math.max(1, Math.min(current.pages, Math.trunc(value)))
  }
  const phase = current?.phase ?? (visible ? 'loading' : 'inactive')
  const find = (query: string, sensitive = currentSearch?.caseSensitive ?? false, again = false, previous = false) => {
    if (finder.current?.owner === data && readable) finder.current.execute(query, sensitive, again, previous)
  }
  return <div className="pdf-content" data-decode-state={phase} onKeyDownCapture={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && readable) { event.preventDefault(); event.stopPropagation(); searchInput.current?.focus(); searchInput.current?.select() }
    if (event.key === 'Escape' && outlineOpen) { event.preventDefault(); setOutlineOpen(false); outlineButton.current?.focus() }
  }}>
    <div className="pdf-content__search" role="search" aria-label="Search PDF text">
      <Search size={13} aria-hidden="true" /><TextInput ref={searchInput} aria-label="Find in PDF" placeholder="Find in PDF" value={currentSearch?.query ?? ''} disabled={!readable} onChange={event => find(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); find(currentSearch?.query ?? '', currentSearch?.caseSensitive, true, event.shiftKey) } }} />
      <button className="small-button" aria-label="Match case in PDF" title="Match case" aria-pressed={currentSearch?.caseSensitive ?? false} disabled={!readable} onClick={() => find(currentSearch?.query ?? '', !currentSearch?.caseSensitive)}>Aa</button>
      <button className="icon-button" aria-label="Previous PDF match" disabled={!readable || !currentSearch?.query} onClick={() => find(currentSearch!.query, currentSearch!.caseSensitive, true, true)}><ChevronLeft size={13} /></button>
      <button className="icon-button" aria-label="Next PDF match" disabled={!readable || !currentSearch?.query} onClick={() => find(currentSearch!.query, currentSearch!.caseSensitive, true)}><ChevronRight size={13} /></button>
      <output aria-live="polite">{!currentSearch?.query ? '' : currentSearch.state === 3 ? 'Searching…' : currentSearch.state === 1 ? 'No matches' : `${currentSearch.current} / ${currentSearch.total}${currentSearch.state === 2 ? ' · Wrapped' : ''}`}</output>
    </div>
    <div className="pdf-content__body">
      {outlineOpen && currentOutline ? <nav className="pdf-content__outline" aria-label="PDF outline"><div className="pdf-content__outline-heading"><strong>Contents</strong><button className="icon-button" aria-label="Close PDF outline" onClick={() => { setOutlineOpen(false); outlineButton.current?.focus() }}><X size={13} /></button></div>
        {currentOutline.phase === 'loading' ? <p>Reading outline…</p> : currentOutline.phase === 'error' ? <p role="status">{currentOutline.message}</p> : !currentOutline.entries.length ? <p>No outline in this PDF.</p> : <ol>{currentOutline.entries.map((entry, index) => <li key={index} style={{ paddingLeft: Math.min(120, entry.depth * 12) }}>{entry.dest ? <button title={entry.title} onClick={() => {
          const navigation = outlineNavigation.current
          if (navigation?.owner !== data || !entry.dest) return
          void navigation.go(entry.dest).catch(() => { if (outlineNavigation.current === navigation) setOutline(previous => previous?.owner === data ? { ...previous, message: 'This section could not be located. Use page navigation to continue.' } : previous) })
        }}>{entry.title}</button> : <span>{entry.title}{entry.external ? ' · external destination' : ''}</span>}</li>)}</ol>}
        {currentOutline.message && currentOutline.phase !== 'error' ? <p role="status">{currentOutline.message}</p> : null}{currentOutline.limited ? <p>The outline is limited to 500 entries and 20 levels.</p> : null}
      </nav> : null}
      <div ref={container} className="pdf-content__viewport" tabIndex={0} aria-label={`PDF ${name}`} aria-hidden={!ready}
        style={{ visibility: ready || current?.phase === 'rendering' ? 'visible' : 'hidden' }}
        onKeyDown={event => {
          if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey || !readable) return
          if (event.key === '+' || event.key === '=') scale(current.scale * 1.25)
          else if (event.key === '-') scale(current.scale / 1.25)
          else if (event.key === '0' || event.key.toLowerCase() === 'f') scale('page-width')
          else if (event.key === 'PageDown') page(current.page + 1)
          else if (event.key === 'PageUp') page(current.page - 1)
          else if (event.key === 'Home') page(1)
          else if (event.key === 'End') page(current.pages)
          else return
          event.preventDefault()
        }}><div ref={pages} className="pdfViewer" /></div>
      {!ready ? <div className="pdf-content__state">
        {phase === 'password' ? <FilePreviewState title="Password protected PDF" detail={current?.message || ''}><form className="pdf-content__password" onSubmit={event => {
          event.preventDefault()
          const form = event.currentTarget, value = new FormData(form).get('password')
          if (typeof value !== 'string' || !value || !password.current) return
          const unlock = password.current
          password.current = null
          setReading(previous => previous?.owner === data ? { ...previous, phase: 'loading', message: undefined } : previous)
          form.reset(); unlock(value)
        }}>
          <label>Password<TextInput name="password" type="password" autoComplete="off" required aria-label="PDF password" /></label>
          <div className="file-preview__controls"><button type="submit" className="small-button">Unlock PDF</button><button type="button" className="small-button" onClick={() => cancel.current?.()}>Cancel</button></div>
        </form></FilePreviewState>
        : phase === 'error' ? <FilePreviewState title="PDF preview unavailable" detail={current?.message || ''} error />
        : phase === 'cancelled' ? <FilePreviewState title="PDF loading cancelled" detail="Reload the file preview to read it again." />
        : <FilePreviewState title={phase === 'inactive' ? 'Preview paused while hidden' : phase === 'rendering' ? 'Rendering PDF…' : 'Loading PDF…'} />}
      </div> : null}
    </div>
    <footer className="pdf-content__tools">
      <div className="file-preview__controls" role="group" aria-label="PDF pages">
        <button ref={outlineButton} className="icon-button" aria-label="PDF contents" title="Show PDF contents" aria-expanded={outlineOpen} disabled={!readable} onClick={() => setOutlineOpen(value => !value)}><ListTree size={13} /></button>
        <button className="icon-button" aria-label="Previous PDF page" title="Previous page (Page Up)" disabled={!readable || current!.page <= 1} onClick={() => page(current!.page - 1)}><ChevronLeft size={13} /></button>
        <TextInput key={`${phase}:${current?.page}`} className="pdf-content__page" aria-label="PDF page" type="number" min={1} max={current?.pages || undefined} defaultValue={readable ? current!.page : ''} disabled={!readable}
          onBlur={event => { page(event.currentTarget.valueAsNumber); event.currentTarget.value = String(viewer.current?.currentPageNumber ?? '') }}
          onKeyDown={event => { if (event.key === 'Enter') { page(event.currentTarget.valueAsNumber); event.currentTarget.blur() } }} />
        <span className="file-preview__metadata">/ {current?.pages || '—'}</span>
        <button className="icon-button" aria-label="Next PDF page" title="Next page (Page Down)" disabled={!readable || current!.page >= current!.pages} onClick={() => page(current!.page + 1)}><ChevronRight size={13} /></button>
      </div>
      <div className="file-preview__controls" role="group" aria-label="PDF zoom">
        <button className="small-button" aria-pressed={readable && current!.mode === 'page-width'} disabled={!readable} onClick={() => scale('page-width')}>Fit width</button>
        <button className="small-button" aria-pressed={readable && current!.mode === 'page-fit'} disabled={!readable} onClick={() => scale('page-fit')}>Fit page</button>
        <button className="icon-button" aria-label="Zoom PDF out" title="Zoom out (-)" disabled={!readable || current!.scale <= MIN_SCALE} onClick={() => scale(current!.scale / 1.25)}><Minus size={13} /></button>
        <button className="pdf-content__percent small-button" aria-label="PDF original size" title="Original size" disabled={!readable} onClick={() => scale(1)}>{readable ? `${Math.round(current!.scale * 100)}%` : '—'}</button>
        <button className="icon-button" aria-label="Zoom PDF in" title="Zoom in (+)" disabled={!readable || current!.scale >= MAX_SCALE} onClick={() => scale(current!.scale * 1.25)}><Plus size={13} /></button>
      </div>
    </footer>
  </div>
}
