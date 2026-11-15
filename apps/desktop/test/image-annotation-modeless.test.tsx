// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ImageAnnotationEditor } from '../src/renderer/src/components/image-annotation/ImageAnnotationEditor'
import type { AnnotationTool } from '../src/renderer/src/components/image-annotation/AnnotationToolbar'
import type { ScreenshotShape } from '@agentmux/client-ui/image-annotation'

const raster = vi.hoisted(() => ({ committed: vi.fn(), scene: vi.fn() }))
// Component state, gestures and output callbacks are production code; only raster drawing is replaced.
vi.mock('@agentmux/client-ui/image-annotation', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/client-ui/image-annotation')>(), renderCommittedLayer: raster.committed, renderScreenshotScene: raster.scene }))
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement
let frames: Map<number, FrameRequestCallback>, nextFrame: number
const image = { dataUrl: 'data:image/png;base64,AA==', width: 400, height: 300 }
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
// initialTool null mounts without the prop, so the remembered tool decides.
type Options = { shapes?: ScreenshotShape[]; initialTool?: AnnotationTool | null; onComplete?: ReturnType<typeof vi.fn>; onRetake?: ReturnType<typeof vi.fn> }
async function mount({ shapes = [], initialTool = 'rect', onComplete = vi.fn(), onRetake }: Options = {}) {
  const props = { image, busy: false, initialState: { shapes, crop: null }, onCancel: vi.fn(), onComplete, onCopyContext: vi.fn(), onSavePng: vi.fn(), ...(onRetake ? { onRetake } : {}) }
  await act(async () => root.render(<ImageAnnotationEditor key={Math.random()} {...props} {...(initialTool ? { initialTool } : {})} />)); await frame()
  const editor = node.querySelector<HTMLElement>('[aria-label="Screenshot editor"]')!, canvas = editor.querySelector('canvas')!
  canvas.setPointerCapture = vi.fn()
  await act(async () => editor.querySelector('img')!.dispatchEvent(new Event('load'))); await frame()
  const gesture = async (from: [number, number], to: [number, number] = from) => {
    await act(async () => {
      const send = (type: string, [x, y]: [number, number]) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }))
      send('pointerdown', from); send('pointermove', to); send('pointerup', to)
    }); await frame()
  }
  const key = async (key: string, init: KeyboardEventInit = {}, target: EventTarget = canvas) => {
    await act(async () => { canvas.focus(); target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) }); await frame()
  }
  const click = async (name: string) => { await act(async () => button(editor, name).click()); await frame() }
  const copy = async () => { await click('Copy PNG'); expect(props.onComplete).toHaveBeenCalled(); return props.onComplete.mock.lastCall![0].shapes as ScreenshotShape[] }
  return { editor, canvas, gesture, key, click, copy, props }
}

