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
    { getState: () => fixture.state, setState: vi.fn() }
  )
}))
// Raster output and PNG encoding have native proof. Keep the real Pane, Editor, input handlers,
// history and copy/cancel token here; only the Canvas implementation and async encoder are replaced.
vi.mock('../src/renderer/src/components/browser-screenshot/canvas-render', () => ({
  renderCommittedLayer: fixture.committed, renderScreenshotScene: fixture.paint
}))
vi.mock('../src/renderer/src/components/browser-screenshot/compose', () => ({ composeScreenshot: fixture.compose }))
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
const capture: BrowserScreenshotCapture = { browserId: page.browserId, navigationId: page.navigationId, image }
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
  fixture.state.config = {
    version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local fixture' }],
    executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
  }
  vi.clearAllMocks()
  bounds = vi.spyOn(api.browser, 'setBounds').mockResolvedValue(undefined)
  clipboard = vi.spyOn(api.ui, 'writeClipboardImage').mockResolvedValue(undefined)
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
async function mount(snapshot = page) {
  await act(async () => root.render(<BrowserPane tab={snapshot} visible />))
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

describe('original Browser screenshot workface', () => {
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

  it.each(['Cancel', 'Escape'] as const)('%s during PNG composition keeps late output out of the clipboard and a new editor', async method => {
    const waiting = deferred<BrowserPng>()
    fixture.compose.mockReturnValueOnce(waiting.promise)
    await mount(); const opened = await openScreenshot()
    await act(async () => button(opened, 'Copy PNG').click())
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
