import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { SemanticIcon } from '../theme/icons.js'
import { constrainImageView, FIT_IMAGE, imageViewSize, zoomImageView, type ImageViewGeometry } from '../lib/image-view-transform.js'

/** Viewing state only. The parent still owns the exact bytes, source and decode failure. */
export function ConversationImageViewport({ src, alt, name, onError }: {
  src: string; alt: string; name: string; onError(): void
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const image = useRef<HTMLImageElement>(null)
  const geometry = useRef<ImageViewGeometry>({ width: 0, height: 0, naturalWidth: 0, naturalHeight: 0 })
  const [size, setSize] = useState(() => imageViewSize(geometry.current))
  const [view, setView] = useState(FIT_IMAGE)
  const [dragging, setDragging] = useState(false)
  const currentView = useRef(view)
  currentView.current = view
  const drag = useRef<{ pointer: number; clientX: number; clientY: number; x: number; y: number } | null>(null)

  const endDrag = useCallback(() => {
    const pointer = drag.current?.pointer, host = viewport.current
    drag.current = null
    setDragging(false)
    if (pointer !== undefined && host?.hasPointerCapture?.(pointer)) host.releasePointerCapture(pointer)
  }, [])

  const measure = useCallback(() => {
    const host = viewport.current, img = image.current
    if (!host || !img) return
    endDrag()
    geometry.current = { width: host.clientWidth, height: host.clientHeight, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight }
    setSize(imageViewSize(geometry.current))
    setView(previous => constrainImageView(previous, geometry.current))
  }, [endDrag])
  useEffect(() => {
    const host = viewport.current
    if (!host) return
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    measure()
    return () => observer.disconnect()
  }, [measure])
  useEffect(() => {
    const host = viewport.current
    if (!host) return
    const wheel = (event: WheelEvent) => {
      const modified = event.ctrlKey || event.metaKey
      if (!modified && currentView.current.scale === 1) return
      event.preventDefault()
      endDrag()
      const rect = host.getBoundingClientRect()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.clientHeight : 1
      setView(previous => modified
        ? zoomImageView(previous, previous.scale * Math.exp(-event.deltaY * unit / 200),
          { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }, geometry.current)
        : constrainImageView({ ...previous, x: previous.x - event.deltaX * unit, y: previous.y - event.deltaY * unit }, geometry.current))
    }
    host.addEventListener('wheel', wheel, { passive: false })
    return () => host.removeEventListener('wheel', wheel)
  }, [endDrag])

  const zoom = (factor: number) => { endDrag(); setView(previous => zoomImageView(previous, previous.scale * factor, { x: 0, y: 0 }, geometry.current)) }
  const fit = () => { endDrag(); setView(FIT_IMAGE) }
  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return
    endDrag()
  }
  return <div className="md-conversation-image__viewer" onKeyDown={event => {
    if (!['+', '=', '-', '0'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    if (event.key === '0') fit()
    else zoom(event.key === '-' ? 1 / 1.25 : 1.25)
  }}>
    <header className="md-conversation-image__header">
      <Dialog.Title className="md-conversation-image__title" title={alt}>{name}</Dialog.Title>
      <Dialog.Close className="md-conversation-image__control" aria-label="Close image" title="Close image (Escape)">
        <SemanticIcon name="action.close" size={16} aria-hidden="true" />
      </Dialog.Close>
    </header>
    <div ref={viewport} className="md-conversation-image__viewport" data-zoomed={view.scale > 1 || undefined}
      data-dragging={dragging || undefined} tabIndex={0} aria-label="Image viewport"
      onDoubleClick={event => {
        endDrag()
        const rect = event.currentTarget.getBoundingClientRect()
        setView(previous => previous.scale > 1 ? FIT_IMAGE : zoomImageView(previous, 2,
          { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }, geometry.current))
      }}
      onPointerDown={event => {
        if (event.button !== 0 || view.scale === 1 || drag.current) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        drag.current = { pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y }
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }}
      onPointerMove={event => {
        const start = drag.current
        if (!start || start.pointer !== event.pointerId) return
        const dx = event.clientX - start.clientX, dy = event.clientY - start.clientY
        if (!dragging && Math.hypot(dx, dy) < 4) return
        setDragging(true)
        setView(previous => constrainImageView({ ...previous, x: start.x + dx, y: start.y + dy }, geometry.current))
      }} onPointerUp={finishDrag} onPointerCancel={finishDrag} onLostPointerCapture={() => { drag.current = null; setDragging(false) }}>
      <img ref={image} className="md-conversation-image__full" src={src} alt={alt} draggable={false}
        onLoad={measure} onError={onError} style={{ ...(size.width ? { width: size.width, height: size.height } : {}),
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
    </div>
    <footer className="md-conversation-image__toolbar">
      <span className="md-conversation-image__hint">Ctrl/⌘ + scroll to zoom · Drag to pan</span>
      <div className="md-conversation-image__tools" role="group" aria-label="Image zoom">
        <button type="button" className="md-conversation-image__control" aria-label="Zoom out" title="Zoom out (−)" disabled={view.scale === 1} onClick={() => zoom(1 / 1.25)}><SemanticIcon name="action.zoom-out" size={16} aria-hidden="true" /></button>
        <span className="md-conversation-image__zoom" aria-label="Zoom level">{Math.round(view.scale * 100)}%</span>
        <button type="button" className="md-conversation-image__control" aria-label="Zoom in" title="Zoom in (+)" disabled={view.scale >= size.maxScale} onClick={() => zoom(1.25)}><SemanticIcon name="action.zoom-in" size={16} aria-hidden="true" /></button>
        <button type="button" className="md-conversation-image__control" aria-label="Fit image" title="Fit image (0)" onClick={fit}><SemanticIcon name="layout.expand" size={16} aria-hidden="true" /></button>
      </div>
    </footer>
  </div>
}
