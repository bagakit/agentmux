// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ImageAnnotationEditor, inlineToolbarPlacement, type InlineAnnotationFrame } from '../src/renderer/src/components/image-annotation/ImageAnnotationEditor'
import type { AnnotationTool } from '../src/renderer/src/components/image-annotation/AnnotationToolbar'
import type { ImageViewport } from '../src/renderer/src/components/image-annotation/view'

const raster = vi.hoisted(() => ({ committed: vi.fn(), scene: vi.fn() }))
// Component state, view, gestures and callbacks are production code; only raster drawing is replaced.
vi.mock('../src/renderer/src/components/image-annotation/canvas-render', () => ({ renderCommittedLayer: raster.committed, renderScreenshotScene: raster.scene }))
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement
let frames: Map<number, FrameRequestCallback>, nextFrame: number, hostHeight = 600
// The laid-out canvas area; normally the selection size, but layout rounding must not change the pixel scale.
let measured = { width: 200, height: 100 }
// A 200 × 100 point selection captured at 2x: 400 × 200 image pixels.
const image = { dataUrl: 'data:image/png;base64,AA==', width: 400, height: 200 }
const selection: InlineAnnotationFrame = { x: 300, y: 120, width: 200, height: 100 }
function box(width: number, height: number): DOMRect { return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} } }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  frames = new Map(); nextFrame = 0; hostHeight = 600; measured = { width: 200, height: 100 }
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  // The editor root fills the host viewport; its canvas area is the selection frame.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('image-annotation-editor')) return box(800, hostHeight)
    const area = this.classList.contains('image-annotation-editor__canvas-area') ? this : this.closest<HTMLElement>('.image-annotation-editor__canvas-area')
    if (area) return box(measured.width, measured.height)
    return box(800, hostHeight)
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.clearAllMocks()
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function frame() { await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)) }) }
function button(scope: ParentNode, name: string): HTMLButtonElement {
  // The compact Markup tool trigger shows the current tool's name, so an exact aria-label wins over visible text.
  const buttons = [...scope.querySelectorAll<HTMLButtonElement>('button')]
  const found = buttons.find(button => button.getAttribute('aria-label') === name) ?? buttons.find(button => button.textContent?.trim() === name)
  expect(found, 'real ' + name + ' control').toBeDefined(); return found!
}
type Options = { frame?: InlineAnnotationFrame | null; initialTool?: AnnotationTool; onExpand?: ReturnType<typeof vi.fn> | null }
async function mount({ frame: inlineFrame = selection, initialTool = 'rect', onExpand = vi.fn() }: Options = {}) {
  const props = { image, busy: false, presentation: 'inline' as const, pixelRatio: 2, ...(inlineFrame ? { inlineFrame } : {}), initialTool, onCancel: vi.fn(), onComplete: vi.fn(), onSavePng: vi.fn(),
    ...(onExpand ? { onExpand } : {}) }
  await act(async () => root.render(<ImageAnnotationEditor key={Math.random()} {...props} />)); await frame()
  const editor = node.querySelector<HTMLElement>('[aria-label="Screenshot editor"]')!, canvas = editor.querySelector('canvas')!
  canvas.setPointerCapture = vi.fn()
  await act(async () => editor.querySelector('img')!.dispatchEvent(new Event('load'))); await frame()
  // Pointer coordinates are local to the selection frame.
  const gesture = async (from: [number, number], to: [number, number]) => {
    await act(async () => {
      const send = (type: string, [x, y]: [number, number]) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }))
      send('pointerdown', from); send('pointermove', to); send('pointerup', to)
    }); await frame()
  }
  const bar = () => editor.querySelector<HTMLElement>('.image-annotation-editor__inline-bar')!
  return { editor, canvas, gesture, bar, props }
}
function view(): ImageViewport { expect(raster.committed).toHaveBeenCalled(); return raster.committed.mock.lastCall![2] }

