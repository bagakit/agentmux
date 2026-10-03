// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { previewFrame, previewMedia } from './helpers/browser-preview-media'

const bridge = vi.hoisted(() => ({
  registerPresentation: vi.fn(), removePresentation: vi.fn(), updatePresentation: vi.fn(),
  activatePresentation: vi.fn(), armPresentationCapture: vi.fn(), ackPresentationCapture: vi.fn(),
  onPresentationEvent: vi.fn(), getZoomFactor: vi.fn()
}))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: bridge, ui: bridge } }))
vi.mock('../src/renderer/src/store', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create(() => ({ noticeReadReceipts: {}, acquireNativeSurfaceOverlay() {}, releaseNativeSurfaceOverlay() {} })) }
})
// Consume the actual persistent disclosure; a null mock would hide the source failure.
import { BrowserPresentationStage, useBrowserPresentationCapture } from '../src/renderer/src/components/BrowserPresentationStage'

type StageProps = Omit<ComponentProps<typeof BrowserPresentationStage>, 'media'>
const presentation: StageProps['presentation'] = {
  occurrence: { presentationId: 'presentation-one', location: {
    displayWorkspaceId: 'workspace-one', groupId: 'group-one', tabId: 'tab-one', regionId: 'region-one'
  } },
  stageHostId: 'original-stage-host', visible: true, active: true, yieldToFocusRing: false,
  target: { hostId: 'original-host', surface: 'space', active: true }
}
function LiveStage(props: StageProps) {
  const media = useBrowserPresentationCapture(props.browserId)
  return createElement(BrowserPresentationStage, { ...props, media },
    createElement('span', { 'data-original-content': '' }, 'Original page retained'))
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let root: Root, container: HTMLDivElement
let props: StageProps
let originalRect: typeof HTMLElement.prototype.getBoundingClientRect
let mediaDescriptor: PropertyDescriptor | undefined
let stageWidth: number
const stopped = vi.fn()
async function render(next: Partial<StageProps> = {}, advanceDocumentTask = true) {
  props = { ...props, ...next }
  await act(async () => root.render(createElement(LiveStage, props)))
  if (advanceDocumentTask) await documentTask()
}
async function settle() { await act(async () => {}) }
async function documentTask() { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete')
  bridge.registerPresentation.mockReset().mockResolvedValue({ leaseId: 'actual-lease' })
  bridge.removePresentation.mockResolvedValue(undefined)
  bridge.updatePresentation.mockResolvedValue(undefined)
  bridge.activatePresentation.mockResolvedValue({ outcome: 'selected' })
  bridge.armPresentationCapture.mockResolvedValue({ captureId: 'capture-one', browserId: 'browser-one' })
  bridge.ackPresentationCapture.mockResolvedValue(undefined)
  bridge.onPresentationEvent.mockImplementation(() => () => {})
  bridge.getZoomFactor.mockReturnValue(1)
  mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getDisplayMedia: vi.fn(async () => {
      const { track, stream } = previewMedia('track-one')
      track.stop = stopped
      return stream
    })
  } })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function () { previewFrame(this); return Promise.resolve() })
  originalRect = HTMLElement.prototype.getBoundingClientRect
  stageWidth = 640
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 10, y: 40, width: stageWidth, height: 320, left: 10, top: 40, right: 10 + stageWidth, bottom: 360, toJSON: () => ({}) }
  }
  props = { browserId: 'browser-one', navigationId: '', presentation, inputSelected: true, blocked: false }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  HTMLElement.prototype.getBoundingClientRect = originalRect
  if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor)
  else delete (navigator as unknown as Record<string, unknown>).mediaDevices
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('reconnects the retained Stage after authoritative creation updates the same Browser identity', async () => {
  bridge.registerPresentation.mockRejectedValueOnce(new Error('Unknown browser: browser-one'))
  await render()
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('Unknown browser: browser-one')
  const stage = container.querySelector('[data-native-browser-stage]')
  await render({ navigationId: 'actual-navigation' })
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[data-native-browser-stage]')).toBe(stage)
  expect(container.querySelector('[data-original-content]')).not.toBeNull()
  expect(container.querySelector('[role="status"]')).toBeNull()
  expect(bridge.armPresentationCapture).toHaveBeenCalledTimes(1)
  expect(bridge.activatePresentation.mock.calls).toEqual([['actual-lease', { kind: 'select', focus: 'preserve' }]])
})

