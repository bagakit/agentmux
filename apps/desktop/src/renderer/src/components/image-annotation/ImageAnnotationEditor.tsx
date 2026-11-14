import { ImageTextTools, type ImageTextPort } from './ImageTextTools'
import { composeScreenshot } from './compose'
import { mintObjectId } from '@agentmux/core/object-id'
// Portions adapted from Orca, MIT Copyright (c) 2026 Lovecast Inc.; see THIRD_PARTY_NOTICES.md.
import { Textarea } from '@agentmux/client-ui/input'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useWorkbenchDocument } from '../../lib/workbench-document'
import { claimSurfaceChords } from '../../lib/surface-chord-owners'
import type { ShortcutEvent } from '../../lib/shortcut-registry'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { AnnotationToolbar, ANNOTATION_TOOLS, type AnnotationTool } from './AnnotationToolbar'
import { CaptureHint, CaptureToolbar, CaptureTooltip, CAPTURE_TOOLS } from './CaptureToolbar'
import { captureLoupePlacement, captureSizeChipPlacement, captureToolbarPlacement, cropGestureRect, CROP_CURSORS, hitCropHandle, rectContains, shownSelection, type CropGesture } from './capture-geometry'
import { AnnotationOriginalMenu } from './AnnotationOriginalMenu'
import { AnnotationNotes } from './AnnotationNotes'
import { renderCommittedLayer, renderScreenshotScene } from './canvas-render'
import { canRedo, canUndo, clearShapes, commitShape, createScreenshotDocument, DEFAULT_SCREENSHOT_COLOR,
  DEFAULT_SCREENSHOT_FONT_SIZE, DEFAULT_SCREENSHOT_WIDTH, redoShape, SCREENSHOT_COLORS, SCREENSHOT_FONT_SIZES,
  SCREENSHOT_WIDTHS, undoShape, hitTestShape, moveShape, replaceShape, removeShapes, setCrop, normalizeRect,
  shapeBounds, intersectRect, screenshotOutputShapes, type NormalizedRect, type ScreenshotDocument, type ScreenshotPoint,
  alignShapes, distributeShapes, duplicateShapes, groupBounds, moveShapes, pasteShapes, reorderShapes, restyleShapes,
  setShapesLocked, type ShapeAlignment, type ShapeOrder,
  isScreenshotMask, screenshotTextLines, constrainedEndpoint, setShapes, renumberNotes, nextNoteNumber,
  createBlurShape, createSpotlightShape, createCalloutShape, calloutBubble, CALLOUT_GAP, BLUR_RADIUS_RANGE, SPOTLIGHT_DIM_RANGE, CALLOUT_ZOOM_RANGE,
  DEFAULT_BLUR_RADIUS, DEFAULT_SPOTLIGHT_DIM, DEFAULT_CALLOUT_ZOOM, ADJUST_FACTOR_RANGE, ADJUST_SHARPEN_RANGE, createAdjustShape, exceedsOutlineLimits, withOutline, NEUTRAL_ADJUSTMENT,
  type AdjustParameters, type AdjustShape, type BlurShape, type CoverShape, type RegionHighlightShape, type PixelateShape, type ScreenshotOutline, type SpotlightShape,
  type ScreenshotShape, type TextShape, type NoteTemplate } from './drawing-model'
import { drawMarchingAnts, SCREENSHOT_TEXT_FONT } from './drawing-renderer'
import { DEFAULT_MAGIC_WAND_TOLERANCE, MAGIC_WAND_TOLERANCE_RANGE, magicWandOutline, magicWandRegion, unionMagicWandRegions, type MagicWandRegion } from './magic-wand'
import { selectionHandles, hitSelectionHandle, lockedMarkAt, marqueeSelection, resizeShapeFromHandle, type SelectionHandleId } from './selection-geometry'
import { pointFeatures, rectFeatures, snap, snapLines, SNAP_DISTANCE, type SnapFeatures, type SnapLines } from './snapping'
import { fitImageView, imagePoint, zoomImageView, type AnnotationView, type ImageViewport } from './view'
import type { AnnotationImage, ImageAnnotationInput, ImageAnnotationOutputResult } from './types'
import './image-annotation.css'

const icon = semanticIconComponent
const CancelIcon = icon('action.cancel'), ClipboardIcon = icon('object.clipboard'), CheckIcon = icon('status.copied')
const ZoomInIcon = icon('action.zoom-in'), ZoomOutIcon = icon('action.zoom-out'), AdjustIcon = icon('action.adjust')
const SaveIcon = icon('action.save'), PinIcon = icon('action.pin'), RetakeIcon = icon('action.capture')
const LockIcon = icon('status.locked'), UnlockIcon = icon('drawing.unlock')
// The window editor's arrange row; a capture reaches the same commands only through shortcuts.
const ALIGNMENTS: readonly { id: ShapeAlignment; label: string; Icon: ReturnType<typeof icon> }[] = [
  { id: 'left', label: 'Align left', Icon: icon('drawing.align-left') }, { id: 'center', label: 'Align centers', Icon: icon('drawing.align-center') },
  { id: 'right', label: 'Align right', Icon: icon('drawing.align-right') }, { id: 'top', label: 'Align top', Icon: icon('drawing.align-top') },
  { id: 'middle', label: 'Align middles', Icon: icon('drawing.align-middle') }, { id: 'bottom', label: 'Align bottom', Icon: icon('drawing.align-bottom') }]
const DISTRIBUTIONS: readonly { id: 'horizontal' | 'vertical'; label: string; Icon: ReturnType<typeof icon> }[] = [
  { id: 'horizontal', label: 'Distribute horizontally', Icon: icon('drawing.distribute-horizontal') },
  { id: 'vertical', label: 'Distribute vertically', Icon: icon('drawing.distribute-vertical') }]
// Stacking shortcuts by bracket; Shift turns forward and backward into front and back, whichever character it types.
const BRACKETS: Readonly<Record<string, 'forward' | 'backward'>> = { ']': 'forward', '}': 'forward', '[': 'backward', '{': 'backward' }
type ObjectCommand = 'select-all' | 'duplicate' | 'copy' | 'paste' | 'lock' | ShapeOrder
/** The object command a Command or Control chord names. Command-C stays the screenshot copy, so marks copy and paste with
 * Shift. The window shortcut router reads the same answer, so a focused editor keeps every chord it names. */
function objectCommandFor(event: ShortcutEvent): ObjectCommand | null {
  if (!event.metaKey && !event.ctrlKey) return null
  const key = event.key.toLowerCase(), bracket = BRACKETS[event.key]
  if (bracket) return event.shiftKey ? bracket === 'forward' ? 'front' : 'back' : bracket
  if (event.shiftKey) return key === 'c' ? 'copy' : key === 'v' ? 'paste' : null
  return key === 'a' ? 'select-all' : key === 'd' ? 'duplicate' : key === 'l' ? 'lock' : null
}
type Size = { width: number; height: number; dpr: number }
const NO_SELECTION: ReadonlySet<string> = new Set()
type TextDraft = { shape: TextShape; existing: boolean; edited: boolean }
// `bubble` drags only a magnifier's bubble; its source region and leader origin stay in place.
type TransformGesture = { original: ScreenshotShape; start: ScreenshotPoint; handle?: SelectionHandleId; bubble?: true }
// Dragging any mark of a multi-mark selection moves every member; `moved` is the live preview, committed once on release.
type GroupGesture = { start: ScreenshotPoint; ids: ReadonlySet<string>; pressed: string; base: ScreenshotShape[]; moved: ScreenshotShape[] }
// `base` is the selection a Shift-marquee adds to; a plain marquee starts from none.
type MarqueeGesture = { start: ScreenshotPoint; at: ScreenshotPoint; base: ReadonlySet<string> }
const toggled = (ids: ReadonlySet<string>, id: string): ReadonlySet<string> => { const next = new Set(ids); if (!next.delete(id)) next.add(id); return next }
// Masks and the spotlight paint fixed colors; a magnifier's color is its frame and leader line.
const colorable = (shape: ScreenshotShape) => !isScreenshotMask(shape) && shape.kind !== 'spotlight'
const widthable = (shape: ScreenshotShape) => colorable(shape) && shape.kind !== 'text' && shape.kind !== 'callout' && shape.kind !== 'region-highlight'
// Region marks need travel; a press that moves less than this many screen pixels creates none of them.
type AnnotationOutput = (input: ImageAnnotationInput) => ImageAnnotationOutputResult
// The last tool and style carry over to the next editor in this Renderer.
let lastStyle: { tool: AnnotationTool; color: string; width: number; fontSize: number; blockSize: number; pixelateMode: 'region' | 'brush'; brushWidth: number
  blurRadius: number; spotlightDim: number; calloutZoom: number; wandTolerance: number } = {
  tool: 'rect', color: DEFAULT_SCREENSHOT_COLOR, width: DEFAULT_SCREENSHOT_WIDTH, fontSize: DEFAULT_SCREENSHOT_FONT_SIZE, blockSize: 16, pixelateMode: 'region', brushWidth: 32,
  blurRadius: DEFAULT_BLUR_RADIUS, spotlightDim: DEFAULT_SPOTLIGHT_DIM, calloutZoom: DEFAULT_CALLOUT_ZOOM, wandTolerance: DEFAULT_MAGIC_WAND_TOLERANCE }
// The strength each pointing mark offers, in the model's own unit and range: blur radius in image pixels, so it matches
// the original and the export at any zoom, dimming opacity and zoom factor.
const POINTING_STRENGTHS = {
  blur: { property: 'radius', style: 'blurRadius', label: 'Strength', name: 'Blur strength', range: BLUR_RADIUS_RANGE, step: 1, unit: (value: number) => value + 'px' },
  spotlight: { property: 'dim', style: 'spotlightDim', label: 'Dim', name: 'Spotlight dimming', range: SPOTLIGHT_DIM_RANGE, step: 0.05, unit: (value: number) => Math.round(value * 100) + '%' },
  callout: { property: 'zoom', style: 'calloutZoom', label: 'Zoom', name: 'Magnifier zoom', range: CALLOUT_ZOOM_RANGE, step: 0.5, unit: (value: number) => value + '×' }
} as const
type PointingKind = keyof typeof POINTING_STRENGTHS
// The marks a wand region turns into, in the order the property row offers them.
const REGION_ACTIONS = [['cover', 'Cover'], ['pixelate', 'Pixelate'], ['blur', 'Blur'], ['region-highlight', 'Highlight'], ['spotlight', 'Spotlight']] as const
type RegionAction = typeof REGION_ACTIONS[number][0]
const signedPercent = (factor: number) => { const value = Math.round((factor - 1) * 100); return (value > 0 ? '+' : '') + value + '%' }
const ADJUST_CONTROLS = [
  { property: 'brightness', label: 'Brightness', range: ADJUST_FACTOR_RANGE, unit: signedPercent },
  { property: 'contrast', label: 'Contrast', range: ADJUST_FACTOR_RANGE, unit: signedPercent },
  { property: 'saturation', label: 'Saturation', range: ADJUST_FACTOR_RANGE, unit: signedPercent },
  { property: 'sharpen', label: 'Sharpen', range: ADJUST_SHARPEN_RANGE, unit: (amount: number) => Math.round(amount * 100) + '%' }
] as const satisfies ReadonlyArray<{ property: keyof AdjustParameters; label: string; range: { min: number; max: number }; unit(value: number): string }>
// Marching ants step one image-independent screen pixel this often, along an eight-pixel dash cycle.
const ANTS_STEP_MS = 100, ANTS_CYCLE = 8
/** The current wand selection: its pixel mask and the outline marks and adjustments take from it. */
type WandSelection = { region: MagicWandRegion; outline: ScreenshotOutline }
/** The adjustment the property row edits: an existing adjust mark, or the one its first change commits. */
type AdjustTarget = { id: string; from: ScreenshotPoint; to: ScreenshotPoint; outline?: ScreenshotOutline }
const isPointingKind = (kind: string): kind is PointingKind => Object.hasOwn(POINTING_STRENGTHS, kind)
// Inline text and note inputs keep Enter as a newline; modifier Enter finishes and Escape abandons the edit.
function inlineEditorKey(event: ReactKeyboardEvent<HTMLTextAreaElement>, finish: (value: string) => void, abandon: () => void) {
  event.stopPropagation(); if (isImeOwnedKeyboardEvent(event)) return
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); finish(event.currentTarget.value) }
  else if (event.key === 'Escape') { event.preventDefault(); abandon() }
}
/** The marks, selection and tool a capture editor hands to a separate window editor on Expand; color and other styles carry over through the editors' shared in-process style memory. */
export type CaptureAnnotationHandoff = { shapes: ScreenshotShape[]; crop: NormalizedRect; tool: AnnotationTool }
const CLICK_DISTANCE = 4, REGION_KINDS: ReadonlySet<ScreenshotShape['kind']> = new Set(['rect', 'arrow', 'ellipse', 'pixelate', 'cover', 'blur', 'spotlight', 'callout'])
// Selection handle hit radius and painted diameter, in frame CSS pixels.
const CROP_HANDLE_HIT = 8, CROP_HANDLE_SIZE = 8
// The loupe magnifies a square of frozen pixels around the pointer into a grid of cells, in loupe CSS pixels.
const LOUPE_CELLS = 15, LOUPE_CELL = 8, LOUPE_GRID = LOUPE_CELLS * LOUPE_CELL, LOUPE_CENTRE = (LOUPE_CELLS - 1) / 2
type LoupeSample = { x: number; y: number; hex: string; rgb: [number, number, number] }
const hexByte = (value: number) => value.toString(16).padStart(2, '0').toUpperCase()
// The editor's accent, the faint fill of the window a click would select, and how long that window's highlight fades in.
const ACCENT = '#3b82f6', WINDOW_FILL = 'rgba(59, 130, 246, .12)', WINDOW_FADE_MS = 90
const NO_WINDOWS: readonly NormalizedRect[] = []

