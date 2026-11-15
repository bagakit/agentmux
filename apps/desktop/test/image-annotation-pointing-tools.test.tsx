// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ImageAnnotationEditor } from '../src/renderer/src/components/image-annotation/ImageAnnotationEditor'
import { CAPTURE_TOOLS } from '../src/renderer/src/components/image-annotation/CaptureToolbar'
import { BLUR_RADIUS_RANGE, calloutBubble, type CalloutShape, type NoteShape, type ScreenshotShape } from '@agentmux/client-ui/image-annotation'
import { createEditableAnnotationDocument, encodeEditableAnnotationDocument } from '../src/renderer/src/components/image-annotation/document'

const raster = vi.hoisted(() => ({ committed: vi.fn(), scene: vi.fn() }))
// Component state, tools, gestures and outputs are production code; only raster drawing is replaced.
vi.mock('@agentmux/client-ui/image-annotation', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/client-ui/image-annotation')>(), renderCommittedLayer: raster.committed, renderScreenshotScene: raster.scene }))
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement
let frames: Map<number, FrameRequestCallback>, nextFrame: number
// A 400 × 300 image fitted into a 400 × 300 canvas: one image pixel per screen pixel.
const image = { dataUrl: 'data:image/png;base64,AA==', width: 400, height: 300 }
function rect(): DOMRect { return { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON() {} } }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  frames = new Map(); nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(rect)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.clearAllMocks()
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function frame() { await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)) }) }
function control<T extends HTMLElement>(scope: ParentNode, selector: string, name: string): T {
  const found = [...scope.querySelectorAll<T>(selector)].find(item => item.getAttribute('aria-label') === name || item.textContent?.trim() === name)
  expect(found, 'real ' + name + ' control').toBeDefined(); return found!
}
async function mount(shapes: ScreenshotShape[] = [], source = image) {
  const props = { image: source, busy: false, initialTool: 'pen' as const, initialState: { shapes, crop: null }, onCancel: vi.fn(), onComplete: vi.fn() }
  await act(async () => root.render(<ImageAnnotationEditor key={Math.random()} {...props} />)); await frame()
  const editor = node.querySelector<HTMLElement>('[aria-label="Screenshot editor"]')!, canvas = editor.querySelector('canvas')!
  canvas.setPointerCapture = vi.fn()
  await act(async () => editor.querySelector('img')!.dispatchEvent(new Event('load'))); await frame()
  const pointer = (type: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }))
  const drag = async (from: [number, number], to: [number, number]) => {
    await act(async () => { pointer('pointerdown', ...from); pointer('pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2); pointer('pointerup', ...to) }); await frame()
  }
  const click = async (name: string) => { await act(async () => control<HTMLButtonElement>(editor, 'button', name).click()); await frame() }
  const key = async (value: string, init: KeyboardEventInit = {}) => {
    await act(async () => { canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, ...init })) }); await frame()
  }
  const shapes_ = async (): Promise<ScreenshotShape[]> => { await click('Copy PNG'); return props.onComplete.mock.lastCall![0].shapes }
  const toolButton = (name: string) => control<HTMLButtonElement>(editor.querySelector('.image-annotation-toolbar__tools')!, 'button', name)
  const range = (name: string) => control<HTMLInputElement>(editor, 'input', name)
  return { editor, pointer, drag, click, key, shapes: shapes_, toolButton, range, props }
}
function slide(field: HTMLInputElement, value: number) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, String(value))
  field.dispatchEvent(new Event('input', { bubbles: true }))
}
const note = (id: string, number: number, x: number): NoteShape => ({ id, kind: 'note', color: '#ef4444', width: 2, radius: 12, number, note: id, from: { x, y: 40 }, to: { x, y: 40 } })