it('consumes creation that arrived while the failed registration was still pending', async () => {
  const pending = deferred<{ leaseId: string }>()
  bridge.registerPresentation.mockReturnValueOnce(pending.promise)
  await render()
  await render({ navigationId: 'actual-navigation' })
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  await act(async () => pending.reject(new Error('Unknown browser: browser-one')))
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[role="status"]')).toBeNull()
  expect(bridge.armPresentationCapture).toHaveBeenCalledTimes(1)
  expect(bridge.activatePresentation.mock.calls).toEqual([['actual-lease', { kind: 'select', focus: 'preserve' }]])
})

it('does not replay an older registration failure when a retry succeeds after another identity update', async () => {
  const pending = deferred<{ leaseId: string }>()
  bridge.registerPresentation.mockRejectedValueOnce(new Error('Unknown browser: browser-one'))
    .mockReturnValueOnce(pending.promise)
  await render()
  await render({ navigationId: 'first-available-navigation' })
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(2)
  await render({ navigationId: 'next-available-navigation' })
  await act(async () => pending.resolve({ leaseId: 'confirmed-recovered-lease' }))
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(2)
  expect(bridge.removePresentation).not.toHaveBeenCalled()
  expect(bridge.activatePresentation.mock.calls).toEqual([['confirmed-recovered-lease', { kind: 'select', focus: 'preserve' }]])
  expect(container.querySelector('[role="status"]')).toBeNull()
})

it('retains a successful lease and its original initial owner through ordinary navigation', async () => {
  await render({ navigationId: 'first-navigation' })
  await render({ navigationId: 'second-navigation' })
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(bridge.removePresentation).not.toHaveBeenCalled()
  expect(bridge.activatePresentation.mock.calls).toEqual([['actual-lease', { kind: 'select', focus: 'preserve' }]])
  expect(bridge.armPresentationCapture).toHaveBeenCalledTimes(1)
})

it('does not poll or retry the same failed identity on unrelated rerenders', async () => {
  bridge.registerPresentation.mockRejectedValue(new Error('Unknown browser: browser-one'))
  await render()
  await render({ blocked: true })
  await render({ blocked: false })
  await settle()
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('Unknown browser: browser-one')
  expect(container.textContent).not.toContain('Keep this window in the foreground')
  expect(bridge.activatePresentation).not.toHaveBeenCalled()
})

it('allows an explicit connection retry without reopening the page or taking focus', async () => {
  bridge.registerPresentation.mockRejectedValueOnce(new Error('Unknown browser: browser-one'))
  await render()
  const retry = container.querySelector<HTMLButtonElement>('.browser-presentation-notice > .small-button')
  expect(retry?.textContent).toBe('Retry connection')
  await act(async () => retry!.click())
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(2)
  expect(bridge.activatePresentation.mock.calls).toEqual([['actual-lease', { kind: 'select', focus: 'preserve' }]])
  expect(container.querySelector('[role="status"]')).toBeNull()
})

it('does not revive an unmounted failed registration on a late rejection', async () => {
  const pending = deferred<{ leaseId: string }>()
  bridge.registerPresentation.mockReturnValueOnce(pending.promise)
  await render()
  await render({ navigationId: 'actual-navigation' })
  await act(async () => root.render(null))
  await act(async () => pending.reject(new Error('Unknown browser: browser-one')))
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(bridge.activatePresentation).not.toHaveBeenCalled()
  expect(container.textContent).toBe('')
})

