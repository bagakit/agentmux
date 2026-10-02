// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
  await render(false); const pending = deferred<void>(); bridge.updatePresentation.mockReturnValueOnce(pending.promise)
  await render(true); await render(false); await act(async () => pending.resolve(undefined))
  expect(bridge.activatePresentation).not.toHaveBeenCalled()
})
it('does not select a late geometry receipt after unmount', async () => {
  await render(false); const pending = deferred<void>(); bridge.updatePresentation.mockReturnValueOnce(pending.promise)
  await render(true); await act(async () => root.render(null)); await act(async () => pending.resolve(undefined))
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
  await act(async () => events({ type: 'input-owner-changed', browserId: 'browser', leaseId: 'human-mote-lease' }))
  width = 720
  await act(async () => window.dispatchEvent(new Event('resize')))
  expect(bridge.activatePresentation).toHaveBeenCalledTimes(1)
})

it('keeps a later Main owner event authoritative over an earlier pending receipt', async () => {
  const pending = deferred<{ outcome: 'selected' }>(); bridge.activatePresentation.mockReturnValueOnce(pending.promise)
  await render(true)
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
  await render(true)
  await act(async () => events({ type: 'input-owner-changed', browserId: 'browser', leaseId: 'human-mote-lease' }))
  await act(async () => events({ type: 'input-owner-changed', browserId: 'browser', leaseId: null }))
  expect(bridge.activatePresentation.mock.calls).toEqual([
    ['lease-focus', { kind: 'select', focus: 'preserve' }], ['lease-focus', { kind: 'select', focus: 'preserve' }]
  ])
  expect(capture).toHaveBeenCalledTimes(1)
})
