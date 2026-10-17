// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserPresentationEvent } from '../src/shared/contracts'

const bridge = vi.hoisted(() => ({
  registerPresentation: vi.fn(), updatePresentation: vi.fn(), removePresentation: vi.fn(),
  activatePresentation: vi.fn(), armPresentationCapture: vi.fn(), ackPresentationCapture: vi.fn(),
  onPresentationEvent: vi.fn(), getZoomFactor: vi.fn()
}))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: bridge, ui: bridge } }))
// Keep the actual Stage's waiting/error decisions without importing unrelated notice Store owners.
vi.mock('../src/renderer/src/components/ServiceWindowNotice', () => ({
  ServiceWindowNotice: ({ notice }: { notice: { notice: { step: string; mode: string } } | null }) => notice
    ? createElement('div', { role: 'status' }, notice.notice.step, ' ', notice.notice.mode) : null
}))
import { BrowserPresentationStage, useBrowserPresentationCapture, type WorkbenchBrowserPresentation } from '../src/renderer/src/components/BrowserPresentationStage'

const browserId = 'original-browser', captureId = 'original-capture'
const presentation = (id: string): WorkbenchBrowserPresentation => ({
  occurrence: { presentationId: id, location: { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: id } },
  stageHostId: id, visible: true, active: true, yieldToFocusRing: false,
  target: { hostId: id, surface: 'space', active: true }
})
const presentations = [presentation('stage-a'), presentation('stage-b')]
type WorkfaceOptions = { secondVisible?: boolean; secondBlocked?: boolean }
function Workfaces({ secondVisible = true, secondBlocked = false }: WorkfaceOptions) {
  const media = useBrowserPresentationCapture(browserId)
  return createElement('div', null, ...presentations.map((item, index) => createElement(BrowserPresentationStage, {
    key: item.occurrence.presentationId, browserId, navigationId: 'original-navigation',
    presentation: index === 1 ? { ...item, visible: secondVisible } : item,
    inputSelected: index === 0, blocked: index === 1 && secondBlocked, media
  }, createElement('span', { 'data-original-page': item.occurrence.presentationId }, 'Original page and draft'))))
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
type Playback = { paused: boolean; readyState: number; width: number; height: number }
let root: Root, container: HTMLDivElement, stream: MediaStream, track: MediaStreamTrack
let trackState: MediaStreamTrackState, stopTrack: ReturnType<typeof vi.fn>, display: ReturnType<typeof vi.fn>
let mediaDescriptor: PropertyDescriptor | undefined
let frameStateDescriptor: PropertyDescriptor | undefined
let listeners: Set<(event: BrowserPresentationEvent) => void>
let playback: WeakMap<HTMLMediaElement, Playback>
let pendingPlay: { presentationId: string; promise: Promise<void> } | null
let srcObjectDescriptor: PropertyDescriptor | undefined
let requestFrameDescriptor: PropertyDescriptor | undefined, cancelFrameDescriptor: PropertyDescriptor | undefined
let sinks: WeakMap<HTMLMediaElement, MediaProvider | null>
let frameCallbacks: Map<number, { node: HTMLVideoElement; callback: VideoFrameRequestCallback }>
let drawFrame: ReturnType<typeof vi.fn>, nextFrame: number

function state(video: HTMLMediaElement): Playback {
  let value = playback.get(video)
  if (!value) {
    value = { paused: true, readyState: 0, width: 0, height: 0 }
    playback.set(video, value)
    const current = value
    Object.defineProperties(video, {
      paused: { configurable: true, get: () => current.paused },
      readyState: { configurable: true, get: () => current.readyState },
      videoWidth: { configurable: true, get: () => current.width },
      videoHeight: { configurable: true, get: () => current.height }
    })
  }
  return value
}
function stage(id: string) {
  const node = container.querySelector<HTMLElement>(`[data-browser-presentation-id="${id}"]`)
  expect(node).not.toBeNull()
  return node!
}
function video(id: string) {
  const node = stage(id).querySelector('video')
  expect(node).not.toBeNull()
  return node!
}
function surface(id: string) { return stage(id).parentElement! }
async function emit(event: BrowserPresentationEvent) {
  await act(async () => { for (const listener of listeners) listener(event) })
}
const coverage = (leaseId: string, captured = captureId, browser = browserId): BrowserPresentationEvent => ({
  type: 'native-coverage-changed', browserId: browser, coverage: { leaseId, captureId: captured }
})
const uncover = (): BrowserPresentationEvent => ({ type: 'native-coverage-changed', browserId, coverage: null })
async function mount(options: WorkfaceOptions = {}) {
  await act(async () => root.render(createElement(Workfaces, options)))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}
async function frame(id: string) {
  await act(async () => {
    const node = video(id)
    if (node.srcObject !== stream) return
    Object.assign(state(node), { readyState: 2, width: 640, height: 320 })
    node.dispatchEvent(new Event('loadeddata'))
    for (const [handle, pending] of frameCallbacks) if (pending.node === node) {
      frameCallbacks.delete(handle); pending.callback(0, {} as VideoFrameCallbackMetadata)
    }
  })
}
function controlCounts() {
  return {
    register: bridge.registerPresentation.mock.calls.length, update: bridge.updatePresentation.mock.calls.length,
    select: bridge.activatePresentation.mock.calls.length, arm: bridge.armPresentationCapture.mock.calls.length,
    acknowledge: bridge.ackPresentationCapture.mock.calls.length, acquire: display.mock.calls.length,
    geometry: vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.calls.length
  }
}
function sourceCounts() {
  const { update, geometry, ...counts } = controlCounts()
  return counts
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks(); playback = new WeakMap(); pendingPlay = null; listeners = new Set()
  sinks = new WeakMap(); frameCallbacks = new Map(); nextFrame = 0; drawFrame = vi.fn()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  bridge.registerPresentation.mockReset().mockImplementation(async request => ({ leaseId: `lease-${request.occurrence.presentationId}` }))
  bridge.updatePresentation.mockReset().mockResolvedValue(undefined)
  bridge.removePresentation.mockReset().mockResolvedValue(undefined)
  bridge.activatePresentation.mockReset().mockResolvedValue({ outcome: 'selected' })
  bridge.armPresentationCapture.mockReset().mockResolvedValue({ captureId, browserId })
  bridge.ackPresentationCapture.mockReset().mockResolvedValue(undefined)
  bridge.onPresentationEvent.mockReset().mockImplementation(listener => { listeners.add(listener); return () => listeners.delete(listener) })
  bridge.getZoomFactor.mockReturnValue(1)
  trackState = 'live'; stopTrack = vi.fn(() => { trackState = 'ended' })
  track = Object.assign(new EventTarget(), { id: 'original-track', stop: stopTrack }) as unknown as MediaStreamTrack
  Object.defineProperty(track, 'readyState', { get: () => trackState })
  stream = new MediaStream()
  Object.defineProperty(stream, 'getTracks', { value: () => [track] })
  display = vi.fn(async () => stream)
  mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: display } })
  frameStateDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement, 'HAVE_CURRENT_DATA')
  Object.defineProperty(HTMLMediaElement, 'HAVE_CURRENT_DATA', { configurable: true, value: 2 })
  srcObjectDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject')
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true,
    get(this: HTMLMediaElement) { return sinks.get(this) ?? null },
    set(this: HTMLMediaElement, value: MediaProvider | null) {
      sinks.set(this, value)
      Object.assign(state(this), { readyState: 0, width: 0, height: 0 })
    } })
  requestFrameDescriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'requestVideoFrameCallback')
  cancelFrameDescriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'cancelVideoFrameCallback')
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', { configurable: true, value(this: HTMLVideoElement, callback: VideoFrameRequestCallback) {
    const handle = ++nextFrame; frameCallbacks.set(handle, { node: this, callback }); return handle
  } })
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', { configurable: true, value(handle: number) { frameCallbacks.delete(handle) } })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: drawFrame } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    state(this).paused = false
    const current = pendingPlay
    if (current && this.closest('[data-browser-presentation-id]')?.getAttribute('data-browser-presentation-id') === current.presentationId) {
      pendingPlay = null
      return current.promise
    }
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) { state(this).paused = true })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(10, 40, 640, 320))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor)
  else delete (navigator as unknown as Record<string, unknown>).mediaDevices
  if (frameStateDescriptor) Object.defineProperty(HTMLMediaElement, 'HAVE_CURRENT_DATA', frameStateDescriptor)
  else delete (HTMLMediaElement as unknown as Record<string, unknown>).HAVE_CURRENT_DATA
  for (const [prototype, key, descriptor] of [
    [HTMLMediaElement.prototype, 'srcObject', srcObjectDescriptor],
    [HTMLVideoElement.prototype, 'requestVideoFrameCallback', requestFrameDescriptor],
    [HTMLVideoElement.prototype, 'cancelVideoFrameCallback', cancelFrameDescriptor]
  ] as const) {
    if (descriptor) Object.defineProperty(prototype, key, descriptor)
    else delete (prototype as unknown as Record<string, unknown>)[key]
  }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('keeps desired selection, its receipt and input-owner facts separate from physical coverage', async () => {
  const selected = deferred<{ outcome: 'selected' }>()
  bridge.activatePresentation.mockReturnValueOnce(selected.promise)
  await mount(); await frame('stage-a'); await frame('stage-b')
  expect(video('stage-a').paused).toBe(false); expect(video('stage-b').paused).toBe(false)
  expect(bridge.activatePresentation).toHaveBeenCalledWith('lease-stage-a', { kind: 'select', focus: 'preserve' })
  await act(async () => selected.resolve({ outcome: 'selected' }))
  await emit({ type: 'input-owner-changed', browserId, leaseId: 'lease-stage-a' })
  expect(video('stage-a').paused).toBe(false); expect(video('stage-b').paused).toBe(false)
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()
  expect(surface('stage-a').querySelector('[role="status"]')).toBeNull()
})