async function copy(props: { onComplete: ReturnType<typeof vi.fn> }) {
  const editor = node.querySelector<HTMLElement>('[aria-label="Screenshot editor"]')!
  await act(async () => button(editor, 'Copy PNG').click()); await frame()
  return props.onComplete.mock.lastCall![0].shapes as ScreenshotShape[]
}
describe('modeless image annotation', () => {
  it('a drawing tool moves the existing mark it presses instead of drawing over it', async () => {
    const { gesture, copy } = await mount({ shapes: [arrow] })
    await gesture([230, 80], [250, 100])
    const shapes = await copy()
    expect(shapes, 'actual press on an existing mark must not add a rectangle').toHaveLength(1)
    expect(shapes[0], 'actual press on an existing mark moves it').toMatchObject({ id: arrow.id, kind: 'arrow', from: { x: 220, y: 70 }, to: { x: 280, y: 130 } })
  })

  it('a new rectangle stays selected so Color recolors it without switching to Select', async () => {
    const { editor, gesture, click, copy } = await mount()
    await gesture([40, 40], [120, 100])
    expect(button(editor, 'Delete selected').disabled, 'actual new rectangle is selected').toBe(false)
    expect(editor.querySelector('.image-annotation-editor__tool-name')?.textContent).toBe('Rectangle')
    await click('Color #3b82f6')
    expect(await copy(), 'actual Color applies to the new rectangle').toEqual([expect.objectContaining({ kind: 'rect', color: '#3b82f6', from: { x: 40, y: 40 }, to: { x: 120, y: 100 } })])
    // The handle of the selected rectangle resizes it in the Rectangle tool.
    await gesture([120, 100], [160, 140])
    expect(await copy(), 'actual handle resizes the selected rectangle').toEqual([expect.objectContaining({ kind: 'rect', from: { x: 40, y: 40 }, to: { x: 160, y: 140 } })])
  })

  it('a click without travel adds no region mark and no Undo entry', async () => {
    const { editor, gesture, click, copy } = await mount()
    await gesture([60, 60], [62, 61])
    expect(await copy(), 'actual stray click creates no rectangle').toEqual([])
    expect(button(editor, 'Undo').disabled, 'actual stray click leaves Undo empty').toBe(true)
    await click('Crop'); await gesture([30, 30], [31, 32])
    expect(editor.querySelector('.image-annotation-editor__footer')?.textContent, 'actual stray click keeps the original frame').toContain('Original image')
  })

  it('a note click opens its inline input and the typed note reaches the output', async () => {
    const { editor, gesture, copy } = await mount({ initialTool: 'note' })
    await gesture([100, 80])
    const field = editor.querySelector<HTMLTextAreaElement>('[aria-label="Marker note"]')
    expect(field, 'actual note click opens the inline note input').not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Line one\nLine two')
      field!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => field!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))); await frame()
    expect(editor.querySelector('[aria-label="Marker note"]'), 'modifier Enter closes the inline note input').toBeNull()
    expect(await copy(), 'actual inline note text reaches the output').toEqual([expect.objectContaining({ kind: 'note', number: 1, note: 'Line one\nLine two', from: { x: 100, y: 80 }, to: { x: 100, y: 80 } })])
  })

  it('Escape peels selection and tool before asking to discard unkept marks', async () => {
    const { editor, gesture, key, click, props } = await mount()
    await gesture([40, 40], [120, 100])
    await click('Arrow')
    await key('Escape')
    expect(button(editor, 'Delete selected').disabled, 'first Escape clears the selection').toBe(true)
    await key('Escape')
    expect(editor.querySelector('.image-annotation-editor__tool-name')?.textContent, 'second Escape returns to the opening tool').toBe('Rectangle')
    await key('Escape')
    expect(props.onCancel, 'actual Escape with unkept marks must not close').not.toHaveBeenCalled()
    expect(editor.querySelector('.image-annotation-editor__discard')?.textContent, 'actual discard bar names the marks').toContain('Discard 1 annotation?')
    await click('Keep editing')
    expect(editor.querySelector('.image-annotation-editor__discard')).toBeNull()
    await click('Cancel'); await click('Discard')
    expect(props.onCancel).toHaveBeenCalledOnce()
    const { editor: next, gesture: draw, key: press, props: nextProps } = await mount()
    await draw([40, 40], [120, 100]); await press('Escape'); await press('Escape')
    expect(next.querySelector('.image-annotation-editor__discard')).not.toBeNull()
    await press('Escape')
    expect(nextProps.onCancel, 'second Escape on the discard bar confirms').toHaveBeenCalledOnce()
  })

  it('Retake asks in place naming the unkept marks and retakes only once confirmed', async () => {
    const plain = await mount()
    expect([...plain.editor.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Retake'), 'no Retake without a host that can retake').toBe(false)
    const onRetake = vi.fn()
    const { editor, gesture, key, click, props } = await mount({ onRetake })
    expect(button(editor, 'Retake').getAttribute('aria-keyshortcuts')).toBe('Shift+Meta+R')
    await click('Retake')
    expect(onRetake, 'nothing to lose retakes at once').toHaveBeenCalledOnce()
    await gesture([40, 40], [120, 100]); await gesture([200, 40], [260, 100])
    await key('r', { metaKey: true, shiftKey: true })
    expect(onRetake, 'actual unkept marks are confirmed before a retake').toHaveBeenCalledOnce()
    expect(editor.querySelector('.image-annotation-editor__discard')?.textContent, 'actual retake confirmation names the marks').toContain('Discard 2 annotations and retake?')
    await key('Escape')
    expect([editor.querySelector('.image-annotation-editor__discard'), onRetake.mock.calls.length, props.onCancel.mock.calls.length], 'Escape keeps editing').toEqual([null, 1, 0])
    await click('Retake'); await click('Keep editing')
    expect(onRetake).toHaveBeenCalledOnce()
    await click('Retake'); await click('Discard & retake')
    expect([onRetake.mock.calls.length, props.onCancel.mock.calls.length], 'confirming retakes and does not close the editor').toEqual([2, 0])
    expect((await copy(props)).length, 'the marks stay until the new capture takes over').toBe(2)
    await key('r', { metaKey: true, shiftKey: true }); await key('Enter')
    expect(onRetake, 'Enter on the retake confirmation retakes').toHaveBeenCalledTimes(3)
    await key('r', { metaKey: true })
    expect(editor.querySelector('.image-annotation-editor__discard'), 'Command R alone is not Retake').toBeNull()
  })

  it('an output the host confirms as kept lets Escape close without asking', async () => {
    const onComplete = vi.fn(async () => true)
    const { editor, gesture, key, click, props } = await mount({ onComplete })
    await gesture([40, 40], [120, 100])
    await click('Copy PNG'); await act(async () => { await Promise.resolve() })
    await key('Escape'); await key('Escape')
    expect(editor.querySelector('.image-annotation-editor__discard'), 'actual confirmed output needs no discard bar').toBeNull()
    expect(props.onCancel, 'actual confirmed output closes on Escape').toHaveBeenCalledOnce()
  })

  it('Enter and Command C deliver the primary output and Command S saves the PNG', async () => {
    const { canvas, gesture, key, props } = await mount()
    await gesture([40, 40], [120, 100])
    await key('Enter')
    expect(props.onComplete, 'actual Enter delivers the primary output').toHaveBeenCalledTimes(1)
    await key('c', { metaKey: true })
    expect(props.onComplete, 'actual Command C delivers the primary output').toHaveBeenCalledTimes(2)
    await key('s', { ctrlKey: true })
    expect(props.onSavePng).toHaveBeenCalledTimes(1)
    expect(props.onComplete.mock.lastCall![0].shapes).toEqual([expect.objectContaining({ kind: 'rect' })])
    const select = document.createElement('select'); canvas.parentElement!.append(select)
    await key('Enter', {}, select)
    expect(props.onComplete, 'Enter inside a form control stays with that control').toHaveBeenCalledTimes(2)
  })

  it('opens with initialTool and otherwise carries the last tool and color to the next editor', async () => {
    const first = await mount({ initialTool: 'ellipse' })
    expect(first.editor.querySelector('.image-annotation-editor__tool-name')?.textContent).toBe('Ellipse')
    await first.click('Arrow'); await first.click('Color #3b82f6')
    const { editor, gesture, copy } = await mount({ initialTool: null })
    expect(editor.querySelector('.image-annotation-editor__tool-name')?.textContent, 'actual remembered tool opens the next editor').toBe('Arrow')
    await gesture([40, 40], [120, 100])
    expect(await copy(), 'actual remembered color draws the next mark').toEqual([expect.objectContaining({ kind: 'arrow', color: '#3b82f6' })])
  })
})