it('removes a late successful lease from an old Browser without selecting or exposing it', async () => {
  const pending = deferred<{ leaseId: string }>()
  bridge.registerPresentation.mockReturnValueOnce(pending.promise)
  await render()
  await render({ browserId: 'browser-two', navigationId: 'actual-two' })
  await act(async () => pending.resolve({ leaseId: 'late-old-lease' }))
  expect(bridge.removePresentation).toHaveBeenCalledWith('late-old-lease')
  expect(bridge.activatePresentation.mock.calls.some(([id]) => id === 'late-old-lease')).toBe(false)
  expect(container.querySelector('[data-native-browser-stage]')?.getAttribute('data-native-browser-stage')).toBe('browser-two')
})

it('does not clear a failure from a separate input authority when registration succeeds', async () => {
  bridge.activatePresentation.mockRejectedValue(new Error('Input owner is unconfirmed'))
  await render({ navigationId: 'first-navigation' })
  expect(container.textContent).toContain('Input owner is unconfirmed')
  await render({ navigationId: 'second-navigation' })
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('Input owner is unconfirmed')
  expect(container.querySelector('.browser-presentation-notice > .small-button')?.textContent).toBe('Retry preview')
})

it('delays initial input ownership until the existing registered Stage has actual positive geometry', async () => {
  await render({ blocked: true })
  expect(bridge.registerPresentation.mock.calls[0]![0].geometry).toEqual({ visible: false })
  expect(bridge.activatePresentation).not.toHaveBeenCalled()
  expect(bridge.armPresentationCapture).not.toHaveBeenCalled()
  await render({ blocked: false, navigationId: 'first-visible-navigation' })
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(bridge.updatePresentation).toHaveBeenCalledWith('actual-lease', { visible: true,
    bounds: { x: 10, y: 40, width: 640, height: 320 } })
  expect(bridge.activatePresentation.mock.calls).toEqual([['actual-lease', { kind: 'select', focus: 'preserve' }]])
  expect(bridge.armPresentationCapture).toHaveBeenCalledTimes(1)
  await render({ navigationId: 'ordinary-navigation' })
  expect(bridge.activatePresentation).toHaveBeenCalledTimes(1)
})

it('does not consume initial selection on an unconfirmed native receipt', async () => {
  bridge.activatePresentation.mockResolvedValue({ outcome: 'input-unconfirmed', reason: 'hidden', message: 'Native geometry is still hidden' })
  await render()
  expect(container.textContent).toContain('Native geometry is still hidden')
  expect(bridge.armPresentationCapture).not.toHaveBeenCalled()
  const attempted = bridge.activatePresentation.mock.calls.length
  bridge.activatePresentation.mockResolvedValue({ outcome: 'selected' })
  await render({ blocked: true })
  await render({ blocked: false })
  expect(bridge.activatePresentation).toHaveBeenCalledTimes(attempted + 1)
  expect(bridge.armPresentationCapture).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[role="status"]')).toBeNull()
})

it('coalesces pending initial input selection across stages sharing one original capture owner', async () => {
  const selection = deferred<{ outcome: 'selected' }>()
  bridge.activatePresentation.mockReturnValueOnce(selection.promise)
  function TwoStages() {
    const media = useBrowserPresentationCapture(props.browserId)
    return createElement('div', null,
      createElement(BrowserPresentationStage, { ...props, media }),
      createElement(BrowserPresentationStage, { ...props, media,
        presentation: { ...presentation, occurrence: { ...presentation.occurrence, presentationId: 'presentation-two' } } }))
  }
  await act(async () => root.render(createElement(TwoStages)))
  await documentTask()
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(2)
  expect(bridge.activatePresentation).toHaveBeenCalledTimes(1)
  await act(async () => selection.resolve({ outcome: 'selected' }))
  expect(bridge.activatePresentation).toHaveBeenCalledTimes(1)
  expect(bridge.armPresentationCapture).toHaveBeenCalledTimes(1)
})