it('releases only the covered receiver and resumes its same video, retained frame, stream and live track without control work', async () => {
  await mount(); await frame('stage-a'); await frame('stage-b')
  const a = video('stage-a'), b = video('stage-b'), originalStage = stage('stage-a')
  const originalPage = originalStage.querySelector('[data-original-page]'), counts = controlCounts()
  expect(a.srcObject).toBe(stream); expect(b.srcObject).toBe(stream)
  await emit(coverage('lease-stage-a'))
  expect(a.paused).toBe(true); expect(b.paused).toBe(false)
  expect(a.srcObject).toBeNull(); expect(track.readyState).toBe('live'); expect(stopTrack).not.toHaveBeenCalled()
  const canvas = originalStage.querySelector('canvas')!
  expect([canvas.width, canvas.height, canvas.hidden]).toEqual([640, 320, false])
  expect(drawFrame).toHaveBeenCalledExactlyOnceWith(a, 0, 0)
  expect(controlCounts()).toEqual(counts)
  await emit(coverage('lease-stage-a'))
  expect(drawFrame).toHaveBeenCalledTimes(1)
  await emit(uncover())
  expect(video('stage-a')).toBe(a); expect(video('stage-b')).toBe(b)
  expect(stage('stage-a')).toBe(originalStage); expect(originalStage.querySelector('[data-original-page]')).toBe(originalPage)
  expect(a.srcObject).toBe(stream); expect(b.srcObject).toBe(stream)
  expect(stream.getTracks()).toEqual([track]); expect(track.readyState).toBe('live')
  expect(a.paused).toBe(false); expect(b.paused).toBe(false)
  expect(canvas.hidden).toBe(false)
  await frame('stage-a')
  expect(canvas.hidden).toBe(true)
  expect(controlCounts()).toEqual(counts); expect(stopTrack).not.toHaveBeenCalled()
  expect(surface('stage-a').querySelector('[role="status"]')).toBeNull()
})

