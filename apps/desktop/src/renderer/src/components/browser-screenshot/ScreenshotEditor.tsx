import { TextInput, ComposerTextarea } from '@agentmux/client-ui/input'
import { mintObjectId } from '@agentmux/core/object-id'
// Portions adapted from Orca, MIT Copyright (c) 2026 Lovecast Inc.; see THIRD_PARTY_NOTICES.md.
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { BrowserPng } from '../../../../shared/contracts'
import { renderCommittedLayer, renderScreenshotScene } from './canvas-render'
import { canRedo, canUndo, clearShapes, commitShape, createScreenshotDocument, DEFAULT_SCREENSHOT_COLOR,
  DEFAULT_SCREENSHOT_FONT_SIZE, DEFAULT_SCREENSHOT_WIDTH, redoShape, SCREENSHOT_COLORS, SCREENSHOT_FONT_SIZES,
  SCREENSHOT_WIDTHS, undoShape, hitTestShape, moveShape, replaceShape, removeShapes, setCrop, normalizeRect,
  intersectRect, shapeBounds, screenshotOutputShapes, type ScreenshotDocument, type ScreenshotPoint,
  type ScreenshotShape, type ScreenshotTool, type NormalizedRect, type TextShape } from './drawing-model'
import { SCREENSHOT_TEXT_FONT } from './drawing-renderer'
import { isImeCompositionKeyDown } from '../../lib/ime-composition-keyboard-event'
import { isMacPlatform } from '../../lib/host-platform'

