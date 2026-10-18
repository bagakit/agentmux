// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { selectedBrowserPresentationId } from '../src/renderer/src/lib/browser-presentation-selection'
import type { WorkbenchBrowserPresentation } from '../src/renderer/src/components/BrowserPresentationStage'

const bridge = vi.hoisted(() => ({ registerPresentation: vi.fn(), updatePresentation: vi.fn(), removePresentation: vi.fn(),
  activatePresentation: vi.fn(), armPresentationCapture: vi.fn(), ackPresentationCapture: vi.fn(), onPresentationEvent: vi.fn(), getZoomFactor: vi.fn() }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: bridge, ui: bridge } }))
import { BrowserPresentationStage, useBrowserPresentationCapture } from '../src/renderer/src/components/BrowserPresentationStage'

const agent = { displayWorkspaceId: 'w', groupId: 'g', tabId: 't', regionId: 'agent' }
const browser = { ...agent, regionId: 'browser' }
const make = (surface: 'focus' | 'survey' | 'space' | 'mote', entity: 'tab' | 'region' | 'zone' = 'tab'): WorkbenchBrowserPresentation => ({
  occurrence: { presentationId: surface, location: browser }, stageHostId: surface, visible: true, active: true, yieldToFocusRing: false,
  target: { hostId: surface, surface, active: true, reference: agent, projection: {
    entity: entity === 'tab' ? { kind: 'tab', tabId: 't' } : entity === 'region' ? { kind: 'region', regionId: 'agent' } : { kind: 'zone', zoneId: 'z' },
    presentationId: surface, displayWorkspaceId: 'w', selection: [agent], catalog: {} as never, onSelect: () => {}
  } }
})
const state = (mainSurface: 'agents' | 'survey' | 'workbench') => ({ mainSurface, layouts: { w: { activeGroupId: 'g' } },
  surveyZoneSelection: { zoneId: 'z', selection: [agent], active: agent } })
it('selects visible Browser siblings in actual whole-Tab Focus and Survey scopes', () => {
  expect(selectedBrowserPresentationId([make('focus')], state('agents'))).toBe('focus')
  expect(selectedBrowserPresentationId([make('survey')], state('survey'))).toBe('survey')
  expect(selectedBrowserPresentationId([make('survey', 'zone')], state('survey'))).toBe('survey')
  expect(selectedBrowserPresentationId([make('space')], state('workbench'))).toBe('space')
})
it('retains exact Region scope, location, visibility and ambiguity protection', () => {
  expect(selectedBrowserPresentationId([make('focus', 'region')], state('agents'))).toBeNull()
  const exact = make('focus', 'region'); exact.target.reference = browser; exact.target.projection!.entity = { kind: 'region', regionId: 'browser' }
  expect(selectedBrowserPresentationId([exact], state('agents'))).toBe('focus')
  expect(selectedBrowserPresentationId([{ ...make('focus'), visible: false }], state('agents'))).toBeNull()
  expect(selectedBrowserPresentationId([{ ...make('focus'), active: false }], state('agents'))).toBeNull()
  const unrelated = make('focus'); unrelated.target.reference = { ...agent, groupId: 'other' }
  expect(selectedBrowserPresentationId([unrelated], state('agents'))).toBeNull()
  expect(selectedBrowserPresentationId([make('focus'), { ...make('focus'), occurrence: { ...make('focus').occurrence, presentationId: 'duplicate' } }], state('agents'))).toBeNull()
})
it('does not give Mote pinned or hover previews passive ownership', () => {
  expect(selectedBrowserPresentationId([make('mote')], state('agents'))).toBeNull()
  expect(selectedBrowserPresentationId([{ ...make('mote'), active: false }], state('agents'))).toBeNull()
})

