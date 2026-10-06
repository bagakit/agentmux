// Portions adapted from Orca, MIT Copyright (c) 2026 Lovecast Inc.; see THIRD_PARTY_NOTICES.md.
import { TextInput } from '@agentmux/client-ui/input'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { AnnotationToolbar, ANNOTATION_TOOLS, type AnnotationTool } from './AnnotationToolbar'
import { AnnotationOriginalMenu } from './AnnotationOriginalMenu'
import { AnnotationNotes } from './AnnotationNotes'
import { renderCommittedLayer, renderScreenshotScene } from './canvas-render'
import { canRedo, canUndo, clearShapes, commitShape, createScreenshotDocument, DEFAULT_SCREENSHOT_COLOR,
  DEFAULT_SCREENSHOT_FONT_SIZE, DEFAULT_SCREENSHOT_WIDTH, redoShape, SCREENSHOT_COLORS, SCREENSHOT_FONT_SIZES,
  SCREENSHOT_WIDTHS, undoShape, hitTestShape, moveShape, replaceShape, removeShapes, setCrop, normalizeRect,
  intersectRect, shapeBounds, screenshotOutputShapes, type ScreenshotDocument, type ScreenshotPoint,
  type ScreenshotShape, type TextShape, type NoteTemplate } from './drawing-model'
import { SCREENSHOT_TEXT_FONT } from './drawing-renderer'
import { selectionHandles, hitSelectionHandle, resizeShapeFromHandle, type SelectionHandleId } from './selection-geometry'
import { fitImageView, imagePoint, zoomImageView, type AnnotationView, type ImageViewport } from './view'
import type { AnnotationImage, ImageAnnotationInput } from './types'
import './image-annotation.css'

const icon = semanticIconComponent
const CancelIcon = icon('action.cancel'), ClipboardIcon = icon('object.clipboard'), CheckIcon = icon('status.copied')
const ZoomInIcon = icon('action.zoom-in'), ZoomOutIcon = icon('action.zoom-out')
type Size = { width: number; height: number; dpr: number }
type TextDraft = { shape: TextShape; existing: boolean }
type TransformGesture = { original: ScreenshotShape; start: ScreenshotPoint; handle?: SelectionHandleId }

