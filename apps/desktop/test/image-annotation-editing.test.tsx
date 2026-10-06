// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ImageAnnotationEditor } from '../src/renderer/src/components/image-annotation/ImageAnnotationEditor'
import type { ScreenshotShape } from '../src/renderer/src/components/image-annotation/drawing-model'
import type { ImageViewport } from '../src/renderer/src/components/image-annotation/view'

const raster = vi.hoisted(() => ({ committed: vi.fn(), scene: vi.fn() }))
// Component state, gesture sampling and completion callbacks remain production code. Actual
// raster pixels, allocation bounds and cover opacity are checked by the private Electron proof.
vi.mock('../src/renderer/src/components/image-annotation/canvas-render', () => ({ renderCommittedLayer: raster.committed, renderScreenshotScene: raster.scene }))
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement
let frames: Map<number, FrameRequestCallback>, nextFrame: number
const image = { dataUrl: 'data:image/png;base64,AA==', width: 400, height: 300 }
const rectangle: ScreenshotShape = { id: 'original-rect', kind: 'rect', color: '#ef4444', width: 4, from: { x: 40, y: 50 }, to: { x: 100, y: 100 } }
const arrow: ScreenshotShape = { id: 'original-arrow', kind: 'arrow', color: '#22c55e', width: 4, from: { x: 200, y: 50 }, to: { x: 260, y: 110 } }
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
function button(editor: HTMLElement, name: string): HTMLButtonElement {
  const found = [...editor.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === name || button.textContent?.trim() === name)
  expect(found, 'real ' + name + ' control').toBeDefined(); return found!
}
async function mount(shapes: ScreenshotShape[] = [], source = image) {
  const props = { image: source, busy: false, initialState: { shapes, crop: null }, onCancel: vi.fn(), onComplete: vi.fn(), onCopyContext: vi.fn(), onSaveOriginal: vi.fn(), onOpenOriginal: vi.fn(), onEdited: vi.fn() }
  await act(async () => root.render(<ImageAnnotationEditor {...props} />)); await frame()
  const editor = node.querySelector<HTMLElement>('[aria-label="Screenshot editor"]')!, canvas = editor.querySelector('canvas')!
  expect(editor).not.toBeNull(); canvas.setPointerCapture = vi.fn()
  await act(async () => editor.querySelector('img')!.dispatchEvent(new Event('load'))); await frame()
  const pointer = (type: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1, clientX: x, clientY: y
  }))
  const click = async (name: string) => {
    if (name === 'Open original' || name === 'Save original') {
      await act(async () => { const trigger = button(editor, 'Original file actions'); trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === name + '…')
      expect(item, 'actual original file menu item').toBeDefined()
      await act(async () => item!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    } else await act(async () => button(editor, name).click())
    await frame()
  }
  const output = async (action = 'Copy PNG') => { await click(action); const callback = action === 'Save original' ? props.onSaveOriginal : action === 'Copy context' ? props.onCopyContext : props.onComplete
    expect(callback).toHaveBeenCalled(); return callback.mock.lastCall![0] }
  return { editor, canvas, pointer, click, output, props }
}
function view(): ImageViewport { expect(raster.committed).toHaveBeenCalled(); return raster.committed.mock.lastCall![2] }
function change(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('standalone image annotation editing consumers', () => {
  it('resizes an existing rectangle and arrow endpoint through real handles and preserves their IDs through Undo', async () => {
    const { pointer, click, output } = await mount([rectangle, arrow])
    await click('Select')
    await act(async () => { pointer('pointerdown', 40, 50); pointer('pointerup', 40, 50) })
    await act(async () => { pointer('pointerdown', 100, 100); pointer('pointermove', 120, 110); pointer('pointerup', 150, 140) })
    const resized = { ...rectangle, to: { x: 150, y: 140 } }
    expect((await output()).shapes, 'actual selected corner must resize the original object').toEqual([resized, arrow])
    await click('Undo'); expect((await output()).shapes).toEqual([rectangle, arrow])
    await click('Redo'); expect((await output()).shapes).toEqual([resized, arrow])
    await act(async () => { pointer('pointerdown', 200, 50); pointer('pointerup', 200, 50) })
    await act(async () => { pointer('pointerdown', 260, 110); pointer('pointermove', 270, 120); pointer('pointerup', 290, 150) })
    expect((await output()).shapes).toEqual([resized, { ...arrow, to: { x: 290, y: 150 } }])
  })

  it('anchors wheel zoom, pans with Space, and completes drawing in original pixels without changing export dimensions', async () => {
    const { editor, canvas, pointer, click, output } = await mount([], { ...image, width: 800, height: 600 })
    expect(view().view).toEqual({ scale: .5, x: 0, y: 0 })
    const zoom = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -Math.log(2) / .002, clientX: 100, clientY: 80 })
    // happy-dom's WheelEvent omits inherited MouseEvent coordinates/modifiers. Native CDP
    // proof supplies the actual event; this unit supplies those missing platform properties.
    Object.defineProperties(zoom, { ctrlKey: { value: true }, clientX: { value: 100 }, clientY: { value: 80 } })
    await act(async () => editor.querySelector('.image-annotation-editor__canvas-area')!.dispatchEvent(zoom)); await frame()
    expect(zoom.defaultPrevented).toBe(true); expect(view().view, 'actual wheel zoom must preserve its cursor anchor').toEqual({ scale: 1, x: -100, y: -80 })
    await act(async () => { canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
      pointer('pointerdown', 10, 10); pointer('pointermove', 20, 20); pointer('pointerup', 40, 30)
      canvas.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true })) })
    await frame(); expect(view().view).toEqual({ scale: 1, x: -70, y: -60 })
    await act(async () => { pointer('pointerdown', 130, 90); pointer('pointermove', 145, 100); pointer('pointerup', 160, 110) })
    expect(await output()).toMatchObject({ displayWidth: 800, displayHeight: 600, crop: null,
      shapes: [{ kind: 'pen', width: 4, points: [{ x: 200, y: 150 }, { x: 215, y: 160 }, { x: 230, y: 170 }] }] })
    await click('Fit image'); expect(view().view).toEqual({ scale: .5, x: 0, y: 0 })
    await click('Actual image size'); expect(view().view).toEqual({ scale: 1, x: -200, y: -150 })
  })

  it('edits existing text by button and double click, cancels without replacing it, then commits one object and undoes it', async () => {
    const text: ScreenshotShape = { id: 'original-text', kind: 'text', color: '#ef4444', fontSize: 18, at: { x: 50, y: 60 }, text: 'Original text' }
    const { editor, canvas, pointer, click, output } = await mount([text])
    await click('Select'); await act(async () => { pointer('pointerdown', 55, 65); pointer('pointerup', 55, 65) })
    await click('Edit text')
    let field = editor.querySelector<HTMLInputElement>('[aria-label="Screenshot text"]')!
    expect(field.value).toBe('Original text')
    await act(async () => { change(field, 'Discarded edit'); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    await frame(); expect((await output()).shapes).toEqual([text])
    expect(button(editor, 'Undo').disabled).toBe(true)
    await act(async () => canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 55, clientY: 65 }))); await frame()
    field = editor.querySelector<HTMLInputElement>('[aria-label="Screenshot text"]')!
    expect(field.value).toBe('Original text')
    await act(async () => { change(field, 'Updated text'); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) }); await frame()
    expect((await output()).shapes, 'actual existing text must be replaced in place').toEqual([{ ...text, text: 'Updated text' }])
    await click('Undo'); expect((await output()).shapes).toEqual([text])
    await click('Redo'); expect((await output()).shapes).toEqual([{ ...text, text: 'Updated text' }])
  })

  it('keeps the note draft while changing template, locates the same note, and includes both in Save original and Copy context callbacks', async () => {
    const note: ScreenshotShape = { id: 'original-note', kind: 'note', color: '#3b82f6', number: 2, note: 'Existing observation', template: 'observation', radius: 12, width: 2, from: { x: 50, y: 60 }, to: { x: 100, y: 100 } }
    const { editor, pointer, click, output } = await mount([note])
    await click('Select'); await act(async () => { pointer('pointerdown', 50, 60); pointer('pointerup', 50, 60) })
    const draft = editor.querySelector<HTMLTextAreaElement>('[aria-label="Note text"]')!, template = editor.querySelector<HTMLSelectElement>('[aria-label="Note template"]')!
    expect(draft.value).toBe('Existing observation'); expect(template.value).toBe('observation')
    await act(async () => change(draft, 'Expected layout after the change'))
    await act(async () => { template.value = 'expected'; template.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(draft.value).toBe('Expected layout after the change')
    await click('Locate')
    expect(view().view).toEqual({ scale: 2, x: 62, y: 2 })
    for (const action of ['Save original', 'Copy context']) expect((await output(action)).shapes)
      .toEqual([{ ...note, note: 'Expected layout after the change', template: 'expected' }])
    await click('Undo'); expect((await output()).shapes).toEqual([note])
  })

  it('keeps an existing edge text editor inside the viewport at actual size and high zoom without changing its image coordinates or font', async () => {
    const text: ScreenshotShape = { id: 'edge-text', kind: 'text', color: '#ffffff', fontSize: 18, at: { x: 390, y: 285 }, text: 'Text near the original edge' }
    const { editor, pointer, click, output } = await mount([text])
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    await click('Select'); await act(async () => { pointer('pointerdown', 395, 290); pointer('pointerup', 395, 290) })
    await click('Actual image size')
    for (const zoomed of [false, true]) {
      if (zoomed) for (let count = 0; count < 6; count++) await click('Zoom in')
      await click('Edit text')
      const field = editor.querySelector<HTMLInputElement>('[aria-label="Screenshot text"]')!
      const box = { left: parseFloat(field.style.left), top: parseFloat(field.style.top), width: parseFloat(field.style.width), height: parseFloat(field.style.height) }
      // happy-dom has no CSS layout. Consume the production-assigned UI geometry here;
      // the native fixture separately checks the actual browser rectangle and scrolling.
      expect(box.width).toBe(280); expect(box.height).toBeGreaterThan(0)
      expect(box.left).toBeGreaterThanOrEqual(0); expect(box.top).toBeGreaterThanOrEqual(0)
      expect(box.left + box.width, 'the actual input width stays within its viewport').toBeLessThanOrEqual(400)
      expect(box.top + box.height, 'the actual input height stays within its viewport').toBeLessThanOrEqual(300)
      expect(parseFloat(field.style.fontSize)).toBeLessThanOrEqual(32)
      expect(field.style.color, 'the editing control uses readable theme text while the annotation stays white').toBe('var(--text)')
      expect(document.activeElement).toBe(field); expect(focus).toHaveBeenLastCalledWith({ preventScroll: true })
      await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))); await frame()
      expect((await output()).shapes, 'UI clamping must preserve the original object and font in output').toEqual([text])
    }
  })

  it('discards a resize on pointer cancellation and a pan on Escape without closing the editor or altering the object', async () => {
    const { canvas, pointer, click, output, props } = await mount([rectangle])
    await click('Select'); await act(async () => { pointer('pointerdown', 40, 50); pointer('pointerup', 40, 50) })
    await act(async () => { pointer('pointerdown', 100, 100); pointer('pointermove', 180, 160); pointer('pointercancel', 180, 160); pointer('pointerup', 180, 160) })
    expect((await output()).shapes).toEqual([rectangle])
    await click('Pan')
    await act(async () => { pointer('pointerdown', 20, 20); pointer('pointermove', 80, 70) }); await frame()
    expect(view().view).toEqual({ scale: 1, x: 60, y: 50 })
    await act(async () => canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))); await frame()
    expect(view().view).toEqual({ scale: 1, x: 0, y: 0 }); expect(props.onCancel).not.toHaveBeenCalled()
    await act(async () => canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(props.onCancel).toHaveBeenCalledOnce()
  })

  it('locates the complete large numbered region after high zoom instead of retaining a clipped magnification', async () => {
    const note: ScreenshotShape = { id: 'large-note', kind: 'note', color: '#ef4444', width: 2, radius: 12, number: 1, note: 'Whole region', from: { x: 25, y: 30 }, to: { x: 370, y: 270 } }
    const { click, output } = await mount([note])
    await click('Actual image size')
    for (let count = 0; count < 8; count++) await click('Zoom in')
    expect(view().view.scale).toBeGreaterThan(4)
    await click('Note 1'); await click('Locate')
    const current = view().view
    for (const at of [{ x: 13, y: 18 }, { x: 370, y: 270 }]) {
      expect(at.x * current.scale + current.x).toBeGreaterThanOrEqual(0)
      expect(at.x * current.scale + current.x).toBeLessThanOrEqual(400)
      expect(at.y * current.scale + current.y).toBeGreaterThanOrEqual(0)
      expect(at.y * current.scale + current.y).toBeLessThanOrEqual(300)
    }
    expect((await output()).shapes).toEqual([note])
  })

  it('preserves Space for a focused button and keeps a failed image editor available for Open or Cancel', async () => {
    const { editor, click, props } = await mount()
    const control = button(editor, 'Zoom in'), space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    await act(async () => { control.focus(); control.dispatchEvent(space) })
    expect(space.defaultPrevented).toBe(false)
    await act(async () => editor.querySelector('img')!.dispatchEvent(new Event('error')))
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(node.querySelector('[aria-label="Screenshot editor"]')).toBe(editor)
    expect(editor.querySelector('[role="alert"]')).not.toBeNull()
    expect(button(editor, 'Original file actions').disabled).toBe(false)
    await click('Open original'); expect(props.onOpenOriginal).toHaveBeenCalledOnce()
    await click('Cancel'); expect(props.onCancel).toHaveBeenCalledOnce()
  })
})
