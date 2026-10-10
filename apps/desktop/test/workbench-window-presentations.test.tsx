import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { createRequire } from 'node:module'
// @vitest-environment happy-dom
import { act, createElement, Fragment, useState } from 'react'
import { expect, it, vi } from 'vitest'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
import { createClientUiRoot } from './helpers/client-ui-render'
import { StableWorkbenchView } from '../src/renderer/src/components/StableWorkbenchView'
import { useWorkbenchDocument, useWorkbenchWindowDocument, WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { placeWorkbenchWindow, registerWorkbenchDocument } from '../src/renderer/src/lib/workbench-window-registry'

it('rebinds a nested original workface document when its parent Tab crosses native documents', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div'), frame = document.createElement('iframe')
  document.body.append(container, frame)
  const child = frame.contentDocument!, destination = child.createElement('div'); child.body.append(destination)
  const mainScope = { windowId: 'original-main', documentGeneration: 'main-document' }, childScope = { windowId: 'original-child', documentGeneration: 'child-document' }
  const releaseMain = registerWorkbenchDocument(document, mainScope), releaseChild = registerWorkbenchDocument(child, childScope)
  const reference = { displayWorkspaceId: 'original-workspace', groupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }
  const target = { kind: 'tab' as const, displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId }
  const seen: Array<{ document: Document; scope: typeof mainScope | null; identity: object }> = []
  function OriginalContent() {
    const owner = useWorkbenchDocument(), scope = useWorkbenchWindowDocument(), [identity] = useState({})
    seen.push({ document: owner, scope, identity })
    return createElement('input', { defaultValue: 'Original unsent content' })
  }
  const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(<Fragment>
      <div id="original-tab-home" />
      <StableWorkbenchView homeId="original-tab-home" targetId={null} primaryTabId={reference.tabId} reference={reference} active visible retainedRegionId={reference.regionId}>
        <div id="original-region-home" />
        <StableWorkbenchView kind="region" nativeRegionId={reference.regionId} homeId="original-region-home" targetId={null} reference={reference} active visible retainedRegionId={reference.regionId}>
          <OriginalContent />
        </StableWorkbenchView>
      </StableWorkbenchView>
    </Fragment>))
    const original = container.querySelector('input')!, identity = seen.at(-1)!.identity
    expect(original).not.toBeNull(); expect(seen.at(-1)!.scope).toEqual(mainScope)
    let moving!: Promise<void>
    await act(() => { moving = placeWorkbenchWindow(target, { destination, window: childScope }) })
    await act(async () => { await moving })
    expect(child.querySelector('input')).toBe(original)
    expect(original.value).toBe('Original unsent content')
    expect(seen.at(-1)!.identity).toBe(identity)
    expect(seen.at(-1)!.document === child).toBe(true)
    expect(seen.at(-1)!.scope).toEqual(childScope)
  } finally {
    await act(async () => root.unmount())
    releaseChild(); releaseMain(); container.remove(); frame.remove(); vi.unstubAllGlobals()
  }
})

import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { workbenchProjectionSlotId } from '../src/renderer/src/lib/workbench-projection'
import { workbenchBrowserWindowTarget, WorkbenchPresentationContext, type WorkbenchViewTarget } from '../src/renderer/src/lib/workbench-presentation'
import type { BrowserPresentationGeometry, BrowserPresentationOccurrence } from '../src/shared/contracts'
import type { WorkbenchWindowDocument } from '../src/shared/workbench-windows'

