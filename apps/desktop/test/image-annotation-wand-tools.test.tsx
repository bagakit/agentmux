// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ImageAnnotationEditor } from '../src/renderer/src/components/image-annotation/ImageAnnotationEditor'
import type { AdjustShape, ScreenshotShape } from '@agentmux/client-ui/image-annotation'

const raster = vi.hoisted(() => ({ committed: vi.fn(), scene: vi.fn() }))
// Component state, tools, sampling and outputs are production code; only raster drawing is replaced.
vi.mock('@agentmux/client-ui/image-annotation', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/client-ui/image-annotation')>(), renderCommittedLayer: raster.committed, renderScreenshotScene: raster.scene }))

const image = { dataUrl: 'data:image/png;base64,AA==', width: 400, height: 300 }
// The original pixels: red block A, a bluer block B touching its right edge (RGB distance 90, 20.4 on the 0–100 scale),
// a separate red block C, all on white.
function originalColor(x: number, y: number): [number, number, number] {
  if (y >= 40 && y < 100 && x >= 40 && x < 120) return [200, 40, 40]
  if (y >= 40 && y < 100 && x >= 120 && x < 160) return [200, 40, 130]
  if (y >= 150 && y < 210 && x >= 200 && x < 260) return [200, 40, 40]
  return [255, 255, 255]
}
let reads = 0, strokes: Array<{ style: string; offset: number; points: Array<{ x: number; y: number }> }>
/** Serves the original image's pixels only after the image element itself was drawn; any canvas, such as the marked
 * result, reads back black, so a wand that sampled marks would select the whole image. */
class PixelContext {
  fillStyle = ''; strokeStyle = ''; lineWidth = 1; lineDashOffset = 0; font = ''; imageSmoothingEnabled = true
  private source: unknown = null
  private path: Array<{ x: number; y: number }> = []
  drawImage(source: unknown) { this.source = source }
  getImageData(left: number, top: number, width: number, height: number) {
    reads++
    const data = new Uint8ClampedArray(width * height * 4), original = this.source instanceof HTMLImageElement
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...(original ? originalColor(left + x, top + y) : [0, 0, 0]), 255], (y * width + x) * 4)
    return { width, height, data }
  }
  stroke() { strokes.push({ style: String(this.strokeStyle), offset: this.lineDashOffset, points: [...this.path] }) }
  measureText(text: string) { return { width: text.length * 7 } }
  save() {} restore() {} setLineDash() {} strokeRect() {} fillRect() {} beginPath() { this.path = [] } moveTo(x: number, y: number) { this.path.push({ x, y }) } lineTo(x: number, y: number) { this.path.push({ x, y }) } closePath() {} arc() {} fill() {} clearRect() {}
}
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement
let frames: Map<number, FrameRequestCallback>, nextFrame: number
function rect(): DOMRect { return { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON() {} } }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  frames = new Map(); nextFrame = 0; reads = 0; strokes = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(rect)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => new PixelContext() as unknown as CanvasRenderingContext2D)
  vi.clearAllMocks()
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function frame() { await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)) }) }
function slide(field: HTMLInputElement, value: number) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, String(value))
  field.dispatchEvent(new Event('input', { bubbles: true }))
}
function named<T extends HTMLElement>(scope: ParentNode, selector: string, name: string): T {
  const found = [...scope.querySelectorAll<T>(selector)].find(item => item.getAttribute('aria-label') === name || item.textContent?.trim() === name)
  expect(found, 'real ' + name + ' control').toBeDefined(); return found!
}
async function mount(shapes: ScreenshotShape[] = [], presentation: 'window' | 'capture' = 'window') {
  const props = presentation === 'capture'
    ? { image, busy: false, presentation, pixelRatio: 1, onCancel: vi.fn(), onComplete: vi.fn(), onSavePng: vi.fn(), onPin: vi.fn(), onExpand: vi.fn(), onSelect: vi.fn() } as const
    : { image, busy: false, initialTool: 'wand' as const, initialState: { shapes, crop: null }, onCancel: vi.fn(), onComplete: vi.fn() }
  await act(async () => root.render(<ImageAnnotationEditor key={Math.random()} {...props} />)); await frame()
  const editor = node.querySelector<HTMLElement>('[aria-label="Screenshot editor"]')!, canvas = editor.querySelector('canvas')!
  canvas.setPointerCapture = vi.fn()
  await act(async () => editor.querySelector('img')!.dispatchEvent(new Event('load'))); await frame()
  const pointer = (type: string, x: number, y: number, shiftKey = false) => canvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, shiftKey }))
  const pick = async (x: number, y: number, shiftKey = false) => { await act(async () => { pointer('pointerdown', x, y, shiftKey); pointer('pointerup', x, y, shiftKey) }); await frame() }
  const press = async (control: HTMLElement) => { await act(async () => control.click()); await frame() }
  const key = async (value: string, modifiers: { metaKey?: boolean; shiftKey?: boolean } = {}) => { await act(async () => { canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, ...modifiers })) }); await frame() }
  const shapes_ = async (): Promise<ScreenshotShape[]> => {
    await press(named(editor, 'button', presentation === 'capture' ? 'Done' : 'Copy PNG')); return props.onComplete.mock.lastCall![0].shapes
  }
  const actions = () => editor.querySelector<HTMLElement>('[aria-label="Turn the region into"]')
  const undo = () => press(named(editor, 'button', 'Undo'))
  return { editor, pointer, pick, press, key, shapes: shapes_, actions, undo, props }
}
const ring = (left: number, top: number, right: number, bottom: number) => [{ x: left, y: top }, { x: left, y: bottom }, { x: right, y: bottom }, { x: right, y: top }]

