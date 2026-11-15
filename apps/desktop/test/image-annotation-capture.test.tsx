// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SEMANTIC_ICON_CATALOG, type SemanticIconName } from '@agentmux/client-ui/icons'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ImageAnnotationEditor } from '../src/renderer/src/components/image-annotation/ImageAnnotationEditor'
import { CaptureSurfaceView } from '../src/renderer/screenshot-editor/CaptureSurfaceView'
import type { CaptureSurfaceApi, CaptureSurfaceInput, CaptureSurfaceRect } from '../src/shared/capture-surface'
import { captureLoupePlacement, captureSizeChipPlacement, captureToolbarPlacement } from '../src/renderer/src/components/image-annotation/capture-geometry'
import type { ImageViewport } from '@agentmux/client-ui/image-annotation'

const raster = vi.hoisted(() => ({ committed: vi.fn(), scene: vi.fn() }))
// Component state, view, gestures and callbacks are production code; only raster drawing is replaced.
vi.mock('@agentmux/client-ui/image-annotation', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/client-ui/image-annotation')>(), renderCommittedLayer: raster.committed, renderScreenshotScene: raster.scene }))

// One 800 × 500 point display frozen at 2x: 1600 × 1000 image pixels.
const image = { dataUrl: 'data:image/png;base64,AA==', width: 1600, height: 1000 }
const FRAME = { width: 800, height: 500, top: 0 }, BAR_WIDTH = 300, CHIP_WIDTH = 80
// The overlay's laid-out size; normally the display, but layout rounding must not change the pixel scale.
let layout = FRAME
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement
let frames: Map<number, FrameRequestCallback>, nextFrame: number
// Every fill the editor paints on its own canvas, with the fill style it used.
let fills: Array<{ style: string; rect: number[] }>, sampled: number[], reads = 0, measures = 0
// Every outline the editor strokes on its own canvas, with its stroke style and alpha.
let strokes: Array<{ style: string; alpha: number; rect: number[] }>, reducedMotion = false
class RecordingContext {
  fillStyle = ''; strokeStyle = ''; lineWidth = 1; font = ''; imageSmoothingEnabled = true; globalAlpha = 1
  fillRect(...rect: number[]) { fills.push({ style: String(this.fillStyle), rect }) }
  strokeRect(...rect: number[]) { strokes.push({ style: String(this.strokeStyle), alpha: this.globalAlpha, rect }) }
  getImageData() { reads++; return { data: Uint8ClampedArray.from([...sampled, 255]) } }
  measureText(text: string) { return { width: text.length * 7 } }
  save() {} restore() {} setLineDash() {} beginPath() {} arc() {} fill() {} stroke() {} drawImage() {} clearRect() {} moveTo() {} lineTo() {}
}
function box(width: number, height: number): DOMRect { return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} } }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  frames = new Map(); nextFrame = 0; fills = []; strokes = []; sampled = [18, 52, 86]; reads = 0; measures = 0; layout = FRAME; reducedMotion = false
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' && reducedMotion, media: query }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  // The overlay fills one display; the toolbar and size chip report their laid-out widths.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('image-annotation-editor__capture-bar')) { measures++; return box(BAR_WIDTH, 36) }
    if (this.classList.contains('image-annotation-editor__size-chip')) { measures++; return box(CHIP_WIDTH, 20) }
    return box(layout.width, layout.height)
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new RecordingContext() as unknown as CanvasRenderingContext2D)
  vi.clearAllMocks()
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function overlayInput(safeTop: number, windows: CaptureSurfaceRect[]): CaptureSurfaceInput {
  return { requestId: 'request', revision: 1, displayId: 1, frame: { x: 0, y: 0, width: FRAME.width, height: FRAME.height }, scale: 2, safeTop,
    attachToDraft: false, expandable: true, theme: { status: 'unavailable', message: '' },
    background: 'included', backgrounds: {
      included: { status: 'ready', capturedAt: 1, engine: 'fixture', image: { mimeType: 'image/png', byteLength: 1, ...image }, windows },
      excluded: { status: 'pending', capturedAt: 0 }
    } }
}
// Each flushed frame is one 16 ms display frame later than the last.
let clock = 0
async function frame() { await act(async () => { const pending = [...frames.values()]; frames.clear(); clock += 16; pending.forEach(callback => callback(clock)) }) }
function button(scope: ParentNode, name: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === name)
  expect(found, 'real ' + name + ' control').toBeDefined(); return found!
}
async function mount(origin?: { x: number; y: number }, windows?: Array<{ x: number; y: number; width: number; height: number }>, initialCrop?: { x: number; y: number; width: number; height: number }, safeTop?: number) {
  const props = { image, busy: false, presentation: 'capture' as const, pixelRatio: 2, ...(origin ? { origin } : {}), ...(windows ? { windows } : {}), ...(safeTop ? { safeTop } : {}),
    ...(initialCrop ? { initialState: { shapes: [], crop: initialCrop } } : {}),
    onCancel: vi.fn(), onComplete: vi.fn(), onSavePng: vi.fn(), onPin: vi.fn(), onExpand: vi.fn(), onCopyColor: vi.fn(), onSelect: vi.fn() }
  const instance = Math.random()
  // The host's lock for this display arrives later than the editor mounts, as another display's claim does.
  const lock = async (locked: boolean) => { await act(async () => root.render(<ImageAnnotationEditor key={instance} {...props} locked={locked} />)); await frame() }
  await act(async () => root.render(<ImageAnnotationEditor key={instance} {...props} />)); await frame()
  const editor = node.querySelector<HTMLElement>('[aria-label="Screenshot editor"]')!, canvas = editor.querySelector('canvas')!
  canvas.setPointerCapture = vi.fn()
  await act(async () => editor.querySelector('img')!.dispatchEvent(new Event('load'))); await frame()
  // Pointer coordinates are frame points; the display's top-left is 0, 0.
  const send = (type: string, [x, y]: [number, number], buttons = 1, metaKey = false) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons, clientX: x, clientY: y, metaKey }))
  const press = async (at: [number, number]) => { await act(async () => { send('pointerdown', at) }) }
  const move = async (to: [number, number], buttons = 1, metaKey = false) => { await act(async () => { send('pointermove', to, buttons, metaKey) }); await frame() }
  const release = async (at: [number, number], metaKey = false) => { await act(async () => { send('pointerup', at, 0, metaKey) }); await frame() }
  const drag = async (from: [number, number], to: [number, number]) => { await press(from); await move(to); await release(to) }
  const key = async (key: string, init: KeyboardEventInit = {}) => {
    await act(async () => { canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) }); await frame()
  }
  const mouse = async (type: 'dblclick' | 'contextmenu', [x, y]: [number, number]) => {
    await act(async () => { canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: type === 'contextmenu' ? 2 : 0, clientX: x, clientY: y })) }); await frame()
  }
  const bar = () => editor.querySelector<HTMLElement>('.image-annotation-editor__capture-bar')
  const loupe = () => editor.querySelector<HTMLElement>('[aria-label="Pixel loupe"]')
  const hint = () => editor.querySelector<HTMLElement>('.image-annotation-editor__capture-hint')
  const lost = async () => { await act(async () => { canvas.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1 })) }); await frame() }
  return { editor, canvas, props, press, move, release, drag, key, mouse, bar, loupe, hint, lock, lost }
}
// The selection every case starts from: frame points 300, 100 to 500, 200.
const SELECTED = { x: 600, y: 200, width: 400, height: 200 }
async function selected(origin?: { x: number; y: number }) {
  const mounted = await mount(origin)
  await mounted.drag([300, 100], [500, 200])
  return mounted
}
function view(): ImageViewport { expect(raster.committed).toHaveBeenCalled(); return raster.committed.mock.lastCall![2] }
const DIM = 'rgba(0, 0, 0, .28)'