export function ImageAnnotationEditor({ image, busy, copied, active = true, initialState, documentStatus,
  onCancel, onComplete, onCopyContext, onSaveOriginal, onOpenOriginal, onEdited, onError }: {
  image: AnnotationImage
  busy: boolean
  copied?: string | null
  active?: boolean
  initialState?: Pick<ScreenshotDocument, 'shapes' | 'crop'>
  documentStatus?: string | null
  onCancel(): void
  onComplete(input: ImageAnnotationInput): void
  onCopyContext?(input: ImageAnnotationInput): void
  onSaveOriginal?(input: ImageAnnotationInput): void
  onOpenOriginal?(): void
  onEdited?(): void
  onError?(error: unknown): void
}) {
  const editorRef = useRef<HTMLDivElement>(null), containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), textInputRef = useRef<HTMLInputElement>(null)
  const currentGestureRef = useRef<ScreenshotShape | null>(null), transformRef = useRef<TransformGesture | null>(null)
  const cropRef = useRef<{ from: ScreenshotPoint; to: ScreenshotPoint } | null>(null)
  const eraseRef = useRef<Set<string> | null>(null), lastErasePoint = useRef<ScreenshotPoint | null>(null)
  const panRef = useRef<{ start: ScreenshotPoint; view: AnnotationView; fitted: boolean } | null>(null)
  const textDraftRef = useRef<TextDraft | null>(null), paintFrame = useRef(0), spaceHeld = useRef(false)
  const committedLayerRef = useRef<HTMLCanvasElement | null>(null)
  if (!committedLayerRef.current && typeof document !== 'undefined') committedLayerRef.current = document.createElement('canvas')
  const [loaded, setLoaded] = useState(false), [size, setSize] = useState<Size>({ width: 0, height: 0, dpr: 1 })
  const [imageError, setImageError] = useState(false)
  const [documentState, setDocumentState] = useState<ScreenshotDocument>(() => ({ ...createScreenshotDocument(), ...initialState }))
  const [pendingText, setPendingText] = useState<TextDraft | null>(null)
  const [tool, setTool] = useState<AnnotationTool>('pen'), [selectedId, setSelectedId] = useState<string | null>(null)
  const [color, setColor] = useState(DEFAULT_SCREENSHOT_COLOR), [width, setWidth] = useState(DEFAULT_SCREENSHOT_WIDTH)
  const [fontSize, setFontSize] = useState(DEFAULT_SCREENSHOT_FONT_SIZE), [blockSize, setBlockSize] = useState(16)
  const [noteDraft, setNoteDraft] = useState(''), [panHeld, setPanHeld] = useState(false)
  const [view, setView] = useState<AnnotationView>({ scale: 1, x: 0, y: 0 }), [fitted, setFitted] = useState(true)
  const viewRef = useRef(view)
  const selected = documentState.shapes.find(shape => shape.id === selectedId) ?? null
  const selectedNote = selected?.kind === 'note' ? selected : null
  const notes = documentState.shapes.filter(shape => shape.kind === 'note')
  const live = useRef({ size, documentState, loaded, selected, tool, active, pendingText })
  live.current = { size, documentState, loaded, selected, tool, active, pendingText }
  const cache = useRef<{ document: ScreenshotDocument; view: AnnotationView; size: Size; loaded: boolean;
    excluded: string | undefined; erased: number; masks: ScreenshotShape[] } | null>(null)
  const originalBounds = { x: 0, y: 0, width: image.width, height: image.height }
  const scale = view.scale

  function measureText(shape: TextShape): number {
    const context = canvasRef.current?.getContext('2d')
    if (!context) return shape.text.length * shape.fontSize * 0.65
    context.save(); context.font = '600 ' + shape.fontSize + 'px ' + SCREENSHOT_TEXT_FONT
    const result = context.measureText(shape.text).width; context.restore(); return result
  }
  const schedulePaint = useCallback(() => {
    if (paintFrame.current) return
    paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = 0
      const canvas = canvasRef.current, committed = committedLayerRef.current, state = live.current, currentView = viewRef.current
      if (!state.active || !canvas || !committed || !state.size.width || !state.size.height) return
      const viewport: ImageViewport = { ...state.size, imageWidth: image.width, imageHeight: image.height, view: currentView }
      const excluded = transformRef.current?.original.id ?? (state.pendingText?.existing ? state.pendingText.shape.id : undefined)
      const erased = eraseRef.current?.size ?? 0, previous = cache.current
      try {
        if (!previous || previous.document !== state.documentState || previous.view !== currentView || previous.size !== state.size ||
          previous.loaded !== state.loaded || previous.excluded !== excluded || previous.erased !== erased) {
          const output = screenshotOutputShapes(state.documentState.shapes.filter(shape => shape.id !== excluded && !eraseRef.current?.has(shape.id)), state.documentState.crop)
          renderCommittedLayer(committed, output, viewport, state.loaded ? imageRef.current! : undefined)
          cache.current = { document: state.documentState, view: currentView, size: state.size, loaded: state.loaded, excluded, erased,
            masks: output.filter(shape => shape.kind === 'pixelate' || shape.kind === 'cover') }
        }
        renderScreenshotScene(canvas, committed, currentGestureRef.current, viewport, cache.current?.masks)
        const context = canvas.getContext('2d')
        if (!context) return
        const fit = currentView.scale
        const crop = cropRef.current ? intersectRect(normalizeRect(cropRef.current.from, cropRef.current.to), { x: 0, y: 0, width: image.width, height: image.height }) : state.documentState.crop
        context.save()
        if (crop) {
          context.fillStyle = 'rgba(8, 13, 20, .58)'
          context.fillRect(0, 0, image.width, crop.y); context.fillRect(0, crop.y + crop.height, image.width, image.height - crop.y - crop.height)
          context.fillRect(0, crop.y, crop.x, crop.height); context.fillRect(crop.x + crop.width, crop.y, image.width - crop.x - crop.width, crop.height)
          context.strokeStyle = '#ffffff'; context.lineWidth = 1 / fit; context.setLineDash([5 / fit, 4 / fit])
          context.strokeRect(crop.x, crop.y, crop.width, crop.height)
        }
        if (state.selected && state.tool === 'select' && !state.pendingText) {
          const shape = currentGestureRef.current ?? state.selected, box = shapeBounds(shape, measureText)
          context.strokeStyle = '#3b82f6'; context.lineWidth = 1 / fit; context.setLineDash([4 / fit, 3 / fit])
          context.strokeRect(box.x - 4 / fit, box.y - 4 / fit, box.width + 8 / fit, box.height + 8 / fit)
          context.setLineDash([]); context.fillStyle = '#ffffff'
          for (const handle of selectionHandles(shape)) {
            context.fillRect(handle.point.x - 4 / fit, handle.point.y - 4 / fit, 8 / fit, 8 / fit)
            context.strokeRect(handle.point.x - 4 / fit, handle.point.y - 4 / fit, 8 / fit, 8 / fit)
          }
        }
        context.restore()
        setView(current => current === currentView ? current : currentView)
      } catch (error) { onError?.(error) }
    })
  }, [image.width, image.height, onError])
  const requestView = useCallback((next: AnnotationView) => { viewRef.current = next; schedulePaint() }, [schedulePaint])
  const resetGesture = useCallback(() => {
    currentGestureRef.current = null; transformRef.current = null; cropRef.current = null; eraseRef.current = null
    lastErasePoint.current = null; panRef.current = null
  }, [])
  const edit = useCallback((update: (current: ScreenshotDocument) => ScreenshotDocument) => { onEdited?.(); setDocumentState(update) }, [onEdited])
  const undo = useCallback(() => { resetGesture(); edit(undoShape); schedulePaint() }, [edit, resetGesture, schedulePaint])
  const redo = useCallback(() => { resetGesture(); edit(redoShape); schedulePaint() }, [edit, resetGesture, schedulePaint])

  useEffect(() => {
    if (!active) return
    const focusCanvas = () => { if (document.activeElement === document.body) canvasRef.current?.focus({ preventScroll: true }) }
    focusCanvas(); const frame = requestAnimationFrame(focusCanvas)
    return () => cancelAnimationFrame(frame)
  }, [active, pendingText])
  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return
    const measure = () => { const rect = container.getBoundingClientRect()
      const next = { width: Math.max(1, rect.width), height: Math.max(1, rect.height), dpr: window.devicePixelRatio || 1 }
      setSize(current => current.width === next.width && current.height === next.height && current.dpr === next.dpr ? current : next)
    }
    measure(); const observer = new ResizeObserver(measure); observer.observe(container)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [active])
  useEffect(() => { if (active && fitted && size.width && size.height) requestView(fitImageView(size.width, size.height, image.width, image.height)) },
    [active, fitted, size, image.width, image.height, requestView])
  useEffect(() => { if (active) schedulePaint() }, [active, documentState, selectedId, loaded, size, tool, pendingText, schedulePaint])
  useEffect(() => { if (!active) { cancelAnimationFrame(paintFrame.current); paintFrame.current = 0; resetGesture(); spaceHeld.current = false; setPanHeld(false) } }, [active, resetGesture])
  useEffect(() => () => { cancelAnimationFrame(paintFrame.current); resetGesture() }, [resetGesture])
  useEffect(() => { if (active && pendingText) { const frame = requestAnimationFrame(() => textInputRef.current?.focus({ preventScroll: true })); return () => cancelAnimationFrame(frame) } }, [active, pendingText])
  useEffect(() => { setNoteDraft(selectedNote?.note ?? '') }, [selectedNote?.id, selectedNote?.note])

  function fitImage() { resetGesture(); setFitted(true); requestView(fitImageView(size.width, size.height, image.width, image.height)) }
  function zoomTo(next: number, anchor = { x: size.width / 2, y: size.height / 2 }) {
    const fit = fitImageView(size.width, size.height, image.width, image.height).scale
    const bounded = Math.max(Math.min(1 / 16, fit / 4), Math.min(Math.max(8, fit), next))
    setFitted(false); requestView(zoomImageView(viewRef.current, bounded, anchor))
  }
  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return
    const wheel = (event: WheelEvent) => {
      if (textDraftRef.current) return
      event.preventDefault()
      const rect = container.getBoundingClientRect(), current = viewRef.current
      if (event.ctrlKey || event.metaKey) zoomTo(current.scale * Math.exp(-event.deltaY * .002), { x: event.clientX - rect.left, y: event.clientY - rect.top })
      else { setFitted(false); requestView({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }) }
    }
    container.addEventListener('wheel', wheel, { passive: false })
    return () => container.removeEventListener('wheel', wheel)
  }, [active, size, image.width, image.height, requestView])
  function cancelGesture() {
    if (panRef.current) { requestView(panRef.current.view); setFitted(panRef.current.fitted) }
    resetGesture(); schedulePaint()
  }
  function removeSelected() { if (selectedId) { edit(doc => removeShapes(doc, new Set([selectedId]))); setSelectedId(null) } }
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Node && event.target !== document.body ? event.target : document.activeElement
      if (!target || !editorRef.current?.contains(target) || isImeOwnedKeyboardEvent(event)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        if (textDraftRef.current) finishText('', true)
        else if (currentGestureRef.current || cropRef.current || eraseRef.current || panRef.current) cancelGesture()
        else onCancel()
        return
      }
      if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return
      if (event.key === ' ' && target === canvasRef.current) { event.preventDefault(); spaceHeld.current = true; setPanHeld(true); return }
      if (event.key === '0') { event.preventDefault(); fitImage(); return }
      if (event.key === '1') { event.preventDefault(); zoomTo(1); return }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomTo(viewRef.current.scale * 1.25); return }
      if (event.key === '-') { event.preventDefault(); zoomTo(viewRef.current.scale / 1.25); return }
      if (busy) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); return }
      if (selected && target === canvasRef.current && event.key.startsWith('Arrow')) {
        const delta = event.shiftKey ? 10 : 1
        const dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0
        const dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0
        if (dx || dy) { event.preventDefault(); edit(doc => replaceShape(doc, moveShape(selected, dx, dy))); return }
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const next = ANNOTATION_TOOLS.find(item => item.key.toLowerCase() === event.key.toLowerCase())
      if (next) { event.preventDefault(); resetGesture(); setTool(next.id) }
    }
    const releaseSpace = () => { spaceHeld.current = false; setPanHeld(false) }
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === ' ') releaseSpace() }
    window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp); window.addEventListener('blur', releaseSpace)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', releaseSpace) }
  }, [active, busy, selected, pendingText, onCancel, redo, undo, edit, resetGesture, requestView, size, fitted])

  function localPoint(event: { clientX: number; clientY: number }): ScreenshotPoint {
    const rect = canvasRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }
  function point(event: { clientX: number; clientY: number }) { return imagePoint(viewRef.current, localPoint(event)) }
  function hit(at: ScreenshotPoint, erased?: Set<string>) {
    return hitTestShape(screenshotOutputShapes(documentState.shapes, documentState.crop).filter(shape => !erased?.has(shape.id)), at, 6 / viewRef.current.scale, measureText)
  }
  function beginText(shape?: TextShape, at: ScreenshotPoint = { x: 0, y: 0 }) {
    resetGesture()
    const draft: TextDraft = shape ? { shape, existing: true } : { shape: { id: crypto.randomUUID(), kind: 'text', color,
      at, text: '', fontSize: fontSize / viewRef.current.scale }, existing: false }
    textDraftRef.current = draft; setPendingText(draft)
  }
  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!active || (event.button !== 0 && event.button !== 1)) return
    event.currentTarget.focus({ preventScroll: true })
    if (tool === 'pan' || spaceHeld.current || event.button === 1) {
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
      panRef.current = { start: localPoint(event), view: viewRef.current, fitted }; setFitted(false); return
    }
    if (busy) return
    const at = point(event)
    if (tool === 'text') {
      if (!textDraftRef.current) {
        event.preventDefault(); beginText(undefined, at)
      }
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'select') {
      const handle = selected ? hitSelectionHandle(selected, at, 9 / viewRef.current.scale) : null
      const shape = handle ? selected : hit(at)
      setSelectedId(shape?.id ?? null)
      if (shape) { transformRef.current = { original: shape, start: at, ...(handle ? { handle } : {}) }; currentGestureRef.current = shape }
    } else if (tool === 'erase') {
      eraseRef.current = new Set(); lastErasePoint.current = at; const shape = hit(at); if (shape) eraseRef.current.add(shape.id)
    } else if (tool === 'crop') cropRef.current = { from: at, to: at }
    else {
      const id = crypto.randomUUID(), fit = viewRef.current.scale, stroke = width / fit
      currentGestureRef.current = tool === 'pen' || tool === 'highlight'
        ? { id, kind: tool, color, width: stroke, points: [at] }
        : tool === 'pixelate' ? { id, kind: 'pixelate', color, blockSize: blockSize / fit, from: at, to: at }
        : tool === 'cover' ? { id, kind: 'cover', color: '#111827', from: at, to: at }
        : tool === 'note' ? { id, kind: 'note', color, width: stroke / 2, radius: 12 / fit, number: Math.max(0, ...notes.map(note => note.number)) + 1, note: '', from: at, to: at }
        : { id, kind: tool, color, width: stroke, from: at, to: at }
    }
    schedulePaint()
  }
  function updateGesture(at: ScreenshotPoint) {
    const transform = transformRef.current
    if (transform) currentGestureRef.current = transform.handle ? resizeShapeFromHandle(transform.original, transform.handle, at)
      : moveShape(transform.original, at.x - transform.start.x, at.y - transform.start.y)
    else if (cropRef.current) cropRef.current.to = at
    else if (eraseRef.current) {
      const from = lastErasePoint.current ?? at
      const steps = Math.max(1, Math.ceil(Math.hypot(at.x - from.x, at.y - from.y) * viewRef.current.scale / 8))
      for (let step = 1; step <= steps; step++) {
        const sample = { x: from.x + (at.x - from.x) * step / steps, y: from.y + (at.y - from.y) * step / steps }
        const shape = hit(sample, eraseRef.current); if (shape) eraseRef.current.add(shape.id)
      }
      lastErasePoint.current = at
    } else {
      const shape = currentGestureRef.current
      if (!shape || shape.kind === 'text') return
      if (shape.kind === 'pen' || shape.kind === 'highlight') {
        const last = shape.points.at(-1)
        if (!last || last.x !== at.x || last.y !== at.y) shape.points.push(at)
      } else shape.to = at
    }
    schedulePaint()
  }
  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const pan = panRef.current
    if (pan) { const at = localPoint(event); requestView({ ...pan.view, x: pan.view.x + at.x - pan.start.x, y: pan.view.y + at.y - pan.start.y }); return }
    if (currentGestureRef.current || cropRef.current || eraseRef.current) updateGesture(point(event))
  }
  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (panRef.current) { onPointerMove(event); resetGesture(); return }
    if (currentGestureRef.current || cropRef.current || eraseRef.current) updateGesture(point(event))
    const finished = currentGestureRef.current, transform = transformRef.current, crop = cropRef.current, erased = eraseRef.current
    resetGesture()
    if (crop) { const box = intersectRect(normalizeRect(crop.from, crop.to), originalBounds); if (box) edit(doc => setCrop(doc, box)) }
    else if (erased?.size) edit(doc => removeShapes(doc, erased))
    else if (finished) {
      if (transform) { if (JSON.stringify(finished) !== JSON.stringify(transform.original)) edit(doc => replaceShape(doc, finished)) }
      else edit(doc => commitShape(doc, finished))
      if (finished.kind === 'note') setSelectedId(finished.id)
    }
    schedulePaint()
  }
  function finishText(value: string, cancelled = false) {
    const draft = textDraftRef.current
    textDraftRef.current = null; setPendingText(null)
    if (!draft || cancelled) return
    const text = value.trim().slice(0, 500)
    if (draft.existing) {
      if (!text) edit(doc => removeShapes(doc, new Set([draft.shape.id])))
      else if (text !== draft.shape.text) edit(doc => replaceShape(doc, { ...draft.shape, text }))
    } else if (text) edit(doc => commitShape(doc, { ...draft.shape, text }))
  }
  function commitNote() { if (selectedNote && noteDraft !== selectedNote.note) edit(doc => replaceShape(doc, { ...selectedNote, note: noteDraft.trim().slice(0, 1000) })) }
  function setTemplate(template: NoteTemplate | undefined) {
    if (!selectedNote) return
    const { template: _previous, ...note } = selectedNote
    edit(doc => replaceShape(doc, { ...note, note: noteDraft.trim().slice(0, 1000), ...(template ? { template } : {}) }))
  }
  function locateNote() {
    if (!selectedNote) return
    const bounds = shapeBounds(selectedNote), fit = Math.min(size.width / Math.max(bounds.width + 80, 1), size.height / Math.max(bounds.height + 80, 1), 2)
    const zoom = fit
    setFitted(false); requestView({ scale: zoom, x: size.width / 2 - (bounds.x + bounds.width / 2) * zoom, y: size.height / 2 - (bounds.y + bounds.height / 2) * zoom })
  }
  function complete(action: 'png' | 'context' | 'save' = 'png') {
    const base = imageRef.current
    if (!base || !loaded) return
    let shapes = selectedNote ? documentState.shapes.map(shape => shape.id === selectedNote.id ? { ...selectedNote, note: noteDraft.trim().slice(0, 1000) } : shape) : documentState.shapes
    const draft = textDraftRef.current
    if (draft) {
      const text = textInputRef.current?.value.trim().slice(0, 500) ?? draft.shape.text
      if (draft.existing) shapes = text ? shapes.map(shape => shape.id === draft.shape.id ? { ...draft.shape, text } : shape) : shapes.filter(shape => shape.id !== draft.shape.id)
      else if (text) shapes = [...shapes, { ...draft.shape, text }]
    }
    const input = { image: base, shapes, crop: documentState.crop, displayWidth: image.width, displayHeight: image.height }
    if (action === 'context') onCopyContext?.(input)
    else if (action === 'save') onSaveOriginal?.(input)
    else onComplete(input)
  }
  function setProperty(property: 'color' | 'width' | 'fontSize', value: string | number) {
    if (property === 'color') setColor(String(value)); else if (property === 'width') setWidth(Number(value)); else setFontSize(Number(value))
    if (tool === 'select' && selected && property in selected) edit(doc => replaceShape(doc, { ...selected, [property]: property === 'color' ? value : Number(value) / viewRef.current.scale } as ScreenshotShape))
  }
  const properties = tool === 'select' ? selected : null
  const showColor = !['crop', 'pixelate', 'cover', 'erase', 'pan'].includes(tool) && (tool !== 'select' || Boolean(properties && properties.kind !== 'pixelate' && properties.kind !== 'cover'))
  const showWidth = showColor && tool !== 'text' && tool !== 'note' && properties?.kind !== 'text'
  const showFont = tool === 'text' || properties?.kind === 'text'
  const displayedWidth = Number((properties && 'width' in properties ? properties.width * scale : width).toFixed(2))
  const displayedFont = Number((properties?.kind === 'text' ? properties.fontSize * scale : fontSize).toFixed(2))
  const widthOptions = [...new Set<number>([...SCREENSHOT_WIDTHS, displayedWidth])].sort((a, b) => a - b)
  const fontOptions = [...new Set<number>([...SCREENSHOT_FONT_SIZES, displayedFont])].sort((a, b) => a - b)
  // This is an editing control, independent of the annotation's original geometry and type size.
  const textEditorFont = Math.max(12, Math.min(32, (pendingText?.shape.fontSize ?? fontSize) * scale))
  const textEditorWidth = Math.min(280, Math.max(1, size.width)), textEditorHeight = Math.min(textEditorFont * 1.4 + 10, Math.max(1, size.height))
  return <div ref={editorRef} className="image-annotation-editor" role="dialog" aria-label="Screenshot editor" style={active ? undefined : { display: 'none' }}>
    <header className="image-annotation-editor__header">
      <span className="image-annotation-editor__title"><strong>Screenshot</strong><small>{image.width} × {image.height}</small>
        <span className={'image-annotation-editor__status' + (copied ? ' image-annotation-editor__status--success' : '')} role="status">{copied ? <><CheckIcon size={13} />{copied}</> : documentStatus}</span>
      </span>
      <div className="image-annotation-toolbar__actions">
        <AnnotationOriginalMenu active={active} busy={busy} loaded={loaded} onOpen={onOpenOriginal} onSave={onSaveOriginal ? () => complete('save') : undefined} />
        <button type="button" onClick={onCancel}><CancelIcon size={13} /> Cancel</button>
        {onCopyContext ? <button type="button" disabled={busy || !loaded} onClick={() => complete('context')}>Copy context</button> : null}
        <button className="primary-button" type="button" disabled={busy || !loaded} onClick={() => complete()}><ClipboardIcon size={13} />{busy ? 'Copying…' : 'Copy PNG'}</button>
      </div>
    </header>
    <AnnotationToolbar tool={tool} busy={busy} undoable={canUndo(documentState)} redoable={canRedo(documentState)} selected={!!selected}
      clearable={!!documentState.shapes.length || !!documentState.crop} onTool={next => { resetGesture(); setTool(next); if (next !== 'select' && next !== 'note') setSelectedId(null); schedulePaint() }}
      onUndo={undo} onRedo={redo} onDelete={removeSelected} onClear={() => { resetGesture(); textDraftRef.current = null; setPendingText(null); setSelectedId(null); edit(clearShapes); schedulePaint() }} />
    <div className="image-annotation-editor__properties">
      <span className="image-annotation-editor__tool-name">{ANNOTATION_TOOLS.find(item => item.id === tool)?.label}</span>
      {showColor ? <div className="image-annotation-toolbar__colors" aria-label="Markup color">{SCREENSHOT_COLORS.map(option => <button key={option} type="button" aria-label={'Color ' + option} title={option}
        aria-pressed={(properties?.color ?? color) === option} className={(properties?.color ?? color) === option ? 'selected' : ''} style={{ backgroundColor: option }} disabled={busy}
        onClick={() => setProperty('color', option)}>{(properties?.color ?? color) === option ? <CheckIcon size={10} /> : null}</button>)}</div> : null}
      {showWidth ? <label>Width<select aria-label="Stroke width" value={displayedWidth} disabled={busy} onChange={event => setProperty('width', Number(event.target.value))}>{widthOptions.map(option => <option key={option} value={option}>{option}px</option>)}</select></label> : null}
      {showFont ? <label>Size<select aria-label="Text size" value={displayedFont} disabled={busy} onChange={event => setProperty('fontSize', Number(event.target.value))}>{fontOptions.map(option => <option key={option} value={option}>{option}px</option>)}</select></label> : null}
      {tool === 'pixelate' ? <label>Blocks<select aria-label="Pixel size" value={blockSize} disabled={busy} onChange={event => setBlockSize(Number(event.target.value))}>{[8,16,24,32].map(option => <option key={option} value={option}>{option}px</option>)}</select></label> : null}
      {tool === 'cover' || properties?.kind === 'cover' ? <span className="image-annotation-editor__hint">Opaque cover · Original stays editable</span> : null}
      {tool === 'crop' ? <><span className="image-annotation-editor__hint">Drag to keep an area</span>{documentState.crop ? <button type="button" disabled={busy} onClick={() => edit(doc => setCrop(doc, null))}>Reset crop</button> : null}</> : null}
      {tool === 'select' ? <><span className="image-annotation-editor__hint">{selected ? 'Drag handles to resize · Arrow keys to nudge' : 'Click an annotation to edit'}</span>
        {selected?.kind === 'text' ? <button type="button" disabled={busy} onClick={() => beginText(selected)}>Edit text</button> : null}</> : null}
      {tool === 'erase' ? <span className="image-annotation-editor__hint">Drag over annotations to remove them</span> : null}
      {tool === 'note' ? <span className="image-annotation-editor__hint">Click a point or drag a region</span> : null}
      {tool === 'pan' ? <span className="image-annotation-editor__hint">Drag to move the image · Fit to reset</span> : null}
    </div>
    <div className="image-annotation-editor__workarea">
      <div ref={containerRef} className="image-annotation-editor__canvas-area">
        <div className="image-annotation-editor__viewport" style={{ width: size.width, height: size.height }}>
          <img ref={imageRef} src={image.dataUrl} alt="Captured image" draggable={false} onLoad={() => { setLoaded(true); setImageError(false) }}
            onError={() => { setLoaded(false); setImageError(true); onError?.(new Error('The image could not be decoded. Current annotations are kept.')) }} />
          <canvas ref={canvasRef} tabIndex={0} aria-label="Screenshot canvas" style={{ cursor: tool === 'pan' || panHeld ? 'grab' : tool === 'select' ? selected ? 'move' : 'default' : 'crosshair' }}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={cancelGesture}
            onLostPointerCapture={() => { if (currentGestureRef.current || cropRef.current || eraseRef.current || panRef.current) cancelGesture() }}
            onDoubleClick={event => { if (!busy && tool === 'select') { const shape = hit(point(event)); if (shape?.kind === 'text') beginText(shape) } }} />
          {pendingText ? <TextInput key={pendingText.shape.id} ref={textInputRef} className="image-annotation-editor__text" aria-label="Screenshot text" defaultValue={pendingText.shape.text} maxLength={500}
            aria-description="Edit the content here. Its position and text size stay on the image."
            style={{ left: Math.max(0, Math.min(size.width - textEditorWidth, view.x + pendingText.shape.at.x * scale)),
              top: Math.max(0, Math.min(size.height - textEditorHeight, view.y + pendingText.shape.at.y * scale)),
              width: textEditorWidth, height: textEditorHeight, maxHeight: Math.max(1, size.height), minWidth: 0, minHeight: 0, maxWidth: 'none',
              color: pendingText.shape.color, fontSize: textEditorFont, lineHeight: 1.4, fontFamily: SCREENSHOT_TEXT_FONT }}
            onPointerDown={event => event.stopPropagation()} onChange={() => onEdited?.()} onBlur={event => finishText(event.currentTarget.value)} onKeyDown={event => {
              event.stopPropagation(); if (isImeOwnedKeyboardEvent(event)) return
              if (event.key === 'Enter') { event.preventDefault(); finishText(event.currentTarget.value) }
              else if (event.key === 'Escape') { event.preventDefault(); finishText('', true) }
            }} /> : null}
          {imageError ? <p className="image-annotation-editor__image-error" role="alert">The image could not be loaded. Current annotations are kept.{onOpenOriginal ? ' Open another original or Cancel to return.' : ' Cancel to return.'}</p> : null}
        </div>
      </div>
      <AnnotationNotes notes={notes} selected={selectedNote} draft={noteDraft} busy={busy}
        onSelect={note => { commitNote(); setSelectedId(note.id); setTool('select') }} onDraft={value => { setNoteDraft(value); onEdited?.() }}
        onCommit={commitNote} onTemplate={setTemplate} onLocate={locateNote} />
    </div>
    <footer className="image-annotation-editor__footer">
      <span>{documentState.crop ? Math.round(documentState.crop.width) + ' × ' + Math.round(documentState.crop.height) + ' crop' : 'Original image'} · {documentState.shapes.length} annotations</span>
      <div className="image-annotation-editor__zoom" aria-label="Image view">
        <button type="button" aria-label="Fit image" aria-pressed={fitted} onClick={fitImage}>Fit</button>
        <button type="button" aria-label="Actual image size" onClick={() => zoomTo(1)}>100%</button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomTo(viewRef.current.scale / 1.25)}><ZoomOutIcon size={13} /></button>
        <span aria-label="Image zoom">{Math.round(scale * 100)}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => zoomTo(viewRef.current.scale * 1.25)}><ZoomInIcon size={13} /></button>
      </div>
      <span className="image-annotation-editor__view-hint">Space to pan · Esc to cancel</span>
    </footer>
  </div>
}