describe('pointing-mark entry points in the mounted editor', () => {
  it('offers blur, spotlight and magnifier as toolbar tools with their own letter shortcuts', async () => {
    const { toolButton, key, editor } = await mount()
    for (const [name, letter] of [['Blur', 'U'], ['Spotlight', 'L'], ['Magnifier', 'Z']] as const) {
      expect(toolButton(name).getAttribute('aria-keyshortcuts'), name + ' shortcut').toBe(letter)
      await act(async () => toolButton(name).click()); await frame()
      expect(toolButton(name).getAttribute('aria-pressed'), name + ' toolbar button selects the tool').toBe('true')
      await key('p'); expect(toolButton(name).getAttribute('aria-pressed')).toBe('false')
      await key(letter.toLowerCase()); expect(toolButton(name).getAttribute('aria-pressed'), 'the bare ' + letter + ' key selects ' + name).toBe('true')
    }
    await key('z', { metaKey: true })
    expect(toolButton('Magnifier').getAttribute('aria-pressed'), 'Command Z stays Undo').toBe('true')
    const groups = Object.fromEntries([...editor.querySelectorAll<HTMLElement>('.image-annotation-toolbar__group')].map(group =>
      [group.getAttribute('aria-label'), [...group.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))]))
    expect(groups['Process image'], 'blur sits with the other redaction tools').toEqual(['Crop', 'Magic wand', 'Pixelate', 'Cover', 'Blur', 'Erase'])
    expect(groups['Annotate']).toEqual(['Text', 'Numbered note', 'Spotlight', 'Magnifier'])
  })

  it('draws each pointing tool as its own kind and commits nothing for a click without travel', async () => {
    const { drag, click, shapes, pointer } = await mount()
    for (const name of ['Blur', 'Spotlight', 'Magnifier']) {
      await click(name)
      await act(async () => { pointer('pointerdown', 300, 250); pointer('pointerup', 301, 250) }); await frame()
    }
    expect(await shapes(), 'a click with no drag commits no zero-size mark').toEqual([])
    await click('Blur'); await drag([20, 20], [80, 60])
    await click('Spotlight'); await drag([100, 20], [160, 60])
    await click('Magnifier'); await drag([20, 100], [60, 130])
    const committed = await shapes()
    expect(committed.map(shape => shape.kind), 'each tool draws its own kind').toEqual(['blur', 'spotlight', 'callout'])
    expect(committed[0]).toMatchObject({ from: { x: 20, y: 20 }, to: { x: 80, y: 60 }, radius: 12 })
    expect(committed[1]).toMatchObject({ from: { x: 100, y: 20 }, to: { x: 160, y: 60 }, dim: 0.6 })
    expect(committed[2]).toMatchObject({ from: { x: 20, y: 100 }, to: { x: 60, y: 130 }, zoom: 2.5 })
  })

  it('keeps the magnifier bubble beside its source while drawing, then drags only the bubble after release', async () => {
    const { drag, click, shapes, pointer } = await mount()
    await click('Magnifier')
    await act(async () => { pointer('pointerdown', 20, 20); pointer('pointermove', 60, 50) }); await frame()
    const live = raster.scene.mock.lastCall![2] as CalloutShape
    expect(live.at, 'the bubble follows the source as it grows, never over it').toEqual({ x: 80, y: 20 })
    await act(async () => { pointer('pointermove', 80, 60); pointer('pointerup', 80, 60) }); await frame()
    const drawn = (await shapes())[0] as CalloutShape
    expect(drawn.at, 'the bubble sits right of the final source').toEqual({ x: 100, y: 20 })
    const bubble = calloutBubble(drawn)
    await click('Select')
    await drag([bubble.x + 20, bubble.y + 20], [bubble.x + 50, bubble.y + 100])
    const moved = (await shapes())[0] as CalloutShape
    expect(moved, 'dragging inside the bubble moves only the bubble').toMatchObject({ from: drawn.from, to: drawn.to, at: { x: 130, y: 100 } })
    await drag([20, 40], [30, 50])
    expect((await shapes())[0], 'dragging the source frame moves the whole mark').toMatchObject({ from: { x: 30, y: 30 }, to: { x: 90, y: 70 }, at: { x: 140, y: 110 } })
  })

  it('flips a magnifier bubble drawn near the image edge to the side that keeps it inside the image', async () => {
    const { drag, click, shapes } = await mount()
    await click('Magnifier'); await drag([350, 20], [380, 40])
    const drawn = (await shapes())[0] as CalloutShape, bubble = calloutBubble(drawn)
    expect(drawn.at, 'the bubble flips left of a source at the right edge').toEqual({ x: 255, y: 20 })
    expect(bubble.x + bubble.width).toBeLessThanOrEqual(image.width)
  })

  it('keeps a magnifier bubble the same screen distance from its source when the view is not one to one', async () => {
    // An 800 × 600 image fitted into the 400 × 300 canvas: two image pixels per screen pixel.
    const { drag, click, shapes } = await mount([], { ...image, width: 800, height: 600 })
    await click('Magnifier'); await drag([20, 20], [60, 50])
    const drawn = (await shapes())[0] as CalloutShape
    expect(drawn.from, 'the source is drawn in image pixels').toEqual({ x: 40, y: 40 })
    expect(drawn.at, 'twenty screen points are forty image pixels at half scale').toEqual({ x: 160, y: 40 })
  })

  it('changes a selected pointing mark through its strength control as one Undo step, else sets the next one', async () => {
    const blur: ScreenshotShape = { id: 'blur', kind: 'blur', color: '#111827', radius: 12, from: { x: 20, y: 20 }, to: { x: 80, y: 60 } }
    const spotlight: ScreenshotShape = { id: 'spot', kind: 'spotlight', color: '#ffffff', dim: 0.6, from: { x: 100, y: 20 }, to: { x: 160, y: 60 } }
    const callout: ScreenshotShape = { id: 'zoom', kind: 'callout', color: '#ef4444', zoom: 2, from: { x: 20, y: 200 }, to: { x: 40, y: 220 }, at: { x: 100, y: 200 } }
    const { pointer, click, shapes, range, editor, drag, key } = await mount([blur, spotlight, callout])
    await click('Select')
    const select = async (x: number, y: number) => { await act(async () => { pointer('pointerdown', x, y); pointer('pointerup', x, y) }); await frame() }
    await select(50, 40)
    expect(editor.querySelector('[aria-label="Custom color"]'), 'blur is a mask with no color').toBeNull()
    await act(async () => slide(range('Blur strength'), 30)); await frame()
    await select(100, 40)
    expect(editor.querySelector('[aria-label="Custom color"]'), 'a spotlight paints a fixed color').toBeNull()
    await act(async () => slide(range('Spotlight dimming'), 0.8)); await frame()
    await select(110, 210)
    expect(editor.querySelector('[aria-label="Custom color"]'), 'the magnifier frame and leader take a color').not.toBeNull()
    expect(editor.querySelector('[aria-label="Stroke width"]')).toBeNull()
    await act(async () => slide(range('Magnifier zoom'), 4)); await frame()
    expect((await shapes()).map(shape => [shape.id, 'radius' in shape ? shape.radius : 'dim' in shape ? shape.dim : (shape as CalloutShape).zoom]),
      'the selected mark takes the new strength').toEqual([['blur', 30], ['spot', 0.8], ['zoom', 4]])
    await click('Undo')
    expect((await shapes()).find(shape => shape.id === 'zoom'), 'one Undo restores one strength change').toMatchObject({ zoom: 2 })
    await key('Escape'); await click('Blur')
    expect(editor.querySelector('[aria-label="Magnifier zoom"]'), 'with nothing selected the control follows the tool').toBeNull()
    expect(range('Blur strength').value, 'the unselected control keeps the last chosen strength').toBe('30')
    await drag([200, 100], [260, 140])
    expect((await shapes()).at(-1), 'the next blur uses it').toMatchObject({ kind: 'blur', radius: 30 })
  })

  it('keeps a selected blur strength in image pixels within the model range when the fitted view is not one to one', async () => {
    // An 800 × 600 image fitted into the 400 × 300 canvas: one screen pixel is two image pixels.
    const large = { ...image, width: 800, height: 600 }
    const blur: ScreenshotShape = { id: 'blur', kind: 'blur', color: '#111827', radius: 12, from: { x: 40, y: 40 }, to: { x: 160, y: 120 } }
    const { pointer, click, shapes, range } = await mount([blur], large)
    await click('Select')
    await act(async () => { pointer('pointerdown', 50, 40); pointer('pointerup', 50, 40) }); await frame()
    expect(range('Blur strength').value, 'the control shows the image-pixel radius at any zoom').toBe('12')
    await act(async () => slide(range('Blur strength'), BLUR_RADIUS_RANGE.max)); await frame()
    const edited = await shapes()
    expect(edited[0], 'the strongest blur stays at the model maximum').toMatchObject({ kind: 'blur', radius: BLUR_RADIUS_RANGE.max })
    await act(async () => slide(range('Blur strength'), BLUR_RADIUS_RANGE.min)); await frame()
    const weakest = await shapes()
    expect(weakest[0], 'the weakest blur stays at the model minimum').toMatchObject({ kind: 'blur', radius: BLUR_RADIUS_RANGE.min })
    const limits = { maxDocumentBytes: 1024 * 1024, maxImageBytes: 1024, maxImageDimension: 1000, maxImagePixels: 1000000 }
    const png = { width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
    for (const marks of [edited, weakest])
      expect(() => encodeEditableAnnotationDocument(createEditableAnnotationDocument({ image: png, shapes: marks, crop: null, source: null }, limits), limits),
        'the edited blur saves as an editable original').not.toThrow()
  })

  it('renumbers a gapped original to 1..n with one action and restores it with one Undo', async () => {
    const { click, shapes, editor } = await mount([note('first', 2, 40), note('second', 5, 120), note('third', 9, 200)])
    const renumber = control<HTMLButtonElement>(editor.querySelector('[aria-label="Numbered annotations"]')!, 'button', 'Renumber')
    expect(renumber.disabled).toBe(false)
    await click('Renumber')
    expect((await shapes()).map(shape => (shape as NoteShape).number), 'explicit renumbering makes the numbers continuous').toEqual([1, 2, 3])
    expect(control<HTMLButtonElement>(editor, 'button', 'Renumber').disabled, 'continuous numbers need no renumbering').toBe(true)
    await click('Undo')
    expect((await shapes()).map(shape => (shape as NoteShape).number)).toEqual([2, 5, 9])
    await click('Numbered note')
    await act(async () => {
      const canvas = editor.querySelector('canvas')!
      for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerdown' ? 1 : 0, clientX: 300, clientY: 200 }))
    }); await frame()
    expect((await shapes()).at(-1), 'a new note never duplicates a gapped number').toMatchObject({ kind: 'note', number: 10 })
  })

  it('numbers a new note after every existing note when a saved original repeats a number', async () => {
    // The old max + 1 rule gives 2 here and repeats the count; the model's next number follows all three notes.
    const { click, shapes, editor } = await mount([note('first', 1, 40), note('second', 1, 120), note('third', 1, 200)])
    await click('Numbered note')
    await act(async () => {
      const canvas = editor.querySelector('canvas')!
      for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerdown' ? 1 : 0, clientX: 300, clientY: 200 }))
    }); await frame()
    expect((await shapes()).at(-1), 'a new note takes the number after all existing notes').toMatchObject({ kind: 'note', number: 4 })
  })

  it('offers blur and the magnifier on the light capture toolbar and keeps spotlight in the window editor', () => {
    expect(CAPTURE_TOOLS.map(item => item.id), 'the capture toolbar carries blur and the magnifier but no spotlight')
      .toEqual(['rect', 'ellipse', 'arrow', 'pen', 'wand', 'pixelate', 'blur', 'text', 'note', 'callout'])
  })
})