describe('magic wand in the mounted editor', () => {
  it('selects the connected region of the original pixels under a click, never the marked result', async () => {
    const covered: ScreenshotShape = { id: 'over', kind: 'cover', color: '#111827', from: { x: 30, y: 30 }, to: { x: 130, y: 110 } }
    const { pick, actions, press, shapes, editor } = await mount([covered])
    expect(named(editor.querySelector('[aria-label="Process image"]')!, 'button', 'Magic wand').getAttribute('aria-keyshortcuts')).toBe('W')
    expect(actions(), 'no region, no conversion').toBeNull()
    await pick(60, 60)
    await press(named(actions()!, 'button', 'Cover'))
    const made = (await shapes()).at(-1)!
    expect(made, 'the click selects block A of the original under the existing cover').toMatchObject({ kind: 'cover', from: { x: 40, y: 40 }, to: { x: 120, y: 100 }, outline: [ring(40, 40, 120, 100)] })
  })

  // The tolerance carries over to the next editor like every other style, so this case puts it back.
  it('grows the region with the tolerance slider, from a default of 20', async () => {
    const { pick, actions, press, shapes, editor } = await mount()
    const tolerance = named<HTMLInputElement>(editor, 'input', 'Wand tolerance')
    expect(tolerance.value, 'default tolerance').toBe('20')
    await pick(60, 60); await press(named(actions()!, 'button', 'Cover'))
    expect((await shapes()).at(-1), 'at 20 the bluer block B stays out').toMatchObject({ from: { x: 40, y: 40 }, to: { x: 120, y: 100 } })
    await act(async () => slide(tolerance, 25)); await frame()
    await pick(60, 60); await press(named(actions()!, 'button', 'Cover'))
    expect((await shapes()).at(-1), 'at 25 block B joins').toMatchObject({ from: { x: 40, y: 40 }, to: { x: 160, y: 100 }, outline: [ring(40, 40, 160, 100)] })
    await act(async () => slide(tolerance, 20)); await frame()
  })

  it('adds a Shift-clicked region to the current one and replaces it on a plain click', async () => {
    const { pick, actions, press, shapes } = await mount()
    await pick(60, 60); await pick(220, 170, true)
    await press(named(actions()!, 'button', 'Cover'))
    const both = (await shapes()).at(-1) as Extract<ScreenshotShape, { kind: 'cover' }>
    expect(both).toMatchObject({ from: { x: 40, y: 40 }, to: { x: 260, y: 210 } })
    expect(both.outline, 'two separate rings').toEqual([ring(40, 40, 120, 100), ring(200, 150, 260, 210)])
    await pick(60, 60); await pick(220, 170)
    await press(named(actions()!, 'button', 'Cover'))
    expect((await shapes()).at(-1), 'a plain click starts over').toMatchObject({ from: { x: 200, y: 150 }, to: { x: 260, y: 210 }, outline: [ring(200, 150, 260, 210)] })
  })

  it('turns the region into each mask and the spotlight as one Undo step', async () => {
    const { pick, actions, press, shapes, undo } = await mount()
    for (const [name, kind] of [['Cover', 'cover'], ['Pixelate', 'pixelate'], ['Blur', 'blur'], ['Spotlight', 'spotlight']] as const) {
      await pick(60, 60)
      await press(named(actions()!, 'button', name))
      expect(actions(), name + ' consumes the region').toBeNull()
      expect(await shapes(), name).toMatchObject([{ kind, from: { x: 40, y: 40 }, to: { x: 120, y: 100 }, outline: [ring(40, 40, 120, 100)] }])
      await undo()
      expect(await shapes(), 'one Undo removes the ' + name).toEqual([])
    }
  })

  it('turns the picked color region into a highlight and removes it with one Undo', async () => {
    const { pick, actions, press, shapes, undo } = await mount()
    await pick(60, 60)
    await press(named(actions()!, 'button', 'Highlight'))
    expect(actions(), 'Highlight consumes the pending region').toBeNull()
    expect(await shapes(), 'Highlight commits the exact picked range').toMatchObject([{ kind: 'region-highlight', from: { x: 40, y: 40 }, to: { x: 120, y: 100 }, outline: [ring(40, 40, 120, 100)] }])
    await undo()
    expect(await shapes(), 'one Undo removes the region highlight').toEqual([])
  })

  it('reads the original pixels once per image, not on each click or pointer move', async () => {
    const { pick, pointer } = await mount()
    await pick(60, 60); await pick(220, 170, true)
    await act(async () => { for (let x = 0; x < 50; x++) pointer('pointermove', x, 20) }); await frame()
    expect(reads, 'one readback serves every click').toBe(1)
  })

  it('marches the ants only while a region shows and keeps them still under reduced motion', async () => {
    let reduced = false
    const ticks = new Map<number, () => void>(); let nextTick = 0
    vi.stubGlobal('matchMedia', (media: string) => ({ media, get matches() { return reduced }, addEventListener() {}, removeEventListener() {} }))
    vi.stubGlobal('setInterval', (callback: () => void) => { ticks.set(++nextTick, callback); return nextTick })
    vi.stubGlobal('clearInterval', (id: number) => { ticks.delete(id) })
    const tick = async () => { await act(async () => [...ticks.values()].forEach(callback => callback())); await frame() }
    const black = () => strokes.filter(stroke => stroke.style === '#000000').map(stroke => stroke.offset)
    const { pick, key } = await mount()
    expect(ticks.size, 'no region, no timer').toBe(0)
    await pick(60, 60)
    expect(ticks.size, 'one timer while the region shows').toBe(1)
    const first = black().at(-1)
    await tick()
    expect(black().at(-1), 'the dashes move').not.toBe(first)
    await key('Escape')
    expect(ticks.size, 'Escape drops the region and its timer').toBe(0)
    const painted = strokes.length; await tick()
    expect(strokes.length, 'nothing repaints at rest').toBe(painted)
    reduced = true
    await pick(60, 60)
    expect(ticks.size, 'reduced motion runs no timer').toBe(0)
    expect(black().length, 'the dashes still show').toBeGreaterThan(0)
  })

  it('offers the wand in a capture selection with its lightweight actions only', async () => {
    const { editor, pointer, pick, press, shapes, actions } = await mount([], 'capture')
    await act(async () => { pointer('pointerdown', 10, 10); pointer('pointermove', 200, 150); pointer('pointerup', 390, 290) }); await frame()
    await press(named(editor.querySelector('[aria-label="Capture tools"]')!, 'button', 'Magic wand'))
    await pick(60, 60)
    expect([...actions()!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Pixelate', 'Blur', 'Highlight'])
    expect(editor.querySelector('.image-annotation-editor__adjust'), 'the capture toolbar has no adjust entry').toBeNull()
    await press(named(actions()!, 'button', 'Pixelate'))
    expect((await shapes()).at(-1), 'the frozen frame is sampled').toMatchObject({ kind: 'pixelate', from: { x: 40, y: 40 }, to: { x: 120, y: 100 }, outline: [ring(40, 40, 120, 100)] })
    await pick(60, 60); await press(named(actions()!, 'button', 'Highlight'))
    expect((await shapes()).at(-1), 'the capture can highlight its picked range').toMatchObject({ kind: 'region-highlight', outline: [ring(40, 40, 120, 100)] })
  })
})

describe('adjustments in the window property row', () => {
  const adjusts = (shapes: ScreenshotShape[]) => shapes.filter((shape): shape is AdjustShape => shape.kind === 'adjust')
  it('adjusts the whole image with four sliders, each change one Undo step', async () => {
    const { editor, press, shapes, undo } = await mount()
    const entry = named<HTMLButtonElement>(editor, 'button', 'Adjust')
    await press(entry)
    expect(entry.getAttribute('aria-pressed')).toBe('true')
    const group = editor.querySelector<HTMLElement>('[aria-label="Image adjustments"]')!
    expect([...group.querySelectorAll('input')].map(input => input.getAttribute('aria-label'))).toEqual(['Brightness', 'Contrast', 'Saturation', 'Sharpen'])
    expect(adjusts(await shapes()), 'opening commits nothing').toEqual([])
    await act(async () => slide(named(group, 'input', 'Brightness'), 1.2)); await frame()
    await act(async () => slide(named(group, 'input', 'Contrast'), 0.8)); await frame()
    await act(async () => slide(named(group, 'input', 'Saturation'), 1.4)); await frame()
    await act(async () => slide(named(group, 'input', 'Sharpen'), 0.5)); await frame()
    const [whole] = adjusts(await shapes())
    expect(adjusts(await shapes()), 'one mark for the whole image').toHaveLength(1)
    expect(whole).toMatchObject({ from: { x: 0, y: 0 }, to: { x: 400, y: 300 }, brightness: 1.2, contrast: 0.8, saturation: 1.4, sharpen: 0.5 })
    expect(whole!.outline).toBeUndefined()
    await undo()
    expect(adjusts(await shapes())[0], 'one Undo restores one slider').toMatchObject({ brightness: 1.2, contrast: 0.8, saturation: 1.4, sharpen: 0 })
    await undo(); await undo(); await undo()
    expect(adjusts(await shapes()), 'the first change created the mark').toEqual([])
    await press(entry); await press(entry)
    await act(async () => slide(named(editor.querySelector('[aria-label="Image adjustments"]')!, 'input', 'Brightness'), 0.9)); await frame()
    expect(adjusts(await shapes()), 'reopening edits the one whole-image mark').toHaveLength(1)
  })

  it('adjusts the current wand region through its outline', async () => {
    const { editor, pick, press, shapes } = await mount()
    await pick(60, 60)
    await press(named(editor, 'button', 'Adjust'))
    const group = editor.querySelector<HTMLElement>('[aria-label="Region adjustments"]')
    expect(group, 'a wand region narrows the adjustment').not.toBeNull()
    await act(async () => slide(named(group!, 'input', 'Saturation'), 0.6)); await frame()
    const [region] = adjusts(await shapes())
    expect(region, 'the range is the region bounds').toMatchObject({ from: { x: 40, y: 40 }, to: { x: 120, y: 100 }, saturation: 0.6, brightness: 1 })
    expect(region!.outline, 'the adjustment keeps the region outline').toEqual([ring(40, 40, 120, 100)])
  })

  it('keeps the adjusted region outlined after a tool change drops the wand selection', async () => {
    const { editor, pick, press, key } = await mount()
    await pick(60, 60)
    await press(named(editor, 'button', 'Adjust'))
    // The tool change repaints the canvas without the wand selection.
    strokes = []; await key('v')
    expect(editor.querySelector('[aria-label="Region adjustments"]'), 'the region adjustment stays open').not.toBeNull()
    expect(strokes.filter(stroke => stroke.style === '#000000').length, 'the region it adjusts still shows its outline').toBeGreaterThan(0)
    strokes = []; await press(named(editor, 'button', 'Adjust'))
    expect(editor.querySelector('[aria-label="Region adjustments"]'), 'Adjust closes it').toBeNull()
    expect(strokes.filter(stroke => stroke.style === '#000000'), 'and its outline goes with it').toEqual([])
  })

  it('draws the current adjustment range after Select All and an arrow move', async () => {
    const { editor, pick, press, key, shapes } = await mount()
    await pick(60, 60); await press(named(editor, 'button', 'Adjust'))
    await act(async () => slide(named(editor.querySelector('[aria-label="Region adjustments"]')!, 'input', 'Saturation'), 0.6)); await frame()
    await key('v'); await key('a', { metaKey: true })
    strokes = []; await key('ArrowRight')
    const movedRing = ring(41, 40, 121, 100)
    expect(strokes.filter(stroke => stroke.style === '#000000').at(-1)?.points, 'the open adjustment outlines its moved range').toEqual(movedRing)
    expect(adjusts(await shapes())[0], 'the keyboard moved the actual adjustment').toMatchObject({ from: { x: 41, y: 40 }, to: { x: 121, y: 100 }, outline: [movedRing] })
    await act(async () => slide(named(editor.querySelector('[aria-label="Region adjustments"]')!, 'input', 'Brightness'), 1.3)); await frame()
    expect(adjusts(await shapes())[0], 'the next slider edits that same moved adjustment').toMatchObject({ brightness: 1.3, saturation: 0.6, outline: [movedRing] })
  })

  it('lists existing adjustments to edit or remove one after the wand selection is gone, each change one Undo step', async () => {
    const { editor, pick, press, key, shapes, undo } = await mount()
    await pick(60, 60)
    await press(named(editor, 'button', 'Adjust'))
    await act(async () => slide(named(editor.querySelector('[aria-label="Region adjustments"]')!, 'input', 'Saturation'), 0.6)); await frame()
    const entry = named<HTMLButtonElement>(editor, 'button', 'Adjust')
    await press(entry); await key('v')
    await press(entry)
    const list = editor.querySelector<HTMLElement>('[aria-label="Adjustment"]')
    expect(list, 'the adjustments are listed').not.toBeNull()
    expect([...list!.querySelectorAll('button')].map(button => [button.textContent, button.getAttribute('aria-pressed')]), 'the whole image opens first')
      .toEqual([['Whole image', 'true'], ['Region 1', 'false']])
    await press(named(list!, 'button', 'Region 1'))
    const group = editor.querySelector<HTMLElement>('[aria-label="Region adjustments"]')
    expect(group, 'picking the region edits the region').not.toBeNull()
    expect(named<HTMLInputElement>(group!, 'input', 'Saturation').value, 'picking the region shows its own values').toBe('0.6')
    await act(async () => slide(named(group!, 'input', 'Brightness'), 1.3)); await frame()
    expect(adjusts(await shapes()), 'the picked region adjustment is edited in place').toMatchObject([{ saturation: 0.6, brightness: 1.3, outline: [ring(40, 40, 120, 100)] }])
    await undo()
    expect(adjusts(await shapes())[0], 'one Undo restores one change').toMatchObject({ saturation: 0.6, brightness: 1 })
    await press(named(editor.querySelector('[aria-label="Region adjustments"]')!, 'button', 'Remove'))
    expect(adjusts(await shapes()), 'Remove deletes the region adjustment').toEqual([])
    expect(editor.querySelector('[aria-label="Image adjustments"]'), 'the panel goes on with the whole image').not.toBeNull()
    await undo()
    expect(adjusts(await shapes()), 'one Undo brings it back').toHaveLength(1)
  })
})
