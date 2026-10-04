// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { previewFrame, previewMedia } from './helpers/browser-preview-media'
const bridge = vi.hoisted(() => ({
  registerPresentation: vi.fn(), removePresentation: vi.fn(), updatePresentation: vi.fn(), activatePresentation: vi.fn(),
  armPresentationCapture: vi.fn(), ackPresentationCapture: vi.fn(), onPresentationEvent: vi.fn(), getZoomFactor: vi.fn()
}))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: bridge, ui: bridge } }))
vi.mock('../src/renderer/src/store', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create(() => ({ noticeReadReceipts: {}, acquireNativeSurfaceOverlay() {}, releaseNativeSurfaceOverlay() {} })) }
})
import { BrowserPresentationStage, useBrowserPresentationCapture } from '../src/renderer/src/components/BrowserPresentationStage'
import type { BrowserPresentationEvent } from '../src/shared/contracts'
type Props = Omit<ComponentProps<typeof BrowserPresentationStage>, 'media'>
const presentation: Props['presentation'] = {
  occurrence: { presentationId: 'original-presentation', location: { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' } },
  stageHostId: 'original-host', visible: true, active: true, yieldToFocusRing: false,
  target: { hostId: 'original-host', surface: 'space', active: true }
}
function LiveStage(props: Props) {
  const media = useBrowserPresentationCapture(props.browserId)
  return createElement(BrowserPresentationStage, { ...props, media }, createElement('span', { 'data-original-page': '' }, 'Original page and draft'))
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let root: Root, container: HTMLDivElement, props: Props, width: number
let mediaDescriptor: PropertyDescriptor | undefined
let event: (value: BrowserPresentationEvent) => void
let acquired: ReturnType<typeof previewMedia>, display: ReturnType<typeof vi.fn>
async function render(next: Partial<Props> = {}) {
  props = { ...props, ...next }
  await act(async () => root.render(createElement(LiveStage, props)))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}
async function frame() { await act(async () => previewFrame(container.querySelector('video')!)) }
async function emit(value: BrowserPresentationEvent) { await act(async () => event(value)) }
async function retry() {
  const button = container.querySelector<HTMLButtonElement>('.browser-presentation-notice > .small-button')
  expect(button).not.toBeNull(); expect(button!.disabled).toBe(false)
  await act(async () => button!.click())
}
const originalPage = () => expect(container.querySelector('[data-original-page]')).not.toBeNull()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  bridge.registerPresentation.mockReset().mockResolvedValue({ leaseId: 'original-lease' })
  bridge.removePresentation.mockResolvedValue(undefined); bridge.updatePresentation.mockResolvedValue(undefined)
  bridge.activatePresentation.mockResolvedValue({ outcome: 'selected' }); bridge.ackPresentationCapture.mockReset().mockResolvedValue(undefined)
  let sequence = 0
  bridge.armPresentationCapture.mockReset().mockImplementation(async () => ({ captureId: `capture-${++sequence}`, browserId: 'original-browser' }))
  bridge.onPresentationEvent.mockImplementation((listener: typeof event) => { event = listener; return () => {} })
  bridge.getZoomFactor.mockReturnValue(1)
  acquired = previewMedia(); display = vi.fn(async () => acquired.stream)
  mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: display } })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  width = 640
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 10, y: 40, width, height: 320,
    left: 10, top: 40, right: width + 10, bottom: 360, toJSON: () => ({}) }))
  props = { browserId: 'original-browser', navigationId: 'original-navigation', presentation, inputSelected: true, blocked: false }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor)
  else delete (navigator as unknown as Record<string, unknown>).mediaDevices
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
it('T045 registration pending is readable without another registration or losing the page', async () => {
  const waiting = deferred<{ leaseId: string }>(); bridge.registerPresentation.mockReturnValueOnce(waiting.promise)
  await render(); originalPage()
  expect(container.textContent).toContain('Connecting page preview')
  expect(container.querySelector<HTMLButtonElement>('.browser-presentation-notice > .small-button')?.disabled).toBe(true)
  await render({ navigationId: 'new-navigation' }); expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  await act(async () => waiting.resolve({ leaseId: 'original-lease' })); await frame()
  expect(container.querySelector('[role="status"]'), container.textContent ?? '').toBeNull()
})
it('T045 capture arm pending is readable and does not block two actual geometry writes', async () => {
  const waiting = deferred<{ captureId: string; browserId: string }>(); bridge.armPresentationCapture.mockReturnValueOnce(waiting.promise)
  await render(); expect(container.textContent).toContain('Connecting live preview')
  width = 700; await act(async () => window.dispatchEvent(new Event('resize')))
  width = 760; await act(async () => window.dispatchEvent(new Event('resize')))
  const bounds = bridge.updatePresentation.mock.calls.map(call => call[1].bounds?.width)
  expect(bounds).toContain(700); expect(bounds).toContain(760)
  expect(bridge.armPresentationCapture).toHaveBeenCalledTimes(1); expect(display).not.toHaveBeenCalled(); originalPage()
  await act(async () => waiting.resolve({ captureId: 'capture-1', browserId: 'original-browser' }))
})
it('T045 system media request pending is readable without guessing permission or replaying requests', async () => {
  const waiting = deferred<MediaStream>(); display.mockReturnValueOnce(waiting.promise)
  await render(); expect(container.textContent).toContain('Waiting for live preview')
  expect(container.textContent).not.toContain('permission denied')
  width = 700; await act(async () => window.dispatchEvent(new Event('resize')))
  expect(display).toHaveBeenCalledTimes(1); expect(bridge.armPresentationCapture).toHaveBeenCalledTimes(1)
  expect(container.querySelector<HTMLButtonElement>('.browser-presentation-notice > .small-button')?.disabled).toBe(true)
  await act(async () => waiting.resolve(acquired.stream)); originalPage()
})
it('T045 capture acknowledgement pending cannot claim a first frame', async () => {
  const waiting = deferred<void>(); bridge.ackPresentationCapture.mockReturnValueOnce(waiting.promise)
  await render(); expect(container.textContent).toContain('Confirming live preview')
  expect(container.querySelector('video')).toBeNull(); originalPage()
  await act(async () => waiting.resolve()); expect(container.textContent).toContain('Waiting for the first preview frame')
})
it('T045 a confirmed stream remains first-frame pending until real frame facts arrive', async () => {
  await render(); expect(container.textContent).toContain('Waiting for the first preview frame')
  await act(async () => container.querySelector('video')!.dispatchEvent(new Event('loadeddata')))
  expect(container.textContent).toContain('Waiting for the first preview frame')
  await frame(); expect(container.querySelector('[role="status"]'), container.textContent ?? '').toBeNull(); originalPage()
})
it('T045 playback pending remains readable even if a frame event arrives before play resolves', async () => {
  const waiting = deferred<void>(); vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(waiting.promise)
  await render(); await frame(); expect(container.textContent).toContain('Starting preview playback')
  await act(async () => waiting.resolve()); expect(container.querySelector('[role="status"]'), container.textContent ?? '').toBeNull()
})
it('T045 playback rejection retries the original stream without another media request or native selection', async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('playback backend unavailable'))
  await render(); expect(container.textContent).toContain('playback backend unavailable')
  expect(container.querySelector<HTMLButtonElement>('.browser-presentation-notice > .small-button')?.textContent).toBe('Retry playback')
  const stream = container.querySelector('video')!.srcObject
  await retry(); await frame()
  expect(container.querySelector('video')!.srcObject).toBe(stream)
  expect(display).toHaveBeenCalledTimes(1); expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(bridge.activatePresentation.mock.calls).toEqual([['original-lease', { kind: 'select', focus: 'preserve' }]])
  expect(container.querySelector('[role="status"]'), container.textContent ?? '').toBeNull(); originalPage()
})
it('T045 track ended has a reason and explicit same-lease retry without resize auto-capture', async () => {
  await render(); await frame(); const old = acquired
  await act(async () => old.track.dispatchEvent(new Event('ended')))
  expect(container.textContent).toContain('Live preview media ended'); expect(container.querySelector('video')).toBeNull()
  width = 700; await act(async () => window.dispatchEvent(new Event('resize')))
  expect(display).toHaveBeenCalledTimes(1); expect(bridge.armPresentationCapture).toHaveBeenCalledTimes(1); originalPage()
  acquired = previewMedia('replacement-track'); await retry(); await frame()
  expect(bridge.armPresentationCapture.mock.calls).toEqual([['original-lease'], ['original-lease']])
  expect(display).toHaveBeenCalledTimes(2); expect(container.querySelector('[role="status"]'), container.textContent ?? '').toBeNull()
})
it('T045 source replaced is explained and explicitly retries the existing lease at unchanged geometry', async () => {
  await render(); await frame()
  await emit({ type: 'capture-revoked', browserId: 'original-browser', captureId: 'capture-1', reason: 'source-replaced' })
  expect(container.textContent).toContain('Live preview source changed'); originalPage()
  await render({ navigationId: 'new-navigation' }); expect(display).toHaveBeenCalledTimes(1)
  acquired = previewMedia('replacement-track'); await retry(); await frame()
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(bridge.armPresentationCapture.mock.calls).toEqual([['original-lease'], ['original-lease']])
  expect(bridge.activatePresentation).toHaveBeenCalledTimes(1); expect(container.querySelector('[role="status"]'), container.textContent ?? '').toBeNull()
})
it('T045 normal hidden capture revocation is not classified as failure and can resume when visible', async () => {
  await render(); await frame(); await render({ presentation: { ...presentation, visible: false } })
  await emit({ type: 'capture-revoked', browserId: 'original-browser', captureId: 'capture-1', reason: 'no-visible-presentations' })
  expect(container.textContent).not.toContain('needs attention'); expect(container.textContent).not.toContain('Live preview source changed')
  acquired = previewMedia('visible-track'); await render({ presentation }); await frame()
  expect(display).toHaveBeenCalledTimes(2); expect(container.querySelector('[role="status"]'), container.textContent ?? '').toBeNull()
})
it('T045 stale ended and playback results cannot retire or reclassify a later stream', async () => {
  const waiting = deferred<void>(); vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(waiting.promise)
  const old = acquired, listeners: EventListenerOrEventListenerObject[] = []
  const originalAdd = old.track.addEventListener.bind(old.track)
  vi.spyOn(old.track, 'addEventListener').mockImplementation((name, listener, options) => {
    if (name === 'ended' && listener) listeners.push(listener); originalAdd(name, listener, options)
  })
  await render(); await emit({ type: 'capture-revoked', browserId: 'original-browser', captureId: 'capture-1', reason: 'source-replaced' })
  acquired = previewMedia('new-track'); await retry()
  expect(container.textContent).toContain('Waiting for the first preview frame')
  expect(listeners.length).toBeGreaterThan(0)
  await act(async () => {
    for (const listener of listeners) { if (typeof listener === 'function') listener.call(old.track, new Event('ended')); else listener.handleEvent(new Event('ended')) }
    waiting.reject(new Error('late old play rejection'))
  })
  expect(container.querySelector<HTMLVideoElement>('video')?.srcObject).toBe(acquired.stream)
  expect(container.textContent).not.toContain('late old play rejection')
  expect(container.textContent).toContain('Waiting for the first preview frame')
  await frame(); expect(container.querySelector('[role="status"]'), container.textContent ?? '').toBeNull()
})
it('T045 revoked pending media is stopped on arrival and cannot overwrite its reason', async () => {
  const waiting = deferred<MediaStream>(); display.mockReturnValueOnce(waiting.promise)
  await render(); await emit({ type: 'capture-revoked', browserId: 'original-browser', captureId: 'capture-1', reason: 'source-replaced' })
  await act(async () => waiting.resolve(acquired.stream))
  expect(acquired.track.stop).toHaveBeenCalledTimes(1); expect(container.querySelector('video')).toBeNull()
  expect(container.textContent).toContain('Live preview source changed'); expect(display).toHaveBeenCalledTimes(1); originalPage()
})

