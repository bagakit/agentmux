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
  return { useAppStore: create(() => ({ noticeReadReceipts: {},  })) }
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

async function renderPair(secondVisible = true) {
  await act(async () => root.render(createElement('div', null,
    createElement(LiveStage, { ...props, key: 'first' }),
    createElement(LiveStage, { ...props, key: 'second', browserId: 'second-browser',
      presentation: { ...presentation, visible: secondVisible, occurrence: { ...presentation.occurrence, presentationId: 'second-presentation' } } }))))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

it('serializes different Browser captures through the original media acknowledgement', async () => {
  const first = deferred<MediaStream>(), second = previewMedia('second-track'), acknowledged = deferred<void>()
  display.mockReturnValueOnce(first.promise).mockResolvedValueOnce(second.stream)
  bridge.registerPresentation.mockImplementation(async request => ({ leaseId: request.browserId }))
  let armed: string | null = null
  bridge.armPresentationCapture.mockImplementation(async leaseId => {
    if (armed) throw new Error('Another Browser presentation capture is still pending')
    armed = leaseId
    return { captureId: leaseId, browserId: leaseId }
  })
  bridge.ackPresentationCapture.mockImplementation(async (_id, ack) => {
    if (ack.outcome === 'ready' && armed === 'original-browser') await acknowledged.promise
    armed = null
  })
  await renderPair()
  expect(bridge.armPresentationCapture.mock.calls).toEqual([['original-browser']])
  await act(async () => first.resolve(acquired.stream))
  expect(display).toHaveBeenCalledTimes(1)
  await act(async () => acknowledged.resolve())
  expect(bridge.armPresentationCapture.mock.calls).toEqual([['original-browser'], ['second-browser']])
  expect([...container.querySelectorAll('video')].map(node => node.srcObject)).toEqual([acquired.stream, second.stream])
  expect(container.textContent).not.toContain('Another Browser')
})

it('skips a queued presentation hidden before its capture turn without requesting media', async () => {
  const first = deferred<MediaStream>()
  display.mockReturnValueOnce(first.promise)
  bridge.registerPresentation.mockImplementation(async request => ({ leaseId: request.browserId }))
  await renderPair(); await renderPair(false)
  await act(async () => first.resolve(acquired.stream))
  expect(bridge.armPresentationCapture.mock.calls).toEqual([['original-browser']])
  expect(display).toHaveBeenCalledTimes(1)
  expect(container.querySelectorAll('video')).toHaveLength(1)
  await renderPair(true)
  expect(bridge.armPresentationCapture.mock.calls).toEqual([['original-browser'], ['second-browser']])
})

it('uses another still-visible occurrence when the queued occurrence of a shared Browser is hidden', async () => {
  const first = deferred<MediaStream>(), shared = previewMedia('shared-track')
  display.mockReturnValueOnce(first.promise).mockResolvedValueOnce(shared.stream)
  bridge.registerPresentation.mockImplementation(async request => ({ leaseId: request.occurrence.presentationId }))
  function Shared({ firstVisible }: { firstVisible: boolean }) {
    const media = useBrowserPresentationCapture('shared-browser')
    return createElement('div', null, ...['queued', 'visible'].map(id => createElement(BrowserPresentationStage, {
      ...props, key: id, browserId: 'shared-browser', inputSelected: false, media,
      presentation: { ...presentation, visible: id === 'visible' || firstVisible,
        occurrence: { ...presentation.occurrence, presentationId: id } }
    })))
  }
  const pair = async (firstVisible: boolean) => {
    await act(async () => root.render(createElement('div', null, createElement(LiveStage, props), createElement(Shared, { firstVisible }))))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  }
  await pair(true); await pair(false)
  await act(async () => first.resolve(acquired.stream))
  expect(bridge.armPresentationCapture.mock.calls).toEqual([['original-presentation'], ['visible']])
  expect(display).toHaveBeenCalledTimes(2)
  expect(container.querySelector<HTMLVideoElement>('[data-browser-presentation-id="visible"] video')?.srcObject).toBe(shared.stream)
})

it('continues another Browser after an actual media failure without retrying the failed page', async () => {
  const first = deferred<MediaStream>(), second = previewMedia('second-track')
  display.mockReturnValueOnce(first.promise).mockResolvedValueOnce(second.stream)
  await renderPair()
  await act(async () => first.reject(new Error('Actual capture denied')))
  expect(display).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('Actual capture denied')
  expect(container.querySelector('video')?.srcObject).toBe(second.stream)
  width = 700; await act(async () => window.dispatchEvent(new Event('resize')))
  expect(display).toHaveBeenCalledTimes(2)
})

it('reconnects a quickly reshown original page after stopping its late hidden capture', async () => {
  const first = deferred<MediaStream>(), old = acquired, fresh = previewMedia('fresh-track')
  display.mockReturnValueOnce(first.promise).mockResolvedValueOnce(fresh.stream)
  await render(); await render({ presentation: { ...presentation, visible: false } })
  await emit({ type: 'capture-revoked', browserId: 'original-browser', captureId: 'capture-1', reason: 'no-visible-presentations' })
  await render({ presentation })
  expect(display).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('Connecting live preview')
  await act(async () => first.resolve(old.stream))
  expect(old.track.stop).toHaveBeenCalledTimes(1)
  expect(bridge.ackPresentationCapture).toHaveBeenCalledWith('capture-1', { outcome: 'stopped', trackIds: [old.track.id] })
  expect(display).toHaveBeenCalledTimes(2)
  expect(container.querySelector('video')?.srcObject).toBe(fresh.stream)
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(container.textContent).not.toContain('needs attention'); originalPage()
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
it('a stage passes its occurrence unchanged, contains the frame and claims no page layout of its own', async () => {
  await render()
  const occurrence = bridge.registerPresentation.mock.calls[0]![0].occurrence
  expect(occurrence).toEqual(presentation.occurrence)
  expect(occurrence.layoutHost).toBeUndefined()
  expect(container.querySelector<HTMLVideoElement>('video')!.style.objectFit).toBe('contain')
})
it('a page laid out to its stage maps a press through the contained frame at its own CSS point', async () => {
  // Stage 640x320 at (10,40). A layout-host page lays out to the stage, so its 1280x640 frame contains at 0.5:
  // a press 20px right of and 30px below the stage origin lands at the same CSS point on the page.
  await render({ presentation: { ...presentation, occurrence: { ...presentation.occurrence, layoutHost: true } } })
  expect(bridge.registerPresentation.mock.calls[0]![0].occurrence.layoutHost).toBe(true)
  const video = container.querySelector<HTMLVideoElement>('video')!
  Object.defineProperty(HTMLMediaElement, 'HAVE_CURRENT_DATA', { configurable: true, value: 2 })
  Object.defineProperties(video, { readyState: { configurable: true, value: 2 }, videoWidth: { configurable: true, value: 1280 }, videoHeight: { configurable: true, value: 640 } })
  await act(async () => video.dispatchEvent(new Event('loadeddata')))
  bridge.activatePresentation.mockResolvedValueOnce({ outcome: 'prepared', inputScopeId: 'actual-input-scope' })
  await previewPress()
  expect(bridge.activatePresentation.mock.calls[1]).toEqual(['original-lease', { kind: 'prepare-first-press', navigationId: 'original-navigation',
    captureId: 'capture-1', down: { x: 20 / 640, y: 30 / 320 }, button: 'left', clickCount: 1, modifiers: [] }])
})