it.each(['tab', 'region', 'tab-sibling'] as const)('actual WorkspaceWorkbench makes a background Browser usable in its exact %s child document without changing Main selection', async kind => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const before = useAppStore.getState(), config = await api.config.get()
  const workspace = { id: 'window-workspace', hostId: 'local', path: fixturePath('window-workspace'), name: 'Window', kind: 'folder' as const }
  const page = await api.browser.create('window-background-page', 'https://example.invalid/window', workspace.id)
  const surface = { ...page, kind: 'browser' as const, browserId: page.id, regionId: 'window-browser-region', workspaceId: workspace.id }
  const tab = createWorkbenchTab('window-browser-tab', surface)
  if (kind === 'tab-sibling') {
    const sibling = { kind: 'launcher' as const, regionId: 'window-browser-launcher-sibling', workspaceId: workspace.id }
    tab.regions[sibling.regionId] = sibling
    tab.layout = { ...splitWorkbenchRegion(tab.layout, surface.regionId, 'right', sibling.regionId), activeRegionId: sibling.regionId }
  }
  const launcher = createWorkbenchTab('window-background-launcher', { kind: 'launcher', regionId: 'window-launcher-region', workspaceId: workspace.id })
  const layout = createWorkspaceLayout('window-original-group', [tab.id, launcher.id]); layout.groups[0]!.activeTabId = launcher.id
  const reference = { displayWorkspaceId: workspace.id, groupId: layout.groups[0]!.id, tabId: tab.id, regionId: tab.layout.activeRegionId }
  const target: WorkbenchViewTarget = { hostId: workbenchProjectionSlotId('workbench-tab-slot', reference), active: false, visible: false, surface: 'space', reference }
  const held = new Map<string, { occurrence: BrowserPresentationOccurrence; geometry: BrowserPresentationGeometry; window?: WorkbenchWindowDocument }>()
  let lease = 0
  const register = vi.spyOn(api.browser, 'registerPresentation').mockImplementation(async request => { const leaseId = 'window-lease-' + ++lease; held.set(leaseId, request); return { leaseId } })
  const update = vi.spyOn(api.browser, 'updatePresentation').mockImplementation(async (id, geometry) => { held.set(id, { ...held.get(id)!, geometry }) })
  const remove = vi.spyOn(api.browser, 'removePresentation').mockImplementation(async id => { held.delete(id) })
  const activate = vi.spyOn(api.browser, 'activatePresentation').mockResolvedValue({ outcome: 'selected' })
  const arm = vi.spyOn(api.browser, 'armPresentationCapture').mockResolvedValue({ captureId: 'window-capture', browserId: page.id })
  const ack = vi.spyOn(api.browser, 'ackPresentationCapture').mockResolvedValue(undefined)
  const events = vi.spyOn(api.browser, 'onPresentationEvent').mockImplementation(() => () => {})
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 60, 640, 320))
  const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: vi.fn().mockRejectedValue(new Error('Capture is unavailable in this bounded consumer')) } })
  const container = document.createElement('div'), frame = document.createElement('iframe'); document.body.append(container, frame)
  const child = frame.contentDocument!, destination = child.createElement('div'); child.body.append(destination)
  const mainScope = { windowId: 'background-main', documentGeneration: 'background-main-document' }, childScope = { windowId: 'background-child', documentGeneration: 'background-child-document' }
  const releaseMain = registerWorkbenchDocument(document, mainScope), releaseChild = registerWorkbenchDocument(child, childScope)
  useAppStore.setState({ ...before, config: { ...config, workspaces: [workspace] }, loading: false, sessions: [], activeWorkspaceId: workspace.id, mainSurface: 'workbench', tabs: { [tab.id]: tab, [launcher.id]: launcher }, layouts: { [workspace.id]: layout }, toolsOpen: false, projectRailOpen: false, warmTerminals: {}, prewarmTerminal: vi.fn(), detectExecutors: vi.fn().mockResolvedValue(undefined), workbenchNavigationInputPolicy: null, workbenchSpaceSelection: null }, true)
  const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: workspace.id, viewTargets: { [tab.id]: [target] } })))
    await vi.waitFor(async () => { await act(async () => {}); expect(register).toHaveBeenCalled(); expect([...held.values()].every(value => value.geometry.visible === false)).toBe(true) })
    expect(activate).not.toHaveBeenCalled()
    const originalStage = container.querySelector('[data-native-browser-stage]')!
    expect(originalStage).not.toBeNull()
    let moving!: Promise<void>
    await act(() => { moving = placeWorkbenchWindow(kind !== 'region' ? { kind: 'tab', displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId } : { kind, ...reference, regionId: surface.regionId }, { destination, window: childScope }) })
    await act(async () => { await moving })
    await vi.waitFor(async () => { await act(async () => {}); const current = [...held.values()]; expect(current.some(value => value.window?.windowId === childScope.windowId && value.geometry.visible && value.geometry.bounds.width > 0)).toBe(true); expect(activate).toHaveBeenCalled() })
    expect(child.querySelector('[data-native-browser-stage]')).toBe(originalStage)
    const selected = held.get(activate.mock.calls.at(-1)![0])!
    expect(selected.window).toEqual(childScope)
    expect(selected.occurrence.location).toEqual({ ...reference, regionId: surface.regionId })
    expect([...held.values()].filter(value => value.window?.windowId === mainScope.windowId).every(value => !value.geometry.visible)).toBe(true)
    expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
    expect(useAppStore.getState().layouts[workspace.id]).toBe(layout)
    expect(layout.groups[0]!.activeTabId).toBe(launcher.id)
  } finally {
    await act(async () => root.unmount()); releaseChild(); releaseMain(); container.remove(); frame.remove(); useAppStore.setState(before, true)
    if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor)
    else delete (navigator as unknown as Record<string, unknown>).mediaDevices
    for (const spy of [register, update, remove, activate, arm, ack, events, rect]) spy.mockRestore()
    vi.unstubAllGlobals()
  }
})