it('does not start capture when an old initial selection completes after the capture owner unmounts', async () => {
  const selection = deferred<{ outcome: 'selected' }>()
  bridge.activatePresentation.mockReturnValueOnce(selection.promise)
  await render()
  await act(async () => root.render(null))
  await act(async () => selection.resolve({ outcome: 'selected' }))
  expect(bridge.removePresentation).toHaveBeenCalledWith('actual-lease')
  expect(bridge.armPresentationCapture).not.toHaveBeenCalled()
  expect(container.textContent).toBe('')
})

it('keeps native selection and geometry working after a capture timeout without repeated system capture requests', async () => {
  const capture = vi.mocked(navigator.mediaDevices.getDisplayMedia)
  capture.mockRejectedValueOnce(new Error('Timeout starting video source'))
  await render({ navigationId: 'initial-navigation' })
  expect(capture).toHaveBeenCalledTimes(1)
  expect(bridge.activatePresentation.mock.calls).toEqual([['actual-lease', { kind: 'select', focus: 'preserve' }]])
  expect(container.textContent).toContain('Timeout starting video source')
  const retainedStage = container.querySelector('[data-native-browser-stage]')
  const service = container.querySelector('.browser-presentation-notice')!
  expect(service.querySelector('.service-disclosure')).not.toBeNull()
  expect(service.parentElement).toBe(retainedStage!.parentElement)
  expect(retainedStage!.contains(service)).toBe(false)
  await render({ navigationId: 'next-navigation', blocked: true })
  await render({ blocked: false })
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(bridge.updatePresentation).toHaveBeenCalledWith('actual-lease', { visible: true,
    bounds: { x: 10, y: 40, width: 640, height: 320 } })
  expect(capture).toHaveBeenCalledTimes(1)
  expect(bridge.armPresentationCapture).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[data-native-browser-stage]')).toBe(retainedStage)
  expect(container.textContent).toContain('Timeout starting video source')
})

it('retries only the current live preview on an explicit action and clears failure after the real capture receipt', async () => {
  const capture = vi.mocked(navigator.mediaDevices.getDisplayMedia)
  capture.mockRejectedValueOnce(new Error('Timeout starting video source'))
  await render()
  const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry preview')!
  expect(retry).not.toBeUndefined()
  await act(async () => retry.click())
  expect(capture).toHaveBeenCalledTimes(2)
  expect(bridge.armPresentationCapture).toHaveBeenCalledTimes(2)
  expect(bridge.ackPresentationCapture.mock.calls.map(([, receipt]) => receipt.outcome)).toEqual(['failed', 'ready'])
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(bridge.activatePresentation).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[role="status"]')).toBeNull()
})

it('does not retry live capture from a hidden or blocked presentation', async () => {
  const capture = vi.mocked(navigator.mediaDevices.getDisplayMedia)
  capture.mockRejectedValueOnce(new Error('Timeout starting video source'))
  await render()
  await render({ blocked: true })
  const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry preview')!
  expect(retry.disabled).toBe(true)
  await act(async () => retry.click())
  expect(capture).toHaveBeenCalledTimes(1)
  await render({ blocked: false, presentation: { ...presentation, visible: false } })
  expect(retry.disabled).toBe(true)
  await act(async () => retry.click())
  expect(capture).toHaveBeenCalledTimes(1)
})

it('does not publish a late capture failure after its original capture owner unmounts', async () => {
  const pending = deferred<MediaStream>()
  vi.mocked(navigator.mediaDevices.getDisplayMedia).mockReturnValueOnce(pending.promise)
  await render()
  await act(async () => root.render(null))
  await act(async () => pending.reject(new Error('Timeout starting video source')))
  expect(bridge.ackPresentationCapture).toHaveBeenCalledWith('capture-one', { outcome: 'failed', message: 'Timeout starting video source' })
  expect(container.textContent).toBe('')
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
})