const inactiveWorkfaces = [
  ['hidden', { secondVisible: false }], ['blocked', { secondBlocked: true }]
] as const

it.each(inactiveWorkfaces)('releases only the %s receiver and restores the same page and live source after a new frame', async (_reason, options) => {
  await mount(); await frame('stage-a'); await frame('stage-b')
  const a = video('stage-a'), b = video('stage-b'), originalStage = stage('stage-b')
  const originalPage = originalStage.querySelector('[data-original-page]'), counts = sourceCounts()
  const timers = vi.getTimerCount()
  await act(async () => root.render(createElement(Workfaces, options)))
  expect(bridge.updatePresentation).toHaveBeenLastCalledWith('lease-stage-b', { visible: false })
  expect(b.srcObject).toBeNull(); expect(b.paused).toBe(true)
  expect(a.srcObject).toBe(stream); expect(a.paused).toBe(false)
  expect(track.readyState).toBe('live'); expect(stopTrack).not.toHaveBeenCalled()
  const canvas = originalStage.querySelector('canvas')!
  expect([canvas.width, canvas.height, canvas.hidden]).toEqual([640, 320, false])
  expect(drawFrame).toHaveBeenCalledExactlyOnceWith(b, 0, 0)
  expect(sourceCounts()).toEqual(counts); expect(vi.getTimerCount()).toBe(timers)
  await act(async () => root.render(createElement(Workfaces)))
  expect(video('stage-b')).toBe(b); expect(stage('stage-b')).toBe(originalStage)
  expect(originalStage.querySelector('[data-original-page]')).toBe(originalPage)
  expect(b.srcObject).toBe(stream); expect(b.paused).toBe(false)
  expect(canvas.hidden).toBe(false); expect(frameCallbacks.size).toBe(1)
  await frame('stage-b')
  expect(canvas.hidden).toBe(true); expect(frameCallbacks.size).toBe(0)
  expect(surface('stage-b').querySelector('[role="status"]')).toBeNull()
  expect(sourceCounts()).toEqual(counts); expect(vi.getTimerCount()).toBe(timers)
  expect(stopTrack).not.toHaveBeenCalled()
})