let container: HTMLDivElement, root: Root, selected: boolean, width: number
let capture: ReturnType<typeof vi.fn>, events: (event: any) => void
function Workface({ inputSelected, two = false, visible = true }: { inputSelected: boolean; two?: boolean; visible?: boolean }) {
  const media = useBrowserPresentationCapture('browser')
  const first = make(two ? 'space' : 'focus'), second = { ...make('focus'), visible }
  return createElement('div', null,
    createElement(BrowserPresentationStage, { browserId: 'browser', navigationId: 'nav', presentation: first, inputSelected: two ? !inputSelected : inputSelected, blocked: false, media }),
    two ? createElement(BrowserPresentationStage, { browserId: 'browser', navigationId: 'nav', presentation: second, inputSelected, blocked: false, media }) : null)
}
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const render = async (next: boolean, two = false) => { selected = next; await act(async () => root.render(createElement(Workface, { inputSelected: selected, two }))) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks(); selected = false; width = 640
  bridge.registerPresentation.mockReset().mockImplementation(async request => ({ leaseId: 'lease-' + request.occurrence.presentationId }))
  bridge.updatePresentation.mockReset().mockResolvedValue(undefined); bridge.removePresentation.mockReset().mockResolvedValue(undefined)
  bridge.activatePresentation.mockReset().mockResolvedValue({ outcome: 'selected' })
  bridge.armPresentationCapture.mockReset().mockResolvedValue({ captureId: 'capture', browserId: 'browser' })
  bridge.ackPresentationCapture.mockReset().mockResolvedValue(undefined)
  bridge.onPresentationEvent.mockReset().mockImplementation(callback => { events = callback; return () => {} }); bridge.getZoomFactor.mockReturnValue(1)
  capture = vi.fn().mockRejectedValue(new Error('Timeout starting video source'))
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: capture } })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(10, 40, width, 320))
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('acknowledges stopped tracks on capture revocation without touching a later capture', async () => {
  const track = new EventTarget() as EventTarget & { id: string; kind: string; readyState: string; stop: ReturnType<typeof vi.fn> }
  Object.assign(track, { id: 'original-track', kind: 'video', readyState: 'live', stop: vi.fn(() => { track.readyState = 'ended' }) })
  const stream = new MediaStream([track as unknown as MediaStreamTrack])
  const next = new EventTarget() as typeof track
  Object.assign(next, { id: 'next-track', kind: 'video', readyState: 'live', stop: vi.fn(() => { next.readyState = 'ended' }) })
  const nextStream = new MediaStream([next as unknown as MediaStreamTrack])
  // HappyDOM's MediaStream omits this standard device API. Supply only that
  // IO method from its own actual stored tracks; retain its native DOM identity.
  Object.defineProperty(stream, 'getTracks', { value: () => stream.getVideoTracks() })
  Object.defineProperty(nextStream, 'getTracks', { value: () => nextStream.getVideoTracks() })
  // This is the original mounted Stage and media hook. Only device IO is a
  // fixture; HappyDOM owns the MediaStream and the video's srcObject setter.
  function CaptureConsumer() {
    const media = useBrowserPresentationCapture('browser')
    return createElement('div', { 'data-capture-phase': media.capturePhase },
      createElement(BrowserPresentationStage, { browserId: 'browser', navigationId: 'nav', presentation: make('focus'), inputSelected: false, blocked: false, media }))
  }
  const ready = async (captureId: string, media: MediaStream, trackId: string) => {
    await vi.waitFor(async () => {
      await act(async () => {})
      expect(bridge.ackPresentationCapture).toHaveBeenCalledWith(captureId, { outcome: 'ready', trackIds: [trackId] })
      expect(container.querySelector('[data-capture-phase]')?.getAttribute('data-capture-phase')).toBe('ready')
      expect(container.querySelector('video')?.srcObject).toBe(media)
    }, { timeout: 3000, interval: 10 })
  }
  let originalReady = false, laterReady = false, retiredAck = false, staleEventIgnored = false
  try {
    capture.mockResolvedValue(stream)
    await act(async () => root.render(createElement(CaptureConsumer)))
    // Production mounts after document load and one task. Deliver that DOM
    // lifecycle within act before expecting any lease or media acknowledgements.
    await act(async () => { window.dispatchEvent(new Event('load')); await new Promise(resolve => setTimeout(resolve, 0)) })
    await ready('capture', stream, track.id); originalReady = true
    bridge.ackPresentationCapture.mockClear()
    await act(async () => events({ type: 'capture-revoked', browserId: 'browser', captureId: 'capture', reason: 'no-visible-presentations' }))
    expect(track.stop).toHaveBeenCalledOnce()
    retiredAck = bridge.ackPresentationCapture.mock.calls.length === 1 && bridge.ackPresentationCapture.mock.calls[0]?.[1]?.outcome === 'stopped'
    expect(bridge.ackPresentationCapture.mock.calls, 'ready capture retirement must acknowledge its actual stopped tracks').toEqual([['capture', { outcome: 'stopped', trackIds: [track.id] }]])
    expect(container.querySelector('video')).toBeNull()

    bridge.armPresentationCapture.mockResolvedValue({ captureId: 'next-capture', browserId: 'browser' })
    capture.mockResolvedValue(nextStream)
    width += 1
    await act(async () => window.dispatchEvent(new Event('resize')))
    await ready('next-capture', nextStream, next.id); laterReady = true
    bridge.ackPresentationCapture.mockClear()
    await act(async () => events({ type: 'capture-revoked', browserId: 'browser', captureId: 'capture', reason: 'no-visible-presentations' }))
    expect(next.stop).not.toHaveBeenCalled()
    expect(bridge.ackPresentationCapture).not.toHaveBeenCalled()
    expect(container.querySelector('video')?.srcObject).toBe(nextStream)
    expect(container.querySelector('[data-capture-phase]')?.getAttribute('data-capture-phase')).toBe('ready')
    staleEventIgnored = true
  } finally {
    if (process.env.AGENTMUX_CAPTURE_RETIREMENT_FACTS) await appendFile(process.env.AGENTMUX_CAPTURE_RETIREMENT_FACTS, JSON.stringify({
      originalReady, laterReady, retiredAck, staleEventIgnored, originalStopCalls: track.stop.mock.calls.length,
      laterStopCalls: next.stop.mock.calls.length, documentState: document.readyState,
      registerCalls: bridge.registerPresentation.mock.calls.length, armCalls: bridge.armPresentationCapture.mock.calls.length,
      deviceCalls: capture.mock.calls.length, phase: container.querySelector('[data-capture-phase]')?.getAttribute('data-capture-phase'),
      originalStreamOwnedByHappyDOM: stream instanceof MediaStream, nextStreamOwnedByHappyDOM: nextStream instanceof MediaStream
    }) + '\n')
  }
})
it('selects the existing lease on same-geometry intent change despite capture failure', async () => {
  await render(false); expect(bridge.activatePresentation).not.toHaveBeenCalled(); expect(capture).toHaveBeenCalledTimes(1)
  const nativeStage = container.querySelector('[data-native-browser-stage]')
  await render(true)
  expect(bridge.activatePresentation.mock.calls).toEqual([['lease-focus', { kind: 'select', focus: 'preserve' }]])
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1); expect(capture).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[data-native-browser-stage]')).toBe(nativeStage)
  expect(container.textContent).toContain('Timeout starting video source')
  await render(true); await act(async () => window.dispatchEvent(new Event('resize')))
  expect(bridge.activatePresentation).toHaveBeenCalledTimes(1); expect(capture).toHaveBeenCalledTimes(1)
})
it('confirms new geometry through the original writer before selecting the intended lease', async () => {
  await render(false); width = 720
  bridge.activatePresentation.mockImplementation(async () => {
    expect(bridge.updatePresentation.mock.calls.at(-1)).toEqual(['lease-focus', { visible: true, bounds: { x: 10, y: 40, width: 720, height: 320 } }])
    return { outcome: 'selected' }
  })
  await render(true); expect(bridge.activatePresentation).toHaveBeenCalledTimes(1)
})
it('transfers the real Space owner to Focus without a resize or another system capture request', async () => {
  await render(false, true)
  expect(bridge.activatePresentation.mock.calls).toEqual([['lease-space', { kind: 'select', focus: 'preserve' }]])
  await render(true, true)
  expect(bridge.activatePresentation.mock.calls).toEqual([['lease-space', { kind: 'select', focus: 'preserve' }], ['lease-focus', { kind: 'select', focus: 'preserve' }]])
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(2); expect(capture).toHaveBeenCalledTimes(1)
})
it('does not treat a pending older selection as the selected current lease', async () => {
  const pending = deferred<{ outcome: 'selected' }>(); bridge.activatePresentation.mockReturnValueOnce(pending.promise)
  await render(false, true); await render(true, true)
  expect(bridge.activatePresentation).toHaveBeenCalledTimes(1)
  await act(async () => pending.resolve({ outcome: 'selected' }))
  expect(bridge.activatePresentation.mock.calls.at(-1)).toEqual(['lease-focus', { kind: 'select', focus: 'preserve' }])
  expect(bridge.activatePresentation).toHaveBeenCalledTimes(2)
})
it('cancels selection when the intent reverses before geometry confirmation', async () => {
  await render(false)
  await vi.waitFor(() => expect(bridge.registerPresentation).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(bridge.updatePresentation).toHaveBeenCalled())
  const pending = deferred<void>(); bridge.updatePresentation.mockReturnValueOnce(pending.promise)
  await render(true); await render(false); await act(async () => pending.resolve(undefined))
  expect(bridge.activatePresentation).not.toHaveBeenCalled()
})
it('does not select a late geometry receipt after unmount', async () => {
  const initialGeometry = deferred<void>()
  bridge.updatePresentation.mockImplementationOnce(async () => initialGeometry.resolve(undefined))
  await render(false); await act(async () => initialGeometry.promise)
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(bridge.updatePresentation.mock.calls).toEqual([['lease-focus', { visible: true, bounds: { x: 10, y: 40, width: 640, height: 320 } }]])
  const pending = deferred<void>(), geometryAdmitted = deferred<void>()
  bridge.updatePresentation.mockImplementationOnce(() => { geometryAdmitted.resolve(undefined); return pending.promise })
  await render(true); await act(async () => geometryAdmitted.promise)
  expect(bridge.activatePresentation).not.toHaveBeenCalled()
  await act(async () => root.render(null)); await act(async () => pending.resolve(undefined))
  expect(bridge.activatePresentation).not.toHaveBeenCalled(); expect(bridge.removePresentation).toHaveBeenCalledWith('lease-focus')
})
it('does not transfer a queued owner after the new intent reverses', async () => {
  const pending = deferred<{ outcome: 'selected' }>(); bridge.activatePresentation.mockReturnValueOnce(pending.promise)
  await render(false, true); await render(true, true); await render(false, true)
  await act(async () => pending.resolve({ outcome: 'selected' }))
  expect(bridge.activatePresentation.mock.calls.every(([id]) => id === 'lease-space')).toBe(true)
})
it('uses authoritative lease identity from Main rather than an entity-wide chosen flag', async () => {
  await render(false)
  await act(async () => events({ type: 'input-owner-changed', browserId: 'browser', leaseId: 'other-live-lease' }))
  await render(true)
  expect(bridge.activatePresentation.mock.calls).toEqual([['lease-focus', { kind: 'select', focus: 'preserve' }]])
})

