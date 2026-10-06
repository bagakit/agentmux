// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ImageAnnotationEditor } from '../src/renderer/src/components/image-annotation/ImageAnnotationEditor'
import { SCREENSHOT_COLORS, SCREENSHOT_WIDTHS, SCREENSHOT_FONT_SIZES } from '../src/renderer/src/components/image-annotation/drawing-model'

// No browser process or rasterization: exercise real controls, sizing and source CSS.
// Actual pointer hits, wrapping geometry and native painting remain in the product probe.
const raster = vi.hoisted(() => ({ committed: vi.fn(), scene: vi.fn() }))
vi.mock('../src/renderer/src/components/image-annotation/canvas-render', () => ({
  renderCommittedLayer: raster.committed, renderScreenshotScene: raster.scene
}))
let root: Root | undefined
let available = { width: 240, height: 120 }
let observers: Array<{ callback: ResizeObserverCallback; nodes: Element[] }> = []
let frames = new Map<number, FrameRequestCallback>(), nextFrame = 0
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.innerHTML = ''; document.head.innerHTML = ''
  observers = []
  frames.clear(); vi.clearAllMocks()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function rect(width: number, height: number): DOMRect {
  return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON() {} }
}
async function mount(busy = false) {
  available = { width: 240, height: 120 }
  frames = new Map(); nextFrame = 0
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('ResizeObserver', class {
    readonly record: { callback: ResizeObserverCallback; nodes: Element[] }
    constructor(callback: ResizeObserverCallback) { this.record = { callback, nodes: [] }; observers.push(this.record) }
    observe(element: Element) { this.record.nodes.push(element) }
    unobserve() {}
    disconnect() {}
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('image-annotation-editor__canvas-area')) return rect(available.width, available.height)
    if (this.classList.contains('image-annotation-editor__viewport')) return rect(Number.parseFloat(this.style.width), Number.parseFloat(this.style.height))
    return rect(240, 300)
  })
  const css = readFileSync(join(import.meta.dirname, '../src/renderer/src/components/image-annotation/image-annotation.css'), 'utf8')
  const style = document.createElement('style')
  style.textContent = ':root{--sp-1:2px;--sp-2:4px;--sp-3:6px;--sp-4:8px;--sp-6:12px;}\n'+css
  document.head.append(style)
  const node = document.createElement('div'); document.body.append(node)
  const anchor = document.createElement('div'); anchor.dataset.nativeBrowserStage = ''; document.body.append(anchor)
  const props = { image: { mimeType: 'image/png' as const, dataUrl: 'data:image/png;base64,AA==', width: 400, height: 300, byteLength: 1 }, busy, onCancel: vi.fn(), onComplete: vi.fn() }
  root = createRoot(node)
  await act(async () => root!.render(<ImageAnnotationEditor {...props} />))
  await flushFrames()
  const editor = document.querySelector<HTMLElement>('.image-annotation-editor')!
  expect(editor).not.toBeNull()
  return { editor, props }
}
async function flushFrames() {
  await act(async () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(16) })
}
function button(editor: HTMLElement, name: string): HTMLButtonElement {
  const result = [...editor.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === name || b.textContent?.trim() === name)
  expect(result, name).toBeDefined()
  return result!
}

it('fits the original image to the remaining Canvas area, not the complete editor behind controls', async () => {
  const { editor } = await mount()
  const area = editor.querySelector('.image-annotation-editor__canvas-area')
  const viewport = editor.querySelector<HTMLElement>('.image-annotation-editor__viewport')!
  expect(area).not.toBeNull()
  expect(viewport.parentElement).toBe(area)
  expect(viewport.style.width).toBe('240px')
  expect(viewport.style.height).toBe('120px')
  // The bitmap remains bounded by the available viewport. Its actual renderer transform fits
  // the complete original image inside that area, leaving 40px horizontal margins.
  expect(raster.committed.mock.lastCall![2]).toMatchObject({ width: 240, height: 120, imageWidth: 400, imageHeight: 300,
    view: { scale: .4, x: 40, y: 0 } })
  expect(editor.querySelector('[role=toolbar]')!.parentElement).toBe(editor)
})

it('updates image fit when controls reduce available height while the outer editor is unchanged', async () => {
  const { editor } = await mount()
  const area = editor.querySelector('.image-annotation-editor__canvas-area')!
  const related = observers.find(o => o.nodes.includes(area))
  expect(related).toBeDefined()
  expect(editor.getBoundingClientRect()).toMatchObject({ width: 240, height: 300 })
  available.height = 90
  await act(async () => related!.callback([], {} as ResizeObserver))
  await flushFrames()
  const viewport = editor.querySelector<HTMLElement>('.image-annotation-editor__viewport')!
  expect(viewport.style.width).toBe('240px')
  expect(viewport.style.height).toBe('90px')
  expect(raster.committed.mock.lastCall![2]).toMatchObject({ width: 240, height: 90, view: { scale: .3, x: 60, y: 0 } })
  expect(editor.getBoundingClientRect()).toMatchObject({ width: 240, height: 300 })
})

