// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import type { AppConfig, BrowserPng, BrowserScreenshotCapture } from '../src/shared/contracts'

const fixture = vi.hoisted(() => ({
  state: {
    applyBrowserEvent: vi.fn(),
    executeControl: vi.fn(async () => ({ operation: 'browser.history', operations: [] })),
    reportError: vi.fn(), setConfig: vi.fn(),
    saveBrowserBookmark: vi.fn(), openFile: vi.fn(), addBrowserAnnotation: vi.fn(),
    browserAnnotationsByBrowserId: {}, noticeReadReceipts: {},
    toolsOpen: false, config: null as AppConfig | null
  },
  compose: vi.fn(), committed: vi.fn(), paint: vi.fn()
}))

vi.mock('../src/renderer/src/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state, setState: vi.fn(), subscribe: () => () => {} }
  )
}))
// Raster output and PNG encoding have native proof. Keep the real Pane, Editor, input handlers,
// history and copy/cancel token here; only the Canvas implementation and async encoder are replaced.
vi.mock('../src/renderer/src/components/browser-screenshot/canvas-render', () => ({
  renderCommittedLayer: fixture.committed, renderScreenshotScene: fixture.paint
}))
vi.mock('../src/renderer/src/components/browser-screenshot/compose', async importOriginal => ({
  ...await importOriginal<typeof import('../src/renderer/src/components/browser-screenshot/compose')>(),
  composeScreenshot: fixture.compose
}))
vi.mock('../src/renderer/src/lib/browser-stage-geometry', () => ({
  observeBrowserStageGeometry(_stage: HTMLElement, update: () => void, active: boolean) {
    if (active) update()
    return () => {}
  }
}))

import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { api } from '../src/renderer/src/lib/api'

const page = {
  id: 'screenshot-original-browser', browserId: 'screenshot-original-browser',
  navigationId: 'screenshot-original-navigation', regionId: 'screenshot-original-region',
  workspaceId: 'screenshot-original-workspace', kind: 'browser' as const,
  profileId: 'screenshot-original-profile', url: 'https://example.invalid/screenshot', title: 'Original page',
  loading: false, canGoBack: false, canGoForward: false, viewport: 'responsive' as const,
  driving: false, appLinkPrompt: null, error: null
}
const image: BrowserPng = {
  mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==', width: 400, height: 300, byteLength: 1
}
const capture: BrowserScreenshotCapture = { browserId: page.browserId, navigationId: page.navigationId, image,
  source: { url: page.url, title: page.title, viewport: { width: 400, height: 300, deviceScaleFactor: 1 }, viewportWarning: null } }