it('updates the original native geometry while live capture is still pending', async () => {
  const pending = deferred<MediaStream>()
  vi.mocked(navigator.mediaDevices.getDisplayMedia).mockReturnValueOnce(pending.promise)
  await render()
  try {
    expect(bridge.activatePresentation.mock.calls).toEqual([['actual-lease', { kind: 'select', focus: 'preserve' }]])
    expect(bridge.updatePresentation).toHaveBeenCalledWith('actual-lease', { visible: true,
      bounds: { x: 10, y: 40, width: 640, height: 320 } })
    stageWidth = 720
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(bridge.updatePresentation).toHaveBeenCalledWith('actual-lease', { visible: true,
      bounds: { x: 10, y: 40, width: 720, height: 320 } })
    expect(bridge.armPresentationCapture).toHaveBeenCalledTimes(1)
    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => pending.reject(new Error('Timeout starting video source')))
  }
})

it('stops only its acquired stream when ready acknowledgement completes after owner unmount', async () => {
  const acknowledgement = deferred<void>()
  bridge.ackPresentationCapture.mockReturnValueOnce(acknowledgement.promise)
  await render()
  expect(bridge.ackPresentationCapture).toHaveBeenCalledWith('capture-one', { outcome: 'ready', trackIds: ['track-one'] })
  await act(async () => root.render(null))
  await act(async () => acknowledgement.resolve(undefined))
  expect(stopped).toHaveBeenCalledTimes(1)
  expect(bridge.ackPresentationCapture).toHaveBeenCalledWith('capture-one', { outcome: 'stopped', trackIds: ['track-one'] })
  expect(container.textContent).toBe('')
})


it('waits for the original document and one task before same-navigation registration', async () => {
  const ready = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading')
  await render({ navigationId: 'same-original-navigation' }, false)
  await documentTask()
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(0)
  expect(container.querySelector('[data-original-content]')).not.toBeNull()
  ready.mockReturnValue('complete')
  await act(async () => window.dispatchEvent(new Event('load')))
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(0)
  await documentTask()
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(bridge.activatePresentation.mock.calls).toEqual([['actual-lease', { kind: 'select', focus: 'preserve' }]])
  expect(props.navigationId).toBe('same-original-navigation')
})

it('also yields one task for a completed hidden document without waiting for a frame', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await render({ navigationId: 'warm-original-navigation' }, false)
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(0)
  await documentTask()
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(bridge.armPresentationCapture).toHaveBeenCalledTimes(1)
})

it('cancels original document readiness on Stage unmount', async () => {
  const removed=vi.spyOn(window,'removeEventListener')
  const added=vi.spyOn(window,'addEventListener')
  const ready = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading')
  await render({}, false)
  await act(async () => root.unmount())
  root = createRoot(container)
  const originalLoad=added.mock.calls.find(row=>row[0]==='load')![1]
  expect(removed.mock.calls.some(row=>row[0]==='load'&&row[1]===originalLoad)).toBe(true)
  ready.mockReturnValue('complete')
  await act(async () => window.dispatchEvent(new Event('load')))
  await documentTask()
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(0)
  expect(bridge.activatePresentation).toHaveBeenCalledTimes(0)
})

it('cancels the scheduled document task on Stage unmount', async () => {
  await render({}, false)
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(0)
  await act(async () => root.unmount())
  root = createRoot(container)
  expect(vi.getTimerCount()).toBe(0)
  await documentTask()
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(0)
  expect(bridge.activatePresentation).toHaveBeenCalledTimes(0)
})

it('reads latest geometry and input intent when document readiness crosses an update', async () => {
  const ready = vi.spyOn(document, 'readyState', 'get').mockReturnValue('interactive')
  await render({ inputSelected: false, navigationId: 'same-original-navigation' }, false)
  stageWidth = 440
  await render({ inputSelected: true }, false)
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(0)
  ready.mockReturnValue('complete')
  await act(async () => window.dispatchEvent(new Event('load')))
  await documentTask()
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(bridge.registerPresentation.mock.calls[0]![0].geometry.bounds.width).toBe(440)
  expect(bridge.activatePresentation.mock.calls).toEqual([['actual-lease', { kind: 'select', focus: 'preserve' }]])
  await act(async () => window.dispatchEvent(new Event('load')))
  await documentTask()
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
})