it('resolves one original Browser Tab occurrence without mistaking another Group, projection or Region for it', () => {
  const reference = { displayWorkspaceId: 'display', groupId: 'selected-group', tabId: 'original-tab', regionId: 'selected-agent-sibling' }
  const owner = { active: true, retainedRegionId: null, reference, surface: 'space' as const }
  const exact: WorkbenchViewTarget = { hostId: 'original-browser-slot', active: true, visible: false, reference, surface: 'space' }
  const otherGroup = { ...exact, hostId: 'other-group-slot', reference: { ...reference, groupId: 'other-group' } }
  const wrongRegion: WorkbenchViewTarget = { ...exact, hostId: 'other-region-slot', projection: { entity: { kind: 'region', regionId: reference.regionId }, displayWorkspaceId: reference.displayWorkspaceId, presentationId: 'region-projection', selection: [reference], catalog: {} as never, onSelect: () => {} } }
  expect(workbenchBrowserWindowTarget([otherGroup, exact], owner, 'original-browser-region')).toBe(exact)
  expect(workbenchBrowserWindowTarget([otherGroup], owner, 'original-browser-region')).toBeUndefined()
  expect(workbenchBrowserWindowTarget([exact, { ...exact, hostId: 'ambiguous-slot' }], owner, 'original-browser-region')).toBeUndefined()
  expect(workbenchBrowserWindowTarget([wrongRegion], { ...owner, projection: wrongRegion.projection }, 'original-browser-region')).toBeUndefined()
  const mismatchedRegion = { ...wrongRegion, projection: { ...wrongRegion.projection!, entity: { kind: 'region' as const, regionId: 'original-browser-region' } } }
  expect(workbenchBrowserWindowTarget([mismatchedRegion], { ...owner, projection: mismatchedRegion.projection }, 'original-browser-region')).toBeUndefined()
  expect(workbenchBrowserWindowTarget([{ ...exact, surface: 'survey' }], owner, 'original-browser-region')).toBeUndefined()
  expect(workbenchBrowserWindowTarget([wrongRegion], owner, 'original-browser-region')).toBeUndefined()
  expect(workbenchBrowserWindowTarget([{ ...exact, projection: { ...wrongRegion.projection!, entity: { kind: 'tab', tabId: reference.tabId } } }], owner, 'original-browser-region')).toBeUndefined()
})

import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import type { WorkbenchBrowserPresentation } from '../src/renderer/src/components/BrowserPresentationStage'

it('an accurately registered Main document keeps inactive Launcher workfaces paused and resumes only its selected original', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const before = useAppStore.getState(), launcherBefore = useLauncherState.getState(), config = await api.config.get()
  const workspace = { id: 'main-cost-workspace', hostId: 'local', path: fixturePath('main-window-cost'), name: 'Main', kind: 'folder' as const }
  const first = createWorkbenchTab('selected-launcher', { kind: 'launcher', regionId: 'selected-launcher-region', workspaceId: workspace.id })
  const hidden = createWorkbenchTab('hidden-launcher', { kind: 'launcher', regionId: 'hidden-launcher-region', workspaceId: workspace.id })
  const layout = createWorkspaceLayout('main-cost-group', [first.id, hidden.id]); layout.groups[0]!.activeTabId = first.id
  const warm = vi.fn(), release = registerWorkbenchDocument(document, { windowId: 'accurate-main', documentGeneration: 'accurate-main-document' })
  useLauncherState.setState({ sections: {}, drafts: {}, executors: {}, persistenceIssue: null })
  useAppStore.setState({ ...before, config: { ...config, workspaces: [workspace] }, sessions: [], tabs: { [first.id]: first, [hidden.id]: hidden }, layouts: { [workspace.id]: layout }, activeWorkspaceId: workspace.id, mainSurface: 'workbench', workbenchSpaceSelection: null, workbenchNavigationInputPolicy: null, prewarmTerminal: warm, warmTerminals: {}, detectExecutors: vi.fn().mockResolvedValue(undefined) }, true)
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: workspace.id })))
    expect(container.querySelectorAll('.launch-surface')).toHaveLength(2)
    expect(warm.mock.calls).toEqual([[workspace.id, 'region:selected-launcher-region']])
    warm.mockClear()
    await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: workspace.id, visible: false })))
    expect(warm).not.toHaveBeenCalled()
    await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: workspace.id, visible: true })))
    expect(warm.mock.calls).toEqual([[workspace.id, 'region:selected-launcher-region']])
    expect(useAppStore.getState().tabs[first.id]).toBe(first)
    expect(useAppStore.getState().layouts[workspace.id]).toBe(layout)
  } finally {
    await act(async () => root.unmount()); release(); container.remove(); useAppStore.setState(before, true); useLauncherState.setState(launcherBefore, true); vi.unstubAllGlobals()
  }
})