const pageBounds = { x: 80, y: 120, width: 400, height: 300 }

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() {} }
}
let container: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
let frames: Map<number, FrameRequestCallback>, nextFrame: number
let bounds: ReturnType<typeof vi.spyOn<typeof api.browser, 'setBounds'>>
let clipboard: ReturnType<typeof vi.spyOn<typeof api.ui, 'writeClipboardImage'>>
let clipboardText: ReturnType<typeof vi.spyOn<typeof api.ui, 'writeClipboardText'>>
let captureScreenshot: ReturnType<typeof vi.spyOn<typeof api.browser, 'captureScreenshot'>>
let release: ReturnType<typeof vi.spyOn<typeof api.browser, 'release'>>
let restore: ReturnType<typeof vi.spyOn<typeof api.browser, 'restore'>>
let navigate: ReturnType<typeof vi.spyOn<typeof api.browser, 'navigate'>>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // api was imported under the normal preview test adapter. The mounted Pane must exercise its
  // native bounds branch, where screenshot mode temporarily hides the original Browser owner.
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  frames = new Map(); nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextFrame; frames.set(id, callback); return id
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id) }))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-native-browser-stage')) return rect(80, 120, 400, 300)
    if (this.classList.contains('browser-screenshot-editor__viewport')) {
      return rect(0, 0, Number.parseFloat(this.style.width), Number.parseFloat(this.style.height))
    }
    return rect(0, 0, 400, 300)
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  fixture.state.config = {
    version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local fixture' }],
    executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
  }
  vi.clearAllMocks()
  bounds = vi.spyOn(api.browser, 'setBounds').mockResolvedValue(undefined)
  clipboard = vi.spyOn(api.ui, 'writeClipboardImage').mockResolvedValue(undefined)
  clipboardText = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  captureScreenshot = vi.spyOn(api.browser, 'captureScreenshot').mockResolvedValue(capture)
  vi.spyOn(api.browser, 'setAnnotationMarkers').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'cancelElementSelection').mockResolvedValue(undefined)
  release = vi.spyOn(api.browser, 'release').mockResolvedValue(undefined)
  restore = vi.spyOn(api.browser, 'restore').mockResolvedValue(page)
  navigate = vi.spyOn(api.browser, 'navigate').mockResolvedValue(page)
  fixture.compose.mockResolvedValue(image)
  container = document.createElement('div'); document.body.append(container)
  root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function flushFrames() {
  // One browser frame, then the microtasks from its real bounds synchronizer. Do not run a
  // frame between pointer samples: the point retention test explicitly controls that boundary.
  await act(async () => {
    const pending = [...frames]; frames.clear()
    for (const [, callback] of pending) callback(16)
  })
}
async function mount(snapshot = page, visible = true) {
  await act(async () => root.render(<BrowserPane tab={snapshot} visible={visible} />))
  await flushFrames()
  expect(container.querySelector('[data-native-browser-stage]')).not.toBeNull()
}
function button(scope: ParentNode, name: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .find(node => node.getAttribute('aria-label') === name || node.textContent?.trim() === name)
  expect(found, `real ${name} control`).toBeDefined()
  return found!
}
function editor(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[aria-label="Screenshot editor"]')
  expect(found, 'the original BrowserPane must mount its real ScreenshotEditor').not.toBeNull()
  return found!
}
async function openScreenshot(entry: 'toolbar' | 'more' = 'toolbar') {
  if (entry === 'more') {
    await act(async () => {
      const trigger = button(container, 'More browser tools')
      trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    const item = document.querySelector<HTMLElement>('.browser-menu [role="menuitem"][aria-label="Screenshot"]')
    expect(item, 'the original More menu Screenshot action').not.toBeNull()
    await act(async () => item!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  } else {
    expect(button(container, 'Screenshot').disabled).toBe(false)
    await act(async () => button(container, 'Screenshot').click())
  }
  await flushFrames()
  const opened = editor()
  await act(async () => opened.querySelector('img')!.dispatchEvent(new Event('load')))
  return opened
}
async function cancel(method: 'Cancel' | 'Escape') {
  await act(async () => {
    if (method === 'Cancel') button(editor(), 'Cancel').click()
    else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await flushFrames()
}
function originalPageKept() {
  expect(container.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!.value).toBe(page.url)
  expect(bounds.mock.calls.every(([id]) => id === page.browserId)).toBe(true)
  expect(release).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
  expect(fixture.state.reportError).not.toHaveBeenCalled()
}
function pointerInput(opened: HTMLElement) {
  const canvas = opened.querySelector('canvas')!
  canvas.setPointerCapture = vi.fn()
  return (type: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, clientX: x, clientY: y
  }))
}
async function copyInput(opened: HTMLElement) {
  const previous = fixture.compose.mock.calls.length
  await act(async () => button(opened, 'Copy PNG').click())
  expect(fixture.compose.mock.calls.length).toBe(previous + 1)
  expect(editor()).toBe(opened)
  expect(button(opened, 'Copy PNG').disabled).toBe(false)
  return fixture.compose.mock.lastCall![0]
}

describe('original Browser screenshot workface', () => {
  it.each(['Enter', 'Escape'] as const)('%s finishes the actual text field, returns focus to its Canvas, and lets the next Escape exit', async key => {
    await mount(); const opened = await openScreenshot(), pointer = pointerInput(opened)
    await act(async () => button(opened, 'Text').click())
    await act(async () => { pointer('pointerdown', 85, 90); pointer('pointerup', 85, 90) })
    await flushFrames()
    const canvas = opened.querySelector('canvas')!
    const field = opened.querySelector<HTMLInputElement>('[aria-label="Screenshot text"]')!
    expect(field).not.toBeNull()
    await act(async () => {
      field.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Markup text')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.activeElement).toBe(field)
    const finish = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    await act(async () => field.dispatchEvent(finish))
    await flushFrames()
    expect(finish.defaultPrevented).toBe(true)
    expect(opened.querySelector('[aria-label="Screenshot text"]')).toBeNull()
    expect(editor()).toBe(opened)
    expect(fixture.committed.mock.lastCall![1]).toEqual(key === 'Enter'
      ? [expect.objectContaining({ kind: 'text', text: 'Markup text', at: { x: 85, y: 90 } })] : [])

    const focused = document.activeElement
    const exit = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => window.dispatchEvent(exit))
    await flushFrames()
    expect({ canvasFocused: focused === canvas, exitConsumed: exit.defaultPrevented,
      editorClosed: !container.querySelector('[aria-label="Screenshot editor"]') },
    `Text completion left focus on ${focused?.tagName} ${focused?.getAttribute('aria-label') ?? ''}`)
      .toEqual({ canvasFocused: true, exitConsumed: true, editorClosed: true })
    expect(bounds).toHaveBeenLastCalledWith(page.browserId, pageBounds)
    expect(clipboard).not.toHaveBeenCalled(); expect(clipboardText).not.toHaveBeenCalled()
    originalPageKept()
  })

  it('commits pending text exactly once on blur to an external textarea, preserving that field and its Escape input', async () => {
    await mount(); const opened = await openScreenshot(), pointer = pointerInput(opened)
    await act(async () => button(opened, 'Text').click())
    await act(async () => { pointer('pointerdown', 85, 90); pointer('pointerup', 85, 90) })
    await flushFrames()
    const field = opened.querySelector<HTMLInputElement>('[aria-label="Screenshot text"]')!
    expect(field).not.toBeNull()
    await act(async () => {
      field.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Text committed on blur')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.activeElement).toBe(field)
    const external = document.createElement('textarea'), draft = 'External editor draft'
    external.value = draft; document.body.append(external)
    try {
      await act(async () => { external.focus(); external.setSelectionRange(2, 8) })
      await flushFrames()
      expect(opened.querySelector('[aria-label="Screenshot text"]')).toBeNull()
      expect(fixture.committed.mock.lastCall![1]).toEqual([
        expect.objectContaining({ kind: 'text', text: 'Text committed on blur', at: { x: 85, y: 90 } })
      ])
      expect(document.activeElement).toBe(external)
      expect(external.value).toBe(draft)
      expect(external.selectionStart).toBe(2); expect(external.selectionEnd).toBe(8)
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      await act(async () => external.dispatchEvent(event))
      await flushFrames()
      expect(event.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(external)
      expect(external.value).toBe(draft)
      expect(external.selectionStart).toBe(2); expect(external.selectionEnd).toBe(8)
      expect(fixture.committed.mock.lastCall![1]).toHaveLength(1)
      expect(editor()).toBe(opened)
      await cancel('Cancel'); originalPageKept()
    } finally { external.remove() }
  })

  it('keeps the same numbered object and unblurred note draft while its Pane is hidden, then copies context and cancels after showing it', async () => {
    await mount(); const opened = await openScreenshot(), pointer = pointerInput(opened)
    await act(async () => {
      button(opened, 'Numbered note').click()
    })
    await act(async () => {
      pointer('pointerdown', 40, 50); pointer('pointermove', 130, 120); pointer('pointerup', 130, 120)
    })
    const note = fixture.committed.mock.lastCall![1][0]
    expect(note).toMatchObject({ kind: 'note', number: 1, note: '' })
    const draft = 'Original note draft before blur'
    const field = opened.querySelector<HTMLTextAreaElement>('[aria-label="Note text"]')!
    expect(field).not.toBeNull()
    await act(async () => {
      field.focus()
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, draft)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.activeElement).toBe(field)
    expect(field.value).toBe(draft)
    expect(fixture.committed.mock.lastCall![1][0]).toMatchObject({ id: note.id, note: '' })
    expect(fixture.compose).not.toHaveBeenCalled()

    await mount(page, false)
    expect(editor()).toBe(opened)
    expect(opened.style.display).toBe('none')
    expect(opened.querySelector('[aria-label="Note text"]')).toBe(field)
    expect(field.value).toBe(draft)
    const inactiveEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => window.dispatchEvent(inactiveEscape))
    expect(inactiveEscape.defaultPrevented).toBe(false)
    expect(editor()).toBe(opened)
    expect(clipboard).not.toHaveBeenCalled(); expect(clipboardText).not.toHaveBeenCalled()

    await mount(page, true)
    expect(editor()).toBe(opened)
    expect(opened.style.display).toBe('')
    expect(opened.querySelector('[aria-label="Note text"]')).toBe(field)
    expect(field.value).toBe(draft)
    await act(async () => button(opened, 'Copy context').click())
    expect(fixture.compose).toHaveBeenCalledTimes(1)
    expect(fixture.compose.mock.lastCall![0].shapes).toEqual([expect.objectContaining({ id: note.id, kind: 'note', number: 1, note: draft })])
    expect(clipboardText).toHaveBeenCalledTimes(1)
    const text = clipboardText.mock.lastCall![0], context = JSON.parse(text.slice(text.indexOf('{')))
    expect(context.annotations).toEqual([expect.objectContaining({ id: note.id, kind: 'note', number: 1, note: draft })])
    expect(editor()).toBe(opened); expect(captureScreenshot).toHaveBeenCalledTimes(1)
    await cancel('Cancel')
    expect(container.querySelector('[aria-label="Screenshot editor"]')).toBeNull()
    expect(bounds).toHaveBeenLastCalledWith(page.browserId, pageBounds)
    originalPageKept()
  })

  it('leaves Escape and drafts with an external input or textarea, while Escape from its actual Canvas cancels the editor', async () => {
    await mount(); const opened = await openScreenshot()
    const external = document.createElement('div'); document.body.append(external)
    try {
      for (const tag of ['input', 'textarea'] as const) {
        const field = document.createElement(tag), draft = 'External ' + tag + ' draft'
        external.append(field); field.value = draft
        await act(async () => { field.focus(); field.setSelectionRange(1, 5) })
        expect(document.activeElement).toBe(field)
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        await act(async () => field.dispatchEvent(event))
        expect(event.defaultPrevented).toBe(false)
        expect(field.value).toBe(draft)
        expect(field.selectionStart).toBe(1); expect(field.selectionEnd).toBe(5)
        expect(editor()).toBe(opened)
        expect(bounds).toHaveBeenLastCalledWith(page.browserId, null)
      }
      const canvas = opened.querySelector('canvas')!
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      await act(async () => { canvas.focus(); expect(document.activeElement).toBe(canvas); canvas.dispatchEvent(event) })
      await flushFrames()
      expect(event.defaultPrevented).toBe(true)
      expect(container.querySelector('[aria-label="Screenshot editor"]')).toBeNull()
      expect(bounds).toHaveBeenLastCalledWith(page.browserId, pageBounds)
      expect(captureScreenshot).toHaveBeenCalledTimes(1)
      expect(clipboard).not.toHaveBeenCalled(); expect(clipboardText).not.toHaveBeenCalled()
      originalPageKept()
    } finally { external.remove() }
  })

  it('successful PNG copy preserves the actual Editor, allows a second explicit copy, then Cancel restores the page', async () => {
    await mount(); const opened = await openScreenshot()
    await copyInput(opened); await copyInput(opened)
    expect(clipboard.mock.calls).toEqual([[image], [image]])
    expect(captureScreenshot).toHaveBeenCalledTimes(1)
    expect(bounds).toHaveBeenLastCalledWith(page.browserId, null)
    await cancel('Cancel')
    expect(bounds).toHaveBeenLastCalledWith(page.browserId, pageBounds)
    originalPageKept()
  })

  it('keeps screenshot editing and context copy available when the exact captured viewport is unknown', async () => {
    captureScreenshot.mockResolvedValueOnce({ ...capture, source: { ...capture.source, viewport: null, viewportWarning: 'Viewport observation unavailable' } })
    await mount(); const opened = await openScreenshot()
    await act(async () => button(opened, 'Copy context').click())
    expect(clipboardText).toHaveBeenCalledTimes(1)
    const text = clipboardText.mock.calls[0]![0], context = JSON.parse(text.slice(text.indexOf('{')))
    expect(context.source).toEqual({ ...capture.source, viewport: null, viewportWarning: 'Viewport observation unavailable' })
    expect(editor()).toBe(opened)
    expect(button(opened, 'Copy PNG').disabled).toBe(false)
    await cancel('Cancel'); originalPageKept()
  })

  it.each(['Copy PNG', 'Copy context'] as const)('%s keeps a late clipboard rejection scoped to its cancelled Editor', async kind => {
    const waiting = deferred<void>(), sink = kind === 'Copy PNG' ? clipboard : clipboardText
    sink.mockReturnValueOnce(waiting.promise)
    await mount(); const opened = await openScreenshot()
    await act(async () => button(opened, kind).click())
    expect(sink).toHaveBeenCalledTimes(1)
    expect(button(opened, 'Cancel').disabled).toBe(false)
    await cancel('Cancel'); const next = await openScreenshot()
    await act(async () => waiting.reject(new Error('Old clipboard write failed after Cancel')))
    expect(fixture.state.reportError).not.toHaveBeenCalled()
    expect(editor()).toBe(next); expect(button(next, 'Copy PNG').disabled).toBe(false)
    await cancel('Cancel'); originalPageKept()
  })

  it('actual Crop and Pixelate omit a hidden or covered note from the copied context', async () => {
    await mount(); const opened = await openScreenshot(), pointer = pointerInput(opened)
    const drag = async (x: number, y: number, toX: number, toY: number) => act(async () => {
      pointer('pointerdown', x, y); pointer('pointermove', toX, toY); pointer('pointerup', toX, toY)
    })
    await act(async () => button(opened, 'Numbered note').click()); await drag(40, 40, 110, 100)
    const field = opened.querySelector<HTMLTextAreaElement>('[aria-label="Note text"]')!
    expect(field).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Private original note')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const copyContext = async () => {
      const before = clipboardText.mock.calls.length
      await act(async () => button(opened, 'Copy context').click())
      expect(clipboardText.mock.calls.length).toBe(before + 1)
      const text = clipboardText.mock.lastCall![0]
      return { text, receipt: JSON.parse(text.slice(text.indexOf('{'))) }
    }
    const visible = await copyContext()
    expect(visible.receipt.annotations).toEqual([expect.objectContaining({ kind: 'note', number: 1, note: 'Private original note' })])
    await act(async () => button(opened, 'Crop').click()); await drag(200, 150, 380, 280)
    const cropped = await copyContext()
    expect(cropped.receipt.crop).toEqual({ x: 200, y: 150, width: 180, height: 130 })
    expect(cropped.receipt.annotations).toEqual([]); expect(cropped.text).not.toContain('Private original note')
    await act(async () => button(opened, 'Undo').click())
    await act(async () => button(opened, 'Pixelate').click()); await drag(20, 20, 135, 115)
    const masked = await copyContext()
    expect(masked.receipt.annotations).toEqual([expect.objectContaining({ kind: 'pixelate' })])
    expect(masked.text).not.toContain('Private original note')
    await cancel('Cancel'); originalPageKept()
  })

  it('real Select, Delete, Erase, Crop, Pixelate and editable numbered-note controls feed copy and context consumers', async () => {
    await mount(); const opened = await openScreenshot(), pointer = pointerInput(opened)
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await act(async () => {
        pointer('pointerdown', from.x, from.y); pointer('pointermove', to.x, to.y); pointer('pointerup', to.x, to.y)
      })
    }
    await drag({ x: 30, y: 40 }, { x: 90, y: 70 })
    const original = (await copyInput(opened)).shapes[0]
    expect(original).toMatchObject({ kind: 'pen', points: [{ x: 30, y: 40 }, { x: 90, y: 70 }] })
    await act(async () => button(opened, 'Select').click())
    await drag({ x: 30, y: 40 }, { x: 50, y: 70 })
    const moved = (await copyInput(opened)).shapes[0]
    expect(moved).toMatchObject({ id: original.id, kind: 'pen', points: [{ x: 50, y: 70 }, { x: 110, y: 100 }] })
    expect(button(opened, 'Delete selected').disabled).toBe(false)
    await act(async () => button(opened, 'Delete selected').click())
    expect((await copyInput(opened)).shapes).toEqual([])
    await act(async () => button(opened, 'Undo').click())
    expect((await copyInput(opened)).shapes).toEqual([moved])
    await act(async () => button(opened, 'Erase').click())
    await drag({ x: 50, y: 70 }, { x: 50, y: 70 })
    expect((await copyInput(opened)).shapes).toEqual([])
    await act(async () => button(opened, 'Undo').click())
    expect((await copyInput(opened)).shapes).toEqual([moved])
    await act(async () => button(opened, 'Crop').click())
    await drag({ x: 20, y: 20 }, { x: 300, y: 220 })
    expect((await copyInput(opened)).crop).toEqual({ x: 20, y: 20, width: 280, height: 200 })
    await act(async () => button(opened, 'Undo').click())
    expect((await copyInput(opened)).crop).toBeNull()
    await act(async () => button(opened, 'Pixelate').click())
    await drag({ x: 140, y: 100 }, { x: 240, y: 180 })
    expect((await copyInput(opened)).shapes).toEqual([moved, expect.objectContaining({ kind: 'pixelate', from: { x: 140, y: 100 }, to: { x: 240, y: 180 } })])
    await act(async () => button(opened, 'Numbered note').click())
    await drag({ x: 40, y: 150 }, { x: 130, y: 230 })
    const noteField = opened.querySelector<HTMLInputElement | HTMLTextAreaElement>('[aria-label="Note text"]')
    expect(noteField).not.toBeNull()
    await act(async () => {
      const prototype = noteField instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(noteField, 'Check original control')
      noteField!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect((await copyInput(opened)).shapes).toEqual([moved, expect.objectContaining({ kind: 'pixelate' }), expect.objectContaining({ kind: 'note', number: 1, note: 'Check original control' })])
    await act(async () => button(opened, 'Copy context').click())
    expect(clipboardText).toHaveBeenCalledTimes(1)
    expect(clipboardText.mock.calls[0]![0]).toContain('Check original control')
    expect(clipboardText.mock.calls[0]![0]).toContain(page.url)
    await act(async () => button(opened, 'Delete selected').click())
    await act(async () => button(opened, 'Copy context').click())
    expect(clipboardText).toHaveBeenCalledTimes(2)
    expect(clipboardText.mock.lastCall![0]).not.toContain('Check original control')
    await cancel('Cancel'); originalPageKept()
  })

  it.each(['Cancel', 'Escape'] as const)('%s exits the real editor and restores the same Browser bounds', async method => {
    await mount()
    expect(bounds).toHaveBeenLastCalledWith(page.browserId, pageBounds)
    bounds.mockClear()
    const stage = container.querySelector('[data-native-browser-stage]')!
    const opened = await openScreenshot(method === 'Escape' ? 'more' : 'toolbar')
    expect(captureScreenshot).toHaveBeenCalledExactlyOnceWith(page.browserId)
    expect(opened.closest('[data-native-browser-stage]')).toBe(stage)
    expect(document.querySelector('[data-overlay-host] .browser-screenshot-editor')).toBeNull()
    expect(bounds).toHaveBeenLastCalledWith(page.browserId, null)
    expect(button(opened, 'Cancel').disabled).toBe(false)
    await cancel(method)
    expect(container.querySelector('[aria-label="Screenshot editor"]')).toBeNull()
    expect(container.querySelector('[data-native-browser-stage]')).toBe(stage)
    expect(bounds).toHaveBeenLastCalledWith(page.browserId, pageBounds)
    expect(button(container, 'Screenshot').disabled).toBe(false)
    expect(clipboard).not.toHaveBeenCalled()
    originalPageKept()
  })

  it.each([
    ['Copy PNG', 'Cancel'], ['Copy PNG', 'Escape'], ['Copy context', 'Cancel'], ['Copy context', 'Escape']
  ] as const)('%s with %s during composition keeps late output out of the clipboard and a new editor', async (kind, method) => {
    const waiting = deferred<BrowserPng>()
    fixture.compose.mockReturnValueOnce(waiting.promise)
    await mount(); const opened = await openScreenshot()
    await act(async () => button(opened, kind).click())
    expect(fixture.compose).toHaveBeenCalledTimes(1)
    const composed = fixture.compose.mock.calls[0]![0]
    expect(composed.image).toBe(opened.querySelector('img'))
    expect(composed).toMatchObject({ shapes: [], displayWidth: 400, displayHeight: 300 })
    expect(button(opened, 'Copying…').disabled).toBe(true)
    expect(button(opened, 'Cancel').disabled).toBe(false)
    await cancel(method)
    expect(container.querySelector('[aria-label="Screenshot editor"]')).toBeNull()
    expect(bounds).toHaveBeenLastCalledWith(page.browserId, pageBounds)
    const next = await openScreenshot()
    expect(next).not.toBe(opened)
    await act(async () => waiting.resolve(image))
    expect(clipboard).not.toHaveBeenCalled()
    expect(clipboardText).not.toHaveBeenCalled()
    expect(editor()).toBe(next)
    expect(button(next, 'Copy PNG').disabled).toBe(false)
    expect(bounds).toHaveBeenLastCalledWith(page.browserId, null)
    await cancel('Cancel'); originalPageKept()
  })

  it('ignores a late capture after navigation and rejects a capture for a foreign Browser identity', async () => {
    const waiting = deferred<BrowserScreenshotCapture>()
    captureScreenshot.mockReturnValueOnce(waiting.promise)
    await mount()
    await act(async () => button(container, 'Screenshot').click())
    await mount({ ...page, navigationId: 'new-original-navigation' })
    await act(async () => waiting.resolve(capture))
    expect(container.querySelector('[aria-label="Screenshot editor"]')).toBeNull()
    expect(clipboard).not.toHaveBeenCalled(); expect(fixture.state.reportError).not.toHaveBeenCalled()
    captureScreenshot.mockResolvedValueOnce({ ...capture, browserId: 'foreign-browser' })
    await act(async () => button(container, 'Screenshot').click())
    expect(container.querySelector('[aria-label="Screenshot editor"]')).toBeNull()
    expect(fixture.state.reportError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Browser page changed before the screenshot editor opened' }))
    expect(button(container, 'Screenshot').disabled).toBe(false)
    expect(release).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
  })

  it('coalesces continuous drawing on one frame while Copy consumes all samples and the final endpoint exactly once', async () => {
    const waiting = deferred<BrowserPng>(); fixture.compose.mockReturnValueOnce(waiting.promise)
    await mount(); const opened = await openScreenshot(); await flushFrames()
    const canvas = opened.querySelector('canvas')!
    canvas.setPointerCapture = vi.fn()
    const pointer = (type: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, clientX: x, clientY: y
    }))
    fixture.paint.mockClear(); fixture.committed.mockClear()
    const schedule = vi.mocked(requestAnimationFrame), before = schedule.mock.calls.length
    await act(async () => {
      pointer('pointerdown', 25, 30)
      pointer('pointermove', 60, 35); pointer('pointermove', 100, 40); pointer('pointermove', 150, 45)
    })
    expect(schedule.mock.calls.length - before).toBe(1)
    expect(fixture.paint).not.toHaveBeenCalled(); expect(fixture.committed).not.toHaveBeenCalled()
    await flushFrames()
    expect(fixture.paint).toHaveBeenCalledTimes(1)
    expect(fixture.paint.mock.calls[0]![2]).toMatchObject({ kind: 'pen', points: [{ x: 25, y: 30 }, { x: 60, y: 35 }, { x: 100, y: 40 }, { x: 150, y: 45 }] })
    await act(async () => {
      pointer('pointermove', 190, 50); pointer('pointerup', 190, 50); pointer('pointerup', 190, 50)
    })
    expect(fixture.committed).toHaveBeenCalledTimes(1)
    await act(async () => button(opened, 'Copy PNG').click())
    expect(fixture.compose).toHaveBeenCalledTimes(1)
    expect(fixture.compose.mock.calls[0]![0].shapes).toEqual([expect.objectContaining({
      kind: 'pen', points: [{ x: 25, y: 30 }, { x: 60, y: 35 }, { x: 100, y: 40 }, { x: 150, y: 45 }, { x: 190, y: 50 }]
    })])
    await cancel('Cancel')
    expect(frames.size).toBe(0)
    await act(async () => waiting.resolve(image))
    expect(clipboard).not.toHaveBeenCalled(); originalPageKept()
  })
})