it.each(inactiveWorkfaces)('does not attach an initially %s receiver to its visible sibling source', async (_reason, options) => {
  await mount(options); await frame('stage-a')
  const a = video('stage-a'), b = video('stage-b'), counts = sourceCounts()
  expect(a.srcObject).toBe(stream); expect(a.paused).toBe(false)
  expect(b.srcObject).toBeNull(); expect(b.paused).toBe(true)
  expect(drawFrame).not.toHaveBeenCalled(); expect(stopTrack).not.toHaveBeenCalled()
  expect(bridge.registerPresentation).toHaveBeenCalledWith(expect.objectContaining({
    occurrence: presentations[1]!.occurrence, geometry: { visible: false }
  }))
  await act(async () => root.render(createElement(Workfaces)))
  expect(video('stage-b')).toBe(b); expect(b.srcObject).toBe(stream); expect(b.paused).toBe(false)
  await frame('stage-b')
  expect(surface('stage-b').querySelector('[role="status"]')).toBeNull()
  expect(sourceCounts()).toEqual(counts); expect(stopTrack).not.toHaveBeenCalled()
})

it('keeps hidden and Native-covered receivers detached until each original condition clears', async () => {
  await mount(); await frame('stage-a'); await frame('stage-b')
  const a = video('stage-a'), b = video('stage-b'), counts = sourceCounts()
  await emit(coverage('lease-stage-a'))
  await act(async () => root.render(createElement(Workfaces, { secondVisible: false })))
  expect(a.srcObject).toBeNull(); expect(b.srcObject).toBeNull()
  expect(track.readyState).toBe('live'); expect(stopTrack).not.toHaveBeenCalled()
  await emit(coverage('lease-stage-b'))
  expect(a.srcObject).toBe(stream); expect(b.srcObject).toBeNull()
  await act(async () => root.render(createElement(Workfaces)))
  expect(b.srcObject).toBeNull(); expect(b.paused).toBe(true)
  await emit(uncover())
  expect(video('stage-a')).toBe(a); expect(video('stage-b')).toBe(b)
  expect(a.srcObject).toBe(stream); expect(b.srcObject).toBe(stream)
  await frame('stage-a'); await frame('stage-b')
  expect(sourceCounts()).toEqual(counts); expect(stopTrack).not.toHaveBeenCalled()
})