it('does not select a queued presentation that becomes hidden', async () => {
  const pending = deferred<{ outcome: 'selected' }>(); bridge.activatePresentation.mockReturnValueOnce(pending.promise)
  await render(false, true); await render(true, true)
  await act(async () => root.render(createElement(Workface, { inputSelected: true, two: true, visible: false })))
  await act(async () => pending.resolve({ outcome: 'selected' }))
  expect(bridge.activatePresentation.mock.calls.every(([id]) => id === 'lease-space')).toBe(true)
})

it('does not reclaim a later human input owner on ordinary geometry changes', async () => {
  await render(true)
  await vi.waitFor(() => expect(bridge.activatePresentation).toHaveBeenCalledTimes(1))
  await act(async () => events({ type: 'input-owner-changed', browserId: 'browser', leaseId: 'human-mote-lease' }))
  width = 720
  await act(async () => window.dispatchEvent(new Event('resize')))
  expect(bridge.activatePresentation).toHaveBeenCalledTimes(1)
})

it('keeps a later Main owner event authoritative over an earlier pending receipt', async () => {
  const pending = deferred<{ outcome: 'selected' }>(), selectionAdmitted = deferred<void>()
  bridge.activatePresentation.mockImplementationOnce(() => { selectionAdmitted.resolve(undefined); return pending.promise })
  await render(true); await act(async () => selectionAdmitted.promise)
  expect(bridge.activatePresentation.mock.calls).toEqual([['lease-focus', { kind: 'select', focus: 'preserve' }]])
  await act(async () => events({ type: 'input-owner-changed', browserId: 'browser', leaseId: 'human-mote-lease' }))
  await act(async () => pending.resolve({ outcome: 'selected' }))
  await render(false); await render(true)
  expect(bridge.activatePresentation.mock.calls).toEqual([
    ['lease-focus', { kind: 'select', focus: 'preserve' }], ['lease-focus', { kind: 'select', focus: 'preserve' }]
  ])
})

