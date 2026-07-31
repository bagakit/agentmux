// Portions adapted from a third-party MIT-licensed implementation (commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e).
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

import {
  ArrowUpRight,
  Circle,
  Clipboard,
  Highlighter,
  Pencil,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  X
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { BrowserPng } from '../../../../shared/contracts'
import { renderCommittedLayer, renderScreenshotScene } from './canvas-render'
import {
  canRedo,
  canUndo,
  clearShapes,
  commitShape,
  createScreenshotDocument,
  DEFAULT_SCREENSHOT_COLOR,
  DEFAULT_SCREENSHOT_FONT_SIZE,
  DEFAULT_SCREENSHOT_WIDTH,
  redoShape,
  SCREENSHOT_COLORS,
  SCREENSHOT_FONT_SIZES,
  SCREENSHOT_WIDTHS,
  undoShape,
  type ScreenshotDocument,
  type ScreenshotPoint,
  type ScreenshotShape,
  type ScreenshotTool
} from './drawing-model'
import { SCREENSHOT_TEXT_FONT } from './drawing-renderer'

type EditorSize = { width: number; height: number; dpr: number }
type PendingText = ScreenshotPoint

const TOOLS: Array<{
  id: ScreenshotTool
  label: string
  icon: typeof Pencil
}> = [
  { id: 'pen', label: 'Pen', icon: Pencil },
  { id: 'highlight', label: 'Highlighter', icon: Highlighter },
  { id: 'arrow', label: 'Arrow', icon: ArrowUpRight },
  { id: 'rect', label: 'Rectangle', icon: Square },
  { id: 'ellipse', label: 'Ellipse', icon: Circle },
  { id: 'text', label: 'Text', icon: Type }
]

export type ScreenshotCompleteInput = {
  image: HTMLImageElement
  shapes: ScreenshotShape[]
  displayWidth: number
  displayHeight: number
}

export function ScreenshotEditor({
  image,
  busy,
  onCancel,
  onComplete
}: {
  image: BrowserPng
  busy: boolean
  onCancel(): void
  onComplete(input: ScreenshotCompleteInput): void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const committedLayerRef = useRef<HTMLCanvasElement | null>(null)
  const textInputRef = useRef<HTMLInputElement>(null)
  if (!committedLayerRef.current && typeof document !== 'undefined') {
    committedLayerRef.current = document.createElement('canvas')
  }
  const [loaded, setLoaded] = useState(false)
  const [size, setSize] = useState<EditorSize>({ width: 0, height: 0, dpr: 1 })
  const [documentState, setDocumentState] = useState<ScreenshotDocument>(() => createScreenshotDocument())
  const [inProgress, setInProgress] = useState<ScreenshotShape | null>(null)
  const [pendingText, setPendingText] = useState<PendingText | null>(null)
  const [tool, setTool] = useState<ScreenshotTool>('pen')
  const [color, setColor] = useState(DEFAULT_SCREENSHOT_COLOR)
  const [width, setWidth] = useState(DEFAULT_SCREENSHOT_WIDTH)
  const [fontSize, setFontSize] = useState(DEFAULT_SCREENSHOT_FONT_SIZE)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = (): void => {
      const rect = container.getBoundingClientRect()
      const fit = Math.min(rect.width / image.width, rect.height / image.height)
      const next = {
        width: Math.max(1, image.width * fit),
        height: Math.max(1, image.height * fit),
        dpr: window.devicePixelRatio || 1
      }
      setSize((current) => (
        current.width === next.width && current.height === next.height && current.dpr === next.dpr
          ? current
          : next
      ))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [image.height, image.width])

  useEffect(() => {
    const committed = committedLayerRef.current
    if (!committed) return
    renderCommittedLayer(
      committed,
      documentState.shapes,
      size.width,
      size.height,
      size.dpr
    )
  }, [documentState.shapes, size])

  useEffect(() => {
    const canvas = canvasRef.current
    const committed = committedLayerRef.current
    if (!canvas || !committed) return
    const frame = requestAnimationFrame(() => {
      renderScreenshotScene(canvas, committed, inProgress, size.width, size.height, size.dpr)
    })
    return () => cancelAnimationFrame(frame)
  }, [documentState.shapes, inProgress, size])

  useEffect(() => {
    if (!pendingText) return
    const frame = requestAnimationFrame(() => textInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [pendingText])

  const undo = useCallback(() => setDocumentState((current) => undoShape(current)), [])
  const redo = useCallback(() => setDocumentState((current) => redoShape(current)), [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (pendingText) setPendingText(null)
        else onCancel()
        return
      }
      if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return
      const modifier = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel, pendingText, redo, undo])

  function point(event: { clientX: number; clientY: number }): ScreenshotPoint {
    const rect = canvasRef.current?.getBoundingClientRect()
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (busy || event.button !== 0) return
    const at = point(event)
    if (tool === 'text') {
      if (!pendingText) {
        event.preventDefault()
        setPendingText(at)
      }
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const id = crypto.randomUUID()
    setInProgress(tool === 'pen' || tool === 'highlight'
      ? { id, kind: tool, color, width, points: [at] }
      : { id, kind: tool, color, width, from: at, to: at })
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const to = point(event)
    setInProgress((current) => {
      if (!current) return current
      if (current.kind === 'pen' || current.kind === 'highlight') {
        return { ...current, points: [...current.points, to] }
      }
      if (current.kind === 'text') return current
      return { ...current, to }
    })
  }

  function onPointerUp(): void {
    if (inProgress) setDocumentState((current) => commitShape(current, inProgress))
    setInProgress(null)
  }

  function commitText(value: string): void {
    const at = pendingText
    setPendingText(null)
    const text = value.trim().slice(0, 500)
    if (!at || !text) return
    setDocumentState((current) => commitShape(current, {
      id: crypto.randomUUID(),
      kind: 'text',
      color,
      at,
      text,
      fontSize
    }))
  }

  function complete(): void {
    const base = imageRef.current
    const viewport = viewportRef.current
    if (!base || !viewport || !loaded) return
    const rect = viewport.getBoundingClientRect()
    onComplete({
      image: base,
      shapes: documentState.shapes,
      displayWidth: rect.width,
      displayHeight: rect.height
    })
  }

  return (
    <div ref={containerRef} className="browser-screenshot-editor" aria-label="Screenshot editor">
      <div
        ref={viewportRef}
        className="browser-screenshot-editor__viewport"
        style={{ width: size.width, height: size.height }}
      >
        <img
          ref={imageRef}
          src={image.dataUrl}
          alt="Captured browser viewport"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={onCancel}
        />
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {pendingText ? (
          <input
            ref={textInputRef}
            className="browser-screenshot-editor__text"
            aria-label="Screenshot text"
            maxLength={500}
            style={{
              left: pendingText.x,
              top: pendingText.y,
              color,
              fontSize,
              fontFamily: SCREENSHOT_TEXT_FONT
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onBlur={(event) => commitText(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                commitText(event.currentTarget.value)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setPendingText(null)
              }
            }}
          />
        ) : null}
      </div>
      <div className="browser-screenshot-toolbar" role="toolbar" aria-label="Screenshot markup tools">
        <div className="browser-screenshot-toolbar__tools">
          {TOOLS.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                aria-label={item.label}
                aria-pressed={tool === item.id}
                className={tool === item.id ? 'selected' : ''}
                disabled={busy}
                onClick={() => setTool(item.id)}
              >
                <Icon size={14} />
              </button>
            )
          })}
          <span className="browser-screenshot-toolbar__divider" />
          <div className="browser-screenshot-toolbar__colors" aria-label="Markup color">
            {SCREENSHOT_COLORS.map((option) => (
              <button
                key={option}
                type="button"
                aria-label={`Color ${option}`}
                aria-pressed={color === option}
                className={color === option ? 'selected' : ''}
                style={{ backgroundColor: option }}
                disabled={busy}
                onClick={() => setColor(option)}
              />
            ))}
          </div>
          <select aria-label="Stroke width" value={width} disabled={busy} onChange={(event) => setWidth(Number(event.target.value))}>
            {SCREENSHOT_WIDTHS.map((option) => <option key={option} value={option}>{option}px</option>)}
          </select>
          {tool === 'text' ? (
            <select aria-label="Text size" value={fontSize} disabled={busy} onChange={(event) => setFontSize(Number(event.target.value))}>
              {SCREENSHOT_FONT_SIZES.map((option) => <option key={option} value={option}>{option}px</option>)}
            </select>
          ) : null}
          <span className="browser-screenshot-toolbar__divider" />
          <button type="button" aria-label="Undo" disabled={busy || !canUndo(documentState)} onClick={undo}><Undo2 size={14} /></button>
          <button type="button" aria-label="Redo" disabled={busy || !canRedo(documentState)} onClick={redo}><Redo2 size={14} /></button>
          <button
            type="button"
            aria-label="Clear all"
            disabled={busy || documentState.shapes.length === 0}
            onClick={() => {
              setPendingText(null)
              setInProgress(null)
              setDocumentState((current) => clearShapes(current))
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
        <div className="browser-screenshot-toolbar__actions">
          <span>Mark the frozen page, then copy a PNG.</span>
          <button type="button" disabled={busy} onClick={onCancel}><X size={13} /> Cancel</button>
          <button className="primary-button" type="button" disabled={busy || !loaded} onClick={complete}>
            <Clipboard size={13} /> {busy ? 'Copying…' : 'Copy PNG'}
          </button>
        </div>
      </div>
    </div>
  )
}