it.each(inactiveWorkfaces)('ignores late play and frame callbacks after the same receiver becomes %s', async (_reason, options) => {
  await mount(); await frame('stage-a'); await frame('stage-b')
  await emit(coverage('lease-stage-b'))
  const playing = deferred<void>()
  pendingPlay = { presentationId: 'stage-b', promise: playing.promise }
  await emit(uncover())
  const b = video('stage-b'), canvas = stage('stage-b').querySelector('canvas')!
  expect(frameCallbacks.size).toBe(1)
  const old = [...frameCallbacks.values()][0]!
  const counts = sourceCounts()
  await act(async () => root.render(createElement(Workfaces, options)))
  expect(frameCallbacks.size).toBe(0)
  await act(async () => { playing.resolve(); old.callback(0, {} as VideoFrameCallbackMetadata) })
  expect(b.srcObject).toBeNull(); expect(b.paused).toBe(true); expect(canvas.hidden).toBe(false)
  expect(surface('stage-b').textContent).not.toContain('Starting preview playback')
  expect(video('stage-a').srcObject).toBe(stream); expect(video('stage-a').paused).toBe(false)
  await act(async () => root.render(createElement(Workfaces)))
  expect(video('stage-b')).toBe(b); expect(b.srcObject).toBe(stream)
  await frame('stage-b')
  expect(canvas.hidden).toBe(true)
  expect(sourceCounts()).toEqual(counts); expect(stopTrack).not.toHaveBeenCalled()
})