describe('inline image annotation', () => {
  it('draws on the selection at a fixed one-to-one pixel scale without zoom or pan', async () => {
    // A larger laid-out area would fit the image at 0.75; the inline view stays at one image pixel per screen pixel.
    measured = { width: 300, height: 150 }
    const { editor, canvas, gesture, props } = await mount()
    expect(view().view, 'actual inline view keeps one image pixel per screen pixel').toEqual({ scale: .5, x: 0, y: 0 })
    const area = editor.querySelector<HTMLElement>('.image-annotation-editor__canvas-area')!
    expect([area.style.left, area.style.top, area.style.width, area.style.height]).toEqual(['300px', '120px', '200px', '100px'])
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -200, clientX: 50, clientY: 50 })
    await act(async () => area.dispatchEvent(wheel)); await frame()
    await act(async () => { canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true })) }); await frame()
    expect(view().view, 'wheel and zoom keys leave the inline view fixed').toEqual({ scale: .5, x: 0, y: 0 })
    expect(wheel.defaultPrevented, 'the host keeps the wheel').toBe(false)
    await gesture([20, 10], [60, 40])
    await act(async () => button(editor, 'Copy PNG').click())
    expect(props.onComplete.mock.lastCall![0], 'actual inline marks land in original image pixels').toMatchObject({ displayWidth: 400, displayHeight: 200,
      shapes: [expect.objectContaining({ kind: 'rect', width: 8, from: { x: 40, y: 20 }, to: { x: 120, y: 80 } })] })
  })

  it('shows only the floating bar and property popover, without the window chrome or Pan', async () => {
    const { editor, bar } = await mount()
    for (const chrome of ['header', 'footer', '.image-annotation-editor__properties', '.image-annotation-editor__notes'])
      expect(editor.querySelector(chrome), 'inline presentation omits the window ' + chrome).toBeNull()
    expect(editor.querySelector('[aria-label="Pan"]'), 'a fixed view offers no Pan tool').toBeNull()
    for (const control of ['Rectangle', 'Undo', 'Cancel', 'Copy PNG', 'Save PNG', 'Expand editor']) button(bar(), control)
    const popover = bar().querySelector<HTMLElement>('[aria-label="Markup properties"]')
    expect(popover, 'the drawing tool opens its property popover').not.toBeNull()
    button(popover!, 'Color #3b82f6'); expect(popover!.querySelector('[aria-label="Stroke width"]')).not.toBeNull()
  })

  it('right-aligns the floating bar below the selection, flips above, and moves inside when neither fits', async () => {
    expect(inlineToolbarPlacement(selection, 600), 'room below keeps the bar below').toEqual({ side: 'below', top: 226 })
    expect(inlineToolbarPlacement({ ...selection, y: 520, height: 60 }, 600), 'no room below flips the bar above').toEqual({ side: 'above', top: 478 })
    expect(inlineToolbarPlacement({ x: 0, y: 10, width: 800, height: 580 }, 600), 'no room on either side moves the bar inside').toEqual({ side: 'inside', top: 548 })
    const { bar } = await mount()
    expect(bar().dataset.side).toBe('below')
    expect(bar().style.right, 'the bar ends at the selection right edge').toBe('calc(100% - 500px)')
    hostHeight = 240
    const flipped = await mount()
    expect(flipped.bar().dataset.side, 'actual bar flips above when the host viewport ends below the selection').toBe('above')
    expect(flipped.bar().querySelector<HTMLElement>('[aria-label="Markup properties"]')!.dataset.side).toBe('above')
    hostHeight = 230
    const inside = await mount({ frame: { x: 300, y: 10, width: 200, height: 210 } })
    expect(inside.bar().dataset.side, 'actual bar moves inside when it fits on neither side').toBe('inside')
    expect(inside.bar().style.top).toBe('178px')
  })

  it('fills the host viewport when the host gives no selection frame', async () => {
    hostHeight = 300
    const { editor, bar } = await mount({ frame: null })
    const area = editor.querySelector<HTMLElement>('.image-annotation-editor__canvas-area')!
    expect([area.style.left, area.style.top, area.style.width, area.style.height], 'the selection is the whole viewport').toEqual(['0px', '0px', '800px', '300px'])
    expect(bar().dataset.side, 'a full-viewport selection keeps its bar inside').toBe('inside')
  })
  it('hands the current marks and tool to the host on Expand', async () => {
    const { bar, gesture, props } = await mount()
    await gesture([20, 10], [60, 40])
    await act(async () => button(bar(), 'Arrow').click())
    await act(async () => button(bar(), 'Expand editor').click())
    expect(props.onExpand, 'actual Expand hands the edit to the host').toHaveBeenCalledOnce()
    expect(props.onExpand.mock.lastCall![0]).toEqual({ crop: null, tool: 'arrow', shapes: [expect.objectContaining({ kind: 'rect', from: { x: 40, y: 20 }, to: { x: 120, y: 80 } })] })
    const { editor } = await mount({ onExpand: null })
    expect(editor.querySelector('[aria-label="Expand editor"]'), 'no Expand without a host handoff').toBeNull()
  })

  it('opens with initialTool and never opens on Pan', async () => {
    const ellipse = await mount({ initialTool: 'ellipse' })
    expect(button(ellipse.bar(), 'Ellipse').getAttribute('aria-pressed'), 'actual initialTool opens the inline editor').toBe('true')
    const pan = await mount({ initialTool: 'pan' })
    expect(button(pan.bar(), 'Rectangle').getAttribute('aria-pressed'), 'a requested Pan opens as Rectangle').toBe('true')
  })
})