it('actual child BrowserPane selects its frozen Group occurrence while Main selects a different Group of the same Tab', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const before = useAppStore.getState(), config = await api.config.get()
  const workspace = { id: 'child-selection-workspace', hostId: 'local', path: fixturePath('child-selection'), name: 'Selection', kind: 'folder' as const }
  const page = await api.browser.create('child-selection-page', 'https://example.invalid/selection', workspace.id)
  const browser = { ...page, kind: 'browser' as const, browserId: page.id, regionId: 'selection-browser', workspaceId: workspace.id }
  const tab = createWorkbenchTab('selection-tab', browser)
  const reference = { displayWorkspaceId: workspace.id, groupId: 'frozen-child-group', tabId: tab.id, regionId: browser.regionId }
  const make = (groupId: string): WorkbenchBrowserPresentation => {
    const location = { ...reference, groupId }, hostId = 'stage-' + groupId
    return { occurrence: { presentationId: hostId, location }, stageHostId: hostId, visible: true, active: true, yieldToFocusRing: false, target: { hostId, reference: location, surface: 'space', visible: true, active: true } }
  }
  const other = make('main-selected-group'), exact = make(reference.groupId)
  const held = new Map<string, Parameters<typeof api.browser.registerPresentation>[0]>()
  const register = vi.spyOn(api.browser, 'registerPresentation').mockImplementation(async request => { const leaseId = request.occurrence.presentationId + '-lease'; held.set(leaseId, request); return { leaseId } })
  const update = vi.spyOn(api.browser, 'updatePresentation').mockResolvedValue(undefined), remove = vi.spyOn(api.browser, 'removePresentation').mockResolvedValue(undefined)
  const activate = vi.spyOn(api.browser, 'activatePresentation').mockResolvedValue({ outcome: 'selected' })
  const arm = vi.spyOn(api.browser, 'armPresentationCapture').mockResolvedValue({ captureId: 'selection-capture', browserId: page.id }), ack = vi.spyOn(api.browser, 'ackPresentationCapture').mockResolvedValue(undefined), events = vi.spyOn(api.browser, 'onPresentationEvent').mockImplementation(() => () => {})
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 320))
  const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices'); Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: vi.fn().mockRejectedValue(new Error('Capture unavailable')) } })
  const frame = document.createElement('iframe'); document.body.append(frame)
  const child = frame.contentDocument!, container = child.createElement('div'); child.body.append(container)
  const scope = { windowId: 'selection-child', documentGeneration: 'selection-child-document' }, release = registerWorkbenchDocument(child, scope)
  const layout = createWorkspaceLayout(other.occurrence.location.groupId, [tab.id])
  useAppStore.setState({ ...before, config: { ...config, workspaces: [workspace] }, mainSurface: 'workbench', tabs: { [tab.id]: tab }, layouts: { [workspace.id]: layout }, toolsOpen: false }, true)
  const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(WorkbenchDocumentContext.Provider, { value: { document: child, window: scope } },
      createElement(WorkbenchPresentationContext.Provider, { value: { active: true, retainedRegionId: browser.regionId, reference, surface: 'space' } },
        createElement(BrowserPane, { tab: browser, visible: true, presentations: [other, exact], presentationTargetId: exact.target.hostId })))))
    await vi.waitFor(async () => { await act(async () => {}); expect(activate.mock.calls).toEqual([[exact.occurrence.presentationId + '-lease', { kind: 'select', focus: 'preserve' }]]) })
    expect(held.get(activate.mock.calls[0]![0])!.window).toEqual(scope)
    expect(held.get(activate.mock.calls[0]![0])!.occurrence.location).toEqual(reference)
    expect(useAppStore.getState().layouts[workspace.id]).toBe(layout)
  } finally {
    await act(async () => root.unmount()); release(); frame.remove(); useAppStore.setState(before, true)
    if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor); else delete (navigator as unknown as Record<string, unknown>).mediaDevices
    for (const spy of [register, update, remove, activate, arm, ack, events, rect]) spy.mockRestore(); vi.unstubAllGlobals()
  }
})