it('preserves a newer Focus intent when the older pending Space selection emits its own Main owner event', async () => {
  const pending = deferred<{ outcome: 'selected' }>(); bridge.activatePresentation.mockReturnValueOnce(pending.promise)
  await render(false, true); await render(true, true)
  await act(async () => events({ type: 'input-owner-changed', browserId: 'browser', leaseId: 'lease-space' }))
  await act(async () => pending.resolve({ outcome: 'selected' }))
  expect(bridge.activatePresentation.mock.calls).toEqual([
    ['lease-space', { kind: 'select', focus: 'preserve' }], ['lease-focus', { kind: 'select', focus: 'preserve' }]
  ])
})


it('cancels an older queued Focus intent when a later foreign first-press becomes the Main owner', async () => {
  const pending = deferred<{ outcome: 'selected' }>(); bridge.activatePresentation.mockReturnValueOnce(pending.promise)
  await render(false, true); await render(true, true)
  await act(async () => events({ type: 'input-owner-changed', browserId: 'browser', leaseId: 'lease-space' }))
  await act(async () => events({ type: 'input-owner-changed', browserId: 'browser', leaseId: 'human-mote-lease' }))
  await act(async () => pending.resolve({ outcome: 'selected' }))
  expect(bridge.activatePresentation.mock.calls).toEqual([['lease-space', { kind: 'select', focus: 'preserve' }]])
  await render(false, true); await render(true, true)
  expect(bridge.activatePresentation.mock.calls.at(-1)).toEqual(['lease-focus', { kind: 'select', focus: 'preserve' }])
})