/** Invoke the actual registered React handler with trusted native pointer facts; happy-dom dispatch is untrusted. */
async function previewPress() {
  const stage = container.querySelector<HTMLDivElement>('[data-native-browser-stage]')!
  const propsKey = Object.keys(stage).find(key => key.startsWith('__reactProps$'))!
  const handlers = (stage as unknown as Record<string, { onPointerDown(event: unknown): void }>)[propsKey]!
  await act(async () => handlers.onPointerDown({ currentTarget: { setPointerCapture: vi.fn() }, clientX: 30, clientY: 70,
    pointerType: 'mouse', isTrusted: true, pointerId: 1, button: 0, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn() }))
}
it('T045 positive metadata without a first frame cannot prepare preview input', async () => {
  await render()
  Object.defineProperties(container.querySelector('video')!, {
    readyState: { configurable: true, value: 1 }, videoWidth: { configurable: true, value: 640 }, videoHeight: { configurable: true, value: 320 }
  })
  await previewPress()
  expect(bridge.activatePresentation.mock.calls).toEqual([['original-lease', { kind: 'select', focus: 'preserve' }]])
  expect(container.textContent).toContain('Waiting for the first preview frame'); originalPage()
})
it('T045 failed playback with positive frame dimensions cannot prepare preview input', async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('Playback could not start'))
  await render(); await frame(); await previewPress()
  expect(bridge.activatePresentation.mock.calls).toEqual([['original-lease', { kind: 'select', focus: 'preserve' }]])
  expect(container.textContent).toContain('Playback could not start'); originalPage()
})
it('T045 confirmed real frame preserves the original trusted first-press route', async () => {
  await render(); await frame()
  bridge.activatePresentation.mockResolvedValueOnce({ outcome: 'prepared', inputScopeId: 'actual-input-scope' })
  await previewPress()
  expect(bridge.activatePresentation).toHaveBeenCalledTimes(2)
  expect(bridge.activatePresentation.mock.calls[1]).toEqual(['original-lease', { kind: 'prepare-first-press', navigationId: 'original-navigation',
    captureId: 'capture-1', down: { x: 20 / 640, y: 30 / 320 }, button: 'left', clickCount: 1, modifiers: [] }])
})
