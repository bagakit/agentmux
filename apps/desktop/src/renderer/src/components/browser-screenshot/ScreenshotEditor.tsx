import { TextInput } from '@agentmux/client-ui/input'
import { mintObjectId } from '@agentmux/core/object-id'
// Portions adapted from a third-party MIT-licensed implementation (commit 4fd93ead1999dc34e13ac5915693ad8467a39a6e).
// Copyright (c) 2026 Lovecast Inc., MIT License. See THIRD_PARTY_NOTICES.md.

import { semanticIconComponent } from '@agentmux/client-ui/icons'
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
import { isImeCompositionKeyDown } from '../../lib/ime-composition-keyboard-event'
import { isMacPlatform } from '../../lib/host-platform'

const ThemeDrawingFreehandIcon = semanticIconComponent('drawing.freehand')
const ThemeDrawingHighlightIcon = semanticIconComponent('drawing.highlight')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeDrawingRectangleIcon = semanticIconComponent('drawing.rectangle')
const ThemeDrawingCircleIcon = semanticIconComponent('drawing.circle')
const ThemeDrawingTextIcon = semanticIconComponent('drawing.text')
const ThemeActionUndoIcon = semanticIconComponent('action.undo')
const ThemeActionRedoIcon = semanticIconComponent('action.redo')
const ThemeActionRemoveIcon = semanticIconComponent('action.remove')
const ThemeActionCancelIcon = semanticIconComponent('action.cancel')
const ThemeObjectClipboardIcon = semanticIconComponent('object.clipboard')


type EditorSize = { width: number; height: number; dpr: number }
type PendingText = ScreenshotPoint

const TOOLS: Array<{
  id: ScreenshotTool
  label: string
  icon: typeof ThemeDrawingFreehandIcon
}> = [
  { id: 'pen', label: 'Pen', icon: ThemeDrawingFreehandIcon },
  { id: 'highlight', label: 'Highlighter', icon: ThemeDrawingHighlightIcon },
  { id: 'arrow', label: 'Arrow', icon: ThemeActionOpenExternalIcon },
  { id: 'rect', label: 'Rectangle', icon: ThemeDrawingRectangleIcon },
  { id: 'ellipse', label: 'Ellipse', icon: ThemeDrawingCircleIcon },
  { id: 'text', label: 'Text', icon: ThemeDrawingTextIcon }
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
  // Pointer samples belong to this gesture. React only sees completed edits;
  // live canvas painting is coalesced on the owning animation frame.
  const currentGestureRef = useRef<ScreenshotShape | null>(null)
  const paintFrame = useRef(0)
  const committedLayerRef = useRef<HTMLCanvasElement | null>(null)
  const textInputRef = useRef<HTMLInputElement>(null)
  if (!committedLayerRef.current && typeof document !== 'undefined') {
    committedLayerRef.current = document.createElement('canvas')
  }
  const [loaded, setLoaded] = useState(false)
  const [size, setSize] = useState<EditorSize>({ width: 0, height: 0, dpr: 1 })
  const paintSize = useRef(size)
  paintSize.current = size
  const [documentState, setDocumentState] = useState<ScreenshotDocument>(() => createScreenshotDocument())
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

  const schedulePaint = useCallback(() => {
    if (paintFrame.current) return
    paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = 0
      const canvas = canvasRef.current, committed = committedLayerRef.current
      const size = paintSize.current
      if (canvas && committed) renderScreenshotScene(canvas, committed, currentGestureRef.current, size.width, size.height, size.dpr)
    })
  }, [])

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
    schedulePaint()
  }, [documentState.shapes, size, schedulePaint])
  useEffect(() => () => {
    cancelAnimationFrame(paintFrame.current)
    currentGestureRef.current = null
  }, [])

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
      const modifier = isMacPlatform() ? event.metaKey : event.ctrlKey
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
    const id = mintObjectId()
    const shape: ScreenshotShape = tool === 'pen' || tool === 'highlight'
      ? { id, kind: tool, color, width, points: [at] }
      : { id, kind: tool, color, width, from: at, to: at }
    currentGestureRef.current = shape
    schedulePaint()
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const current = currentGestureRef.current
    if (!current || current.kind === 'text') return
    const to = point(event)
    if (current.kind === 'pen' || current.kind === 'highlight') current.points.push(to)
    else current.to = to
    schedulePaint()
  }

  function onPointerUp(): void {
    const finished = currentGestureRef.current
    currentGestureRef.current = null
    if (finished) setDocumentState((current) => commitShape(current, finished))
    schedulePaint()
  }

  function commitText(value: string): void {
    const at = pendingText
    setPendingText(null)
    const text = value.trim().slice(0, 500)
    if (!at || !text) return
    setDocumentState((current) => commitShape(current, {
      id: mintObjectId(),
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
    <div className="browser-screenshot-editor" role="dialog" aria-label="Screenshot editor">
      <div ref={containerRef} className="browser-screenshot-editor__canvas-area">
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
          <TextInput
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
              // 组字确认用的 Enter（CJK 输入法）不能提交标注文本，否则半转换的取值会被落成一条 text
              // 图形。此前只判 `!event.nativeEvent.isComposing`，那漏掉了另外三个来源（合成事件的
              // isComposing、两处 keyCode===229），换成完整的四路判据。
              if (isImeCompositionKeyDown(event)) return
              if (event.key === 'Enter') {
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
          <button type="button" aria-label="Undo" disabled={busy || !canUndo(documentState)} onClick={undo}><ThemeActionUndoIcon size={14} /></button>
          <button type="button" aria-label="Redo" disabled={busy || !canRedo(documentState)} onClick={redo}><ThemeActionRedoIcon size={14} /></button>
          <button
            type="button"
            aria-label="Clear all"
            disabled={busy || documentState.shapes.length === 0}
            onClick={() => {
              currentGestureRef.current = null
              setPendingText(null)
              schedulePaint()
              setDocumentState((current) => clearShapes(current))
            }}
          >
            <ThemeActionRemoveIcon size={14} />
          </button>
        </div>
        <div className="browser-screenshot-toolbar__actions">
          <button type="button" onClick={onCancel}><ThemeActionCancelIcon size={13} /> Cancel</button>
          <button className="primary-button" type="button" disabled={busy || !loaded} onClick={complete}>
            <ThemeObjectClipboardIcon size={13} /> {busy ? 'Copying…' : 'Copy PNG'}
          </button>
        </div>
      </div>
    </div>
  )
}