type EditorBase = {
  textTools?: ImageTextPort
  captureControls?: import('react').ReactNode
  image: AnnotationImage
  busy: boolean
  copied?: string | null
  active?: boolean
  initialState?: Pick<ScreenshotDocument, 'shapes' | 'crop'>
  /** Whether `initialState` is already kept by its owner (a saved original or a remembered selection), or carries marks
   * that exist nowhere else yet (marks moved here from a capture with ⌘E), which a close or retake must confirm first.
   * A handoff with no marks has nothing to lose, so the host passes it as kept. */
  initialStateKept?: boolean
  documentStatus?: string | null
  ownerDocument?: Document
  title?: string
  /** The primary delivery's name. Defaults to 'Copy PNG' in a window and 'Done' in a capture. */
  completeLabel?: string
  busyLabel?: string
  onCancel(): void
  onComplete: AnnotationOutput
  onEdited?(): void
  /** The current source image has been loaded and drawn into the editor canvas. */
  onPresented?(): void
  onError?(error: unknown): void
}
/** A fitted, zoomable editor with its header, property row, notes panel and footer. The default presentation. */
type WindowPresentation = {
  presentation?: 'window'
  /** Opens with this tool instead of the remembered one. */
  initialTool?: AnnotationTool
  onCopyContext?: AnnotationOutput
  onSaveOriginal?: AnnotationOutput
  onOpenOriginal?(): void
  onSavePng?: AnnotationOutput
  onPin?: AnnotationOutput
  onCheckPin?(): void
  /** Retake (⇧⌘R): the host captures again for the same consumer; unkept marks are confirmed in place first. */
  onRetake?(): void
  pixelRatio?: never; origin?: never; windows?: never; safeTop?: never; onCopyColor?: never; onExpand?: never; onSelect?: never; locked?: never; backgroundHint?: never
}
/**
 * One display's full frozen frame at a fixed one-to-one pixel scale, filling a transparent capture overlay. The
 * document crop is the selection: a drag makes it, and the floating capture toolbar, property popover, size chip and
 * loupe follow it. Outputs require a selection. The host unmounts the editor after a confirmed primary output; Save
 * PNG and Pin keep it open.
 */
type CapturePresentation = {
  presentation: 'capture'
  /** Image pixels per frame CSS pixel: the display's backing scale. Fixes the view and sizes stroke widths and fonts. */
  pixelRatio: number
  /** The global point of the frame's top-left, for the loupe's pt coordinates. Defaults to 0, 0. */
  origin?: ScreenshotPoint
  /** The application windows on this frame when it froze, front to back, in image pixels: hover lights the one a click selects, and gestures snap to their edges. */
  windows?: readonly NormalizedRect[]
  /** Frame CSS pixels at the top the display covers with its camera housing; the hint, toolbar, size chip and loupe stay below it. */
  safeTop?: number
  /** Names the frozen background and the key that switches it. */
  backgroundHint?: string
  /** Plain C while the loupe shows: the host copies this exact sampled color. */
  onCopyColor?(hex: string): void
  onSavePng: AnnotationOutput
  onPin: AnnotationOutput
  /** ⌘E or Expand: the host reopens these marks in a separate window editor as initialState and initialTool. */
  onExpand(handoff: CaptureAnnotationHandoff): void
  /** A drag or a click on a window made a new selection on this display, once per new selection; the host claims the request's one selection for this display. Moving, resizing or a click off every window claims nothing.
   * An opening `initialState.crop` is claimed by the first change that keeps a selection; the host claims it before any output made on it unchanged. */
  onSelect(): void
  /** Another display owns the request's selection: this frame keeps only its dimmed freeze and Cancel, and anything begun here is dropped. */
  locked?: boolean
  initialTool?: never; onCopyContext?: never; onSaveOriginal?: never; onOpenOriginal?: never; onCheckPin?: never; onRetake?: never
}
export type ImageAnnotationEditorProps = EditorBase & (WindowPresentation | CapturePresentation)

