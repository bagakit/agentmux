import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react'
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

/** Owns the reader, never the File or its byte snapshot. Hidden readers release their worker. */
export function PdfContent({ data, name, visible = true }: { data: Uint8Array; name: string; visible?: boolean }) {
  const container = useRef<HTMLDivElement>(null), pages = useRef<HTMLDivElement>(null)
  const viewer = useRef<PDFViewer | null>(null)
  const password = useRef<((value: string) => void) | null>(null)
  const cancel = useRef<(() => void) | null>(null)
  const mode = useRef<ScaleMode>('page-width')
  const [reading, setReading] = useState<Reading | null>(null)
  const current = visible && reading?.owner === data ? reading : null
  const ready = current?.phase === 'ready'
  const readable = !!current?.pages

  useEffect(() => {
    const viewport = container.current, pageContainer = pages.current
    if (!visible) { setReading(null); return }
    if (!viewport || !pageContainer) return
    let disposed = false, loading: PDFDocumentLoadingTask | null = null
    let reader: PDFViewer | null = null, removeListeners: (() => void) | null = null
    let observer: ResizeObserver | null = null
    const lifetime = new AbortController()
    mode.current = 'page-width'
    const update = (facts: Partial<Omit<Reading, 'owner'>>) => {
      if (!disposed) setReading(previous => ({ phase: 'loading', pages: 0, page: 1, scale: 1, mode: 'page-width', ...(previous?.owner === data ? previous : {}), ...facts, owner: data }))
    }
    setReading({ owner: data, phase: 'loading', pages: 0, page: 1, scale: 1, mode: 'page-width' })
    const release = () => {
      if (disposed) return
      disposed = true
      password.current = null; cancel.current = null
      removeListeners?.(); observer?.disconnect()
      // The runtime accepts null for teardown; PDF.js 6's declaration omits it.
      reader?.setDocument(null as unknown as PDFDocumentProxy)
      lifetime.abort()
      if (viewer.current === reader) viewer.current = null
      void loading?.destroy().catch(() => {})
    }
    cancel.current = () => { update({ phase: 'cancelled' }); release() }
    void Promise.all([import('pdfjs-dist'), import('pdfjs-dist/web/pdf_viewer.mjs')]).then(([engine, components]) => {
      if (disposed) return
      engine.GlobalWorkerOptions.workerSrc = workerUrl
      const eventBus = new components.EventBus()
      const failedPages = new Set<number>()
      const linkService = new components.PDFLinkService({ eventBus, externalLinkTarget: 2, externalLinkRel: 'noopener noreferrer' })
      const options = {
        container: viewport, viewer: pageContainer, eventBus, linkService,
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
      const listeners = { pagesinit: initialized, pagerendered: rendered, pagechanging: changedPage, scalechanging: changedScale }
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
  return <div className="pdf-content" data-decode-state={phase}>
    <div className="pdf-content__body">
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
          <label>Password<input name="password" type="password" autoComplete="off" required aria-label="PDF password" /></label>
          <div className="file-preview__controls"><button type="submit" className="small-button">Unlock PDF</button><button type="button" className="small-button" onClick={() => cancel.current?.()}>Cancel</button></div>
        </form></FilePreviewState>
        : phase === 'error' ? <FilePreviewState title="PDF preview unavailable" detail={current?.message || ''} error />
        : phase === 'cancelled' ? <FilePreviewState title="PDF loading cancelled" detail="Reload the file preview to read it again." />
        : <FilePreviewState title={phase === 'inactive' ? 'Preview paused while hidden' : phase === 'rendering' ? 'Rendering PDF…' : 'Loading PDF…'} />}
      </div> : null}
    </div>
    <footer className="pdf-content__tools">
      <div className="file-preview__controls" role="group" aria-label="PDF pages">
        <button className="icon-button" aria-label="Previous PDF page" title="Previous page (Page Up)" disabled={!readable || current!.page <= 1} onClick={() => page(current!.page - 1)}><ChevronLeft size={13} /></button>
        <input key={`${phase}:${current?.page}`} className="pdf-content__page" aria-label="PDF page" type="number" min={1} max={current?.pages || undefined} defaultValue={readable ? current!.page : ''} disabled={!readable}
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