it('restores the currently selected visible lease when Main releases a foreign owner without recapturing', async () => {
  const selectionAdmitted = deferred<void>()
  bridge.activatePresentation.mockImplementationOnce(async () => { selectionAdmitted.resolve(undefined); return { outcome: 'selected' } })
  await render(true); await act(async () => selectionAdmitted.promise)
  expect(bridge.activatePresentation.mock.calls).toEqual([['lease-focus', { kind: 'select', focus: 'preserve' }]])
  await act(async () => events({ type: 'input-owner-changed', browserId: 'browser', leaseId: 'human-mote-lease' }))
  await act(async () => events({ type: 'input-owner-changed', browserId: 'browser', leaseId: null }))
  expect(bridge.activatePresentation.mock.calls).toEqual([
    ['lease-focus', { kind: 'select', focus: 'preserve' }], ['lease-focus', { kind: 'select', focus: 'preserve' }]
  ])
  expect(capture).toHaveBeenCalledTimes(1)
})

function previewStream(id: string) {
  const track = new EventTarget() as EventTarget & { id: string; kind: string; readyState: string; stop: ReturnType<typeof vi.fn> }
  Object.assign(track, { id, kind: 'video', readyState: 'live', stop: vi.fn(() => { track.readyState = 'ended' }) })
  const stream = new MediaStream([track as unknown as MediaStreamTrack])
  Object.defineProperty(stream, 'getTracks', { value: () => stream.getVideoTracks() })
  return { stream, track }
}
const agentRefusal = { outcome: 'input-unconfirmed' as const, reason: 'agent-control-active' as const,
  message: 'Native input stays with its current Agent. This text is not a control protocol.' }
function AgentPreview({ visible = true, owner = 'agent' }: { visible?: boolean; owner?: 'agent' | 'human' }) {
  const media = useBrowserPresentationCapture('browser')
  return createElement('div', { 'data-capture-phase': media.capturePhase },
    createElement(BrowserPresentationStage, { browserId: 'browser', navigationId: 'nav',
      presentation: { ...make('focus'), visible }, inputSelected: true, blocked: false, media,
      control: { owner, activeOperationId: null, revision: owner === 'agent' ? 3 : 4, inputIsolation: owner === 'agent' ? 'isolated' : 'inactive' } }))
}
const renderPreview = async (visible = true, owner: 'agent' | 'human' = 'agent') => {
  await act(async () => { root.render(createElement(AgentPreview, { visible, owner })); await new Promise(resolve => setTimeout(resolve, 0)) })
}

