// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ImageAnnotationEditor } from '../src/renderer/src/components/image-annotation/ImageAnnotationEditor'
import { shapeBounds, type NoteShape, type RectShape, type ScreenshotShape } from '@agentmux/client-ui/image-annotation'
import { createEditableAnnotationDocument, encodeEditableAnnotationDocument, parseEditableAnnotationDocument } from '../src/renderer/src/components/image-annotation/document'
import { ANNOTATION_DOCUMENT_LIMITS } from '../src/renderer/src/components/browser-screenshot/document-files'

const raster = vi.hoisted(() => ({ committed: vi.fn(), scene: vi.fn() }))
// Component state, gestures, commands and outputs are production code; only raster drawing is replaced.
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
const box = (id: string, x: number, y: number, width = 40, height = 30, extra: Partial<RectShape> = {}): RectShape =>
  ({ id, kind: 'rect', color: '#ef4444', width: 2, from: { x, y }, to: { x: x + width, y: y + height }, ...extra })
const note = (id: string, number: number, x: number, y: number): NoteShape =>
  ({ id, kind: 'note', color: '#ef4444', width: 2, radius: 10, number, note: id, from: { x, y }, to: { x: x + 40, y: y + 30 } })
// Three marks in a row; each rectangle's top-left edge at (x, y) is where a press hits its outline.
const row = (): ScreenshotShape[] => [box('a', 20, 40), box('b', 120, 80), box('c', 260, 60)]

async function mount(shapes: ScreenshotShape[] = row(), presentation: 'window' | 'capture' = 'window') {
  const props = presentation === 'capture'
    ? { image, busy: false, presentation, pixelRatio: 1, initialState: { shapes, crop: { x: 0, y: 0, width: 400, height: 300 } }, onCancel: vi.fn(), onComplete: vi.fn() }
    : { image, busy: false, initialTool: 'select' as const, initialState: { shapes, crop: null }, onCancel: vi.fn(), onComplete: vi.fn() }
  await act(async () => root.render(<ImageAnnotationEditor key={Math.random()} {...props} />)); await frame()
  const editor = node.querySelector<HTMLElement>('[aria-label="Screenshot editor"]')!, canvas = editor.querySelector('canvas')!
  canvas.setPointerCapture = vi.fn()
  await act(async () => editor.querySelector('img')!.dispatchEvent(new Event('load'))); await frame()
  const pointer = (type: string, x: number, y: number, shiftKey = false) => canvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, shiftKey }))
  const press = async (x: number, y: number, shiftKey = false) => { await act(async () => { pointer('pointerdown', x, y, shiftKey); pointer('pointerup', x, y, shiftKey) }); await frame() }
  const drag = async (from: [number, number], to: [number, number], shiftKey = false) => {
    await act(async () => { pointer('pointerdown', ...from, shiftKey); pointer('pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, shiftKey) }); await frame()
    await act(async () => { pointer('pointerup', ...to, shiftKey) }); await frame()
  }
  const hover = async (x: number, y: number) => { await act(async () => { canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, buttons: 0, clientX: x, clientY: y })) }); await frame() }
  const key = async (value: string, init: KeyboardEventInit = {}) => {
    await act(async () => { canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init })) }); await frame()
  }
  const click = async (name: string) => { await act(async () => control<HTMLButtonElement>(editor, 'button', name).click()); await frame() }
  // The document a Copy PNG hands over, read through the real output path.
  const output = async (): Promise<ScreenshotShape[]> => {
    if (presentation === 'capture') { await key('Enter') } else await click('Copy PNG')
    return props.onComplete.mock.lastCall![0].shapes
  }
  const ids = (shapes: readonly ScreenshotShape[]) => shapes.map(shape => shape.id)
  const by = (shapes: readonly ScreenshotShape[], id: string) => shapes.find(shape => shape.id === id)!
  const hint = () => editor.querySelector('.image-annotation-editor__properties .image-annotation-editor__hint')?.textContent ?? ''
  const arrange = () => editor.querySelector('[aria-label="Arrange annotations"]')
  return { editor, canvas, press, drag, hover, key, click, output, ids, by, hint, arrange, props }
}
// The last group outline the scene painted, read from what the editor reports as selected.
const selectedCount = (hint: string) => Number(/^(\d+) selected/.exec(hint)?.[1] ?? 0)