export function ImageAnnotationEditor({ image, textTools, captureControls, busy, copied, active = true, initialState, initialStateKept = true, initialTool, documentStatus,
  ownerDocument, title = 'Screenshot', completeLabel, busyLabel = 'Copying…', presentation = 'window', pixelRatio = 1, origin = { x: 0, y: 0 }, windows = NO_WINDOWS, safeTop = 0, backgroundHint,
  locked = false, onCancel, onComplete, onCopyContext, onSaveOriginal, onOpenOriginal, onSavePng, onPin, onCheckPin, onRetake, onExpand, onCopyColor, onSelect: claimSelection, onEdited, onPresented, onError }: ImageAnnotationEditorProps) {
  const workbenchDocument = useWorkbenchDocument()
  const document = ownerDocument ?? workbenchDocument
  const ownerWindow = document.defaultView!
  const editorRef = useRef<HTMLDivElement>(null), containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null), canvasRef = useRef<HTMLCanvasElement>(null), textInputRef = useRef<HTMLTextAreaElement>(null)
  const currentGestureRef = useRef<ScreenshotShape | null>(null), transformRef = useRef<TransformGesture | null>(null)
  const groupRef = useRef<GroupGesture | null>(null), marqueeRef = useRef<MarqueeGesture | null>(null)
  // Marks copied with Command-Shift-C; they live only in this editor and never reach the system clipboard.
  const copiedRef = useRef<ScreenshotShape[]>([]), lockBadgeRef = useRef<HTMLButtonElement>(null)
  const cropRef = useRef<CropGesture | null>(null), downRef = useRef<{ at: ScreenshotPoint; deselected: boolean; dragged?: true } | null>(null)
  const eraseRef = useRef<Set<string> | null>(null), lastErasePoint = useRef<ScreenshotPoint | null>(null)
  const panRef = useRef<{ start: ScreenshotPoint; view: AnnotationView; fitted: boolean } | null>(null)
  const textDraftRef = useRef<TextDraft | null>(null), noteEditorRef = useRef<string | null>(null), paintFrame = useRef(0), spaceHeld = useRef(false)
  const committedLayerRef = useRef<HTMLCanvasElement | null>(null), samplerRef = useRef<HTMLCanvasElement | null>(null)
  // Capture only: the window a click would select with the paint time its fade began, and the snap lines engaged now.
  const litWindowRef = useRef<{ rect: NormalizedRect; since: number | null } | null>(null), guidesRef = useRef<SnapLines | null>(null)
  // The original image's pixels, read once per editor for the wand; the marked result is never sampled.
  const sourcePixelsRef = useRef<ImageData | null>(null), antsPhase = useRef(0)
  const barRef = useRef<HTMLDivElement>(null), chipRef = useRef<HTMLSpanElement>(null), loupeRef = useRef<HTMLCanvasElement>(null)
  if (!committedLayerRef.current && typeof document !== 'undefined') committedLayerRef.current = document.createElement('canvas')
  const [loadedSource, setLoadedSource] = useState<string | null>(null), [size, setSize] = useState<Size>({ width: 0, height: 0, dpr: 1 })
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const loaded = loadedSource === image.dataUrl, imageError = failedSource === image.dataUrl
  const [documentState, setDocumentState] = useState<ScreenshotDocument>(() => ({ ...createScreenshotDocument(), ...initialState }))
  const [pendingText, setPendingText] = useState<TextDraft | null>(null)
  const capture = presentation === 'capture', label = completeLabel ?? (capture ? 'Done' : 'Copy PNG')
  // A capture opens on adjusting its selection; a window on the requested or remembered tool.
  const openingTool = useRef<AnnotationTool>(capture ? 'select' : initialTool ?? lastStyle.tool).current
  // A kept opening document needs no confirmation until it changes; handed-over marks are unkept from the start.
  // What the in-place discard confirmation would do: close the editor, or retake the capture.
  const [exported, setExported] = useState<ScreenshotDocument | null>(initialStateKept ? documentState : null)
  const [discarding, setDiscarding] = useState<false | 'close' | 'retake'>(false)
  const [tool, setTool] = useState<AnnotationTool>(openingTool), [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(NO_SELECTION)
  const [color, setColor] = useState(lastStyle.color), [width, setWidth] = useState(lastStyle.width)
  const [fontSize, setFontSize] = useState(lastStyle.fontSize), [blockSize, setBlockSize] = useState(lastStyle.blockSize)
  const [pixelateMode, setPixelateMode] = useState(lastStyle.pixelateMode), [brushWidth, setBrushWidth] = useState(lastStyle.brushWidth)
  const [strengths, setStrengths] = useState({ blurRadius: lastStyle.blurRadius, spotlightDim: lastStyle.spotlightDim, calloutZoom: lastStyle.calloutZoom })
  const [textRows, setTextRows] = useState(2)
  const [wandTolerance, setWandTolerance] = useState(lastStyle.wandTolerance), [wand, setWand] = useState<WandSelection | null>(null)
  const [adjusting, setAdjusting] = useState<AdjustTarget | null>(null), [wandIssue, setWandIssue] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState(''), [noteEditor, setNoteEditor] = useState<string | null>(null), [panHeld, setPanHeld] = useState(false)
  const [view, setView] = useState<AnnotationView>({ scale: 1, x: 0, y: 0 }), [fitted, setFitted] = useState(true)
  // Capture only: the pointer in frame CSS pixels while the loupe can show, the moving gesture's kind, the canvas
  // cursor, and the laid-out widths of the toolbar and size chip.
  const [hover, setHover] = useState<{ at: ScreenshotPoint; sample: LoupeSample | null } | null>(null), [gesture, setGesture] = useState<'selection' | 'mark' | null>(null)
  const [cursor, setCursor] = useState('crosshair'), [measured, setMeasured] = useState({ bar: 0, chip: 0 })
  // The locked mark under the pointer, which shows its lock; locked marks are never hit or selected.
  const [lockHover, setLockHover] = useState<string | null>(null)
  const viewRef = useRef(view)
  // Every selected mark, in stacking order; handles and text editing need exactly one. A locked mark never counts.
  const selectedShapes = documentState.shapes.filter(shape => selectedIds.has(shape.id) && !shape.locked)
  const groupIds: ReadonlySet<string> = new Set(selectedShapes.map(shape => shape.id))
  const hasLocked = documentState.shapes.some(shape => shape.locked)
  const selected = selectedShapes.length === 1 ? selectedShapes[0]! : null
  const selectOnly = (id: string | null) => setSelectedIds(id ? new Set([id]) : NO_SELECTION)
  const selectedNote = selected?.kind === 'note' ? selected : null
  const notes = documentState.shapes.filter(shape => shape.kind === 'note')
  // A capture selection alone is not an edit to lose; its marks are.
  const unexported = (documentState.shapes.length > 0 || (!capture && Boolean(documentState.crop))) && documentState !== exported
  const confirmingDiscard = unexported ? discarding : false
  const originalBounds = { x: 0, y: 0, width: image.width, height: image.height }
  // The selection a capture shows now: the moving gesture's, else the document crop.
  const selection = shownSelection(cropRef.current, documentState.crop, originalBounds)
  // The capture toolbar shows on a kept selection at rest; the size chip names the shown selection's image pixels.
  const barShown = capture && selection !== null && documentState.crop !== null && gesture === null
  const sizeText = capture && selection ? Math.round(selection.width) + ' × ' + Math.round(selection.height) + ' px' : null
  // The loupe shows the frozen pixel under the pointer while a selection is made or adjusted, never at rest or while drawing.
  const loupe = capture && hover?.sample && (gesture === 'selection' || (!documentState.crop && gesture === null)) ? { at: hover.at, sample: hover.sample } : null
  // The region an open adjustment edits shows as still dashes once no wand selection marches around it.
  const currentAdjustment = adjusting ? documentState.shapes.find(shape => shape.id === adjusting.id) : null
  const outlined = wand?.outline ?? (currentAdjustment && 'outline' in currentAdjustment ? currentAdjustment.outline : adjusting?.outline) ?? null
  const live = useRef({ size, documentState, loaded, source: image.dataUrl, selected, selectedShapes, tool, active, pendingText, loupe, outlined })
  live.current = { size, documentState, loaded, source: image.dataUrl, selected, selectedShapes, tool, active, pendingText, loupe, outlined }
  const cache = useRef<{ document: ScreenshotDocument; shapes: ScreenshotShape[]; view: AnnotationView; size: Size; loaded: boolean; source: string;
    excluded: string | undefined; hidden: ReadonlySet<string> | undefined; erased: number; masks: ScreenshotShape[] } | null>(null)
  const presentedSource = useRef<string | null>(null), presentedCallback = useRef(onPresented)
  presentedCallback.current = onPresented
  const scale = view.scale

  /** Copies the frozen pixels around the frame point into the sampler and reads the centre one. */
  function sampleLoupe(at: ScreenshotPoint): LoupeSample | null {
    const sampler = samplerRef.current ??= document.createElement('canvas')
    sampler.width = LOUPE_CELLS; sampler.height = LOUPE_CELLS
    const context = sampler.getContext('2d', { willReadFrequently: true })
    if (!context || !imageRef.current || !loaded) return null
    const x = Math.min(image.width - 1, Math.max(0, Math.floor(at.x * pixelRatio))), y = Math.min(image.height - 1, Math.max(0, Math.floor(at.y * pixelRatio)))
    context.drawImage(imageRef.current, x - LOUPE_CENTRE, y - LOUPE_CENTRE, LOUPE_CELLS, LOUPE_CELLS, 0, 0, LOUPE_CELLS, LOUPE_CELLS)
    const [red = 0, green = 0, blue = 0] = context.getImageData(LOUPE_CENTRE, LOUPE_CENTRE, 1, 1).data
    return { x, y, hex: '#' + hexByte(red) + hexByte(green) + hexByte(blue), rgb: [red, green, blue] }
  }

  /** The original pixels the wand reads: the window editor's source image, or a capture's frozen frame, never marks. */
  function sourcePixels(): ImageData | null {
    if (sourcePixelsRef.current) return sourcePixelsRef.current
    const base = imageRef.current
    if (!base || !loaded) return null
    const reader = document.createElement('canvas'); reader.width = image.width; reader.height = image.height
    const context = reader.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(base, 0, 0, image.width, image.height)
    return sourcePixelsRef.current = context.getImageData(0, 0, image.width, image.height)
  }
  /** Selects the connected color region under the point; Shift adds it to the current selection. */
  function pickWand(at: ScreenshotPoint, add: boolean) {
    const pixels = sourcePixels()
    if (!pixels) { setWandIssue('The image pixels could not be read for the magic wand.'); return }
    const picked = magicWandRegion(pixels, at, wandTolerance)
    if (!picked) return
    const region = add && wand ? unionMagicWandRegions(wand.region, picked) : picked
    const outline = magicWandOutline(region)
    // An outline over the document limits could not be saved whole, so the selection stays as it was.
    if (exceedsOutlineLimits(outline)) { setWandIssue('That region is too detailed to keep. Lower the tolerance or pick a smaller area.'); return }
    // A new selection is a new adjustment range, so an open adjustment closes rather than follow it.
    setWandIssue(null); selectOnly(null); setAdjusting(null); setWand({ region, outline })
  }
  function measureText(shape: TextShape): number {
    const context = canvasRef.current?.getContext('2d')
    const lines = screenshotTextLines(shape.text)
    if (!context) return lines.reduce((longest, line) => Math.max(longest, line.length), 0) * shape.fontSize * 0.65
    context.save(); context.font = '600 ' + shape.fontSize + 'px ' + SCREENSHOT_TEXT_FONT
    const result = lines.reduce((longest, line) => Math.max(longest, context.measureText(line).width), 0); context.restore(); return result
  }
  const schedulePaint = useCallback(() => {
    if (paintFrame.current) return
    paintFrame.current = ownerWindow.requestAnimationFrame(time => {
      paintFrame.current = 0
      const canvas = canvasRef.current, committed = committedLayerRef.current, state = live.current, currentView = viewRef.current
      if (!state.active || !canvas || !committed || !state.size.width || !state.size.height) return
      const viewport: ImageViewport = { ...state.size, imageWidth: image.width, imageHeight: image.height, view: currentView }
      const excluded = transformRef.current?.original.id ?? (state.pendingText?.existing ? state.pendingText.shape.id : undefined)
      // A moving group keeps the committed layer of everything else and draws only its members per frame, like one mark.
      const group = groupRef.current, hidden = group?.ids
      const erased = eraseRef.current?.size ?? 0, previous = cache.current, shapes = state.documentState.shapes
      try {
        if (!previous || previous.document !== state.documentState || previous.view !== currentView || previous.size !== state.size ||
          previous.loaded !== state.loaded || previous.source !== state.source || previous.excluded !== excluded || previous.erased !== erased || previous.shapes !== shapes || previous.hidden !== hidden) {
          const output = screenshotOutputShapes(shapes.filter(shape => shape.id !== excluded && !hidden?.has(shape.id) && !eraseRef.current?.has(shape.id)), state.documentState.crop)
          renderCommittedLayer(committed, output, viewport, state.loaded ? imageRef.current! : undefined)
          cache.current = { document: state.documentState, shapes, hidden, view: currentView, size: state.size, loaded: state.loaded, source: state.source, excluded, erased,
            masks: output.filter(isScreenshotMask) }
        }
        const moving = group ? screenshotOutputShapes(group.moved.filter(shape => group.ids.has(shape.id)), state.documentState.crop) : currentGestureRef.current
        renderScreenshotScene(canvas, committed, moving, viewport, cache.current?.masks)
        const context = canvas.getContext('2d')
        if (!context) return
        const fit = currentView.scale
        const crop = shownSelection(cropRef.current, state.documentState.crop, { x: 0, y: 0, width: image.width, height: image.height })
        let fading = false
        context.save()
        if (capture) fading = paintCaptureSelection(context, crop, fit, time)
        else if (crop) {
          context.fillStyle = 'rgba(8, 13, 20, .58)'
          context.fillRect(0, 0, image.width, crop.y); context.fillRect(0, crop.y + crop.height, image.width, image.height - crop.y - crop.height)
          context.fillRect(0, crop.y, crop.x, crop.height); context.fillRect(crop.x + crop.width, crop.y, image.width - crop.x - crop.width, crop.height)
          context.strokeStyle = '#ffffff'; context.lineWidth = 1 / fit; context.setLineDash([5 / fit, 4 / fit])
          context.strokeRect(crop.x, crop.y, crop.width, crop.height)
        }
        if (state.outlined) drawMarchingAnts(context, state.outlined, 1 / fit, antsPhase.current)
        if (state.selected && !state.pendingText) {
          const shape = currentGestureRef.current ?? state.selected, box = shapeBounds(shape, measureText)
          context.strokeStyle = ACCENT; context.lineWidth = 1 / fit; context.setLineDash([4 / fit, 3 / fit])
          context.strokeRect(box.x - 4 / fit, box.y - 4 / fit, box.width + 8 / fit, box.height + 8 / fit)
          context.setLineDash([]); context.fillStyle = '#ffffff'
          for (const handle of selectionHandles(shape)) {
            context.fillRect(handle.point.x - 4 / fit, handle.point.y - 4 / fit, 8 / fit, 8 / fit)
            context.strokeRect(handle.point.x - 4 / fit, handle.point.y - 4 / fit, 8 / fit, 8 / fit)
          }
        }
        const marquee = marqueeRef.current
        const members = group ? group.moved.filter(shape => group.ids.has(shape.id)) : state.selectedShapes
        if (members.length > 1 && !state.pendingText) paintGroup(context, members, fit)
        if (marquee) paintMarquee(context, marquee, state.documentState, fit)
        // While a gesture snaps, each engaged line runs 1 px across the frame.
        const guides = capture ? guidesRef.current : null
        if (guides) {
          context.fillStyle = ACCENT
          for (const x of guides.x) context.fillRect(x - .5 / fit, 0, 1 / fit, image.height)
          for (const y of guides.y) context.fillRect(0, y - .5 / fit, image.width, 1 / fit)
        }
        context.restore()
        if (state.loaded && presentedSource.current !== image.dataUrl) {
          presentedSource.current = image.dataUrl
          presentedCallback.current?.()
        }
        // The window highlight's fade paints only its own few frames.
        if (fading) schedulePaint()
        setView(current => current === currentView ? current : currentView)
      } catch (error) { onError?.(error) }
    })
  }, [image.width, image.height, image.dataUrl, onError, ownerWindow, capture])
  /** Each member's dashed bounds, and the group's bounds as one thin solid outline around them. */
  function paintGroup(context: CanvasRenderingContext2D, members: readonly ScreenshotShape[], fit: number) {
    context.strokeStyle = '#3b82f6'; context.lineWidth = 1 / fit; context.setLineDash([4 / fit, 3 / fit])
    for (const shape of members) {
      const box = shapeBounds(shape, measureText)
      context.strokeRect(box.x - 3 / fit, box.y - 3 / fit, box.width + 6 / fit, box.height + 6 / fit)
    }
    const box = groupBounds(members, measureText)
    if (!box) return
    context.setLineDash([]); context.globalAlpha = .6
    context.strokeRect(box.x - 7 / fit, box.y - 7 / fit, box.width + 14 / fit, box.height + 14 / fit)
    context.globalAlpha = 1
  }
  /** The dashed marquee with a faint fill, and the marks its release would select. */
  function paintMarquee(context: CanvasRenderingContext2D, marquee: MarqueeGesture, doc: ScreenshotDocument, fit: number) {
    const area = normalizeRect(marquee.start, marquee.at), ids = new Set([...marquee.base, ...marqueeHits(doc, area)])
    context.fillStyle = 'rgba(59, 130, 246, .08)'; context.fillRect(area.x, area.y, area.width, area.height)
    context.strokeStyle = '#3b82f6'; context.lineWidth = 1 / fit; context.setLineDash([4 / fit, 3 / fit])
    context.strokeRect(area.x, area.y, area.width, area.height)
    for (const shape of doc.shapes) {
      if (!ids.has(shape.id)) continue
      const box = shapeBounds(shape, measureText)
      context.strokeRect(box.x - 3 / fit, box.y - 3 / fit, box.width + 6 / fit, box.height + 6 / fit)
    }
  }
  // A marquee selects what it shows: visible, unlocked marks.
  function marqueeHits(doc: ScreenshotDocument, area: NormalizedRect): string[] {
    return marqueeSelection(screenshotOutputShapes(doc.shapes, doc.crop), area, measureText)
  }
  /**
   * Dims the frozen frame outside the selection and draws its border and handles. Before one exists it dims all of it.
   * Either way it lights the window a click would select, if any; true while that highlight still fades in.
   */
  function paintCaptureSelection(context: CanvasRenderingContext2D, crop: NormalizedRect | null, fit: number, time: number): boolean {
    const unit = 1 / fit
    context.fillStyle = 'rgba(0, 0, 0, .28)'
    if (!crop) { context.fillRect(0, 0, image.width, image.height); return paintLitWindow(context, unit, time) }
    context.fillRect(0, 0, image.width, crop.y); context.fillRect(0, crop.y + crop.height, image.width, image.height - crop.y - crop.height)
    context.fillRect(0, crop.y, crop.x, crop.height); context.fillRect(crop.x + crop.width, crop.y, image.width - crop.x - crop.width, crop.height)
    // A white line between two dark hairlines reads on any frozen content, white windows included.
    context.lineWidth = unit; context.setLineDash([])
    context.strokeStyle = 'rgba(0, 0, 0, .55)'
    context.strokeRect(crop.x - 1.5 * unit, crop.y - 1.5 * unit, crop.width + 3 * unit, crop.height + 3 * unit)
    context.strokeRect(crop.x + .5 * unit, crop.y + .5 * unit, crop.width - unit, crop.height - unit)
    context.strokeStyle = '#ffffff'; context.strokeRect(crop.x - .5 * unit, crop.y - .5 * unit, crop.width + unit, crop.height + unit)
    const xs = [crop.x, crop.x + crop.width / 2, crop.x + crop.width], ys = [crop.y, crop.y + crop.height / 2, crop.y + crop.height]
    context.fillStyle = '#ffffff'; context.strokeStyle = 'rgba(0, 0, 0, .55)'
    for (const [column, x] of xs.entries()) for (const [row, y] of ys.entries()) {
      if (column === 1 && row === 1) continue
      context.beginPath(); context.arc(x, y, CROP_HANDLE_SIZE / 2 * unit, 0, Math.PI * 2); context.fill(); context.stroke()
    }
    // A window lights beside an untouched remembered selection, which is only a suggestion.
    return paintLitWindow(context, unit, time)
  }
  /** A faint fill and a 1 px accent outline, eased in over 90 ms from the first frame that paints it. */
  function paintLitWindow(context: CanvasRenderingContext2D, unit: number, time: number): boolean {
    const lit = litWindowRef.current
    if (!lit) return false
    lit.since ??= time
    const progress = Math.min(1, (time - lit.since) / WINDOW_FADE_MS), { x, y, width, height } = lit.rect
    context.globalAlpha = 1 - (1 - progress) ** 2
    context.fillStyle = WINDOW_FILL; context.fillRect(x, y, width, height)
    context.strokeStyle = ACCENT; context.lineWidth = unit; context.setLineDash([])
    context.strokeRect(x + unit / 2, y + unit / 2, width - unit, height - unit)
    context.globalAlpha = 1
    return progress < 1
  }
  const requestView = useCallback((next: AnnotationView) => { viewRef.current = next; schedulePaint() }, [schedulePaint])
  const resetGesture = useCallback(() => {
    currentGestureRef.current = null; transformRef.current = null; cropRef.current = null; eraseRef.current = null
    groupRef.current = null; marqueeRef.current = null
    lastErasePoint.current = null; panRef.current = null; downRef.current = null; guidesRef.current = null; litWindowRef.current = null; setGesture(null)
  }, [])
  const gestureActive = () => Boolean(currentGestureRef.current || cropRef.current || eraseRef.current || groupRef.current || marqueeRef.current)
  const edit = useCallback((update: (current: ScreenshotDocument) => ScreenshotDocument) => { onEdited?.(); setDocumentState(update) }, [onEdited])
  const undo = useCallback(() => { resetGesture(); edit(undoShape); schedulePaint() }, [edit, resetGesture, schedulePaint])
  const redo = useCallback(() => { resetGesture(); edit(redoShape); schedulePaint() }, [edit, resetGesture, schedulePaint])

  useEffect(() => {
    if (!active) return
    const focusCanvas = () => { if (document.activeElement === document.body) canvasRef.current?.focus({ preventScroll: true }) }
    focusCanvas(); const frame = ownerWindow.requestAnimationFrame(focusCanvas)
    return () => ownerWindow.cancelAnimationFrame(frame)
  }, [active, pendingText, noteEditor])
  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return
    const measure = () => { const rect = container.getBoundingClientRect()
      const next = { width: Math.max(1, rect.width), height: Math.max(1, rect.height), dpr: ownerWindow.devicePixelRatio || 1 }
      setSize(current => current.width === next.width && current.height === next.height && current.dpr === next.dpr ? current : next)
    }
    measure(); const observer = new ResizeObserver(measure); observer.observe(container)
    ownerWindow.addEventListener('resize', measure)
    return () => { observer.disconnect(); ownerWindow.removeEventListener('resize', measure) }
  }, [active])
  // A capture keeps one image pixel per physical screen pixel of its display; only the window view fits and zooms.
  const fitView = () => capture ? { scale: 1 / pixelRatio, x: 0, y: 0 } : fitImageView(size.width, size.height, image.width, image.height)
  useEffect(() => { if (active && fitted && size.width && size.height) requestView(fitView()) },
    [active, fitted, size, image.width, image.height, capture, pixelRatio, requestView])
  useEffect(() => { if (active) schedulePaint() }, [active, documentState, selectedIds, loaded, size, tool, pendingText, outlined, schedulePaint])
  // Pixel samples and a lit window belong to this source; the user's region geometry stays in the same document.
  useEffect(() => { sourcePixelsRef.current = null; litWindowRef.current = null; setHover(null) }, [image.dataUrl])
  // Capture keeps user region geometry across its backgrounds; a replaced window image, another tool or a locked display drops an uncommitted pick.
  useEffect(() => { setWand(null); setWandIssue(null) }, [tool, locked, capture ? null : image.dataUrl])
  // Marching ants step only while a selection shows in an active, visible editor; under reduced motion the dashes stay put.
  useEffect(() => {
    if (!active || !wand) return
    const reduced = ownerWindow.matchMedia('(prefers-reduced-motion: reduce)')
    let timer = 0
    const step = () => { antsPhase.current = (antsPhase.current + 1) % ANTS_CYCLE; schedulePaint() }
    const sync = () => { ownerWindow.clearInterval(timer); timer = reduced.matches || document.hidden ? 0 : ownerWindow.setInterval(step, ANTS_STEP_MS) }
    sync(); reduced.addEventListener('change', sync); document.addEventListener('visibilitychange', sync)
    return () => { ownerWindow.clearInterval(timer); reduced.removeEventListener('change', sync); document.removeEventListener('visibilitychange', sync) }
  }, [active, wand, ownerWindow, schedulePaint])
  useEffect(() => { if (!active) { ownerWindow.cancelAnimationFrame(paintFrame.current); paintFrame.current = 0; resetGesture(); spaceHeld.current = false; setPanHeld(false) } }, [active, resetGesture, ownerWindow])
  useEffect(() => () => { ownerWindow.cancelAnimationFrame(paintFrame.current); resetGesture() }, [resetGesture, ownerWindow])
  useEffect(() => { if (active && pendingText) { const frame = ownerWindow.requestAnimationFrame(() => textInputRef.current?.focus({ preventScroll: true })); return () => ownerWindow.cancelAnimationFrame(frame) } }, [active, pendingText, ownerWindow])
  useEffect(() => { setNoteDraft(selectedNote?.note ?? '') }, [selectedNote?.id, selectedNote?.note])
  // An opening capture selection is only a starting point: the first change that keeps a selection claims it like a drawn
  // one, and clearing it claims nothing. Opening on it claims nothing and delivers nothing.
  const opening = useRef(capture && initialState?.crop ? documentState : null)
  const onSelect = () => { opening.current = null; claimSelection?.() }
  useEffect(() => {
    const start = opening.current
    if (!start || documentState === start) return
    opening.current = null
    if (documentState.crop) claimSelection?.()
  }, [documentState, claimSelection])
  // The lock reaches this display asynchronously, so a gesture or selection begun here before it arrived is dropped.
  useEffect(() => {
    if (!locked) return
    resetGesture(); selectOnly(null); setHover(null); setDocumentState(createScreenshotDocument()); schedulePaint()
  }, [locked, resetGesture, schedulePaint])
  // The capture toolbar and size chip are placed from their laid-out widths before the frame paints, so they appear in
  // place. Their widths change only with what they show, so pointer moves that change neither force no layout.
  useLayoutEffect(() => {
    if (!capture) return
    const bar = barRef.current?.getBoundingClientRect().width, chip = chipRef.current?.getBoundingClientRect().width
    setMeasured(current => (bar ?? current.bar) === current.bar && (chip ?? current.chip) === current.chip ? current : { bar: bar ?? current.bar, chip: chip ?? current.chip })
  }, [capture, barShown, sizeText, label, busy, busyLabel, confirmingDiscard])
  const loupeSample = capture ? hover?.sample : undefined
  useLayoutEffect(() => {
    const target = loupeRef.current?.getContext('2d'), source = samplerRef.current
    if (!target || !source || !loupeSample) return
    target.imageSmoothingEnabled = false; target.clearRect(0, 0, LOUPE_GRID, LOUPE_GRID)
    target.drawImage(source, 0, 0, LOUPE_CELLS, LOUPE_CELLS, 0, 0, LOUPE_GRID, LOUPE_GRID)
    target.strokeStyle = 'rgba(255, 255, 255, .12)'; target.lineWidth = 1; target.beginPath()
    for (let line = 1; line < LOUPE_CELLS; line++) {
      const at = line * LOUPE_CELL + .5
      target.moveTo(at, 0); target.lineTo(at, LOUPE_GRID); target.moveTo(0, at); target.lineTo(LOUPE_GRID, at)
    }
    target.stroke()
    const centre = LOUPE_CENTRE * LOUPE_CELL
    target.strokeStyle = 'rgba(0, 0, 0, .6)'; target.strokeRect(centre - .5, centre - .5, LOUPE_CELL + 1, LOUPE_CELL + 1)
    target.strokeStyle = '#ffffff'; target.strokeRect(centre + .5, centre + .5, LOUPE_CELL - 1, LOUPE_CELL - 1)
  }, [loupeSample])
  useEffect(() => { lastStyle = { tool, color, width, fontSize, blockSize, pixelateMode, brushWidth, ...strengths, wandTolerance } }, [tool, color, width, fontSize, blockSize, pixelateMode, brushWidth, strengths, wandTolerance])

  function fitImage() { resetGesture(); setFitted(true); requestView(fitView()) }
  function zoomTo(next: number, anchor = { x: size.width / 2, y: size.height / 2 }) {
    if (capture) return
    const fit = fitImageView(size.width, size.height, image.width, image.height).scale
    const bounded = Math.max(Math.min(1 / 16, fit / 4), Math.min(Math.max(8, fit), next))
    setFitted(false); requestView(zoomImageView(viewRef.current, bounded, anchor))
  }
  useEffect(() => {
    if (!active || capture) return
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
  }, [active, capture, size, image.width, image.height, requestView])
  function cancelGesture() {
    if (panRef.current) { requestView(panRef.current.view); setFitted(panRef.current.fitted) }
    resetGesture(); schedulePaint()
  }
  function requestClose() { if (unexported) setDiscarding('close'); else onCancel() }
  function requestRetake() { if (!onRetake || busy) return; if (unexported) setDiscarding('retake'); else onRetake() }
  // The confirmed discard: the marks go only once the person confirms, and a retake keeps this editor until the new capture completes.
  function discard() { if (confirmingDiscard === 'retake') { setDiscarding(false); onRetake?.() } else onCancel() }
  function removeSelected() { if (groupIds.size) { edit(doc => removeShapes(doc, groupIds)); selectOnly(null) } }
  // One command over the marks is one Undo step; a command that changes nothing records none.
  function editShapes(next: ScreenshotShape[]) { if (next !== documentState.shapes) edit(doc => setShapes(doc, next)) }
  function addShapes(result: { shapes: ScreenshotShape[]; ids: string[] }) { editShapes(result.shapes); setSelectedIds(new Set(result.ids)) }
  // Unlocked marks come back unselected, even when Redo locked them while they were selected.
  function unlockShapes(ids: ReadonlySet<string>) {
    editShapes(setShapesLocked(documentState.shapes, ids, false))
    setSelectedIds(current => [...current].some(id => ids.has(id)) ? new Set([...current].filter(id => !ids.has(id))) : current)
  }
  /** Marks copied with Shift stay inside this editor and never reach the system clipboard. */
  function runObjectCommand(command: ObjectCommand) {
    const shapes = documentState.shapes, distance = 10 / viewRef.current.scale
    const offset = capture ? { x: Math.round(distance), y: Math.round(distance) } : { x: distance, y: distance }
    // Like the marquee, Select All takes what the canvas shows: unlocked marks, never a note hidden under a mask.
    if (command === 'select-all') setSelectedIds(new Set(screenshotOutputShapes(shapes, documentState.crop).filter(shape => !shape.locked).map(shape => shape.id)))
    else if (command === 'duplicate') { if (groupIds.size) addShapes(duplicateShapes(shapes, groupIds, offset, mintObjectId)) }
    else if (command === 'copy') { if (selectedShapes.length) copiedRef.current = selectedShapes }
    else if (command === 'paste') {
      // Each paste cascades from the last one, so repeated pastes do not stack exactly.
      const pasted = pasteShapes(shapes, copiedRef.current, offset, mintObjectId)
      if (pasted.ids.length) { addShapes(pasted); copiedRef.current = pasted.shapes.filter(shape => pasted.ids.includes(shape.id)) }
    }
    // Locking takes the marks out of the selection; the lock badge under the pointer or Unlock all brings them back.
    else if (command === 'lock') { if (groupIds.size) { editShapes(setShapesLocked(shapes, groupIds, true)); selectOnly(null) } }
    else editShapes(reorderShapes(shapes, groupIds, command))
  }
  // While shown, the editor owns the chords it names, so the window shortcut router does not split or switch tabs on them.
  useEffect(() => {
    const root = editorRef.current
    if (!active || !root) return
    return claimSurfaceChords(root, event => objectCommandFor(event) !== null)
  }, [active, capture])
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target && 'nodeType' in event.target && event.target !== document.body ? event.target as Node : document.activeElement
      if (event.defaultPrevented || !target || !editorRef.current?.contains(target) || isImeOwnedKeyboardEvent(event)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        // Each Escape undoes one layer of editing state before the editor itself closes.
        if (textDraftRef.current) finishText('', true)
        else if (noteEditorRef.current) closeNoteEditor(false)
        else if (gestureActive() || panRef.current) cancelGesture()
        else if (confirmingDiscard === 'retake') setDiscarding(false)
        else if (confirmingDiscard) onCancel()
        else if (groupIds.size) selectOnly(null)
        else if (adjusting) setAdjusting(null)
        else if (wand) setWand(null)
        else if (tool !== openingTool) { resetGesture(); setTool(openingTool) }
        else requestClose()
        return
      }
      if (event.target && 'tagName' in event.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(String(event.target.tagName))) return
      // A focused button activates itself on Enter, so only the canvas or editor surface confirms.
      if (confirmingDiscard && event.key === 'Enter' && !('tagName' in target && target.tagName === 'BUTTON')) { event.preventDefault(); discard(); return }
      if (event.key === ' ' && target === canvasRef.current && !capture) { event.preventDefault(); spaceHeld.current = true; setPanHeld(true); return }
      if (capture && ['0', '1', '+', '=', '-'].includes(event.key)) return
      if (event.key === '0') { event.preventDefault(); fitImage(); return }
      if (event.key === '1') { event.preventDefault(); zoomTo(1); return }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomTo(viewRef.current.scale * 1.25); return }
      if (event.key === '-') { event.preventDefault(); zoomTo(viewRef.current.scale / 1.25); return }
      if (busy) return
      const command = event.metaKey || event.ctrlKey, key = event.key.toLowerCase()
      if (!textDraftRef.current && !noteEditorRef.current) {
        if (event.key === 'Enter' && !command && !('tagName' in target && target.tagName === 'BUTTON')) { event.preventDefault(); complete(); return }
        const object = objectCommandFor(event)
        if (object) { event.preventDefault(); runObjectCommand(object); return }
        if (command && key === 'c') { event.preventDefault(); complete(); return }
        if (command && key === 's' && onSavePng) { event.preventDefault(); complete('save-png'); return }
        if (capture && command && key === 'p') { event.preventDefault(); complete('pin'); return }
        if (capture && command && key === 'e') { event.preventDefault(); expand(); return }
        if (onRetake && command && event.shiftKey && key === 'r') { event.preventDefault(); requestRetake(); return }
      }
      if (command && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); return }
      if (groupIds.size && target === canvasRef.current && event.key.startsWith('Arrow')) {
        const delta = event.shiftKey ? 10 : 1
        const dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0
        const dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0
        if (dx || dy) { event.preventDefault(); editShapes(moveShapes(documentState.shapes, groupIds, dx, dy)); return }
      }
      // With no mark selected, arrows nudge a capture selection by one frame pixel, or ten with Shift.
      const crop = documentState.crop
      if (capture && crop && !groupIds.size && target === canvasRef.current && event.key.startsWith('Arrow')) {
        event.preventDefault()
        const delta = Math.round((event.shiftKey ? 10 : 1) * pixelRatio), still = { x: 0, y: 0 }
        const at = { x: event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0, y: event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0 }
        const moved = cropGestureRect({ mode: 'move', start: still, at, original: crop }, originalBounds)!
        if (moved.x !== crop.x || moved.y !== crop.y) edit(doc => setCrop(doc, moved))
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (capture) {
        const loupe = live.current.loupe
        if (key === 'c' && loupe) { event.preventDefault(); onCopyColor?.(loupe.sample.hex); return }
        const mark = crop ? CAPTURE_TOOLS.find(item => item.key.toLowerCase() === key) : undefined
        if (mark) { event.preventDefault(); resetGesture(); setTool(mark.id) }
        return
      }
      const next = ANNOTATION_TOOLS.find(item => item.key.toLowerCase() === event.key.toLowerCase())
      if (next) { event.preventDefault(); resetGesture(); setTool(next.id) }
    }
    const releaseSpace = () => { spaceHeld.current = false; setPanHeld(false) }
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === ' ') releaseSpace() }
    ownerWindow.addEventListener('keydown', onKeyDown); ownerWindow.addEventListener('keyup', onKeyUp); ownerWindow.addEventListener('blur', releaseSpace)
    return () => { ownerWindow.removeEventListener('keydown', onKeyDown); ownerWindow.removeEventListener('keyup', onKeyUp); ownerWindow.removeEventListener('blur', releaseSpace) }
  }, [active, busy, selected, selectedIds, tool, pendingText, confirmingDiscard, unexported, documentState, loaded, noteDraft, onCancel, onComplete, onSavePng, onPin, onRetake, onExpand, onCopyColor, redo, undo, edit, resetGesture, requestView, size, fitted, adjusting, wand])

  function localPoint(event: { clientX: number; clientY: number }): ScreenshotPoint {
    const rect = canvasRef.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }
  // A capture works in whole image pixels, so the selection, its size chip and the cropped output agree.
  function point(event: { clientX: number; clientY: number }) {
    const at = imagePoint(viewRef.current, localPoint(event))
    return capture ? { x: Math.round(at.x), y: Math.round(at.y) } : at
  }
  function hit(at: ScreenshotPoint, erased?: Set<string>) {
    return hitTestShape(screenshotOutputShapes(documentState.shapes, documentState.crop).filter(shape => !erased?.has(shape.id)), at, 6 / viewRef.current.scale, measureText)
  }
  function beginText(shape?: TextShape, at: ScreenshotPoint = { x: 0, y: 0 }) {
    resetGesture()
    const draft: TextDraft = shape ? { shape, existing: true, edited: false } : { shape: { id: mintObjectId(), kind: 'text', color,
      at, text: '', fontSize: fontSize / viewRef.current.scale }, existing: false, edited: false }
    textDraftRef.current = draft; setPendingText(draft)
    setTextRows(Math.max(2, screenshotTextLines(draft.shape.text).length))
  }
  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    beginGesture(event)
    if (capture) { setGesture(cropRef.current ? 'selection' : gestureActive() ? 'mark' : null); track(event) }
  }
  // A default bubble stays inside the selection or image, a fixed number of screen points from its source at any zoom.
  const bubblePlacement = () => ({ bounds: documentState.crop ?? originalBounds, gap: CALLOUT_GAP / viewRef.current.scale })
  function beginGesture(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!active || locked || (event.button !== 0 && event.button !== 1) || (capture && event.button !== 0)) return
    event.currentTarget.focus({ preventScroll: true }); setDiscarding(false)
    if (tool === 'pan' || (!capture && (spaceHeld.current || event.button === 1))) {
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
      panRef.current = { start: localPoint(event), view: viewRef.current, fitted }; setFitted(false); return
    }
    if (busy) return
    const at = point(event)
    // A capture selects first. Without a mark under the pointer, its edges and handles resize the selection, the Select
    // tool moves it, and a press outside starts a new one while there are no marks to lose; mark tools draw inside it.
    const crop = documentState.crop
    if (capture && (!crop || !((selected && hitSelectionHandle(selected, at, 9 / viewRef.current.scale)) || hit(at)))) {
      const handle = crop ? hitCropHandle(crop, at, CROP_HANDLE_HIT / viewRef.current.scale) : null
      const inside = crop !== null && rectContains(crop, at)
      if (handle || !inside || (tool === 'select' && !event.shiftKey)) {
        const mode = handle ?? (inside ? 'move' : !crop || !documentState.shapes.length ? 'create' : null)
        selectOnly(null)
        if (mode) { event.currentTarget.setPointerCapture(event.pointerId); cropRef.current = { mode, start: at, at, original: crop } }
        // A new selection needs travel like any region mark, so a jittery click keeps the current one.
        if (mode === 'create') downRef.current = { at: localPoint(event), deselected: false }
        schedulePaint(); return
      }
    }
    // The wand reads the original pixels under the press, at its exact sub-pixel point; marks above them never count.
    if (tool === 'wand') { event.preventDefault(); pickWand(imagePoint(viewRef.current, localPoint(event)), event.shiftKey); schedulePaint(); return }
    // Existing marks are selected and transformed before any tool creates a new one.
    if (tool !== 'erase' && tool !== 'crop') {
      const handle = selected ? hitSelectionHandle(selected, at, 9 / viewRef.current.scale) : null
      const shape = handle ? selected : hit(at)
      // Shift-click adds a mark to the selection or removes it; a press on a member of several drags them all as one edit.
      if (shape && !handle && event.shiftKey) { setSelectedIds(toggled(groupIds, shape.id)); schedulePaint(); return }
      if (shape && !handle && groupIds.size > 1 && groupIds.has(shape.id)) {
        event.currentTarget.setPointerCapture(event.pointerId); downRef.current = { at: localPoint(event), deselected: false }
        groupRef.current = { start: at, ids: groupIds, pressed: shape.id, base: documentState.shapes, moved: documentState.shapes }
        schedulePaint(); return
      }
      // Select draws a marquee from empty canvas; Shift adds what it catches to the selection. A capture needs Shift,
      // since its plain Select drag moves the capture selection.
      if (!shape && tool === 'select' && (!capture || event.shiftKey)) {
        event.currentTarget.setPointerCapture(event.pointerId); downRef.current = { at: localPoint(event), deselected: false }
        marqueeRef.current = { start: at, at, base: event.shiftKey ? groupIds : NO_SELECTION }
        if (!event.shiftKey) selectOnly(null)
        schedulePaint(); return
      }
      selectOnly(shape?.id ?? null)
      if (shape || tool === 'select') {
        event.currentTarget.setPointerCapture(event.pointerId)
        const bubble = !handle && shape?.kind === 'callout' && rectContains(calloutBubble(shape), at)
        if (shape) { transformRef.current = { original: shape, start: at, ...(handle ? { handle } : {}), ...(bubble ? { bubble: true as const } : {}) }; currentGestureRef.current = shape }
        schedulePaint(); return
      }
    }
    if (tool === 'text') {
      if (!textDraftRef.current && !groupIds.size) {
        event.preventDefault(); beginText(undefined, at)
      }
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId); downRef.current = { at: localPoint(event), deselected: groupIds.size > 0 }
    if (tool === 'erase') {
      eraseRef.current = new Set(); lastErasePoint.current = at; const shape = hit(at); if (shape) eraseRef.current.add(shape.id)
    } else if (tool === 'crop') cropRef.current = { mode: 'create', start: at, at, original: documentState.crop }
    else {
      const id = mintObjectId(), fit = viewRef.current.scale, stroke = width / fit
      currentGestureRef.current = tool === 'pen' || tool === 'highlight'
        ? { id, kind: tool, color, width: stroke, points: [at] }
        : tool === 'pixelate' ? pixelateMode === 'brush'
          ? { id, kind: 'pixelate-brush', color, width: brushWidth / fit, blockSize: blockSize / fit, points: [at] }
          : { id, kind: 'pixelate', color, blockSize: blockSize / fit, from: at, to: at }
        : tool === 'cover' ? { id, kind: 'cover', color: '#111827', from: at, to: at }
        : tool === 'blur' ? createBlurShape(id, '#111827', at, at, strengths.blurRadius)
        : tool === 'spotlight' ? createSpotlightShape(id, '#ffffff', at, at, strengths.spotlightDim)
        : tool === 'callout' ? createCalloutShape(id, color, at, at, strengths.calloutZoom, undefined, bubblePlacement())
        : tool === 'note' ? { id, kind: 'note', color, width: stroke / 2, radius: 12 / fit, number: nextNoteNumber(documentState.shapes), note: '', from: at, to: at }
        : { id, kind: tool, color, width: stroke, from: at, to: at }
    }
    schedulePaint()
  }
  /** `unsnapped`: ⌘ is held, so a capture gesture follows the pointer exactly. */
  function updateGesture(at: ScreenshotPoint, constrained = false, unsnapped = false) {
    guidesRef.current = null
    const group = groupRef.current, marquee = marqueeRef.current
    if (group || marquee) {
      if (group) group.moved = moveShapes(group.base, group.ids, at.x - group.start.x, at.y - group.start.y)
      else marquee!.at = at
      schedulePaint(); return
    }
    if (capture && !unsnapped) at = snapPoint(at, constrained)
    const transform = transformRef.current
    if (transform) currentGestureRef.current = transform.handle ? resizeShapeFromHandle(transform.original, transform.handle, at, constrained)
      : transform.bubble && transform.original.kind === 'callout'
        ? { ...transform.original, at: { x: transform.original.at.x + at.x - transform.start.x, y: transform.original.at.y + at.y - transform.start.y } }
        : moveShape(transform.original, at.x - transform.start.x, at.y - transform.start.y)
    else if (cropRef.current) cropRef.current.at = at
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
      if (shape.kind === 'pen' || shape.kind === 'highlight' || shape.kind === 'pixelate-brush') {
        const last = shape.points.at(-1)
        if (!last || last.x !== at.x || last.y !== at.y) shape.points.push(at)
      } else if (shape.kind === 'callout') {
        // While its source is drawn, the bubble keeps the default place beside it; after release it moves on its own.
        currentGestureRef.current = createCalloutShape(shape.id, shape.color, shape.from, at, shape.zoom, undefined, bubblePlacement())
      } else shape.to = constrained && (shape.kind === 'rect' || shape.kind === 'ellipse' || shape.kind === 'arrow')
        ? constrainedEndpoint(shape.kind, shape.from, at) : at
    }
    schedulePaint()
  }
  /**
   * Lands what the gesture moves on a window edge, the selection's edges or another mark's edges or centre within 6 screen
   * points: a moved selection's or mark's edges and centre, a resized selection's moving edges, a mark's dragged handle,
   * or the moving corner of a new selection or region mark. Returns the shifted pointer and keeps the engaged lines as guides.
   */
  function snapPoint(at: ScreenshotPoint, constrained: boolean): ScreenshotPoint {
    const transform = transformRef.current, crop = cropRef.current, drawn = currentGestureRef.current
    const offset = (rect: NormalizedRect, start: ScreenshotPoint) => ({ ...rect, x: rect.x + at.x - start.x, y: rect.y + at.y - start.y })
    // Shift reshapes a handle's or a new mark's end after it would snap, so a constrained end follows the pointer.
    const end = constrained ? null : pointFeatures(at)
    let features: SnapFeatures | null = null
    if (transform) {
      const box = transform.bubble && transform.original.kind === 'callout' ? calloutBubble(transform.original) : shapeBounds(transform.original, measureText)
      features = transform.handle ? end : rectFeatures(offset(box, transform.start), null)
    } else if (crop) features = crop.mode === 'create' || !crop.original ? pointFeatures(at) : rectFeatures(offset(crop.original, crop.start), crop.mode === 'move' ? null : crop.mode)
    else if (drawn && REGION_KINDS.has(drawn.kind)) features = end
    if (!features) return at
    // The selection being made or adjusted moves its own edges, and a moved mark its own, so neither is a line to itself.
    const own = transform?.original.id
    const marks = documentState.shapes.flatMap(shape => shape.id === own ? [] : [shapeBounds(shape, measureText)])
    const snapped = snap(features, snapLines(windows, crop ? null : documentState.crop, marks), SNAP_DISTANCE / viewRef.current.scale)
    if (snapped.guides.x.length || snapped.guides.y.length) guidesRef.current = snapped.guides
    // A capture works in whole image pixels; a mark's centre may sit on a half pixel.
    return { x: at.x + Math.round(snapped.dx), y: at.y + Math.round(snapped.dy) }
  }
  /** The topmost window containing the point. */
  function windowAt(at: ScreenshotPoint): NormalizedRect | null { return windows.find(window => rectContains(window, at)) ?? null }
  /** Lights the window a click would select, repainting only when that window changes; reduced motion shows it at once. */
  function lightWindow(rect: NormalizedRect | null) {
    if (rect === (litWindowRef.current?.rect ?? null)) return
    litWindowRef.current = rect && { rect, since: ownerWindow.matchMedia('(prefers-reduced-motion: reduce)').matches ? -Infinity : null }
    schedulePaint()
  }
  // The loupe follows the pointer before a selection exists and while one is made or adjusted. At rest a move reads no
  // frozen pixels, since each read is a canvas readback, and only sets the cursor for what a press would do.
  function track(event: { clientX: number; clientY: number }) {
    if (locked) return
    const at = localPoint(event), crop = documentState.crop
    setHover(cropRef.current || !crop ? { at, sample: sampleLoupe(at) } : null)
    if (gestureActive()) {
      // A press keeps showing the window its release selects until the pointer travels into a drag, which it stays.
      const down = downRef.current
      if (down && Math.hypot(at.x - down.at.x, at.y - down.at.y) >= CLICK_DISTANCE) down.dragged = true
      if (!down || down.dragged) lightWindow(null)
      return
    }
    const spot = point(event), handle = crop ? hitCropHandle(crop, spot, CROP_HANDLE_HIT / viewRef.current.scale) : null
    // An untouched opening selection is only a suggestion: outside it the window under the pointer still lights.
    const suggested = crop !== null && opening.current !== null && documentState === opening.current
    lightWindow(!crop || suggested && !rectContains(crop, spot) ? windowAt(spot) : null)
    setCursor(!crop ? 'crosshair' : handle ? CROP_CURSORS[handle] : !rectContains(crop, spot) ? documentState.shapes.length ? 'default' : 'crosshair' : tool === 'select' ? 'move' : 'crosshair')
  }
  /** Right-click outside the selection clears it while there are no marks to lose; with no selection it cancels. */
  function onContextMenu(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (!capture) return
    event.preventDefault()
    const crop = documentState.crop
    if (busy || cropRef.current || currentGestureRef.current) return
    if (!crop) onCancel()
    else if (!documentState.shapes.length && !rectContains(crop, point(event))) { selectOnly(null); setTool('select'); edit(doc => setCrop(doc, null)) }
  }
  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (capture) track(event)
    const pan = panRef.current
    if (pan) { const at = localPoint(event); requestView({ ...pan.view, x: pan.view.x + at.x - pan.start.x, y: pan.view.y + at.y - pan.start.y }); return }
    if (gestureActive()) updateGesture(point(event), event.shiftKey, event.metaKey)
    // At rest the pointer finds a locked mark to show its lock; with none locked a move does no work here.
    else if (hasLocked && !locked) setLockHover(lockedMarkAt(documentState.shapes, point(event), 4 / viewRef.current.scale, measureText)?.id ?? null)
  }
  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (panRef.current) { onPointerMove(event); resetGesture(); return }
    if (gestureActive()) updateGesture(point(event), event.shiftKey, event.metaKey)
    const finished = currentGestureRef.current, transform = transformRef.current, crop = cropRef.current, erased = eraseRef.current
    const group = groupRef.current, marquee = marqueeRef.current
    const down = downRef.current, up = localPoint(event)
    const click = down !== null && Math.hypot(up.x - down.at.x, up.y - down.at.y) < CLICK_DISTANCE
    resetGesture()
    // A click on a member of several selects only it; a drag moves them all.
    if (group) { if (click) selectOnly(group.pressed); else editShapes(group.moved) }
    else if (marquee) { if (!click) setSelectedIds(new Set([...marquee.base, ...marqueeHits(documentState, normalizeRect(marquee.start, marquee.at))])) }
    else if (crop) {
      // Before any selection, a press that never travelled selects the window it lit, as this display shows it.
      const untouched = opening.current !== null && crop.original !== null && crop.original === opening.current.crop
      const target = crop.mode === 'create' && click && !down.dragged && (!crop.original || untouched) ? windowAt(crop.start) : null
      const box = target ? intersectRect(target, originalBounds) : cropGestureRect(crop, originalBounds)
      if (box && !(crop.mode === 'create' && click && !target) && JSON.stringify(box) !== JSON.stringify(crop.original)) {
        edit(doc => setCrop(doc, box)); if (crop.mode === 'create') onSelect?.()
      }
    }
    else if (erased?.size) edit(doc => removeShapes(doc, erased))
    else if (transform && finished) { if (JSON.stringify(finished) !== JSON.stringify(transform.original)) edit(doc => replaceShape(doc, finished)) }
    // A click on empty image while a mark is selected only deselects it; a drag also draws.
    else if (finished && !(click && (down.deselected || REGION_KINDS.has(finished.kind)))) {
      const shape = click && finished.kind === 'note' ? { ...finished, to: finished.from } : finished
      edit(doc => commitShape(doc, shape)); selectOnly(shape.id)
      if (shape.kind === 'note') { noteEditorRef.current = shape.id; setNoteEditor(shape.id) }
    }
    schedulePaint()
  }
  function finishText(value: string, cancelled = false) {
    const draft = textDraftRef.current
    textDraftRef.current = null; setPendingText(null)
    if (!draft || cancelled || !draft.edited) return
    const text = value
    if (draft.existing) {
      if (text !== draft.shape.text && !text.trim()) edit(doc => removeShapes(doc, new Set([draft.shape.id])))
      else if (text !== draft.shape.text) edit(doc => replaceShape(doc, { ...draft.shape, text }))
    } else if (text.trim()) edit(doc => commitShape(doc, { ...draft.shape, text }))
  }
  function commitNote() { if (selectedNote && noteDraft !== selectedNote.note) edit(doc => replaceShape(doc, { ...selectedNote, note: noteDraft })) }
  // Like text drafts, the ref makes the blur that follows Escape or unmounting a no-op.
  function closeNoteEditor(commit: boolean) {
    if (!noteEditorRef.current) return
    noteEditorRef.current = null; setNoteEditor(null)
    if (commit) commitNote(); else setNoteDraft(selectedNote?.note ?? '')
  }
  function setTemplate(template: NoteTemplate | undefined) {
    if (!selectedNote) return
    const { template: _previous, ...note } = selectedNote
    edit(doc => replaceShape(doc, { ...note, note: noteDraft, ...(template ? { template } : {}) }))
  }
  function locateNote() {
    if (!selectedNote) return
    const bounds = shapeBounds(selectedNote), fit = Math.min(size.width / Math.max(bounds.width + 80, 1), size.height / Math.max(bounds.height + 80, 1), 2)
    const zoom = fit
    setFitted(false); requestView({ scale: zoom, x: size.width / 2 - (bounds.x + bounds.width / 2) * zoom, y: size.height / 2 - (bounds.y + bounds.height / 2) * zoom })
  }
  // The exact marks an output or the Expand handoff sees, including an open text or note draft.
  function currentShapes(): ScreenshotShape[] {
    let shapes = selectedNote ? documentState.shapes.map(shape => shape.id === selectedNote.id ? { ...selectedNote, note: noteDraft } : shape) : documentState.shapes
    const draft = textDraftRef.current
    if (draft) {
      // Native textareas normalize CRLF; untouched originals keep their exact saved text.
      const text = draft.edited ? textInputRef.current?.value ?? draft.shape.text : draft.shape.text
      if (draft.existing && draft.edited && text !== draft.shape.text) shapes = text.trim() ? shapes.map(shape => shape.id === draft.shape.id ? { ...draft.shape, text } : shape) : shapes.filter(shape => shape.id !== draft.shape.id)
      else if (!draft.existing && text.trim()) shapes = [...shapes, { ...draft.shape, text }]
    }
    return shapes
  }
  function complete(action: 'png' | 'context' | 'save' | 'save-png' | 'pin' = 'png') {
    const base = imageRef.current
    if (!base || !loaded) return
    // A capture delivers only its selection; the whole frozen display is never an output.
    if (capture && !documentState.crop) return
    const input = { image: base, shapes: currentShapes(), crop: documentState.crop, displayWidth: image.width, displayHeight: image.height }
    const output = { context: onCopyContext, save: onSaveOriginal, 'save-png': onSavePng, pin: onPin, png: onComplete }[action]
    const kept = documentState, result = output?.(input)
    if (result instanceof Promise) void result.then(confirmed => { if (confirmed === true) { setExported(kept); setDiscarding(false) } })
  }
  function expand() { if (documentState.crop) onExpand?.({ shapes: currentShapes(), crop: documentState.crop, tool }) }
  // A change applies to every selected mark that shows the property, as one Undo; with none selected it sets the next mark's.
  function setProperty(property: 'color' | 'width' | 'fontSize', value: string | number) {
    if (property === 'color') setColor(String(value)); else if (property === 'width') setWidth(Number(value)); else setFontSize(Number(value))
    const applies = property === 'color' ? colorable : property === 'width' ? widthable : (shape: ScreenshotShape) => shape.kind === 'text'
    const next = property === 'color' ? value : Number(value) / viewRef.current.scale
    editShapes(restyleShapes(documentState.shapes, groupIds, shape => applies(shape) && (shape as unknown as Record<string, unknown>)[property] !== next
      ? { ...shape, [property]: next } as ScreenshotShape : shape))
  }
  // Selected marks show their own values, a group its first member's that has each one; otherwise the controls show the next mark's.
  const properties = selectedShapes.length ? selectedShapes : null
  const colorShape = properties?.find(colorable), widthShape = properties?.find(widthable), fontShape = properties?.find(shape => shape.kind === 'text')
  // Strength units differ by kind, so the control shows only while the selected pointing marks share one kind.
  const pointingKinds = [...new Set(properties?.map(shape => shape.kind).filter(isPointingKind))]
  const strengthKind = properties ? (pointingKinds.length === 1 ? pointingKinds[0]! : null) : isPointingKind(tool) ? tool : null
  const strength = strengthKind && POINTING_STRENGTHS[strengthKind]
  const strengthShape = properties?.find(shape => shape.kind === strengthKind)
  const strengthValue = !strength ? 0 : strengthShape
    ? Number((strengthShape as unknown as Record<string, number>)[strength.property]!.toFixed(2)) : strengths[strength.style]
  function setStrength(value: number) {
    if (!strength) return
    setStrengths(current => ({ ...current, [strength.style]: value }))
    const restyled = restyleShapes(documentState.shapes, groupIds, shape => shape.kind === strengthKind ? { ...shape, [strength.property]: value } as ScreenshotShape : shape)
    editShapes(restyled)
  }
  /** Turns the wand selection into a mark narrowed to its outline, as one Undo step, and selects that mark. */
  function convertWand(kind: RegionAction) {
    if (!wand) return
    const id = mintObjectId(), { x, y, width: across, height: down } = wand.region.bounds, from = { x, y }, to = { x: x + across, y: y + down }
    const base: CoverShape | RegionHighlightShape | PixelateShape | BlurShape | SpotlightShape = kind === 'cover' ? { id, kind, color: '#111827', from, to }
      : kind === 'region-highlight' ? { id, kind, color, from, to }
      : kind === 'pixelate' ? { id, kind, color, blockSize: blockSize / viewRef.current.scale, from, to }
      : kind === 'blur' ? createBlurShape(id, '#111827', from, to, strengths.blurRadius)
      : createSpotlightShape(id, '#ffffff', from, to, strengths.spotlightDim)
    const shape = withOutline(base, wand.outline)
    edit(doc => commitShape(doc, shape)); setWand(null); selectOnly(id)
  }
  // Capture keeps its own lighter mark set, so its wand offers only the masks its toolbar offers.
  const regionActions = REGION_ACTIONS.filter(([kind]) => !capture || kind === 'region-highlight' || CAPTURE_TOOLS.some(item => item.id === kind))
  // Adjust marks never take a canvas press, so the Adjust panel lists them: the whole image's and each region's.
  const adjustMarks = documentState.shapes.filter((shape): shape is AdjustShape => shape.kind === 'adjust')
  const regionAdjusts = adjustMarks.filter(shape => shape.outline)
  const adjustTarget = (shape: AdjustShape): AdjustTarget => ({ id: shape.id, from: shape.from, to: shape.to, ...(shape.outline ? { outline: shape.outline } : {}) })
  /** The whole image's adjustment, or the one its first change commits; `removed` no longer counts. */
  function wholeImageTarget(removed?: string): AdjustTarget {
    const existing = adjustMarks.filter(shape => !shape.outline && shape.id !== removed).at(-1)
    return existing ? adjustTarget(existing) : { id: mintObjectId(), from: { x: 0, y: 0 }, to: { x: image.width, y: image.height } }
  }
  /** Opens the adjustment of the wand selection, else of the whole image, reopening the one already made for that
   * range; pressing again closes it. */
  function toggleAdjust() {
    if (adjusting) { setAdjusting(null); return }
    selectOnly(null)
    if (!wand) { setAdjusting(wholeImageTarget()); return }
    const { outline, region: { bounds } } = wand, existing = regionAdjusts.filter(shape => shape.outline === outline).at(-1)
    setAdjusting(existing ? adjustTarget(existing) : { id: mintObjectId(), from: { x: bounds.x, y: bounds.y }, to: { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, outline })
  }
  const adjustment = adjusting ? adjustMarks.find(shape => shape.id === adjusting.id) ?? null : null
  /** Removes the adjustment being edited as one Undo step; the panel then edits the whole image's. */
  function removeAdjust() {
    if (!adjustment) return
    edit(doc => removeShapes(doc, new Set([adjustment.id]))); setAdjusting(wholeImageTarget(adjustment.id))
  }
  /** Each change is one Undo step: the first commits the adjust mark, later ones replace it. */
  function setAdjust(property: keyof AdjustParameters, value: number) {
    if (!adjusting) return
    if (adjustment) { edit(doc => replaceShape(doc, { ...adjustment, [property]: value })); return }
    const created = createAdjustShape(adjusting.id, adjusting.from, adjusting.to, { [property]: value })
    const shape = adjusting.outline ? withOutline(created, adjusting.outline) : created
    edit(doc => commitShape(doc, shape))
  }
  const propertyColor = colorShape?.color ?? color
  const customColor = propertyColor.length === 4 ? '#' + propertyColor.slice(1).split('').map(value => value + value).join('') : propertyColor
  const showColor = properties ? colorShape !== undefined : !['select', 'crop', 'wand', 'pixelate', 'cover', 'blur', 'spotlight', 'erase', 'pan'].includes(tool)
  const showWidth = properties ? widthShape !== undefined : showColor && tool !== 'text' && tool !== 'note' && tool !== 'callout'
  const showFont = properties ? fontShape !== undefined : tool === 'text'
  const displayedWidth = Number((widthShape && 'width' in widthShape ? widthShape.width * scale : width).toFixed(2))
  const displayedFont = Number((fontShape?.kind === 'text' ? fontShape.fontSize * scale : fontSize).toFixed(2))
  const widthOptions = [...new Set<number>([...SCREENSHOT_WIDTHS, displayedWidth])].sort((a, b) => a - b)
  const fontOptions = [...new Set<number>([...SCREENSHOT_FONT_SIZES, displayedFont])].sort((a, b) => a - b)
  // This is an editing control, independent of the annotation's original geometry and type size.
  const textEditorFont = Math.max(12, Math.min(32, (pendingText?.shape.fontSize ?? fontSize) * scale))
  const textEditorWidth = Math.min(280, Math.max(1, size.width)), textEditorHeight = Math.min(168, Math.max(1, size.height), textEditorFont * 1.4 * Math.max(2, textRows) + 12)
  const noteEditorHeight = Math.min(96, Math.max(1, size.height))
  // Text and note editors stay inside the viewport while their anchor keeps its image coordinates.
  const inlineEditorBox = (at: ScreenshotPoint, width: number, height: number) => ({ width, height,
    left: Math.max(0, Math.min(size.width - width, view.x + at.x * scale)), top: Math.max(0, Math.min(size.height - height, view.y + at.y * scale)) })
  // Color, size and pixelation controls; the window shows them in its property row, a capture in a popover on its toolbar.
  const propertyControls = <>
      {showColor ? <div className="image-annotation-toolbar__colors" aria-label="Markup color">{SCREENSHOT_COLORS.map(option => <button key={option} type="button" aria-label={'Color ' + option} title={capture ? undefined : option} data-capture-hint={capture ? option : undefined}
        aria-pressed={propertyColor === option} className={propertyColor === option ? 'selected' : ''} style={{ backgroundColor: option }} disabled={busy}
        onClick={() => setProperty('color', option)}>{propertyColor === option ? <CheckIcon size={10} /> : null}</button>)}</div> : null}
      {showColor ? <label className="image-annotation-editor__custom-color" title={capture ? undefined : 'Choose an opaque annotation color'} data-capture-hint={capture ? 'Choose an opaque annotation color' : undefined}><input type="color" aria-label="Custom color" value={customColor} disabled={busy} onChange={event => setProperty('color', event.target.value)} /><span>Custom</span></label> : null}
      {showWidth ? <label>Width<select aria-label="Stroke width" value={displayedWidth} disabled={busy} onChange={event => setProperty('width', Number(event.target.value))}>{widthOptions.map(option => <option key={option} value={option}>{option}px</option>)}</select></label> : null}
      {showFont ? <label>Size<select aria-label="Text size" value={displayedFont} disabled={busy} onChange={event => setProperty('fontSize', Number(event.target.value))}>{fontOptions.map(option => <option key={option} value={option}>{option}px</option>)}</select></label> : null}
      {strength ? <label>{strength.label}<input type="range" aria-label={strength.name} min={strength.range.min} max={strength.range.max} step={strength.step}
        value={strengthValue} disabled={busy} onChange={event => setStrength(Number(event.target.value))} /><output>{strength.unit(strengthValue)}</output></label> : null}
      {tool === 'wand' ? <label>Tolerance<input type="range" aria-label="Wand tolerance" min={MAGIC_WAND_TOLERANCE_RANGE.min} max={MAGIC_WAND_TOLERANCE_RANGE.max} step={1}
        value={wandTolerance} disabled={busy} onChange={event => setWandTolerance(Number(event.target.value))} /><output>{wandTolerance}</output></label> : null}
      {wand ? <div className="image-annotation-editor__mode" role="group" aria-label="Turn the region into">{regionActions.map(([kind, name]) =>
        <button key={kind} type="button" disabled={busy} onClick={() => convertWand(kind)}>{name}</button>)}</div> : null}
      {tool === 'wand' && wandIssue ? <span className="image-annotation-editor__hint" role="status">{wandIssue}</span> : null}
      {tool === 'pixelate' ? <>
        <div className="image-annotation-editor__mode" role="group" aria-label="Pixelation mode">
          <button type="button" aria-pressed={pixelateMode === 'region'} disabled={busy} onClick={() => setPixelateMode('region')}>Region</button>
          <button type="button" aria-pressed={pixelateMode === 'brush'} disabled={busy} onClick={() => setPixelateMode('brush')}>Brush</button>
        </div>
        {pixelateMode === 'brush' ? <label>Brush<select aria-label="Pixelation brush width" value={brushWidth} disabled={busy} onChange={event => setBrushWidth(Number(event.target.value))}>{[16,32,64,96].map(option => <option key={option} value={option}>{option}px</option>)}</select></label> : null}
        <label>Blocks<select aria-label="Pixel size" value={blockSize} disabled={busy} onChange={event => setBlockSize(Number(event.target.value))}>{[8,16,24,32].map(option => <option key={option} value={option}>{option}px</option>)}</select></label>
      </> : null}
  </>
  // The hovered locked mark's lock, at its bounds' top-right corner and kept inside the viewport.
  const lockedMark = lockHover ? documentState.shapes.find(shape => shape.id === lockHover && shape.locked) : undefined
  const lockBox = lockedMark ? shapeBounds(lockedMark, measureText) : null
  const lockBadge = lockedMark && lockBox ? { id: lockedMark.id, style: {
    left: Math.max(0, Math.min(size.width - 20, view.x + (lockBox.x + lockBox.width) * scale - 10)), top: Math.max(0, Math.min(size.height - 20, view.y + lockBox.y * scale - 10)) } } : null
  // Window only: align with two or more selected, distribute with three or more; a capture reaches neither by button.
  const arrangeControls = selectedShapes.length > 1 ? <div className="image-annotation-editor__arrange" role="group" aria-label="Arrange annotations">
    {ALIGNMENTS.map(({ id, label, Icon }) => <button key={id} type="button" aria-label={label} title={label} disabled={busy}
      onClick={() => editShapes(alignShapes(documentState.shapes, groupIds, id, measureText))}><Icon size={14} /></button>)}
    {selectedShapes.length > 2 ? DISTRIBUTIONS.map(({ id, label, Icon }) => <button key={id} type="button" aria-label={label} title={label} disabled={busy}
      onClick={() => editShapes(distributeShapes(documentState.shapes, groupIds, id, measureText))}><Icon size={14} /></button>) : null}
  </div> : null
  // The in-place discard confirmation; both presentations show it in place of Cancel.
  const discardControl = confirmingDiscard ? <span className="image-annotation-editor__discard" role="alert">
          <span>{(documentState.shapes.length ? 'Discard ' + documentState.shapes.length + ' annotation' + (documentState.shapes.length === 1 ? '' : 's') : 'Discard the crop') + (confirmingDiscard === 'retake' ? ' and retake?' : '?')}</span>
          <button type="button" onClick={() => setDiscarding(false)}>Keep editing</button>
          <button type="button" className="danger-button" onClick={discard}>{confirmingDiscard === 'retake' ? 'Discard & retake' : 'Discard'}</button>
        </span> : null
  const outputControls = <>
        <span className="image-annotation-toolbar__output" role="group" aria-label="Screenshot output">
          <AnnotationOriginalMenu active={active} busy={busy} loaded={loaded} onOpen={onOpenOriginal} onSave={onSaveOriginal ? () => complete('save') : undefined} />
          {onSavePng ? <button type="button" aria-label="Save PNG" title="Save the processed image as PNG" disabled={busy || !loaded} onClick={() => complete('save-png')}><SaveIcon size={13} /><span>Save PNG</span></button> : null}
          {onPin ? <button type="button" className={onCheckPin ? 'image-annotation-editor__pin--uncertain' : undefined} aria-label="Pin image" title={onCheckPin ? 'Create a separate reference. Check pin cycles through unconfirmed original operations.' : 'Keep the processed image in a floating window'} disabled={busy || !loaded} onClick={() => complete('pin')}><PinIcon size={13} /><span>{onCheckPin ? 'Pin another' : 'Pin'}</span></button> : null}
          {onCheckPin ? <button type="button" title="Cycle through unconfirmed original operations without creating another pin" disabled={busy} onClick={onCheckPin}>Check pin</button> : null}
          {onCopyContext ? <button type="button" aria-label="Copy context" title="Copy the processed image context" disabled={busy || !loaded} onClick={() => complete('context')}><ClipboardIcon size={13} /><span>Copy context</span></button> : null}
        </span>
        <button className="primary-button" type="button" disabled={busy || !loaded} onClick={() => complete()}><ClipboardIcon size={13} />{busy ? busyLabel : label}</button>
  </>
  const toolbar = <AnnotationToolbar active={active} tool={tool} busy={busy} undoable={canUndo(documentState)} redoable={canRedo(documentState)} selected={groupIds.size > 0}
    clearable={!!documentState.shapes.length || !!documentState.crop} onTool={next => { resetGesture(); setTool(next); schedulePaint() }}
    onUndo={undo} onRedo={redo} onDelete={removeSelected} onClear={() => { resetGesture(); textDraftRef.current = null; setPendingText(null); selectOnly(null); edit(clearShapes); schedulePaint() }} />
  const canvasViewport = <>
        <div className="image-annotation-editor__viewport" style={{ width: size.width, height: size.height }}>
          <img ref={imageRef} src={image.dataUrl} alt="Captured image" draggable={false} onLoad={event => { if ((event.currentTarget.currentSrc || event.currentTarget.src) === image.dataUrl) { setLoadedSource(image.dataUrl); setFailedSource(null) } }}
            onError={() => { setLoadedSource(null); setFailedSource(image.dataUrl); onError?.(new Error('The image could not be decoded. Current annotations are kept.')) }} />
          <canvas ref={canvasRef} tabIndex={0} aria-label="Screenshot canvas" style={{ cursor: capture ? locked ? 'default' : cursor : tool === 'pan' || panHeld ? 'grab' : tool === 'select' ? groupIds.size ? 'move' : 'default' : 'crosshair' }}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={cancelGesture}
            onPointerLeave={event => { if (capture) { setHover(null); lightWindow(null) } if (event.relatedTarget !== lockBadgeRef.current) setLockHover(null) }} onContextMenu={onContextMenu}
            onLostPointerCapture={() => { if (gestureActive() || panRef.current) cancelGesture() }}
            onDoubleClick={event => {
              if (busy) return
              const at = point(event), shape = hit(at), crop = documentState.crop
              if (shape?.kind === 'text') beginText(shape)
              // A double-click inside a capture selection while adjusting it is the primary delivery.
              else if (capture && !shape && tool === 'select' && crop && rectContains(crop, at)) complete()
            }} />
          {lockBadge ? <button ref={lockBadgeRef} type="button" className="image-annotation-editor__lock" aria-label="Unlock annotation" title={capture ? undefined : 'Locked · Click to unlock'} data-capture-hint={capture ? 'Locked · Click to unlock' : undefined}
            style={lockBadge.style} disabled={busy} onPointerLeave={event => { if (event.relatedTarget !== canvasRef.current) setLockHover(null) }}
            onClick={() => { unlockShapes(new Set([lockBadge.id])); setLockHover(null) }}><LockIcon size={11} /></button> : null}
          {pendingText ? <Textarea key={pendingText.shape.id} ref={textInputRef} className="image-annotation-editor__text" aria-label="Screenshot text" defaultValue={pendingText.shape.text} wrap="off"
            aria-description="Enter inserts a new line. Command or Control plus Enter finishes. Escape discards this text edit."
            style={{ ...inlineEditorBox(pendingText.shape.at, textEditorWidth, textEditorHeight), maxHeight: Math.max(1, size.height), minWidth: 0, minHeight: 0, maxWidth: 'none',
              color: 'var(--text)', fontSize: textEditorFont, lineHeight: 1.4, fontFamily: SCREENSHOT_TEXT_FONT }}
            onPointerDown={event => event.stopPropagation()} onChange={event => { if (textDraftRef.current) textDraftRef.current = { ...textDraftRef.current, edited: true }; setTextRows(Math.max(2, screenshotTextLines(event.target.value).length)); onEdited?.() }} onBlur={event => finishText(event.currentTarget.value)} onKeyDown={event => inlineEditorKey(event, finishText, () => finishText('', true))} /> : null}
          {selectedNote && noteEditor === selectedNote.id ? <Textarea autoFocus className="image-annotation-editor__text" aria-label="Marker note" value={noteDraft} placeholder={'Note ' + selectedNote.number}
            aria-description="Enter inserts a new line. Command or Control plus Enter finishes. Escape discards this note edit."
            style={{ ...inlineEditorBox({ x: selectedNote.from.x + selectedNote.radius, y: selectedNote.from.y - selectedNote.radius }, textEditorWidth, noteEditorHeight),
              minWidth: 0, minHeight: 0, maxWidth: 'none', color: 'var(--text)', lineHeight: 1.4 }}
            onPointerDown={event => event.stopPropagation()} onChange={event => { setNoteDraft(event.target.value); onEdited?.() }} onBlur={() => closeNoteEditor(true)} onKeyDown={event => inlineEditorKey(event, () => closeNoteEditor(true), () => closeNoteEditor(false))} /> : null}
          {imageError ? <p className="image-annotation-editor__image-error" role="alert">The image could not be loaded. Current annotations are kept.{onOpenOriginal ? ' Open another original or Cancel to return.' : ' Cancel to return.'}</p> : null}
        </div>
  </>
  if (capture) {
    // Frame CSS pixels: the selection, its toolbar, size chip and loupe all sit on the one frozen display frame.
    const frame = { width: size.width, height: size.height, top: safeTop }
    const shown = selection && { x: selection.x * scale, y: selection.y * scale, width: selection.width * scale, height: selection.height * scale }
    // The bar shows only at rest, but its side is known during a gesture too, so the size chip never swaps sides on release.
    const placement = shown ? captureToolbarPlacement(shown, measured.bar, frame) : null
    const bar = barShown ? placement : null
    const chip = shown && placement ? captureSizeChipPlacement(shown, measured.chip, placement.side, frame) : null
    const loupeBox = loupe ? captureLoupePlacement(loupe.at, shown, frame) : null
    const hasProperties = showColor || showWidth || showFont || tool === 'pixelate' || tool === 'wand' || strength !== null
    // Before a selection one line names the gestures and keys; afterwards the toolbar's tooltips carry them.
    const hint = locked ? 'Selecting on another display · Esc to cancel'
      : !documentState.crop && gesture === null ? `${windows.length ? 'Click a window or drag' : 'Drag'} to select · Arrows nudge · Enter to finish${backgroundHint ? ' · ' + backgroundHint : ''} · Esc to cancel` : null
    return <div ref={editorRef} className="image-annotation-editor image-annotation-editor--capture" role="dialog" aria-label={title === 'Screenshot' ? 'Screenshot editor' : title}
      style={{ ...(active ? {} : { display: 'none' }), ...(safeTop ? { '--capture-safe-top': safeTop + 'px' } : {}) } as CSSProperties}>
      <div ref={containerRef} className="image-annotation-editor__canvas-area">{canvasViewport}</div>
      {chip ? <span ref={chipRef} className="image-annotation-editor__size-chip" aria-label="Selection size" style={chip}>{sizeText}</span> : null}
      {bar ? <div ref={barRef} className="image-annotation-editor__capture-bar" data-side={bar.side} style={{ left: bar.left, top: bar.top }}>
        <CaptureToolbar tool={tool} busy={busy} loaded={loaded} label={busy ? busyLabel : label} discard={discardControl}
          onTool={next => { resetGesture(); setTool(next); schedulePaint() }} onPin={() => complete('pin')} onSavePng={() => complete('save-png')}
          onExpand={expand} onCancel={requestClose} onComplete={() => complete()} />
        {hasProperties ? <div className="image-annotation-editor__capture-properties" role="group" aria-label="Markup properties" data-side={bar.side === 'below' ? 'below' : 'above'}>{propertyControls}</div> : null}
      </div> : null}
      {captureControls}
      <CaptureTooltip />
      {hint ? <CaptureHint text={hint} onCancel={requestClose} /> : null}
      {loupe && loupeBox ? <div className="image-annotation-editor__loupe" aria-label="Pixel loupe" style={loupeBox}>
        <canvas ref={loupeRef} width={LOUPE_GRID} height={LOUPE_GRID} aria-hidden="true" />
        <span>{loupe.sample.hex}<span>{loupe.sample.rgb.join(',')}</span></span>
        <span>{Math.round(origin.x + loupe.at.x) + ', ' + Math.round(origin.y + loupe.at.y)}<small>pt</small></span>
        <span>{loupe.sample.x + ', ' + loupe.sample.y}<small>px</small></span>
      </div> : null}
      {copied || documentStatus ? <span className={'image-annotation-editor__status' + (copied ? ' image-annotation-editor__status--success' : '')} role="status">{copied ?? documentStatus}</span> : null}
    </div>
  }
  return <div ref={editorRef} className="image-annotation-editor" role="dialog" aria-label={title === 'Screenshot' ? 'Screenshot editor' : title} style={active ? undefined : { display: 'none' }}>
    <header className="image-annotation-editor__header">
      <span className="image-annotation-editor__title"><strong>{title}</strong><small>{image.width} × {image.height}</small>
        <span className={'image-annotation-editor__status' + (copied ? ' image-annotation-editor__status--success' : '')} role="status" title={copied ?? documentStatus ?? undefined}>{copied ? <><CheckIcon size={13} />{copied}</> : documentStatus}</span>
      </span>
      <div className="image-annotation-toolbar__actions">
        {discardControl ?? <button type="button" className="image-annotation-editor__cancel" onClick={requestClose}><CancelIcon size={13} /> Cancel</button>}
        {onRetake && !discardControl ? <button type="button" aria-label="Retake" title="Capture a new region for the same destination (⇧⌘R)" aria-keyshortcuts="Shift+Meta+R"
          disabled={busy} onClick={requestRetake}><RetakeIcon size={13} /><span>Retake</span></button> : null}
        {outputControls}
      </div>
    </header>
    {toolbar}
    {textTools ? <ImageTextTools port={textTools} loaded={loaded} busy={busy} revision={documentState} image={async () => {
      const base = imageRef.current
      if (!base || !loaded) throw new Error('The current image is not loaded.')
      return { image: await composeScreenshot({ image: base, shapes: currentShapes(), crop: documentState.crop, displayWidth: image.width, displayHeight: image.height, outputScale: 1, document: base.ownerDocument }), origin: documentState.crop ?? { x: 0, y: 0 } }
    }} apply={rects => { edit(doc => setShapes(doc, [...doc.shapes, ...rects.map(rect => ({ id: mintObjectId(), kind: 'cover' as const, color: '#000000', from: { x: rect.x, y: rect.y }, to: { x: rect.x + rect.width, y: rect.y + rect.height } }))])); schedulePaint() }} /> : null}
    <div className="image-annotation-editor__properties">
      <span className="image-annotation-editor__tool-name">{ANNOTATION_TOOLS.find(item => item.id === tool)?.label}</span>
      {propertyControls}
      {arrangeControls}
      {hasLocked ? <button type="button" disabled={busy} onClick={() => unlockShapes(new Set(documentState.shapes.filter(shape => shape.locked).map(shape => shape.id)))}><UnlockIcon size={13} />Unlock all</button> : null}
      <button type="button" className="image-annotation-editor__adjust" aria-pressed={adjusting !== null} disabled={busy || !loaded} onClick={toggleAdjust}
        title={wand ? 'Adjust the selected region' : 'Adjust the whole image'}><AdjustIcon size={13} /><span>Adjust</span></button>
      {adjusting ? <div className="image-annotation-editor__adjustments" role="group" aria-label={adjusting.outline ? 'Region adjustments' : 'Image adjustments'}>
        {regionAdjusts.length ? <div className="image-annotation-editor__mode" role="group" aria-label="Adjustment">
          <button type="button" aria-pressed={!adjusting.outline} disabled={busy} onClick={() => setAdjusting(wholeImageTarget())}>Whole image</button>
          {regionAdjusts.map((shape, index) => <button key={shape.id} type="button" aria-pressed={shape.id === adjusting.id} disabled={busy}
            onClick={() => setAdjusting(adjustTarget(shape))}>{'Region ' + (index + 1)}</button>)}
        </div> : null}
        {ADJUST_CONTROLS.map(control => { const value = (adjustment ?? NEUTRAL_ADJUSTMENT)[control.property]
          return <label key={control.property}>{control.label}<input type="range" aria-label={control.label} min={control.range.min} max={control.range.max} step={0.05}
            value={value} disabled={busy} onChange={event => setAdjust(control.property, Number(event.target.value))} /><output>{control.unit(value)}</output></label> })}
        {adjustment ? <button type="button" disabled={busy} onClick={removeAdjust}>Remove</button> : null}
      </div> : null}
      {tool === 'wand' && !wand ? <span className="image-annotation-editor__hint">Click a color region · Shift-click to add</span> : null}
      {tool === 'cover' || selected?.kind === 'cover' ? <span className="image-annotation-editor__hint">Opaque cover · Original stays editable</span> : null}
      {tool === 'crop' ? <><span className="image-annotation-editor__hint">Drag to keep an area</span>{documentState.crop ? <button type="button" disabled={busy} onClick={() => edit(doc => setCrop(doc, null))}>Reset crop</button> : null}</> : null}
      {tool === 'select' ? <span className="image-annotation-editor__hint">{selected ? (selectionHandles(selected).length ? 'Drag handles to resize · Arrow keys to nudge' : 'Drag to move · Arrow keys to nudge') : selectedShapes.length > 1 ? selectedShapes.length + ' selected · Drag one to move all' : 'Click an annotation · Drag to select several'}</span> : null}
      {selected?.kind === 'text' ? <button type="button" disabled={busy} onClick={() => beginText(selected)}>Edit text</button> : null}
      {tool === 'erase' ? <span className="image-annotation-editor__hint">Drag over annotations to remove them</span> : null}
      {tool === 'note' ? <span className="image-annotation-editor__hint">Click a point or drag a region</span> : null}
      {tool === 'pan' ? <span className="image-annotation-editor__hint">Drag to move the image · Fit to reset</span> : null}
      {['rect', 'ellipse', 'arrow'].includes(tool) ? <span className="image-annotation-editor__hint">Hold Shift to constrain</span> : null}
      {tool === 'text' || pendingText ? <span className="image-annotation-editor__hint">Enter for a new line · ⌘ / Ctrl + Enter to finish</span> : null}
    </div>
    <div className="image-annotation-editor__workarea">
      <div ref={containerRef} className="image-annotation-editor__canvas-area">
        {canvasViewport}
      </div>
      <AnnotationNotes notes={notes} selected={selectedNote} draft={noteDraft} busy={busy}
        onSelect={note => { commitNote(); selectOnly(note.id) }} onDraft={value => { setNoteDraft(value); onEdited?.() }}
        onCommit={commitNote} onTemplate={setTemplate} onLocate={locateNote}
        onRenumber={() => { commitNote(); edit(doc => setShapes(doc, renumberNotes(doc.shapes))) }} />
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