it.each(inactiveWorkfaces)('keeps the original receiver and recovery notice if retaining the %s preview fails', async (_reason, options) => {
  await mount(); await frame('stage-a'); await frame('stage-b')
  drawFrame.mockImplementationOnce(() => { throw new Error('Frame retention failed') })
  const b = video('stage-b'), counts = sourceCounts()
  await act(async () => root.render(createElement(Workfaces, options)))
  expect(b.srcObject).toBe(stream); expect(b.paused).toBe(false)
  expect(surface('stage-b').textContent).toContain('Frame retention failed')
  expect(surface('stage-b').querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
  await act(async () => root.render(createElement(Workfaces)))
  await frame('stage-b')
  expect(video('stage-b')).toBe(b); expect(b.srcObject).toBe(stream)
  expect(surface('stage-b').querySelector('[role="status"]')).toBeNull()
  expect(sourceCounts()).toEqual(counts); expect(stopTrack).not.toHaveBeenCalled()
})

it.each([
  ['a different Browser', () => coverage('lease-stage-a', captureId, 'foreign-browser')],
  ['an earlier capture', () => coverage('lease-stage-a', 'retired-capture')],
  ['another lease', () => coverage('unrelated-lease')]
] as const)('does not pause either current sink for coverage of %s', async (_label, event) => {
  await mount(); await frame('stage-a'); await frame('stage-b')
  const counts = controlCounts()
  await emit(event())
  expect(video('stage-a').paused).toBe(false); expect(video('stage-b').paused).toBe(false)
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()
  expect(controlCounts()).toEqual(counts); expect(stopTrack).not.toHaveBeenCalled()
})

it('retains coverage published before the ready acknowledgement and does not leave playback starting', async () => {
  const ready = deferred<void>()
  bridge.ackPresentationCapture.mockImplementation(async (_id, acknowledgement) => {
    if (acknowledgement.outcome === 'ready') await ready.promise
  })
  await mount()
  expect(surface('stage-a').textContent).toContain('Confirming live preview')
  expect(container.querySelector('video')).toBeNull()
  await emit(coverage('lease-stage-a'))
  await act(async () => ready.resolve())
  await frame('stage-a'); await frame('stage-b')
  const a = video('stage-a'), counts = controlCounts()
  expect(a.paused).toBe(true); expect(video('stage-b').paused).toBe(false)
  expect(a.srcObject).toBeNull(); expect(drawFrame).not.toHaveBeenCalled()
  expect(surface('stage-a').textContent).not.toContain('Starting preview playback')
  await emit(uncover())
  expect(video('stage-a')).toBe(a); expect(a.srcObject).toBe(stream); expect(a.paused).toBe(false)
  await frame('stage-a')
  expect(surface('stage-a').querySelector('[role="status"]')).toBeNull()
  expect(controlCounts()).toEqual(counts)
})

it('clears an interrupted starting phase when Main covers a pending play, and ignores its late result', async () => {
  const playing = deferred<void>()
  pendingPlay = { presentationId: 'stage-a', promise: playing.promise }
  await mount(); await frame('stage-a'); await frame('stage-b')
  expect(surface('stage-a').textContent).toContain('Starting preview playback')
  const a = video('stage-a'), counts = controlCounts()
  await emit(coverage('lease-stage-a'))
  expect(a.paused).toBe(true)
  expect(surface('stage-a').textContent).not.toContain('Starting preview playback')
  await act(async () => playing.resolve())
  expect(a.paused).toBe(true); expect(video('stage-b').paused).toBe(false)
  await emit(uncover())
  expect(video('stage-a')).toBe(a); expect(a.paused).toBe(false); expect(a.srcObject).toBe(stream)
  await frame('stage-a')
  expect(surface('stage-a').querySelector('[role="status"]')).toBeNull()
  expect(controlCounts()).toEqual(counts)
})

it('keeps the retained image until one new frame and cancels an obsolete reattachment callback', async () => {
  await mount(); await frame('stage-a'); await frame('stage-b')
  await emit(coverage('lease-stage-a')); await emit(uncover())
  const a = video('stage-a'), canvas = stage('stage-a').querySelector('canvas')!
  await act(async () => {
    Object.assign(state(a), { readyState: 2, width: 640, height: 320 })
    a.dispatchEvent(new Event('loadeddata'))
    a.dispatchEvent(new Event('playing'))
  })
  expect(frameCallbacks.size).toBe(1)
  expect(canvas.hidden).toBe(false)
  expect(surface('stage-a').textContent).toContain('Waiting for the first preview frame')
  const old = [...frameCallbacks.values()][0]!
  await emit(coverage('lease-stage-a'))
  expect(frameCallbacks.size).toBe(0)
  await act(async () => old.callback(0, {} as VideoFrameCallbackMetadata))
  expect(a.srcObject).toBeNull(); expect(canvas.hidden).toBe(false)
  await emit(uncover()); await frame('stage-a')
  expect(canvas.hidden).toBe(true)
  expect(surface('stage-a').querySelector('[role="status"]')).toBeNull()
})

it('accepts a single new frame delivered before the same reattachment play request resolves', async () => {
  await mount(); await frame('stage-a'); await frame('stage-b')
  await emit(coverage('lease-stage-a'))
  const playing = deferred<void>()
  pendingPlay = { presentationId: 'stage-a', promise: playing.promise }
  await emit(uncover())
  const canvas = stage('stage-a').querySelector('canvas')!
  expect(frameCallbacks.size).toBe(1)
  await frame('stage-a')
  expect(frameCallbacks.size).toBe(0); expect(canvas.hidden).toBe(false)
  await act(async () => playing.resolve())
  expect(canvas.hidden).toBe(true)
  expect(surface('stage-a').querySelector('[role="status"]')).toBeNull()
})

it.each(['missing-context', 'draw-failure'] as const)('keeps the original preview and local retry when retaining a frame has %s', async failure => {
  await mount(); await frame('stage-a'); await frame('stage-b')
  if (failure === 'missing-context') vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null)
  else drawFrame.mockImplementationOnce(() => { throw new Error('Frame retention failed') })
  const counts = controlCounts()
  await emit(coverage('lease-stage-a'))
  expect(video('stage-a').srcObject).toBe(stream); expect(video('stage-a').paused).toBe(false)
  expect(video('stage-b').srcObject).toBe(stream); expect(video('stage-b').paused).toBe(false)
  expect(surface('stage-a').textContent).toContain('Page preview needs attention')
  const retry = surface('stage-a').querySelector<HTMLButtonElement>('button')!
  expect(retry.disabled).toBe(false)
  expect(track.readyState).toBe('live'); expect(stopTrack).not.toHaveBeenCalled()
  expect(controlCounts()).toEqual(counts)
  await act(async () => retry.click())
  expect(video('stage-a').srcObject).toBeNull()
  expect(surface('stage-a').querySelector('[role="status"]')).toBeNull()
  await emit(uncover()); await frame('stage-a')
  expect(video('stage-a').srcObject).toBe(stream)
  expect(surface('stage-a').querySelector('[role="status"]')).toBeNull()
  expect(controlCounts()).toEqual(counts)
})

