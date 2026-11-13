// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ImageAnnotationEditor } from '../src/renderer/src/components/image-annotation/ImageAnnotationEditor'
import { captureToolbarPlacement } from '../src/renderer/src/components/image-annotation/capture-geometry'
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
let fills: Array<{ style: string; rect: number[] }>, sampled: number[], reads = 0
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
  frames = new Map(); nextFrame = 0; fills = []; sampled = [18, 52, 86]; reads = 0; layout = FRAME
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  // The overlay fills one display; the toolbar and size chip report their laid-out widths.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('image-annotation-editor__capture-bar')) return box(BAR_WIDTH, 36)
    if (this.classList.contains('image-annotation-editor__size-chip')) return box(CHIP_WIDTH, 20)
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
    onCancel: vi.fn(), onComplete: vi.fn(), onSavePng: vi.fn(), onPin: vi.fn(), onExpand: vi.fn(), onCopyColor: vi.fn() }
  await act(async () => root.render(<ImageAnnotationEditor key={Math.random()} {...props} />)); await frame()
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
  return { editor, canvas, props, press, move, release, drag, key, mouse, bar, loupe }
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
    const before = [bar()!.style.left, bar()!.style.top]
    await act(async () => button(bar()!, 'Rectangle').click()); await frame()
    expect(props.onExpand, 'actual mark button opens no other editor').not.toHaveBeenCalled()
    expect(button(bar()!, 'Rectangle').getAttribute('aria-pressed'), 'the current mark shows pressed').toBe('true')
    expect([bar()!.style.left, bar()!.style.top], 'the toolbar keeps its place').toEqual(before)
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
    const rows = [...loupe()!.querySelectorAll('span')].map(row => row.textContent)
    expect(rows, 'the loupe reads the frozen pixel and both coordinate units').toEqual(['#123456  18,52,86', '-1340, 125 pt · 200, 200 px'])
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
})