it('keeps the real palette, width, text size, drawing history, Copy and Cancel handlers', async () => {
  const { editor, props } = await mount()
  expect(SCREENSHOT_COLORS.length).toBeGreaterThan(0)
  expect([...editor.querySelectorAll('.image-annotation-toolbar__colors button')].map(b => b.getAttribute('aria-label'))).toEqual(SCREENSHOT_COLORS.map(c => `Color ${c}`))
  const selected = SCREENSHOT_COLORS.at(-1)!
  await act(async () => button(editor, `Color ${selected}`).click())
  expect(button(editor, `Color ${selected}`).getAttribute('aria-pressed')).toBe('true')
  const width = editor.querySelector<HTMLSelectElement>('select[aria-label="Stroke width"]')!
  expect([...width.options].map(o => Number(o.value))).toEqual([...SCREENSHOT_WIDTHS])
  await act(async () => { width.value = '8'; width.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(width.value).toBe('8')
  const canvas = editor.querySelector('canvas')!
  canvas.setPointerCapture = vi.fn()
  await act(async () => canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 60, clientY: 25 })))
  await act(async () => canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 85, clientY: 25 })))
  await act(async () => canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 85, clientY: 25 })))
  expect(button(editor, 'Undo').disabled).toBe(false)
  await act(async () => button(editor, 'Undo').click())
  expect(button(editor, 'Redo').disabled).toBe(false)
  await act(async () => button(editor, 'Redo').click())
  await act(async () => editor.querySelector('img')!.dispatchEvent(new Event('load')))
  await act(async () => button(editor, 'Copy PNG').click())
  expect(props.onComplete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ displayWidth: 400, displayHeight: 300, crop: null, shapes: [expect.objectContaining({ color: selected, width: 20, points: [{ x: 50, y: 62.5 }, { x: 112.5, y: 62.5 }] })] }))
  await act(async () => button(editor, 'Text').click())
  expect([...editor.querySelector<HTMLSelectElement>('select[aria-label="Text size"]')!.options].map(o => Number(o.value))).toEqual([...SCREENSHOT_FONT_SIZES])
  await act(async () => button(editor, 'Cancel').click())
  expect(props.onCancel).toHaveBeenCalledTimes(1)
})

it('keeps completion actions and relevant parameters outside the independent canvas area', async () => {
  const { editor } = await mount()
  const sheet = document.styleSheets[0]!
  const rules = [...sheet.cssRules].filter(r => r.cssText.includes('image-annotation-toolbar'))
  expect(rules.length).toBeGreaterThan(0)
  const toolbar = editor.querySelector<HTMLElement>('[role=toolbar]')!
  const tools = toolbar.querySelector<HTMLElement>('.image-annotation-toolbar__tools')!
  const properties = editor.querySelector<HTMLElement>('.image-annotation-editor__properties')!
  const colors = properties.querySelector<HTMLElement>('.image-annotation-toolbar__colors')!
  expect(getComputedStyle(editor).display).toBe('flex')
  expect(getComputedStyle(editor).flexDirection).toBe('column')
  expect(getComputedStyle(toolbar).position).toBe('relative')
  expect(getComputedStyle(toolbar).flexWrap).toBe('wrap')
  expect(properties.closest('.image-annotation-editor__canvas-area')).toBeNull()
  expect(getComputedStyle(tools).display).toBe('contents')
  expect(getComputedStyle(colors).flexShrink).toBe('0')
  expect(getComputedStyle(colors).maxWidth).toBe('100%')
  expect(getComputedStyle(colors).flexWrap).toBe('wrap')
  const actions = editor.querySelector<HTMLElement>('.image-annotation-toolbar__actions')!
  expect(getComputedStyle(actions).flexWrap).toBe('wrap')
  expect(getComputedStyle(actions).maxWidth).toBe('100%')
  expect(getComputedStyle(properties.querySelector('select')!).flexShrink).toBe('0')
})

it('retains one toolbar and the complete actions without a repeated instructional sentence', async () => {
  const { editor } = await mount()
  expect(editor.querySelectorAll('[role=toolbar]')).toHaveLength(1)
  expect(editor.textContent).not.toContain('Mark the frozen page, then copy a PNG.')
  expect(button(editor, 'Cancel').disabled).toBe(false)
  expect(button(editor, 'Copy PNG')).toBeDefined()
  expect(editor.querySelector('canvas')).not.toBeNull()
})

it('keeps Cancel available while image encoding or clipboard acknowledgement is busy', async () => {
  const { editor, props } = await mount(true)
  const controls = [...editor.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select')]
  expect(controls.length).toBeGreaterThan(SCREENSHOT_COLORS.length)
  const available = ['Cancel', 'Pan', 'Fit image', 'Actual image size', 'Zoom in', 'Zoom out'].map(name => button(editor, name))
  expect(controls.filter(control => !available.includes(control as HTMLButtonElement)).map(control => control.disabled))
    .toEqual(Array(controls.length - available.length).fill(true))
  expect(available.map(control => control.disabled)).toEqual(available.map(() => false))
  expect(button(editor, 'Cancel').disabled).toBe(false)
  await act(async () => button(editor, 'Cancel').click())
  expect(props.onCancel).toHaveBeenCalledOnce()
  await act(async () => button(editor, 'Copying…').click())
  expect(props.onComplete).not.toHaveBeenCalled()
})