it('does not clear an actual playback failure when Native coverage succeeds', async () => {
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error('Playback denied'))
  await mount(); await frame('stage-a')
  expect(surface('stage-a').textContent).toContain('Playback denied')
  await emit(coverage('lease-stage-a'))
  expect(video('stage-a').srcObject).toBeNull()
  expect(surface('stage-a').textContent).toContain('Playback denied')
  expect(surface('stage-a').querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
})

it('releases a revoked source bitmap and never lends its image to the next capture', async () => {
  await mount(); await frame('stage-a'); await frame('stage-b')
  await emit(coverage('lease-stage-a'))
  const oldCanvas = stage('stage-a').querySelector('canvas')!, oldVideo = video('stage-a')
  await emit({ type: 'capture-revoked', browserId, captureId, reason: 'source-replaced' })
  expect([oldCanvas.width, oldCanvas.height, oldCanvas.hidden]).toEqual([0, 0, true])
  expect(oldVideo.srcObject).toBeNull()
  expect(stage('stage-a').querySelector('canvas')).toBeNull()
  expect(surface('stage-a').textContent).toContain('Live preview source changed')
  const nextStream = new MediaStream()
  Object.defineProperty(nextStream, 'getTracks', { value: () => [track] })
  trackState = 'live'
  display.mockResolvedValueOnce(nextStream)
  bridge.armPresentationCapture.mockResolvedValueOnce({ captureId: 'next-capture', browserId })
  await emit(uncover())
  await act(async () => surface('stage-a').querySelector<HTMLButtonElement>('button')!.click())
  expect(video('stage-a').srcObject).toBe(nextStream)
  const nextCanvas = stage('stage-a').querySelector('canvas')!
  expect(nextCanvas).not.toBe(oldCanvas)
  expect(nextCanvas.hidden).toBe(true)
  expect(drawFrame).toHaveBeenCalledTimes(1)
})

it('releases the local bitmap, attached receiver and pending frame callback when the workface ends', async () => {
  await mount(); await frame('stage-a'); await frame('stage-b')
  await emit(coverage('lease-stage-a')); await emit(uncover())
  const a = video('stage-a'), b = video('stage-b'), canvas = stage('stage-a').querySelector('canvas')!
  await act(async () => {
    Object.assign(state(a), { readyState: 2, width: 640, height: 320 })
    a.dispatchEvent(new Event('loadeddata'))
  })
  const old = [...frameCallbacks.values()][0]!
  expect(old).toBeDefined()
  await act(async () => root.render(null))
  expect(frameCallbacks.size).toBe(0)
  expect(a.srcObject).toBeNull(); expect(b.srcObject).toBeNull()
  expect([canvas.width, canvas.height, canvas.hidden]).toEqual([0, 0, true])
  await act(async () => old.callback(0, {} as VideoFrameCallbackMetadata))
  expect(canvas.hidden).toBe(true)
})

it.each(['track-ended', 'source-released'] as const)('reports %s while covered and keeps the original page available for explicit recovery', async reason => {
  await mount(); await frame('stage-a'); await frame('stage-b')
  await emit(coverage('lease-stage-a'))
  if (reason === 'track-ended') await act(async () => { trackState = 'ended'; track.dispatchEvent(new Event('ended')) })
  else await emit({ type: 'capture-revoked', browserId, captureId, reason })
  const message = reason === 'track-ended' ? 'Live preview media ended' : 'Live preview stopped (source-released)'
  expect(container.querySelector('video')).toBeNull()
  expect(surface('stage-a').textContent).toContain(message)
  expect(surface('stage-b').textContent).toContain(message)
  expect(stage('stage-a').querySelector('[data-original-page]')).not.toBeNull()
  expect(surface('stage-a').querySelector<HTMLButtonElement>('button')?.disabled).toBe(false)
  expect(stopTrack).toHaveBeenCalledTimes(1)
  if (reason === 'track-ended') expect(bridge.ackPresentationCapture).toHaveBeenCalledWith(captureId, { outcome: 'stopped', trackIds: ['original-track'] })
  const counts = controlCounts()
  await emit(uncover())
  expect(container.querySelector('video')).toBeNull()
  expect(surface('stage-a').textContent).toContain(message)
  expect(controlCounts()).toEqual(counts)
})