type EditorTool = ScreenshotTool | 'select' | 'erase' | 'crop' | 'pixelate' | 'note'
const icon = semanticIconComponent
const UndoIcon = icon('action.undo'), RedoIcon = icon('action.redo'), DeleteIcon = icon('action.remove')
const CancelIcon = icon('action.cancel'), ClipboardIcon = icon('object.clipboard'), CheckIcon = icon('status.copied')
const TOOLS: Array<{ id: EditorTool; label: string; key: string; icon: ReturnType<typeof icon> }> = [
  { id: 'select', label: 'Select', key: 'V', icon: icon('drawing.select') },
  { id: 'pen', label: 'Pen', key: 'P', icon: icon('drawing.freehand') },
  { id: 'highlight', label: 'Highlighter', key: 'H', icon: icon('drawing.highlight') },
  { id: 'arrow', label: 'Arrow', key: 'A', icon: icon('drawing.arrow') },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: icon('drawing.rectangle') },
  { id: 'ellipse', label: 'Ellipse', key: 'E', icon: icon('drawing.circle') },
  { id: 'text', label: 'Text', key: 'T', icon: icon('drawing.text') },
  { id: 'note', label: 'Numbered note', key: 'N', icon: icon('drawing.note') },
  { id: 'crop', label: 'Crop', key: 'C', icon: icon('drawing.crop') },
  { id: 'pixelate', label: 'Pixelate', key: 'M', icon: icon('drawing.pixelate') },
  { id: 'erase', label: 'Erase', key: 'X', icon: icon('action.erase') }
]
export type ScreenshotCompleteInput = {
  image: HTMLImageElement
  shapes: ScreenshotShape[]
  crop: NormalizedRect | null
  /** Model coordinates always refer to original captured image pixels. */
  displayWidth: number
  displayHeight: number
}
type EditorSize = { width: number; height: number; dpr: number }
export function ScreenshotEditor({ image, busy, copied, active = true, onCancel, onComplete, onCopyContext, onEdited, onError }: {
  image: BrowserPng
  busy: boolean
  copied?: string | null
  active?: boolean
  onCancel(): void
  onComplete(input: ScreenshotCompleteInput): void
  onCopyContext?(input: ScreenshotCompleteInput): void
  onEdited?(): void
  onError?(error: unknown): void
}) {
  const containerRef = useRef<HTMLDivElement>(null), viewportRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), textInputRef = useRef<HTMLInputElement>(null)
  const currentGestureRef = useRef<ScreenshotShape | null>(null), paintFrame = useRef(0)
  const moveRef = useRef<{ original: ScreenshotShape; start: ScreenshotPoint } | null>(null)
  const cropRef = useRef<{ from: ScreenshotPoint; to: ScreenshotPoint } | null>(null)
  const eraseRef = useRef<Set<string> | null>(null)
  const lastErasePoint = useRef<ScreenshotPoint | null>(null)
  const committedLayerRef = useRef<HTMLCanvasElement | null>(null)
  if (!committedLayerRef.current && typeof document !== 'undefined') committedLayerRef.current = document.createElement('canvas')
  const [loaded, setLoaded] = useState(false)
  const [size, setSize] = useState<EditorSize>({ width: 0, height: 0, dpr: 1 })
  const [documentState, setDocumentState] = useState<ScreenshotDocument>(() => createScreenshotDocument())
  const [pendingText, setPendingText] = useState<ScreenshotPoint | null>(null)
  const [tool, setTool] = useState<EditorTool>('pen')
  const [selectedId, setSelectedId] = useState<string | null>(null), [draggingId, setDraggingId] = useState<string | null>(null)
  const [color, setColor] = useState(DEFAULT_SCREENSHOT_COLOR), [width, setWidth] = useState(DEFAULT_SCREENSHOT_WIDTH)
  const [fontSize, setFontSize] = useState(DEFAULT_SCREENSHOT_FONT_SIZE), [blockSize, setBlockSize] = useState(16)
  const [noteDraft, setNoteDraft] = useState('')
  const selected = documentState.shapes.find(shape => shape.id === selectedId) ?? null
  const selectedNote = selected?.kind === 'note' ? selected : null
  const live = useRef({ size, documentState, loaded, selected, draggingId, tool, active })
  live.current = { size, documentState, loaded, selected, draggingId, tool, active }
  const fit = size.width / image.width || 1
  const originalBounds = { x: 0, y: 0, width: image.width, height: image.height }
  const notes = documentState.shapes.filter(shape => shape.kind === 'note')
  useEffect(() => {
    if (!active) return
    const focusCanvas = () => {
      const focused = document.activeElement, editor = editorRef.current
      const pane = editor?.closest('.browser-surface')
      if (focused && editor?.contains(focused)) return
      if (focused === document.body || (pane && focused instanceof HTMLButtonElement && focused.closest('.browser-surface') === pane)) canvasRef.current?.focus({ preventScroll: true })
    }
    focusCanvas()
    // A closing menu restores its trigger after the editor mounts. Complete that
    // local handoff without taking focus from another workface or an editor input.
    const frame = requestAnimationFrame(focusCanvas)
    return () => cancelAnimationFrame(frame)
  }, [active, pendingText])

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return
    const measure = () => {
      const rect = container.getBoundingClientRect(), scale = Math.min(rect.width / image.width, rect.height / image.height)
      const next = { width: Math.max(1, image.width * scale), height: Math.max(1, image.height * scale), dpr: window.devicePixelRatio || 1 }
      setSize(current => current.width === next.width && current.height === next.height && current.dpr === next.dpr ? current : next)
    }
    measure(); const observer = new ResizeObserver(measure); observer.observe(container)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [active, image.width, image.height])

  const schedulePaint = useCallback(() => {
    if (paintFrame.current) return
    paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = 0
      const canvas = canvasRef.current, committed = committedLayerRef.current
      const { size, documentState, loaded, selected, draggingId, tool, active } = live.current
      if (!active || !canvas || !committed) return
      const fit = size.width / image.width || 1
      try {
        if (eraseRef.current) renderCommittedLayer(committed,
          screenshotOutputShapes(documentState.shapes.filter(shape => !eraseRef.current!.has(shape.id)), documentState.crop),
          size.width, size.height, size.dpr, loaded ? imageRef.current! : undefined, image.width)
        renderScreenshotScene(canvas, committed, currentGestureRef.current, size.width, size.height, size.dpr, image.width)
        const context = canvas.getContext('2d')
        if (!context) return
        const crop = cropRef.current ? intersectRect(normalizeRect(cropRef.current.from, cropRef.current.to), { x: 0, y: 0, width: image.width, height: image.height }) : documentState.crop
        context.save()
        if (crop) {
          context.fillStyle = 'rgba(8, 13, 20, .58)'
          context.fillRect(0, 0, image.width, crop.y); context.fillRect(0, crop.y + crop.height, image.width, image.height - crop.y - crop.height)
          context.fillRect(0, crop.y, crop.x, crop.height); context.fillRect(crop.x + crop.width, crop.y, image.width - crop.x - crop.width, crop.height)
          context.strokeStyle = '#ffffff'; context.lineWidth = 1 / fit; context.setLineDash([5 / fit, 4 / fit])
          context.strokeRect(crop.x, crop.y, crop.width, crop.height)
        }
        if (selected && tool !== 'erase' && tool !== 'crop') {
          const shape = draggingId ? currentGestureRef.current ?? selected : selected
          const box = shapeBounds(shape, measureText)
          context.strokeStyle = '#3b82f6'; context.lineWidth = 1 / fit; context.setLineDash([4 / fit, 3 / fit])
          context.strokeRect(box.x - 4 / fit, box.y - 4 / fit, box.width + 8 / fit, box.height + 8 / fit)
        }
        context.restore()
      } catch (error) { onError?.(error) }
    })
  }, [image.width, image.height, onError])

  useEffect(() => {
    if (!active) return
    const layer = committedLayerRef.current
    if (!layer) return
    try {
      renderCommittedLayer(layer, screenshotOutputShapes(documentState.shapes.filter(shape => shape.id !== draggingId), documentState.crop),
        size.width, size.height, size.dpr, loaded ? imageRef.current! : undefined, image.width)
      schedulePaint()
    } catch (error) { onError?.(error) }
  }, [active, documentState, draggingId, image.width, loaded, size, schedulePaint, onError])
  useEffect(() => () => { cancelAnimationFrame(paintFrame.current); currentGestureRef.current = null }, [])
  useEffect(() => {
    if (!active || !pendingText) return
    const frame = requestAnimationFrame(() => textInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [active, pendingText])
  useEffect(() => { setNoteDraft(selectedNote?.note ?? '') }, [selectedNote?.id, selectedNote?.note])

  const edit = useCallback((update: (current: ScreenshotDocument) => ScreenshotDocument) => { onEdited?.(); setDocumentState(update) }, [onEdited])
  const resetGesture = useCallback(() => { currentGestureRef.current = null; moveRef.current = null; cropRef.current = null; eraseRef.current = null; lastErasePoint.current = null; setDraggingId(null) }, [])
  useEffect(() => { if (!active) resetGesture() }, [active, resetGesture])
  const undo = useCallback(() => { resetGesture(); edit(undoShape) }, [edit, resetGesture])
  const redo = useCallback(() => { resetGesture(); edit(redoShape) }, [edit, resetGesture])
  const removeSelected = useCallback(() => {
    if (selectedId) { edit(doc => removeShapes(doc, new Set([selectedId]))); setSelectedId(null) }
  }, [edit, selectedId])
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Node && event.target !== document.body ? event.target : document.activeElement
      if (!target || !editorRef.current?.contains(target)) return
      if (event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') { event.preventDefault(); if (pendingText) setPendingText(null); else onCancel(); return }
      if (busy || event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return
      const modifier = isMacPlatform() ? event.metaKey : event.ctrlKey
      if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); return }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const next = TOOLS.find(item => item.key.toLowerCase() === event.key.toLowerCase())
      if (next) { event.preventDefault(); resetGesture(); setTool(next.id) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, busy, onCancel, pendingText, redo, undo, removeSelected, resetGesture])

  function measureText(shape: TextShape): number {
    const context = canvasRef.current?.getContext('2d')
    if (!context) return shape.text.length * shape.fontSize * 0.65
    context.save(); context.font = `600 ${shape.fontSize}px ${SCREENSHOT_TEXT_FONT}`
    const result = context.measureText(shape.text).width; context.restore(); return result
  }
  function point(event: { clientX: number; clientY: number }): ScreenshotPoint {
    const rect = viewportRef.current?.getBoundingClientRect()
    return rect ? { x: (event.clientX - rect.left) * image.width / rect.width, y: (event.clientY - rect.top) * image.height / rect.height } : { x: 0, y: 0 }
  }
  function hit(at: ScreenshotPoint, erased?: Set<string>) {
    return hitTestShape(screenshotOutputShapes(documentState.shapes, documentState.crop).filter(shape => !erased?.has(shape.id)), at, 6 / fit, measureText)
  }
  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!active || busy || event.button !== 0) return
    event.currentTarget.focus({ preventScroll: true })
    const at = point(event)
    if (tool === 'text') { if (!pendingText) { event.preventDefault(); setPendingText(at) } return }
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'select') {
      const shape = hit(at); setSelectedId(shape?.id ?? null)
      if (shape) { moveRef.current = { original: shape, start: at }; currentGestureRef.current = shape; setDraggingId(shape.id) }
    } else if (tool === 'erase') {
      eraseRef.current = new Set(); lastErasePoint.current = at; const shape = hit(at); if (shape) eraseRef.current.add(shape.id)
    } else if (tool === 'crop') cropRef.current = { from: at, to: at }
    else {
      const id = mintObjectId(), stroke = width / fit
      currentGestureRef.current = tool === 'pen' || tool === 'highlight'
        ? { id, kind: tool, color, width: stroke, points: [at] }
        : tool === 'pixelate' ? { id, kind: 'pixelate', color, blockSize: blockSize / fit, from: at, to: at }
        : tool === 'note' ? { id, kind: 'note', color, width: stroke / 2, radius: 12 / fit, number: Math.max(0, ...notes.map(note => note.number)) + 1, note: '', from: at, to: at }
        : { id, kind: tool, color, width: stroke, from: at, to: at }
    }
    schedulePaint()
  }
  function updateGesture(at: ScreenshotPoint) {
    if (moveRef.current) {
      const { original, start } = moveRef.current
      currentGestureRef.current = moveShape(original, at.x - start.x, at.y - start.y)
    } else if (cropRef.current) cropRef.current.to = at
    else if (eraseRef.current) {
      const from = lastErasePoint.current ?? at
      const steps = Math.max(1, Math.ceil(Math.hypot(at.x - from.x, at.y - from.y) * fit / 8))
      for (let step = 1; step <= steps; step++) {
        const sample = { x: from.x + (at.x - from.x) * step / steps, y: from.y + (at.y - from.y) * step / steps }
        const shape = hit(sample, eraseRef.current); if (shape) eraseRef.current.add(shape.id)
      }
      lastErasePoint.current = at
    }
    else {
      const shape = currentGestureRef.current
      if (!shape || shape.kind === 'text') return
      if (shape.kind === 'pen' || shape.kind === 'highlight') {
        const last = shape.points.at(-1)
        if (!last || last.x !== at.x || last.y !== at.y) shape.points.push(at)
      } else shape.to = at
    }
    schedulePaint()
  }
  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) { if (currentGestureRef.current || cropRef.current || eraseRef.current) updateGesture(point(event)) }
  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.type === 'pointerup' && (currentGestureRef.current || cropRef.current || eraseRef.current)) updateGesture(point(event))
    const finished = currentGestureRef.current, move = moveRef.current, crop = cropRef.current, erased = eraseRef.current
    resetGesture()
    if (crop) {
      const box = intersectRect(normalizeRect(crop.from, crop.to), originalBounds)
      if (box) edit(doc => setCrop(doc, box))
    } else if (erased?.size) edit(doc => removeShapes(doc, erased))
    else if (finished) {
      if (move) { if (JSON.stringify(finished) !== JSON.stringify(move.original)) edit(doc => replaceShape(doc, finished)) }
      else edit(doc => commitShape(doc, finished))
      if (finished.kind === 'note') setSelectedId(finished.id)
    }
    schedulePaint()
  }
  function commitText(value: string) {
    const at = pendingText; setPendingText(null); const text = value.trim().slice(0, 500)
    if (at && text) edit(doc => commitShape(doc, { id: mintObjectId(), kind: 'text', color, at, text, fontSize: fontSize / fit }))
  }
  function commitNote() {
    if (selectedNote && noteDraft !== selectedNote.note) edit(doc => replaceShape(doc, { ...selectedNote, note: noteDraft.trim().slice(0, 1000) }))
  }
  function complete(context = false) {
    const base = imageRef.current
    if (!base || !loaded) return
    const shapes = selectedNote ? documentState.shapes.map(shape => shape.id === selectedNote.id ? { ...selectedNote, note: noteDraft.trim().slice(0, 1000) } : shape) : documentState.shapes
    const input = { image: base, shapes, crop: documentState.crop, displayWidth: image.width, displayHeight: image.height }
    if (context) onCopyContext?.(input); else onComplete(input)
  }
  function setProperty(property: 'color' | 'width' | 'fontSize', value: string | number) {
    if (property === 'color') setColor(String(value)); else if (property === 'width') setWidth(Number(value)); else setFontSize(Number(value))
    if (tool === 'select' && selected && property in selected) edit(doc => replaceShape(doc, { ...selected, [property]: property === 'color' ? value : Number(value) / fit } as ScreenshotShape))
  }
  const properties = tool === 'select' ? selected : null
  const showColor = !['crop', 'pixelate', 'erase'].includes(tool) && (tool !== 'select' || Boolean(properties && properties.kind !== 'pixelate'))
  const showWidth = showColor && tool !== 'text' && tool !== 'note' && properties?.kind !== 'text'
  const showFont = tool === 'text' || properties?.kind === 'text'
  const displayedWidth = Number((properties && 'width' in properties ? properties.width * fit : width).toFixed(2))
  const displayedFont = Number((properties?.kind === 'text' ? properties.fontSize * fit : fontSize).toFixed(2))
  const widthOptions = [...new Set<number>([...SCREENSHOT_WIDTHS, displayedWidth])].sort((a, b) => a - b)
  const fontOptions = [...new Set<number>([...SCREENSHOT_FONT_SIZES, displayedFont])].sort((a, b) => a - b)
  return <div ref={editorRef} className="browser-screenshot-editor" role="dialog" aria-label="Screenshot editor" style={active ? undefined : { display: 'none' }}>
    <header className="browser-screenshot-editor__header">
      <span className="browser-screenshot-editor__title"><strong>Screenshot</strong><small>{image.width} × {image.height}</small></span>
      <span className="browser-screenshot-editor__status" role="status">{copied ? <><CheckIcon size={13} />{copied}</> : null}</span>
      <div className="browser-screenshot-toolbar__actions">
        <button type="button" onClick={onCancel}><CancelIcon size={13} /> Cancel</button>
        {onCopyContext ? <button type="button" disabled={busy || !loaded} onClick={() => complete(true)}>Copy context</button> : null}
        <button className="primary-button" type="button" disabled={busy || !loaded} onClick={() => complete()}><ClipboardIcon size={13} />{busy ? 'Copying…' : 'Copy PNG'}</button>
      </div>
    </header>
    <div className="browser-screenshot-toolbar" role="toolbar" aria-label="Screenshot markup tools">
      <div className="browser-screenshot-toolbar__tools">
        {TOOLS.map(item => <button key={item.id} type="button" aria-label={item.label} title={`${item.label} (${item.key})`} aria-keyshortcuts={item.key}
          aria-pressed={tool === item.id} className={tool === item.id ? 'selected' : ''} disabled={busy}
          onClick={() => { resetGesture(); setTool(item.id); if (item.id !== 'select' && item.id !== 'note') setSelectedId(null); schedulePaint() }}><item.icon size={16} /></button>)}
      </div>
      <div className="browser-screenshot-toolbar__history">
        <button type="button" aria-label="Undo" title="Undo" disabled={busy || !canUndo(documentState)} onClick={undo}><UndoIcon size={15} /></button>
        <button type="button" aria-label="Redo" title="Redo" disabled={busy || !canRedo(documentState)} onClick={redo}><RedoIcon size={15} /></button>
        <button type="button" aria-label="Delete selected" title="Delete selected (Delete)" disabled={busy || !selected} onClick={removeSelected}><DeleteIcon size={15} /></button>
        <button type="button" aria-label="Clear all" title="Clear all" disabled={busy || !documentState.shapes.length && !documentState.crop}
          onClick={() => { resetGesture(); setPendingText(null); setSelectedId(null); edit(clearShapes); schedulePaint() }}>Clear</button>
      </div>
    </div>
    <div className="browser-screenshot-editor__properties">
      <span className="browser-screenshot-editor__tool-name">{TOOLS.find(item => item.id === tool)?.label}</span>
      {showColor ? <div className="browser-screenshot-toolbar__colors" aria-label="Markup color">{SCREENSHOT_COLORS.map(option => <button key={option} type="button" aria-label={`Color ${option}`} title={option}
        aria-pressed={(properties?.color ?? color) === option} className={(properties?.color ?? color) === option ? 'selected' : ''}
        style={{ backgroundColor: option }} disabled={busy} onClick={() => setProperty('color', option)}>{(properties?.color ?? color) === option ? <CheckIcon size={10} /> : null}</button>)}</div> : null}
      {showWidth ? <label>Width<select aria-label="Stroke width" value={displayedWidth} disabled={busy} onChange={event => setProperty('width', Number(event.target.value))}>{widthOptions.map(option => <option key={option} value={option}>{option}px</option>)}</select></label> : null}
      {showFont ? <label>Size<select aria-label="Text size" value={displayedFont} disabled={busy} onChange={event => setProperty('fontSize', Number(event.target.value))}>{fontOptions.map(option => <option key={option} value={option}>{option}px</option>)}</select></label> : null}
      {tool === 'pixelate' ? <label>Blocks<select aria-label="Pixel size" value={blockSize} disabled={busy} onChange={event => setBlockSize(Number(event.target.value))}>{[8,16,24,32].map(option => <option key={option} value={option}>{option}px</option>)}</select></label> : null}
      {tool === 'crop' ? <><span className="browser-screenshot-editor__hint">Drag to keep an area</span>{documentState.crop ? <button type="button" disabled={busy} onClick={() => edit(doc => setCrop(doc, null))}>Reset crop</button> : null}</> : null}
      {tool === 'select' ? <span className="browser-screenshot-editor__hint">{selected ? 'Drag to move · Delete to remove' : 'Click an annotation to edit'}</span> : null}
      {tool === 'erase' ? <span className="browser-screenshot-editor__hint">Drag over annotations to remove them</span> : null}
      {tool === 'note' ? <span className="browser-screenshot-editor__hint">Click a point or drag a region</span> : null}
    </div>
    <div className="browser-screenshot-editor__workarea">
      <div ref={containerRef} className="browser-screenshot-editor__canvas-area">
        <div ref={viewportRef} className="browser-screenshot-editor__viewport" style={{ width: size.width, height: size.height }}>
          <img ref={imageRef} src={image.dataUrl} alt="Captured browser viewport" draggable={false} onLoad={() => setLoaded(true)} onError={onCancel} />
          <canvas ref={canvasRef} tabIndex={0} aria-label="Screenshot canvas" style={{ cursor: tool === 'select' ? selected ? 'move' : 'default' : 'crosshair' }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
          {pendingText ? <TextInput ref={textInputRef} className="browser-screenshot-editor__text" aria-label="Screenshot text" maxLength={500}
            style={{ left: pendingText.x * fit, top: pendingText.y * fit, color, fontSize, fontFamily: SCREENSHOT_TEXT_FONT }}
            onPointerDown={event => event.stopPropagation()} onBlur={event => commitText(event.currentTarget.value)} onKeyDown={event => {
              event.stopPropagation(); if (isImeCompositionKeyDown(event)) return
              if (event.key === 'Enter') { event.preventDefault(); commitText(event.currentTarget.value) }
              else if (event.key === 'Escape') { event.preventDefault(); setPendingText(null) }
            }} /> : null}
        </div>
      </div>
      {notes.length ? <aside className="browser-screenshot-editor__notes" aria-label="Numbered annotations">
        <header><strong>Notes</strong><small>{notes.length}</small></header>
        <div className="browser-screenshot-editor__note-list">{notes.map(note => <button type="button" key={note.id} className={note.id === selectedId ? 'selected' : ''} aria-label={`Note ${note.number}`} disabled={busy}
          onClick={() => { commitNote(); setSelectedId(note.id); setTool('select') }}><b>{note.number}</b><span>{note.note || 'Add a note…'}</span></button>)}</div>
        {selectedNote ? <label><span>Note {selectedNote.number}</span><ComposerTextarea aria-label="Note text" value={noteDraft} maxLength={1000} disabled={busy}
          placeholder="What should the Agent notice?" onValueChange={value => { setNoteDraft(value); onEdited?.() }} onBlur={commitNote} /></label> : <span className="browser-screenshot-editor__hint">Select a number to add context</span>}
      </aside> : null}
    </div>
    <footer className="browser-screenshot-editor__footer"><span>{documentState.crop ? `${Math.round(documentState.crop.width)} × ${Math.round(documentState.crop.height)} crop` : 'Original image'}</span><span>{documentState.shapes.length} annotations · {Math.round(fit * 100)}% · Esc to cancel</span></footer>
  </div>
}