describe('capture image annotation', () => {
  it('shows the whole frozen display at a fixed one-to-one pixel scale without zoom, pan or window chrome', async () => {
    // A larger laid-out area would fit the image at 0.625; the capture view stays at one image pixel per screen pixel.
    layout = { width: 1000, height: 700 }
    const { editor, canvas, key } = await mount()
    expect(view().view, 'actual capture view keeps one image pixel per screen pixel').toEqual({ scale: .5, x: 0, y: 0 })
    const area = editor.querySelector<HTMLElement>('.image-annotation-editor__canvas-area')!
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -200, clientX: 50, clientY: 50 })
    await act(async () => area.dispatchEvent(wheel)); await frame()
    await key('+')
    expect(view().view, 'wheel and zoom keys leave the capture view fixed').toEqual({ scale: .5, x: 0, y: 0 })
    expect(wheel.defaultPrevented, 'the host keeps the wheel').toBe(false)
    for (const chrome of ['header', 'footer', '.image-annotation-editor__properties', '.image-annotation-editor__notes', '[aria-label="Screenshot markup tools"]'])
      expect(editor.querySelector(chrome), 'capture presentation omits the window ' + chrome).toBeNull()
    expect(canvas.style.cursor, 'before a selection a press starts one').toBe('crosshair')
  })

  it('drags a selection that becomes the crop and dims the frozen frame outside it', async () => {
    const { editor, press, move, release, props } = await mount()
    expect(fills.filter(fill => fill.style === DIM).map(fill => fill.rect), 'before a selection the whole frame is dimmed').toContainEqual([0, 0, 1600, 1000])
    await press([300, 100]); await move([500, 200])
    expect(editor.querySelector('[aria-label="Selection size"]')!.textContent, 'the size chip shows image pixels while dragging').toBe('400 × 200 px')
    fills = []; await release([500, 200])
    const dimmed = fills.filter(fill => fill.style === DIM).map(fill => fill.rect)
    expect(dimmed, 'actual dim covers exactly the four bands outside the selection').toEqual([[0, 0, 1600, 200], [0, 400, 1600, 600], [0, 200, 600, 200], [1000, 200, 600, 200]])
    const chip = editor.querySelector<HTMLElement>('[aria-label="Selection size"]')!
    expect([chip.style.left, chip.style.top], 'the size chip sits above the selection top-left').toEqual(['300px', '76px'])
    await act(async () => button(editor, 'Done').click())
    expect(props.onComplete.mock.lastCall![0], 'actual Done delivers the selection as the crop').toMatchObject({ crop: SELECTED, displayWidth: 1600, displayHeight: 1000, shapes: [] })
  })

  it('delivers only a selection: Enter and Command C do nothing before one exists', async () => {
    const { key, drag, props } = await mount()
    await key('Enter'); await key('c', { metaKey: true }); await key('s', { metaKey: true }); await key('p', { metaKey: true })
    expect(props.onComplete, 'no selection means no delivery').not.toHaveBeenCalled()
    expect(props.onSavePng).not.toHaveBeenCalled(); expect(props.onPin).not.toHaveBeenCalled()
    await drag([300, 100], [500, 200])
    await key('Enter')
    expect(props.onComplete.mock.lastCall![0], 'Enter delivers the selection').toMatchObject({ crop: SELECTED })
    await key('c', { metaKey: true })
    expect(props.onComplete, 'Command C is the same primary delivery').toHaveBeenCalledTimes(2)
  })

  it('moves, resizes, nudges and clamps the selection within the frame', async () => {
    const { drag, key, props } = await selected()
    const crop = async () => { await key('Enter'); return props.onComplete.mock.lastCall![0].crop }
    await drag([400, 150], [420, 160])
    expect(await crop(), 'a drag inside moves the selection').toEqual({ ...SELECTED, x: 640, y: 220 })
    await drag([520, 160], [570, 160])
    expect(await crop(), 'a drag on the right edge resizes it').toEqual({ x: 640, y: 220, width: 500, height: 200 })
    await key('ArrowLeft')
    expect(await crop(), 'an arrow nudges by one frame point').toEqual({ x: 638, y: 220, width: 500, height: 200 })
    await key('ArrowDown', { shiftKey: true })
    expect(await crop(), 'Shift nudges by ten frame points').toEqual({ x: 638, y: 240, width: 500, height: 200 })
    await drag([500, 200], [2000, 2000])
    expect(await crop(), 'a move stops at the frame edge').toEqual({ x: 1100, y: 800, width: 500, height: 200 })
  })

  it('hides the toolbar while the selection is dragged and shows it at rest', async () => {
    const { bar, press, move, release, editor } = await selected()
    expect(bar(), 'the toolbar shows at rest').not.toBeNull()
    expect(editor.querySelector('[aria-label="Done"]')!.className, 'Done is the solid primary action').toContain('primary-button')
    await press([400, 150]); await move([420, 160])
    expect(bar(), 'actual toolbar is hidden while the selection moves').toBeNull()
    await release([420, 160])
    expect(bar(), 'the toolbar returns when the gesture ends').not.toBeNull()
  })

  it('places the toolbar below the selection, else above, else inside, clamped to the frame', async () => {
    expect(captureToolbarPlacement({ x: 300, y: 100, width: 200, height: 100 }, BAR_WIDTH, FRAME), 'room below keeps the bar 8 below, right-aligned')
      .toEqual({ side: 'below', left: 200, top: 208 })
    expect(captureToolbarPlacement({ x: 300, y: 420, width: 200, height: 60 }, BAR_WIDTH, FRAME), 'no room below flips the bar 8 above')
      .toEqual({ side: 'above', left: 200, top: 376 })
    expect(captureToolbarPlacement({ x: 0, y: 10, width: 800, height: 480 }, BAR_WIDTH, FRAME), 'no room on either side moves the bar inside the bottom-right corner')
      .toEqual({ side: 'inside', left: 488, top: 442 })
    expect(captureToolbarPlacement({ x: 0, y: 100, width: 100, height: 100 }, BAR_WIDTH, FRAME).left, 'the bar stays 12 inside the frame').toBe(12)
    const { bar } = await selected()
    expect([bar()!.dataset.side, bar()!.style.left, bar()!.style.top], 'actual bar sits 8 below the selection, right-aligned').toEqual(['below', '200px', '208px'])
  })

  it('a mark button only changes the current tool, and pressing it again returns to the selection tool', async () => {
    const { bar, drag, key, props } = await selected()
    await act(async () => button(bar()!, 'Rectangle').click()); await frame()
    expect(props.onExpand, 'actual mark button opens no other editor').not.toHaveBeenCalled()
    expect(button(bar()!, 'Rectangle').getAttribute('aria-pressed'), 'the current mark shows pressed').toBe('true')
    expect(bar()!.querySelector('[aria-label="Markup properties"]'), 'a mark tool opens its property popover').not.toBeNull()
    await drag([320, 120], [360, 160])
    await key('Enter')
    expect(props.onComplete.mock.lastCall![0], 'the mark lands inside the selection').toMatchObject({ crop: SELECTED,
      shapes: [expect.objectContaining({ kind: 'rect', from: { x: 640, y: 240 }, to: { x: 720, y: 320 } })] })
    await act(async () => button(bar()!, 'Rectangle').click()); await frame()
    expect(button(bar()!, 'Rectangle').getAttribute('aria-pressed'), 'pressing the current mark again leaves it').toBe('false')
    await key('e')
    expect(button(bar()!, 'Ellipse').getAttribute('aria-pressed'), 'a plain letter selects its mark').toBe('true')
  })

  it('draws every capture control with its own glyph, and Expand editor with the expand glyph rather than an external link', async () => {
    const { bar } = await selected()
    const meaning = (name: string) => button(bar()!, name).querySelector('[data-semantic-icon]')!.getAttribute('data-semantic-icon') as SemanticIconName
    expect(meaning('Expand editor'), 'expanding stays in the editor; it opens nothing outside').toBe('layout.expand')
    const glyphs = [...bar()!.querySelectorAll('button [data-semantic-icon]')].map(icon => SEMANTIC_ICON_CATALOG[icon.getAttribute('data-semantic-icon') as SemanticIconName].glyph)
    expect(glyphs.length, 'the toolbar draws its icons').toBeGreaterThan(5)
    expect(glyphs.filter((glyph, index) => glyphs.indexOf(glyph) !== index), 'no two capture controls share one glyph').toEqual([])
    expect(SEMANTIC_ICON_CATALOG[meaning('Magnifier')].glyph, 'the magnifier is not the window editor zoom').not.toBe(SEMANTIC_ICON_CATALOG['action.zoom-in'].glyph)
  })

  it('double-click inside the selection with the selection tool is the primary delivery', async () => {
    const { mouse, props } = await selected()
    await mouse('dblclick', [100, 50])
    expect(props.onComplete, 'a double-click outside delivers nothing').not.toHaveBeenCalled()
    await mouse('dblclick', [400, 150])
    expect(props.onComplete, 'actual double-click inside delivers the selection').toHaveBeenCalledWith(expect.objectContaining({ crop: SELECTED }))
  })

  it('Command S, Command P and Command E act directly on the processed selection', async () => {
    const { key, drag, bar, props } = await selected()
    await key('r'); await drag([320, 120], [360, 160])
    await key('s', { metaKey: true })
    expect(props.onSavePng.mock.lastCall![0], 'Command S saves the selection').toMatchObject({ crop: SELECTED, shapes: [expect.objectContaining({ kind: 'rect' })] })
    await key('p', { metaKey: true })
    expect(props.onPin.mock.lastCall![0], 'Command P pins the selection').toMatchObject({ crop: SELECTED })
    await key('e', { metaKey: true })
    expect(props.onExpand.mock.lastCall![0], 'actual Command E hands marks, selection and tool to the window editor')
      .toEqual({ crop: SELECTED, tool: 'rect', shapes: [expect.objectContaining({ kind: 'rect', from: { x: 640, y: 240 }, to: { x: 720, y: 320 } })] })
    await act(async () => button(bar()!, 'Pin image').click()); await act(async () => button(bar()!, 'Save PNG').click())
    expect([props.onPin.mock.calls.length, props.onSavePng.mock.calls.length], 'the output buttons act directly').toEqual([2, 2])
  })

  it('Escape peels the gesture, the selected mark and the tool before confirming the discard and cancelling', async () => {
    const { key, drag, press, move, release, bar, editor, props } = await selected()
    await key('r'); await drag([320, 120], [360, 160])
    // Pressing the new rectangle's left edge moves it.
    await press([320, 140]); await move([340, 150])
    expect(bar(), 'the toolbar hides while the mark moves').toBeNull()
    await key('Escape')
    expect(bar(), 'the first Escape ends the gesture').not.toBeNull()
    await release([340, 150])
    await key('Escape')
    expect(button(bar()!, 'Rectangle').getAttribute('aria-pressed'), 'the second Escape deselects the mark and keeps the tool').toBe('true')
    await key('Escape')
    expect(button(bar()!, 'Rectangle').getAttribute('aria-pressed'), 'the third Escape returns to the selection tool').toBe('false')
    await key('Escape')
    expect(editor.querySelector('[role="alert"]')?.textContent, 'unkept marks ask before discarding').toContain('Discard 1 annotation?')
    expect(props.onCancel).not.toHaveBeenCalled()
    await key('Escape')
    expect(props.onCancel, 'the confirmed Escape cancels').toHaveBeenCalledOnce()
  })

  it('right-click outside the selection clears it without marks, keeps it with marks, and cancels without a selection', async () => {
    const { mouse, drag, key, bar, props } = await selected()
    await mouse('contextmenu', [400, 150])
    expect(bar(), 'a right-click inside keeps the selection').not.toBeNull()
    await mouse('contextmenu', [100, 50])
    expect(bar(), 'a right-click outside clears a selection without marks').toBeNull()
    expect(props.onCancel).not.toHaveBeenCalled()
    await drag([300, 100], [500, 200]); await key('r'); await drag([320, 120], [360, 160])
    await mouse('contextmenu', [100, 50])
    expect(bar(), 'actual right-click outside keeps a selection that has marks').not.toBeNull()
    await drag([100, 50], [150, 80])
    await key('Enter')
    expect(props.onComplete.mock.lastCall![0].crop, 'with marks, a drag outside starts no new selection').toEqual(SELECTED)
    const empty = await mount()
    await empty.mouse('contextmenu', [100, 50])
    expect(empty.props.onCancel, 'a right-click with no selection cancels').toHaveBeenCalledOnce()
  })

  it('shows the loupe before a selection and while adjusting it, hides it at rest, and copies the sampled color on C', async () => {
    const { loupe, move, press, release, key, props } = await mount({ x: -1440, y: 25 })
    await move([100, 100], 0)
    const rows = [...loupe()!.querySelectorAll(':scope > span')].map(row => [...row.childNodes].map(part => part.textContent))
    expect(rows, 'the loupe reads the frozen pixel and names each coordinate unit on its own row').toEqual([['#123456', '18,52,86'], ['-1340, 125', 'pt'], ['200, 200', 'px']])
    expect([loupe()!.style.left, loupe()!.style.top], 'the loupe sits beside the pointer').toEqual(['116px', '116px'])
    await key('c')
    expect(props.onCopyColor, 'actual C copies the sampled HEX').toHaveBeenCalledWith('#123456')
    await press([300, 100]); await move([500, 200])
    expect(loupe(), 'the loupe follows the selection drag').not.toBeNull()
    await release([500, 200]); const before = reads; await move([600, 300], 0); await move([620, 320], 0)
    expect(loupe(), 'the loupe is hidden at rest').toBeNull()
    expect(reads, 'pointer moves at rest read no frozen pixels').toBe(before)
    await key('c')
    expect(props.onCopyColor, 'C copies nothing while the loupe is hidden').toHaveBeenCalledOnce()
    await key('r'); await press([320, 120]); await move([360, 160])
    expect(loupe(), 'the loupe is hidden while drawing').toBeNull()
  })

  it('shows a one-line hint with Cancel before a selection and hides it once one exists', async () => {
    const { hint, drag, props } = await mount()
    expect(hint()?.textContent, 'before a selection a hint names the gestures and keys').toBe('Drag to select · Arrows nudge · Enter to finish · Esc to cancel')
    await act(async () => button(hint()!, 'Cancel').click())
    expect(props.onCancel, 'the hint carries a visible Cancel').toHaveBeenCalledOnce()
    await drag([300, 100], [500, 200])
    expect(hint(), 'the hint goes once a selection exists').toBeNull()
  })

  it('claims the selection once a drag makes one, and not for a click, move or resize', async () => {
    const { press, release, drag, mouse, props } = await mount()
    await press([300, 100]); await release([300, 100])
    expect(props.onSelect, 'a click makes no selection and claims nothing').not.toHaveBeenCalled()
    await drag([300, 100], [500, 200])
    expect(props.onSelect, 'a drag claims the selection').toHaveBeenCalledOnce()
    await drag([400, 150], [420, 160]); await drag([520, 160], [570, 160])
    expect(props.onSelect, 'moving or resizing claims nothing more').toHaveBeenCalledOnce()
    await mouse('contextmenu', [100, 50]); await drag([100, 50], [200, 150])
    expect(props.onSelect, 'a new selection after clearing claims again').toHaveBeenCalledTimes(2)
  })

  it('opens on a remembered selection at rest, claims it only once acted on, and delivers it only on Enter', async () => {
    const { editor, bar, hint, loupe, move, key, drag, props } = await mount(undefined, undefined, SELECTED)
    expect(bar(), 'the toolbar shows at rest on the remembered selection').not.toBeNull()
    expect(editor.querySelector('[aria-label="Selection size"]')?.textContent, 'the size chip names it').toContain('400 × 200')
    expect([hint(), loupe()], 'no hint and no loupe on a kept selection').toEqual([null, null])
    await move([100, 100], 0); await frame()
    expect([props.onComplete.mock.calls.length, props.onSelect.mock.calls.length, props.onCancel.mock.calls.length], 'opening on it delivers, claims and cancels nothing').toEqual([0, 0, 0])
    await key('Enter')
    expect(props.onComplete, 'actual Enter delivers the remembered selection').toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ crop: SELECTED, shapes: [] }))
    expect(props.onSelect, 'an unchanged remembered selection is claimed by its host on output, not by the editor').not.toHaveBeenCalled()
    await drag([400, 150], [420, 160])
    expect(props.onSelect, 'moving the remembered selection claims it once').toHaveBeenCalledOnce()
    await drag([520, 160], [570, 160]); await key('ArrowLeft')
    expect(props.onSelect, 'later edits claim nothing more').toHaveBeenCalledOnce()
    await key('Enter')
    expect(props.onComplete.mock.lastCall![0].crop, 'the moved selection is what Enter delivers').toEqual({ x: 638, y: 220, width: 500, height: 200 })
    const cleared = await mount(undefined, undefined, SELECTED)
    await cleared.mouse('contextmenu', [100, 50])
    expect([cleared.bar(), cleared.props.onSelect.mock.calls.length], 'clearing the remembered selection claims nothing').toEqual([null, 0])
    await cleared.drag([100, 50], [200, 150])
    expect(cleared.props.onSelect, 'a selection drawn in its place claims as usual').toHaveBeenCalledOnce()
    const redrawn = await mount(undefined, undefined, SELECTED)
    await redrawn.drag([100, 50], [200, 150])
    expect(redrawn.props.onSelect, 'a selection re-drawn over the remembered one claims once').toHaveBeenCalledOnce()
  })

  it('a locked display keeps its dimmed frozen frame and Cancel but makes no selection, loupe or color copy', async () => {
    const { editor, hint, lock, move, drag, key, bar, loupe, props } = await mount()
    fills = []; await lock(true)
    expect(editor.style.display, 'the locked frame stays visible').toBe('')
    expect(fills.filter(fill => fill.style === DIM).map(fill => fill.rect), 'the locked frame stays dimmed').toContainEqual([0, 0, 1600, 1000])
    await move([100, 100], 0)
    expect(loupe(), 'actual locked display shows no loupe').toBeNull()
    await key('c')
    expect(props.onCopyColor, 'C copies nothing on a locked display').not.toHaveBeenCalled()
    await drag([300, 100], [500, 200])
    expect(bar(), 'actual locked display makes no selection').toBeNull()
    expect(editor.querySelector('[aria-label="Selection size"]'), 'a locked display shows no size').toBeNull()
    await key('Enter')
    expect([props.onComplete.mock.calls.length, props.onSelect.mock.calls.length], 'a locked display delivers and claims nothing').toEqual([0, 0])
    expect(hint()?.textContent, 'the locked frame says where the selection is').toBe('Selecting on another display · Esc to cancel')
    await act(async () => button(hint()!, 'Cancel').click())
    expect(props.onCancel, 'the locked frame keeps a visible Cancel').toHaveBeenCalledOnce()
  })

  it('a lock that arrives after a selection or during its drag drops it', async () => {
    const early = await mount()
    await early.drag([300, 100], [500, 200]); await early.lock(true)
    expect(early.bar(), 'actual selection made before the lock is dropped').toBeNull()
    await early.key('Enter')
    expect(early.props.onComplete, 'a dropped selection delivers nothing').not.toHaveBeenCalled()
    const racing = await mount()
    await racing.press([300, 100]); await racing.move([500, 200]); await racing.lock(true); await racing.release([500, 200])
    await racing.key('Enter')
    expect([racing.bar(), racing.props.onComplete.mock.calls.length], 'a drag the lock interrupts leaves no selection').toEqual([null, 0])
  })

  it('a click that barely moves keeps the selection, and shows it while pressed', async () => {
    const { editor, press, move, release, key, props } = await selected()
    await press([100, 50])
    expect(editor.querySelector('[aria-label="Selection size"]')?.textContent, 'a press without travel still shows the kept selection').toBe('400 × 200 px')
    await move([102, 51]); await release([102, 51])
    await key('Enter')
    expect(props.onComplete.mock.lastCall![0].crop, 'actual trackpad jitter keeps the selection').toEqual(SELECTED)
    const blank = await mount()
    await blank.press([100, 50]); await blank.move([102, 51]); await blank.release([102, 51])
    expect([blank.bar(), blank.props.onSelect.mock.calls.length], 'jitter on a blank display makes no selection').toEqual([null, 0])
  })

  it('Escape or lost pointer capture during a move restores the selection, and Command Z undoes a move', async () => {
    const { press, move, release, lost, key, drag, bar, props } = await selected()
    const crop = async () => { await key('Enter'); return props.onComplete.mock.lastCall![0].crop }
    await press([400, 150]); await move([420, 160]); await key('Escape')
    expect(bar(), 'the toolbar returns after Escape').not.toBeNull()
    await release([420, 160])
    expect(await crop(), 'actual Escape during a move restores the selection').toEqual(SELECTED)
    await press([400, 150]); await move([420, 160]); await lost(); await release([420, 160])
    expect([bar() !== null, await crop()], 'lost pointer capture restores the selection and its toolbar').toEqual([true, SELECTED])
    await drag([400, 150], [420, 160]); await key('z', { metaKey: true })
    expect(await crop(), 'Command Z restores the selection before the move').toEqual(SELECTED)
  })

  it('keeps the hint, toolbar, size chip and loupe below a camera housing while the selection still reaches the top edge', async () => {
    const notched = { ...FRAME, top: 32 }
    expect(captureToolbarPlacement({ x: 300, y: 100, width: 200, height: 40 }, BAR_WIDTH, { ...FRAME, height: 160 }).side, 'without a housing the bar fits above').toBe('above')
    expect(captureToolbarPlacement({ x: 300, y: 100, width: 200, height: 40 }, BAR_WIDTH, { ...notched, height: 160 }).side, 'the housing takes the room above').toBe('inside')
    expect(captureToolbarPlacement({ x: 300, y: 0, width: 200, height: 60 }, BAR_WIDTH, { ...notched, height: 120 }), 'a bar pushed inside a short top selection stays below the band')
      .toEqual({ side: 'inside', left: 188, top: 32 + 12 })
    expect(captureSizeChipPlacement({ x: 300, y: 40, width: 200, height: 100 }, CHIP_WIDTH, 'below', notched), 'a chip that would sit in the band moves inside the selection').toEqual({ left: 300, top: 44 })
    expect(captureSizeChipPlacement({ x: 300, y: 0, width: 200, height: 100 }, CHIP_WIDTH, 'below', notched).top, 'a selection at the top edge keeps its chip below the band').toBe(32)
    expect(captureLoupePlacement({ x: 790, y: 10 }, null, notched), 'at the top-right corner the loupe opens below the band and left of the pointer').toEqual({ left: 638, top: 32 })
    expect(captureLoupePlacement({ x: 300, y: 200 }, { x: 250, y: 210, width: 300, height: 250 }, notched), 'a loupe above the pointer that would reach into the band is not chosen').toEqual({ left: 316, top: 216 })
    const { editor, hint, drag, key, props } = await mount(undefined, undefined, undefined, 32)
    const crop = async () => { await key('Enter'); return props.onComplete.mock.lastCall![0].crop }
    expect(editor.style.getPropertyValue('--capture-safe-top'), 'the hint is placed below the band through one variable').toBe('32px')
    expect(hint(), 'the hint still shows before a selection').not.toBeNull()
    await drag([300, 0], [500, 200])
    expect((await crop())?.y, 'the selection itself still reaches the top edge').toBe(0)
  })

  it('keeps the size chip off the toolbar side and leaves room for the property popover', async () => {
    expect(captureToolbarPlacement({ x: 300, y: 300, width: 200, height: 140 }, BAR_WIDTH, FRAME), 'the bar flips above when the popover has no room below')
      .toEqual({ side: 'above', left: 200, top: 256 })
    const narrow = { x: 300, y: 420, width: 200, height: 60 }
    expect(captureSizeChipPlacement(narrow, CHIP_WIDTH, 'above', FRAME), 'the chip moves inside when the bar takes the side above').toEqual({ left: 300, top: 424 })
    expect(captureSizeChipPlacement(narrow, CHIP_WIDTH, 'below', FRAME), 'the chip sits above the selection when the bar is below').toEqual({ left: 300, top: 396 })
    expect(captureSizeChipPlacement({ x: 790, y: 2, width: 10, height: 100 }, CHIP_WIDTH, 'below', FRAME), 'the chip stays inside the frame').toEqual({ left: 720, top: 6 })
    const { editor, drag, bar } = await mount()
    await drag([300, 420], [500, 480])
    const chip = editor.querySelector<HTMLElement>('[aria-label="Selection size"]')!
    expect([bar()!.dataset.side, bar()!.style.top, chip.style.top], 'actual chip leaves the side the bar takes').toEqual(['above', '376px', '424px'])
  })

  // Two windows in image pixels, front to back: a small one over part of a large one that runs past the frame.
  const FRONT = { x: 400, y: 300, width: 400, height: 200 }, BACK = { x: 200, y: 100, width: 1600, height: 600 }
  const ACCENT = '#3b82f6'
  const outlines = () => strokes.filter(stroke => stroke.style === ACCENT)
  const guides = () => fills.filter(fill => fill.style === ACCENT).map(fill => fill.rect)

  it('lights the topmost window under the pointer before a selection, fading in over 90 ms', async () => {
    const { move, canvas } = await mount(undefined, [FRONT, BACK])
    strokes = []; await move([300, 200], 0)
    // A 1 point accent outline just inside the window: half a point is one image pixel at 2x.
    expect(outlines().at(-1), 'the front window lights first where both contain the pointer').toMatchObject({ rect: [401, 301, 398, 198] })
    expect(outlines().at(-1)!.alpha, 'its first frame begins the fade').toBe(0)
    expect(frames.size, 'the fade asks for its next frame').toBe(1)
    for (let step = 0; step < 6; step++) await frame()
    expect(outlines().at(-1)!.alpha, 'after 90 ms the highlight is whole').toBe(1)
    expect(frames.size, 'a whole highlight requests no more frames').toBe(0)
    expect(fills.some(fill => fill.style === 'rgba(59, 130, 246, .12)' && fill.rect.join() === '400,300,400,200'), 'the faint fill covers the window').toBe(true)
    strokes = []; await move([150, 100], 0)
    expect(outlines().at(-1), 'outside the front window the back one lights').toMatchObject({ rect: [201, 101, 1598, 598] })
    strokes = []; await move([50, 20], 0)
    expect(outlines(), 'off every window nothing is lit').toEqual([])
    const painted = raster.scene.mock.calls.length
    await move([60, 25], 0); await move([70, 30], 0)
    expect(raster.scene.mock.calls.length, 'moves that light no other window repaint nothing').toBe(painted)
    await move([300, 200], 0); strokes = []
    await act(async () => { canvas.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null })) }); await frame()
    expect(outlines(), 'leaving the frame clears the highlight').toEqual([])
    reducedMotion = true
    const reduced = await mount(undefined, [FRONT, BACK])
    strokes = []; await reduced.move([300, 200], 0)
    expect([outlines().at(-1)!.alpha, frames.size], 'reduced motion shows the highlight whole with no fade frames').toEqual([1, 0])
  })

  it('a click without travel selects the window under it, clipped to the frame, and claims it', async () => {
    const { press, release, move, key, props, bar } = await mount(undefined, [FRONT, BACK])
    await move([300, 200], 0); await press([300, 200]); await move([301, 201]); await release([301, 201])
    expect(props.onSelect, 'a window click claims the selection').toHaveBeenCalledOnce()
    await key('Enter')
    expect(props.onComplete.mock.lastCall![0].crop, 'the crop is the front window').toEqual(FRONT)
    expect(bar(), 'the toolbar shows on the window selection').not.toBeNull()
    const back = await mount(undefined, [FRONT, BACK])
    await back.press([150, 100]); await back.release([150, 100]); await back.key('Enter')
    expect(back.props.onComplete.mock.lastCall![0].crop, 'the back window is clipped to the frame').toEqual({ x: 200, y: 100, width: 1400, height: 600 })
    const off = await mount(undefined, [FRONT, BACK])
    await off.press([50, 20]); await off.release([50, 20])
    expect([off.bar(), off.props.onSelect.mock.calls.length], 'a click off every window selects nothing').toEqual([null, 0])
    await off.drag([210, 160], [290, 190]); await off.key('Enter')
    expect(off.props.onComplete.mock.lastCall![0].crop, 'a drag still makes a free selection').toEqual({ x: 420, y: 320, width: 160, height: 60 })
  })

  it('outside an untouched remembered selection a window still lights and a click selects it', async () => {
    // The remembered selection sits inside the front window's top-left; the pointer hovers the front window outside it.
    const remembered = { x: 420, y: 320, width: 100, height: 60 }
    const { move, press, release, key, props } = await mount(undefined, [FRONT, BACK], remembered)
    strokes = []; await move([350, 220], 0)
    expect(outlines().at(-1), 'the front window lights outside the untouched remembered selection').toMatchObject({ rect: [401, 301, 398, 198] })
    strokes = []; await move([235, 175], 0)
    expect(outlines(), 'inside the remembered selection no window lights').toEqual([])
    await press([350, 220]); await release([350, 220]); await key('Enter')
    expect(props.onComplete.mock.lastCall![0].crop, 'a click outside the untouched remembered selection selects the window under it').toEqual(FRONT)
  })

  it('a press that drags away and comes back to its start selects no window', async () => {
    const { move, press, release, bar, props } = await mount(undefined, [FRONT, BACK])
    // The press lights the front window, the drag puts the highlight out, and the release lands within a click of the press.
    await move([300, 200], 0); await press([300, 200]); await move([320, 220]); await move([301, 200]); await release([301, 200])
    expect([bar(), props.onSelect.mock.calls.length], 'a press that became a drag selects nothing on its way back').toEqual([null, 0])
  })

  it('the hint names the window click only when the frame has windows to click', async () => {
    const { hint } = await mount(undefined, [FRONT, BACK])
    expect(hint()?.textContent, 'with windows the hint names the click that selects one').toBe('Click a window or drag to select · Arrows nudge · Enter to finish · Esc to cancel')
  })

  it('keeps the hint, toolbar, size chip and loupe below a camera housing in the mounted overlay', async () => {
    const api = { load: vi.fn(), presented: vi.fn(async () => {}), select: vi.fn(async () => true), onEvent: vi.fn(() => () => {}), finish: vi.fn(),
      pin: vi.fn(), savePng: vi.fn(), copyText: vi.fn(), expand: vi.fn(), cancel: vi.fn() } as unknown as CaptureSurfaceApi
    const input = { ...overlayInput(32, []), initialCrop: { x: 600, y: 0, width: 400, height: 200 } }
    await act(async () => root.render(<CaptureSurfaceView input={input} api={api} />)); await frame(); await frame()
    const editor = node.querySelector<HTMLElement>('[aria-label="Screenshot editor"]')!
    await act(async () => editor.querySelector('img')!.dispatchEvent(new Event('load'))); await frame()
    expect(editor.style.getPropertyValue('--capture-safe-top'), "the overlay forwards its display's band").toBe('32px')
    // A selection at the top edge has no room for its size chip above, so the chip goes inside, below the band.
    const chip = editor.querySelector<HTMLElement>('[aria-label="Selection size"]')!
    expect(chip.style.top, 'the mounted size chip stays below the band').toBe('32px')
  })

  it('the capture overlay hands its frozen windows to the editor, so a click there selects one', async () => {
    const api = { load: vi.fn(), presented: vi.fn(async () => {}), select: vi.fn(async () => true), onEvent: vi.fn(() => () => {}), finish: vi.fn(),
      pin: vi.fn(), savePng: vi.fn(), copyText: vi.fn(), expand: vi.fn(), cancel: vi.fn() } as unknown as CaptureSurfaceApi
    const input = overlayInput(0, [FRONT, BACK])
    await act(async () => root.render(<CaptureSurfaceView input={input} api={api} />)); await frame(); await frame()
    const canvas = node.querySelector<HTMLCanvasElement>('[aria-label="Screenshot canvas"]')!
    canvas.setPointerCapture = vi.fn()
    const send = (type: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }))
    await act(async () => { send('pointerdown', 300, 200) }); await act(async () => { send('pointerup', 300, 200) }); await frame()
    expect(api.select, 'a click on a frozen window claims the selection').toHaveBeenCalledWith('request')
    expect(node.querySelector('[aria-label="Selection size"]')?.textContent, 'the selection is that window').toBe('400 × 200 px')
  })

  it('snaps a new selection to window edges within 6 points and not beyond, with guides only while it engages', async () => {
    const { press, move, release, key, props } = await mount(undefined, [FRONT, BACK])
    // The front window's right edge is frame point 400; 405 is 5 points away, 407 is 7.
    await press([100, 50]); await move([405, 245])
    expect(guides(), 'one vertical guide runs across the frame at the engaged edge').toContainEqual([799, 0, 2, 1000])
    expect(guides(), 'and a horizontal one at the front window bottom').toContainEqual([0, 499, 1600, 2])
    fills = []; await release([405, 245])
    expect(guides(), 'the guides disappear on release').toEqual([])
    await key('Enter')
    expect(props.onComplete.mock.lastCall![0].crop, 'the corner landed on the front window corner').toEqual({ x: 200, y: 100, width: 600, height: 400 })
    const far = await mount(undefined, [FRONT, BACK])
    await far.press([20, 20]); fills = []; await far.move([407, 243])
    expect(guides(), 'beyond 6 points no guide shows').toEqual([])
    await far.release([407, 243]); await far.key('Enter')
    expect(far.props.onComplete.mock.lastCall![0].crop, 'beyond 6 points the corner follows the pointer').toEqual({ x: 40, y: 40, width: 774, height: 446 })
  })

  it('snaps a moved selection and drawn and moved marks, and holding Command suspends it', async () => {
    const { press, move, release, key, drag, bar, props } = await mount(undefined, [FRONT])
    const last = async () => { await key('Enter'); return props.onComplete.mock.lastCall![0] }
    await drag([100, 50], [300, 100])
    // Moved right by 97 points, the selection's edges sit 3 points short of the front window's left and right edges.
    await drag([200, 75], [297, 75])
    expect((await last()).crop, 'a moved selection lands on the window edges').toEqual({ x: 400, y: 100, width: 400, height: 100 })
    await act(async () => button(bar()!, 'Rectangle').click()); await frame()
    // A rectangle's end 4 points short of the selection's right edge lands on it.
    await drag([240, 60], [396, 90])
    expect((await last()).shapes.at(-1), 'a drawn region mark lands on the selection edge').toMatchObject({ kind: 'rect', from: { x: 480, y: 120 }, to: { x: 800, y: 180 } })
    // Command held: 4 points from the selection's right edge and 3 from the first rectangle's centre, the end stays put.
    await press([250, 72]); await move([396, 78], 1, true); await release([396, 78], true)
    expect((await last()).shapes.at(-1), 'with Command held a drawn mark follows the pointer exactly').toMatchObject({ kind: 'rect', from: { x: 500, y: 144 }, to: { x: 792, y: 156 } })
    // Moved left by 9 points from its bottom edge, its left edge sits 1 point from the first rectangle's left edge.
    await drag([323, 78], [314, 78])
    expect((await last()).shapes.at(-1), 'a moved mark lands on another mark edge').toMatchObject({ kind: 'rect', from: { x: 480, y: 144 }, to: { x: 772, y: 156 } })
    await press([313, 78]); await move([315, 78], 1, true); await release([315, 78], true)
    expect((await last()).shapes.at(-1), 'with Command held a moved mark follows the pointer').toMatchObject({ from: { x: 484, y: 144 }, to: { x: 776, y: 156 } })
  })

  it('a resized selection snaps only its moving edge, and a dragged mark handle snaps its corner', async () => {
    // The front window spans frame points 200 to 400 across and 150 to 250 down.
    const { drag, key, props, bar } = await mount(undefined, [FRONT])
    const last = async () => { await key('Enter'); return props.onComplete.mock.lastCall![0] }
    await drag([100, 160], [300, 230])
    // The east edge at 300 dragged to 396 lands on the window's right edge 4 points beyond it.
    fills = []; await drag([300, 190], [396, 190])
    expect((await last()).crop, 'a resized east edge lands on the window edge').toEqual({ x: 200, y: 320, width: 600, height: 140 })
    await act(async () => button(bar()!, 'Rectangle').click()); await frame()
    await drag([220, 170], [300, 200])
    // The rectangle's south-east handle at 300, 200 dragged to 396, 247 lands on the window's bottom-right corner.
    await drag([300, 200], [396, 247])
    expect((await last()).shapes.at(-1), 'a dragged mark handle lands on the window corner').toMatchObject({ kind: 'rect', from: { x: 440, y: 340 }, to: { x: 800, y: 500 } })
    // Dragging the east edge 46 points would put the west edge, shifted as far, 4 points from the window's left edge;
    // a resize moves only the east edge, 54 points from any line, so it follows the pointer.
    const near = await mount(undefined, [FRONT])
    await near.drag([150, 160], [300, 230]); await near.drag([300, 190], [346, 190]); await near.key('Enter')
    expect(near.props.onComplete.mock.lastCall![0].crop, 'a resize far from any line leaves its moving edge on the pointer').toEqual({ x: 300, y: 320, width: 392, height: 140 })
  })

  it('moving a selection forces no layout of the toolbar or size chip', async () => {
    const { press, move, release } = await selected()
    await press([400, 150]); const before = measures
    await move([410, 155]); await move([420, 160])
    expect(measures, 'actual pointer moves that keep the size measure nothing').toBe(before)
    await release([420, 160])
    expect(measures, 'the returning toolbar is measured').toBeGreaterThan(before)
  })
})