describe('object editing in the mounted editor', () => {
  it('a marquee from empty canvas selects the unlocked marks it touches; a click there clears the selection', async () => {
    const { drag, press, hint, arrange } = await mount([...row(), box('locked', 150, 150, 40, 30, { locked: true })])
    await drag([10, 30], [200, 200])
    expect(selectedCount(hint()), 'the marquee caught a and b, never the locked mark inside it').toBe(2)
    expect(arrange(), 'two selected marks offer the arrange group').not.toBeNull()
    await press(390, 290)
    expect(hint(), 'a click on empty canvas clears the selection').toContain('Click an annotation')
  })

  it('Shift-click adds a mark to the selection and Shift-click again removes it', async () => {
    const { press, hint } = await mount()
    await press(20, 40)
    await press(120, 80, true)
    expect(selectedCount(hint()), 'Shift-click adds b to a').toBe(2)
    await press(260, 60, true)
    expect(selectedCount(hint())).toBe(3)
    await press(120, 80, true)
    expect(selectedCount(hint()), 'Shift-click on a member removes it').toBe(2)
    await press(120, 80)
    expect(hint(), 'a plain click selects only that mark').toContain('Drag handles')
  })

  it('dragging one selected mark moves the whole group as one Undo step', async () => {
    const { press, drag, key, output, by } = await mount()
    await press(20, 40); await press(120, 80, true)
    await drag([20, 40], [50, 60])
    const moved = await output()
    expect([by(moved, 'a').from, by(moved, 'b').from], 'both members move by the drag').toEqual([{ x: 50, y: 60 }, { x: 150, y: 100 }])
    expect(by(moved, 'c').from, 'the unselected mark stays').toEqual({ x: 260, y: 60 })
    await key('z', { metaKey: true })
    const undone = await output()
    expect([by(undone, 'a').from, by(undone, 'b').from], 'one Undo restores the whole group move').toEqual([{ x: 20, y: 40 }, { x: 120, y: 80 }])
  })

  it('a group drag keeps the committed layer of the other marks and draws only its members each frame', async () => {
    const mask: ScreenshotShape = { id: 'm', kind: 'pixelate', color: '#000000', blockSize: 8, from: { x: 300, y: 200 }, to: { x: 380, y: 280 } }
    const { press, key, canvas } = await mount([...row(), mask])
    await press(20, 40); await press(120, 80, true)
    const pointer = (type: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }))
    await act(async () => { pointer('pointerdown', 20, 40); pointer('pointermove', 25, 45) }); await frame()
    const committedAtStart = raster.committed.mock.calls.length
    for (const step of [30, 35, 40, 45]) { await act(async () => { pointer('pointermove', step, step + 20) }); await frame() }
    expect(raster.committed.mock.calls.length, 'moving the group re-renders no committed layer per frame').toBe(committedAtStart)
    const drawn = raster.scene.mock.lastCall![2] as ScreenshotShape[]
    expect(drawn.map(shape => shape.id).sort(), 'each frame draws only the moving members above the cached layer').toEqual(['a', 'b'])
    await act(async () => { pointer('pointerup', 45, 65) }); await frame()
    await key('Escape')
  })

  it('Delete removes every selected mark and arrows nudge them all', async () => {
    const { press, key, output, ids, by } = await mount()
    await press(20, 40); await press(260, 60, true)
    await key('ArrowRight', { shiftKey: true })
    const nudged = await output()
    expect([by(nudged, 'a').from.x, by(nudged, 'c').from.x, by(nudged, 'b').from.x], 'Shift-arrow nudges each selected mark by ten').toEqual([30, 270, 120])
    await key('Delete')
    expect(ids(await output()), 'Delete removes the group').toEqual(['b'])
  })

  it('align and distribute in the property row act on the group as one Undo step', async () => {
    const { press, click, key, output, by, arrange, editor } = await mount()
    await press(20, 40); await press(120, 80, true)
    expect(arrange()?.querySelector('[aria-label="Distribute horizontally"]'), 'two marks cannot distribute').toBeNull()
    await click('Align top')
    const aligned = await output()
    expect([by(aligned, 'a').from.y, by(aligned, 'b').from.y], 'align top uses the group bounds').toEqual([40, 40])
    await press(260, 60, true)
    await click('Align left')
    const left = await output()
    expect(['a', 'b', 'c'].map(id => by(left, id).from.x), 'align left moves all three to the leftmost edge').toEqual([20, 20, 20])
    await key('z', { metaKey: true })
    const undone = await output()
    expect(['a', 'b', 'c'].map(id => by(undone, id).from.x), 'one Undo restores the alignment').toEqual([20, 120, 260])
    await click('Distribute horizontally')
    const spread = (await output()).map(shape => shapeBounds(shape)).sort((first, second) => first.x - second.x)
    expect(spread[1]!.x - (spread[0]!.x + spread[0]!.width), 'equal gaps').toBeCloseTo(spread[2]!.x - (spread[1]!.x + spread[1]!.width), 5)
    expect(editor.querySelector('.image-annotation-editor__capture-bar'), 'the window editor shows no capture bar').toBeNull()
  })

  it('stacking shortcuts reorder only the marks, and a mask never moves under a mark', async () => {
    const mask: ScreenshotShape = { id: 'mask', kind: 'cover', color: '#111827', from: { x: 300, y: 200 }, to: { x: 380, y: 280 } }
    const { press, key, output, ids } = await mount([...row(), mask])
    await press(20, 40)
    await key('}', { metaKey: true, shiftKey: true })
    expect(ids(await output()), 'Shift forward brings a to the front of the marks').toEqual(['b', 'c', 'a', 'mask'])
    await key('[', { metaKey: true })
    expect(ids(await output()), 'backward moves a one step down').toEqual(['b', 'a', 'c', 'mask'])
    await key('{', { metaKey: true, shiftKey: true })
    expect(ids(await output()), 'Shift backward sends a to the back').toEqual(['a', 'b', 'c', 'mask'])
    await key(']', { metaKey: true })
    expect(ids(await output()), 'forward moves a one step up').toEqual(['b', 'a', 'c', 'mask'])
    await press(310, 210)
    await key('[', { metaKey: true, shiftKey: false })
    expect(ids(await output()).at(-1), 'the only mask stays in its own layer above every mark').toBe('mask')
  })

  it('locking keeps a mark out of hit, erase, marquee and moves until it is unlocked', async () => {
    const { press, key, drag, hover, output, by, editor, click, hint } = await mount()
    await press(20, 40)
    await key('l', { metaKey: true })
    expect(by(await output(), 'a').locked, 'Command-L locks the selected mark').toBe(true)
    expect(hint(), 'a locked mark leaves the selection').toContain('Click an annotation')
    await key('z', { metaKey: true })
    expect(hint(), 'undoing the lock brings the mark back unselected, as undoing a delete does').toContain('Click an annotation')
    await key('z', { metaKey: true, shiftKey: true })
    await press(20, 40)
    expect(hint(), 'a click on a locked mark selects nothing').toContain('Click an annotation')
    await drag([20, 40], [80, 90])
    expect(by(await output(), 'a').from, 'a drag on a locked mark does not move it').toEqual({ x: 20, y: 40 })
    await key('l', { metaKey: true })
    expect(by(await output(), 'a').locked, 'Command-L with nothing selected leaves the lock alone').toBe(true)
    await key('a', { metaKey: true })
    expect(selectedCount(hint()), 'Select All skips the locked mark').toBe(2)
    await key('z', { metaKey: true })
    expect(selectedCount(hint()), 'undoing the lock does not add a mark Select All skipped').toBe(2)
    await key('z', { metaKey: true, shiftKey: true })
    await key('l', { metaKey: true })
    expect((await output()).map(shape => shape.locked), 'Command-L locks what Select All chose and keeps a locked').toEqual([true, true, true])
    await click('Erase')
    await drag([15, 40], [30, 45])
    expect(by(await output(), 'a'), 'erase passes over a locked mark').toBeDefined()
    expect(editor.querySelector('[aria-label="Unlock annotation"]'), 'the lock shows only on hover').toBeNull()
    await hover(40, 55)
    control<HTMLButtonElement>(editor, 'button', 'Unlock annotation')
    await hover(390, 290)
    expect(editor.querySelector('[aria-label="Unlock annotation"]'), 'the lock hides once the pointer leaves').toBeNull()
    await hover(40, 55)
    await click('Unlock annotation')
    expect((await output()).map(shape => shape.locked), 'the lock badge unlocks only its mark').toEqual([undefined, true, true])
    await key('v')
    await click('Unlock all')
    expect((await output()).map(shape => Object.hasOwn(shape, 'locked')), 'Unlock all clears every lock').toEqual([false, false, false])
    expect(hint(), 'unlocked marks come back unselected').toContain('Click an annotation')
  })

  it('a mark Redo locks while selected is inert, and comes back unselected once unlocked', async () => {
    const { press, key, click, output, by, hint } = await mount()
    await press(20, 40); await key('l', { metaKey: true })
    await key('z', { metaKey: true }); await press(20, 40); await key('z', { metaKey: true, shiftKey: true })
    expect(by(await output(), 'a').locked, 'Redo locks the mark again').toBe(true)
    expect(hint(), 'a mark Redo locks drops out of the selection').toContain('Click an annotation')
    await key('ArrowRight')
    expect(by(await output(), 'a').from, 'arrows do not move a locked mark').toEqual({ x: 20, y: 40 })
    await click('Unlock all')
    expect(hint(), 'the unlocked mark is not selected again').toContain('Click an annotation')
  })

  it('Select All takes the marks it shows: never a note hidden under a mask', async () => {
    const mask: ScreenshotShape = { id: 'mask', kind: 'cover', color: '#111827', from: { x: 300, y: 200 }, to: { x: 390, y: 290 } }
    const { key, hint, output, ids } = await mount([box('a', 20, 40), note('hidden', 1, 320, 220), note('shown', 2, 120, 80), mask])
    await key('a', { metaKey: true })
    expect(selectedCount(hint()), 'Select All selects a, the shown note and the mask, not the hidden note').toBe(3)
    await key('Delete')
    expect(ids(await output()), 'Delete then removes only what Select All showed').toEqual(['hidden'])
  })

  it('duplicate and session paste give fresh ids and next note numbers without touching the system clipboard', async () => {
    const write = vi.fn(), read = vi.fn()
    vi.stubGlobal('navigator', { ...navigator, clipboard: { write, read, writeText: write, readText: read } })
    const { press, key, output, ids, by } = await mount([note('n1', 1, 40, 40), box('b', 120, 80)])
    await press(40, 40); await press(120, 80, true)
    await key('d', { metaKey: true })
    const duplicated = await output()
    expect(duplicated, 'Command-D adds a copy of each selected mark').toHaveLength(4)
    expect(new Set(ids(duplicated)).size, 'every copy has its own id').toBe(4)
    expect(duplicated.filter(shape => shape.kind === 'note').map(shape => (shape as NoteShape).number), 'the copied note takes the next number').toEqual([1, 2])
    await key('c', { metaKey: true, shiftKey: true })
    await key('v', { metaKey: true, shiftKey: true })
    const pasted = await output()
    expect(new Set(ids(pasted)).size, 'pasted marks have fresh ids').toBe(6)
    expect(pasted.slice(4).map(shape => shapeBounds(shape).x), 'the paste lands one step past the copies it was taken from').toEqual(duplicated.slice(2).map(shape => shapeBounds(shape).x + 10))
    expect(pasted.slice(0, 4), 'paste keeps every earlier mark').toEqual(duplicated)
    expect([write, read].every(spy => spy.mock.calls.length === 0), 'mark copy and paste never reach the system clipboard').toBe(true)
  })

  it('color and width apply to every selected mark that has them, as one Undo step', async () => {
    const text: ScreenshotShape = { id: 't', kind: 'text', color: '#ef4444', at: { x: 120, y: 200 }, text: 'Label', fontSize: 18 }
    const { press, editor, key, output, by } = await mount([...row(), text])
    await press(20, 40); await press(120, 80, true); await press(125, 205, true)
    await act(async () => control<HTMLButtonElement>(editor, 'button', 'Color #3b82f6').click()); await frame()
    const colored = await output()
    expect(['a', 'b', 't'].map(id => by(colored, id).color), 'every selected mark takes the color').toEqual(['#3b82f6', '#3b82f6', '#3b82f6'])
    expect(by(colored, 'c').color).toBe('#ef4444')
    const width = control<HTMLSelectElement>(editor, 'select', 'Stroke width')
    await act(async () => { width.value = '8'; width.dispatchEvent(new Event('change', { bubbles: true })) }); await frame()
    const widened = await output()
    expect([by(widened, 'a'), by(widened, 'b')].map(shape => (shape as RectShape).width), 'width reaches the marks that have it').toEqual([8, 8])
    expect('width' in by(widened, 't'), 'text gains no stroke width').toBe(false)
    await key('z', { metaKey: true })
    expect((by(await output(), 'a') as RectShape).width, 'one Undo restores the group width').toBe(2)
  })

  it('a capture keeps the object shortcuts and adds no object buttons to its bar', async () => {
    const { key, output, ids, editor, by } = await mount(row(), 'capture')
    const bar = editor.querySelector('.image-annotation-editor__capture-bar')!
    // The bar's own buttons; the property popover it hosts grows with a selection, as it did for one mark.
    const own = () => [...bar.querySelectorAll('button')].filter(button => !button.closest('.image-annotation-editor__capture-properties'))
    const before = own().length
    await key('a', { metaKey: true })
    await key('d', { metaKey: true })
    const shapes = await output()
    expect(shapes, 'Command-A then Command-D duplicates every mark in a capture').toHaveLength(6)
    expect(shapes.slice(3).map(shape => shapeBounds(shape).x), 'each copy sits one step right of its own source').toEqual(shapes.slice(0, 3).map(shape => shapeBounds(shape).x + 10))
    expect(new Set(ids(shapes)).size, 'every copy has its own id').toBe(6)
    expect(editor.querySelector('[aria-label="Arrange annotations"]'), 'a capture shows no arrange group').toBeNull()
    expect(own().length, 'the capture bar keeps its buttons').toBe(before)
    const labels = [...bar.querySelectorAll('button')].map(button => button.getAttribute('aria-label') ?? button.textContent)
    expect(labels.filter(label => /^(Align|Distribute|Unlock)/.test(label ?? '')), 'no object command reaches the capture bar').toEqual([])
  })

  it('a reopened document keeps a locked mark locked in the editor and in its output', async () => {
    const png = { width: 1, height: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }
    const saved = createEditableAnnotationDocument({ image: png, shapes: [box('a', 20, 40, 40, 30, { locked: true }), box('b', 120, 80)], crop: null, source: null }, ANNOTATION_DOCUMENT_LIMITS)
    const reopened = parseEditableAnnotationDocument(encodeEditableAnnotationDocument(saved, ANNOTATION_DOCUMENT_LIMITS), ANNOTATION_DOCUMENT_LIMITS)
    const { press, hint, output, by, editor } = await mount(reopened.shapes)
    await press(20, 40)
    expect(hint(), 'the reopened locked mark is not selectable').toContain('Click an annotation')
    control<HTMLButtonElement>(editor, 'button', 'Unlock all')
    expect(by(await output(), 'a').locked, 'the output keeps the lock').toBe(true)
  })
})
