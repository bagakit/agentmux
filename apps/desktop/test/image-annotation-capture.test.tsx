// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SEMANTIC_ICON_CATALOG, type SemanticIconName } from '@agentmux/client-ui/icons'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ImageAnnotationEditor } from '../src/renderer/src/components/image-annotation/ImageAnnotationEditor'
import { captureSizeChipPlacement, captureToolbarPlacement } from '../src/renderer/src/components/image-annotation/capture-geometry'
import type { ImageViewport } from '../src/renderer/src/components/image-annotation/view'

const raster = vi.hoisted(() => ({ committed: vi.fn(), scene: vi.fn() }))
// Component state, view, gestures and callbacks are production code; only raster drawing is replaced.
vi.mock('../src/renderer/src/components/image-annotation/canvas-render', () => ({ renderCommittedLayer: raster.committed, renderScreenshotScene: raster.scene }))

// One 800 × 500 point display frozen at 2x: 1600 × 1000 image pixels.
const image = { dataUrl: 'data:image/png;base64,AA==', width: 1600, height: 1000 }
const FRAME = { width: 800, height: 500 }, BAR_WIDTH = 300, CHIP_WIDTH = 80
// The overlay's laid-out size; normally the display, but layout rounding must not change the pixel scale.
let layout = FRAME
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement
let frames: Map<number, FrameRequestCallback>, nextFrame: number
// Every fill the editor paints on its own canvas, with the fill style it used.
let fills: Array<{ style: string; rect: number[] }>, sampled: number[], reads = 0, measures = 0
class RecordingContext {
  fillStyle = ''; strokeStyle = ''; lineWidth = 1; font = ''; imageSmoothingEnabled = true
  fillRect(...rect: number[]) { fills.push({ style: String(this.fillStyle), rect }) }
  getImageData() { reads++; return { data: Uint8ClampedArray.from([...sampled, 255]) } }
  measureText(text: string) { return { width: text.length * 7 } }
  save() {} restore() {} setLineDash() {} strokeRect() {} beginPath() {} arc() {} fill() {} stroke() {} drawImage() {} clearRect() {} moveTo() {} lineTo() {}
}
function box(width: number, height: number): DOMRect { return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} } }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  frames = new Map(); nextFrame = 0; fills = []; sampled = [18, 52, 86]; reads = 0; measures = 0; layout = FRAME
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
async function frame() { await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)) }) }
function button(scope: ParentNode, name: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === name)
  expect(found, 'real ' + name + ' control').toBeDefined(); return found!
}
async function mount(origin?: { x: number; y: number }) {
  const props = { image, busy: false, presentation: 'capture' as const, pixelRatio: 2, ...(origin ? { origin } : {}),
    onCancel: vi.fn(), onComplete: vi.fn(), onSavePng: vi.fn(), onPin: vi.fn(), onExpand: vi.fn(), onCopyColor: vi.fn(), onSelect: vi.fn() }
  const instance = Math.random()
  // The host's lock for this display arrives later than the editor mounts, as another display's claim does.
  const lock = async (locked: boolean) => { await act(async () => root.render(<ImageAnnotationEditor key={instance} {...props} locked={locked} />)); await frame() }
  await act(async () => root.render(<ImageAnnotationEditor key={instance} {...props} />)); await frame()
  const editor = node.querySelector<HTMLElement>('[aria-label="Screenshot editor"]')!, canvas = editor.querySelector('canvas')!
  canvas.setPointerCapture = vi.fn()
  await act(async () => editor.querySelector('img')!.dispatchEvent(new Event('load'))); await frame()
  // Pointer coordinates are frame points; the display's top-left is 0, 0.
  const send = (type: string, [x, y]: [number, number], buttons = 1) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons, clientX: x, clientY: y }))
  const press = async (at: [number, number]) => { await act(async () => { send('pointerdown', at) }) }
  const move = async (to: [number, number], buttons = 1) => { await act(async () => { send('pointermove', to, buttons) }); await frame() }
  const release = async (at: [number, number]) => { await act(async () => { send('pointerup', at, 0) }); await frame() }
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

  it('moving a selection forces no layout of the toolbar or size chip', async () => {
    const { press, move, release } = await selected()
    await press([400, 150]); const before = measures
    await move([410, 155]); await move([420, 160])
    expect(measures, 'actual pointer moves that keep the size measure nothing').toBe(before)
    await release([420, 160])
    expect(measures, 'the returning toolbar is measured').toBeGreaterThan(before)
  })
})