it('keeps an idle Agent preview readable after its native selection is refused and reconciles explicit human takeover', async () => {
  const held = previewStream('agent-preview-track')
  bridge.activatePresentation.mockResolvedValue(agentRefusal); capture.mockResolvedValue(held.stream)
  await renderPreview()
  await vi.waitFor(() => expect(bridge.ackPresentationCapture).toHaveBeenCalledWith('capture', { outcome: 'ready', trackIds: [held.track.id] }))
  expect(container.querySelector('video')?.srcObject).toBe(held.stream)
  expect(container.textContent).not.toContain('Page preview needs attention')
  expect(container.textContent).not.toContain(agentRefusal.message)
  const originalStage = container.querySelector('[data-native-browser-stage]')
  const refusedSelections = bridge.activatePresentation.mock.calls.length
  expect(refusedSelections).toBeGreaterThan(0)
  bridge.activatePresentation.mockResolvedValue({ outcome: 'selected' })
  await renderPreview(true, 'human')
  await vi.waitFor(() => expect(bridge.activatePresentation).toHaveBeenCalledTimes(refusedSelections + 1))
  expect(bridge.activatePresentation.mock.calls.at(-1)).toEqual(['lease-focus', { kind: 'select', focus: 'preserve' }])
  expect(container.querySelector('[data-native-browser-stage]')).toBe(originalStage)
  expect(capture).toHaveBeenCalledTimes(1)
  expect(held.track.stop).not.toHaveBeenCalled()
})

it('reacquires the same Agent Browser preview after hiding retires its capture without a false retry notice', async () => {
  const first = previewStream('before-hide'), next = previewStream('after-show')
  bridge.activatePresentation.mockResolvedValue(agentRefusal); capture.mockResolvedValueOnce(first.stream).mockResolvedValue(next.stream)
  await renderPreview()
  await vi.waitFor(() => expect(container.querySelector('video')?.srcObject).toBe(first.stream))
  await renderPreview(false)
  await act(async () => events({ type: 'capture-revoked', browserId: 'browser', captureId: 'capture', reason: 'no-visible-presentations' }))
  expect(first.track.stop).toHaveBeenCalledOnce()
  bridge.armPresentationCapture.mockResolvedValue({ captureId: 'returned-capture', browserId: 'browser' })
  await renderPreview(true)
  await vi.waitFor(() => expect(bridge.ackPresentationCapture).toHaveBeenCalledWith('returned-capture', { outcome: 'ready', trackIds: [next.track.id] }))
  expect(container.querySelector('video')?.srcObject).toBe(next.stream)
  expect(capture).toHaveBeenCalledTimes(2)
  expect(bridge.registerPresentation).toHaveBeenCalledTimes(1)
  expect(bridge.removePresentation).not.toHaveBeenCalled()
  expect(bridge.activatePresentation.mock.calls.every(([id, intent]) => id === 'lease-focus' && intent.kind === 'select' && intent.focus === 'preserve')).toBe(true)
  expect(container.textContent).not.toContain('Page preview needs attention')
  expect(container.textContent).not.toContain(agentRefusal.message)
})

it('keeps one healthy capture while navigating between Agent-owned presentations', async () => {
  const held = previewStream('two-presentations')
  bridge.activatePresentation.mockResolvedValue(agentRefusal); capture.mockResolvedValue(held.stream)
  await render(false, true)
  await vi.waitFor(() => expect(bridge.ackPresentationCapture).toHaveBeenCalledWith('capture', { outcome: 'ready', trackIds: [held.track.id] }))
  await render(true, true)
  await vi.waitFor(() => expect(bridge.activatePresentation.mock.calls.some(([id]) => id === 'lease-focus')).toBe(true))
  expect(bridge.activatePresentation.mock.calls.some(([id]) => id === 'lease-space')).toBe(true)
  expect(capture).toHaveBeenCalledTimes(1)
  expect([...container.querySelectorAll('video')].every(video => video.srcObject === held.stream)).toBe(true)
  expect(container.textContent).not.toContain('Page preview needs attention')
})

it('preserves a genuine media failure after the normal Agent selection refusal', async () => {
  bridge.activatePresentation.mockResolvedValue(agentRefusal)
  await renderPreview()
  await vi.waitFor(() => expect(container.textContent).toContain('Timeout starting video source'))
  expect(capture).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('Page preview needs attention')
  expect([...container.querySelectorAll('button')].some(button => button.textContent?.includes('Retry preview'))).toBe(true)
  expect(container.textContent).not.toContain(agentRefusal.message)
})

it('retains a different selection refusal even when its display message matches normal Agent control', async () => {
  bridge.activatePresentation.mockResolvedValue({ ...agentRefusal, reason: 'hidden' })
  await renderPreview()
  await vi.waitFor(() => expect(container.textContent).toContain(agentRefusal.message))
  expect(container.textContent).toContain('Page preview needs attention')
  expect(capture).not.toHaveBeenCalled()
})
