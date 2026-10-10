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
function Workfaces() {
  const media = useBrowserPresentationCapture(browserId)
  return createElement('div', null, ...presentations.map((item, index) => createElement(BrowserPresentationStage, {
    key: item.occurrence.presentationId, browserId, navigationId: 'original-navigation', presentation: item,
    inputSelected: index === 0, blocked: false, media
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
async function mount() {
  await act(async () => root.render(createElement(Workfaces)))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}
async function frame(id: string) {
  await act(async () => {
    const node = video(id)
    Object.assign(state(node), { readyState: 2, width: 640, height: 320 })
    node.dispatchEvent(new Event('loadeddata'))
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
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks(); playback = new WeakMap(); pendingPlay = null; listeners = new Set()
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

it('pauses only the exactly covered lease and resumes its same video, last frame, stream and live track without control work', async () => {
  await mount(); await frame('stage-a'); await frame('stage-b')
  const a = video('stage-a'), b = video('stage-b'), originalStage = stage('stage-a')
  const originalPage = originalStage.querySelector('[data-original-page]'), counts = controlCounts()
  expect(a.srcObject).toBe(stream); expect(b.srcObject).toBe(stream)
  await emit(coverage('lease-stage-a'))
  expect(a.paused).toBe(true); expect(b.paused).toBe(false)
  expect(a.readyState).toBe(2); expect(a.videoWidth).toBe(640); expect(a.videoHeight).toBe(320)
  expect(a.srcObject).toBe(stream); expect(track.readyState).toBe('live'); expect(stopTrack).not.toHaveBeenCalled()
  expect(controlCounts()).toEqual(counts)
  await emit(uncover())
  expect(video('stage-a')).toBe(a); expect(video('stage-b')).toBe(b)
  expect(stage('stage-a')).toBe(originalStage); expect(originalStage.querySelector('[data-original-page]')).toBe(originalPage)
  expect(a.srcObject).toBe(stream); expect(b.srcObject).toBe(stream)
  expect(stream.getTracks()).toEqual([track]); expect(track.readyState).toBe('live')
  expect(a.paused).toBe(false); expect(b.paused).toBe(false)
  expect(controlCounts()).toEqual(counts); expect(stopTrack).not.toHaveBeenCalled()
  expect(surface('stage-a').querySelector('[role="status"]')).toBeNull()
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
  expect(surface('stage-a').textContent).not.toContain('Starting preview playback')
  await emit(uncover())
  expect(video('stage-a')).toBe(a); expect(a.srcObject).toBe(stream); expect(a.paused).toBe(false)
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
  expect(surface('stage-a').querySelector('[role="status"]')).toBeNull()
  expect(controlCounts()).toEqual(counts)
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
