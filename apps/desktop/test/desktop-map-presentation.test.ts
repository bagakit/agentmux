// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxDesktopSelection } from '@agentmux/core'
import { desktopObservationSchema } from '../src/shared/desktop-focus-observation'
import { captureDesktopInput, desktopInputPreserved, installDesktopPresentationOwner, readDesktopPresentation } from '../src/renderer/src/lib/desktop-presentation'
import { workbenchRegionProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'
import type { WorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

const address = { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' }
const selection: AgentMuxDesktopSelection = { surface: 'space', mainSurface: 'workbench', spaceView: 'map', goalId: null,
  space: { spaceId: 'space', zoneId: 'zone', workspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region', topicId: null } }
const tab: WorkbenchTab = { id: 'tab', workspaceId: 'workspace', titleRegionId: 'region', layout: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' },
  regions: { region: { kind: 'agent', phase: 'attached', regionId: 'region', workspaceId: 'workspace', sessionId: 'original-session' } } }
let main: HTMLElement, workface: HTMLElement, region: HTMLElement, dispose: () => void
beforeEach(() => {
  // Finite DOM observation; the original visibility predicate and input reader execute. This is not a native screen receipt.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) })
  main = document.createElement('main'); main.dataset.desktopSurface = 'space'
  workface = document.createElement('section'); workface.dataset.desktopSpaceView = 'workbench'
  workface.dataset.workbenchPrimaryTabId = 'tab'; workface.dataset.workbenchPrimaryReference = workbenchRegionProjectionSlotId('primary', address)
  region = document.createElement('section'); region.dataset.workbenchRegionId = 'region'; region.dataset.workbenchTabId = 'tab'
  workface.append(region); main.append(workface); document.body.append(main)
  dispose = installDesktopPresentationOwner(() => ({ loading: false, overlays: { settings: false, quickSwitcher: false }, floating: null }))
})
afterEach(() => { dispose(); main.remove(); vi.restoreAllMocks() })
const map = () => { const element = document.createElement('section'); element.dataset.desktopSpaceView = 'map'; main.append(element); return element }
const read = (view = selection) => readDesktopPresentation(view, { tab })

it('requires the actual map owner even when the retained original Region is visibly presented', () => {
  expect(read({ ...selection, spaceView: 'workbench' }).presentation).toMatchObject({ state: 'main-visible', tabId: 'tab', regionId: 'region' })
  expect(read().presentation).toMatchObject({ state: 'pending', tabId: null, regionId: null })
  expect(selection.space?.regionId).toBe('region'); expect(main.contains(region)).toBe(true)
})

it('observes one exact visible map without presenting the retained Region or upgrading its now hidden input', () => {
  const input = document.createElement('textarea'); input.value = 'Original unsent draft'; region.append(input); input.focus(); input.setSelectionRange(2, 8)
  const before = captureDesktopInput({ tab }), focus = vi.spyOn(input, 'focus'), blur = vi.spyOn(input, 'blur')
  workface.hidden = true; const canvas = map()
  const observed = read(), after = captureDesktopInput({ tab })
  expect(observed.presentation).toEqual({ provenance: 'observed', state: 'main-visible', tabId: null, regionId: null, blockers: [] })
  expect(observed.input).toMatchObject({ connected: true, visible: false, sessionId: 'original-session' })
  expect(desktopInputPreserved(before, after)).toBe(false)
  expect(canvas.isConnected).toBe(true); expect(region.isConnected).toBe(true); expect(document.activeElement).toBe(input)
  expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['Original unsent draft', 2, 8])
  expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled()
})

it('keeps hidden foreign and ambiguous map owners unconfirmed and reports original overlay blockers', () => {
  const hidden = map(); hidden.hidden = true
  const foreign = document.createElement('section'); foreign.dataset.desktopSpaceView = 'map'; document.body.append(foreign)
  try {
    expect(read().presentation.state).toBe('pending')
    const first = map(), second = map()
    expect(read().presentation.state).toBe('pending')
    second.remove(); expect(read().presentation.state).toBe('main-visible')
    first.remove(); dispose()
    dispose = installDesktopPresentationOwner(() => ({ loading: false, overlays: { settings: true, quickSwitcher: false }, floating: null }))
    expect(read().presentation).toMatchObject({ state: 'covered', tabId: null, regionId: null, blockers: ['settings'] })
  } finally { foreign.remove() }
})

it('validates the same strict Space view discriminant for client inspection and rejects missing or foreign facts', () => {
  map()
  const observed = { selection, ...read(), focus: { executionSessionId: 'original-session', pmoSessionId: null } }
  expect(desktopObservationSchema.parse(observed).selection.spaceView).toBe('map')
  expect(desktopObservationSchema.parse({ ...observed, selection: { ...selection, surface: 'focus', mainSurface: 'agents', spaceView: null } }).selection.spaceView).toBeNull()
  const invalid = [ { ...selection, spaceView: null }, { ...selection, spaceView: undefined }, { ...selection, spaceView: 'unknown' }, { ...selection, surface: 'focus', mainSurface: 'agents', spaceView: 'map' } ]
  expect(invalid).toHaveLength(4)
  for (const value of invalid) expect(() => desktopObservationSchema.parse({ ...observed, selection: value })).toThrow()
  for (const state of ['main-visible', 'pending', 'unknown', 'covered'] as const) {
    const current = { ...observed, presentation: { ...observed.presentation, state, blockers: state === 'covered' ? ['settings'] : [] } }
    expect(() => desktopObservationSchema.parse(current)).not.toThrow()
    expect(() => desktopObservationSchema.parse({ ...current, presentation: { ...current.presentation, tabId: 'tab', regionId: 'region' } })).toThrow()
    expect(() => desktopObservationSchema.parse({ ...current, presentation: { ...current.presentation, windowId: 'native-window', documentGeneration: 'native-document' } })).toThrow()
  }
  for (const state of ['floating', 'window'] as const) expect(() => desktopObservationSchema.parse({ ...observed,
    presentation: { ...observed.presentation, state, ...(state === 'window' ? { windowId: 'native-window', documentGeneration: 'native-document' } : {}) } })).toThrow()
})
