import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { createRequire } from 'node:module'
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
import { createClientUiRoot } from './helpers/client-ui-render'
import { placeWorkbenchWindow, registerWorkbenchDocument } from '../src/renderer/src/lib/workbench-window-registry'

import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { StableWorkbenchView } from '../src/renderer/src/components/StableWorkbenchView'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import type { BrowserPresentationGeometry, BrowserPresentationOccurrence } from '../src/shared/contracts'
import type { WorkbenchWindowDocument } from '../src/shared/workbench-windows'

it('shows the original window in both Space and the selected Focus slot', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const reference = { displayWorkspaceId: 'notice-workspace', groupId: 'notice-group', tabId: 'notice-tab', regionId: 'notice-region' }
  const target = { kind: 'tab' as const, displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId }
  const identity = { windowId: 'notice-window', documentGeneration: 'notice-document' }
  const container = document.createElement('div'), destination = document.createElement('div')
  destination.id = 'notice-window-root'
  document.body.append(container, destination)
  const root = createClientUiRoot(container)
  const call = vi.spyOn(api.ui.workbenchWindows, 'call').mockImplementation(async method => {
    if (method === 'app.window.return') await placeWorkbenchWindow(target, null)
    return { windows: [], recordedOperation: null }
  })
  try {
    await act(async () => root.render(createElement('div', null,
      createElement('div', { id: 'notice-space' }),
      createElement('div', { id: 'notice-focus' }),
      createElement(StableWorkbenchView, { homeId: 'notice-space', targetId: 'notice-focus', surface: 'focus', reference,
        primaryTabId: reference.tabId, windowTarget: target, active: true, visible: true, retainedRegionId: reference.regionId,
        children: createElement('input', { defaultValue: 'Original draft' })
      }))))
    const input = container.querySelector<HTMLInputElement>('#notice-focus input')!
    expect(input).not.toBeNull()
    let moving!: Promise<void>
    await act(() => { moving = placeWorkbenchWindow(target, { destination, window: identity }) })
    await act(async () => moving)
    expect(destination.querySelector('input')).toBe(input)
    const button = (slot: string, name: string) => Array.from(container.querySelectorAll<HTMLButtonElement>(`#notice-${slot} button`))
      .find(item => item.textContent === name)
    const show = button('focus', 'Show window')
    expect(show, 'Focus must explain the confirmed move and expose the exact window').toBeDefined()
    expect(button('space', 'Show window')).toBeDefined()
    await act(async () => { show!.click() })
    expect(call).toHaveBeenCalledWith('app.window.focus', expect.objectContaining(identity))
    await act(async () => { button('focus', 'Bring back')!.click() })
    expect(call).toHaveBeenCalledWith('app.window.return', expect.objectContaining(identity))
    expect(container.querySelector('#notice-focus input')).toBe(input)
    expect(input.value).toBe('Original draft')
    expect(button('space', 'Show window')).toBeUndefined()
    expect(button('focus', 'Show window')).toBeUndefined()
  } finally {
    call.mockRestore()
    await act(async () => root.unmount())
    container.remove()
    destination.remove()
    vi.unstubAllGlobals()
  }
})

it.each(['tab', 'region', 'cross-display-tab', 'cross-display-region'] as const)('returns off-surface original %s to Main without a fabricated presentation slot', async kind => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const before = useAppStore.getState(), config = await api.config.get()
  const workspace = { id: 'window-workspace', hostId: 'local', path: fixturePath('window-workspace'), name: 'Window', kind: 'folder' as const }
  const page = await api.browser.create('window-background-page', 'https://example.invalid/window', workspace.id)
  const surface = { ...page, kind: 'browser' as const, browserId: page.id, regionId: 'window-browser-region', workspaceId: workspace.id }
  const siblingPage = await api.browser.create('window-background-sibling-page', 'https://example.invalid/sibling', workspace.id)
  const sibling = { ...siblingPage, kind: 'browser' as const, browserId: siblingPage.id, regionId: 'window-sibling-region', workspaceId: workspace.id }
  const tab = addWorkbenchRegion(createWorkbenchTab('window-browser-tab', surface), surface.regionId, 'right', sibling)
  const launcher = createWorkbenchTab('window-background-launcher', { kind: 'launcher', regionId: 'window-launcher-region', workspaceId: workspace.id })
  const layout = createWorkspaceLayout('window-original-group', [tab.id, launcher.id]); layout.groups[0]!.activeTabId = launcher.id
  const crossDisplay = kind.startsWith('cross-display')
  const reference = { displayWorkspaceId: crossDisplay ? 'window-display' : workspace.id, groupId: layout.groups[0]!.id, tabId: tab.id, regionId: tab.layout.activeRegionId }
  const windowKind = kind.endsWith('region') ? 'region' : 'tab'
  const target = windowKind === 'tab' ? { kind: windowKind, displayWorkspaceId: reference.displayWorkspaceId, groupId: reference.groupId, tabId: reference.tabId } : { kind: windowKind, ...reference, regionId: surface.regionId }
  const held = new Map<string, { occurrence: BrowserPresentationOccurrence; geometry: BrowserPresentationGeometry; window?: WorkbenchWindowDocument }>()
  let lease = 0
  const register = vi.spyOn(api.browser, 'registerPresentation').mockImplementation(async request => { const leaseId = 'window-lease-' + ++lease; held.set(leaseId, request); return { leaseId } })
  const update = vi.spyOn(api.browser, 'updatePresentation').mockImplementation(async (id, geometry) => { held.set(id, { ...held.get(id)!, geometry }) })
  const remove = vi.spyOn(api.browser, 'removePresentation').mockImplementation(async id => { held.delete(id) })
  const activate = vi.spyOn(api.browser, 'activatePresentation').mockResolvedValue({ outcome: 'selected' })
  const arm = vi.spyOn(api.browser, 'armPresentationCapture').mockResolvedValue({ captureId: 'window-capture', browserId: page.id })
  const ack = vi.spyOn(api.browser, 'ackPresentationCapture').mockResolvedValue(undefined)
  const events = vi.spyOn(api.browser, 'onPresentationEvent').mockImplementation(() => () => {})
  const unscopedBounds = vi.spyOn(api.browser, 'setBounds')
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 60, 640, 320))
  const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: vi.fn().mockRejectedValue(new Error('Capture is unavailable in this bounded consumer')) } })
  const container = document.createElement('div'), frame = document.createElement('iframe'); document.body.append(container, frame)
  const child = frame.contentDocument!, destination = child.createElement('div'); destination.id = 'original-native-window-root'; child.body.append(destination)
  // happy-dom pins ownerDocument as non-configurable on first adoption. Chromium
  // supports repeated adoption; keep that platform property mutable in this IO fixture.
  const adoption = [document, child].map(owner => {
    const adopt = owner.adoptNode.bind(owner)
    return vi.spyOn(owner, 'adoptNode').mockImplementation(<T extends Node>(node: T): T => {
      Object.defineProperty(node, 'ownerDocument', { value: node.ownerDocument, configurable: true })
      return adopt(node)
    })
  })
  const mainScope = { windowId: 'background-main', documentGeneration: 'background-main-document' }, childScope = { windowId: 'background-child', documentGeneration: 'background-child-document' }
  const releaseMain = registerWorkbenchDocument(document, mainScope), releaseChild = registerWorkbenchDocument(child, childScope)
  useAppStore.setState({ ...before, config: { ...config, workspaces: [workspace] }, loading: false, sessions: [], activeWorkspaceId: workspace.id, mainSurface: 'workbench', tabs: { [tab.id]: tab, [launcher.id]: launcher }, layouts: { [workspace.id]: layout, ...(crossDisplay ? { [reference.displayWorkspaceId]: layout } : {}) }, toolsOpen: false, projectRailOpen: false, warmTerminals: {}, prewarmTerminal: vi.fn(), detectExecutors: vi.fn().mockResolvedValue(undefined), workbenchNavigationInputPolicy: null, workbenchSpaceSelection: null }, true)
  const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(WorkspaceWorkbench, { workspaceId: workspace.id, visible: false, viewTargets: {}, windowTargets: [{ windowId: childScope.windowId, target }] })))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    expect(activate).not.toHaveBeenCalled()
    expect(register, 'Hidden primary stages must not wake cold Browser resources').not.toHaveBeenCalled()
    const originalStage = container.querySelector(`[data-native-browser-stage="${page.id}"]`)!
    const address = originalStage.closest('.browser-surface')!.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(address, 'https://unsubmitted.invalid/original')
      address.dispatchEvent(new Event('input', { bubbles: true })); address.setSelectionRange(3, 8)
    })
    expect(originalStage).not.toBeNull()
    let moving!: Promise<void>
    await act(() => { moving = placeWorkbenchWindow(target, { destination, window: childScope }) })
    await act(async () => { await moving })
    expect(child.querySelector(`[data-native-browser-stage="${page.id}"]`)).toBe(originalStage)
    expect(child.querySelector('[aria-label="Browser address"]')).toBe(address)
    expect(address.value).toBe('https://unsubmitted.invalid/original')
    await vi.waitFor(() => expect(register.mock.calls.some(([request]) => request.browserId === page.id &&
      request.window?.windowId === childScope.windowId && request.window.documentGeneration === childScope.documentGeneration && request.geometry.visible &&
      !('kind' in request.occurrence.location) && request.occurrence.location.displayWorkspaceId === reference.displayWorkspaceId &&
      request.occurrence.location.groupId === reference.groupId && request.occurrence.location.tabId === tab.id && request.occurrence.location.regionId === surface.regionId)).toBe(true))
    await vi.waitFor(() => expect(activate.mock.calls.some(([leaseId]) => held.get(leaseId)?.window?.windowId === childScope.windowId)).toBe(true))
    const childRegions = register.mock.calls.filter(([request]) => request.window?.windowId === childScope.windowId && request.geometry.visible)
      .map(([request]) => 'kind' in request.occurrence.location ? null : request.occurrence.location.regionId)
    expect(new Set(childRegions)).toEqual(new Set(windowKind === 'tab' ? [surface.regionId, sibling.regionId] : [surface.regionId]))
    let returned = false, returning!: Promise<void>
    await act(() => { returning = placeWorkbenchWindow(target, null); void returning.then(() => { returned = true }, () => {}) })
    await act(async () => {})
    expect(returned, 'the exact original host physically returns before its ACK').toBe(true)
    await returning
    expect(container.querySelector(`[data-native-browser-stage="${page.id}"]`)).toBe(originalStage)
    expect(container.querySelector('[aria-label="Browser address"]')).toBe(address)
    expect(address.value).toBe('https://unsubmitted.invalid/original')
    expect(child.querySelector(`[data-native-browser-stage="${page.id}"]`)).toBeNull()
    expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
    expect(useAppStore.getState().layouts[workspace.id]).toBe(layout)
    expect(layout.groups[0]!.activeTabId).toBe(launcher.id)
    expect(unscopedBounds, 'The Renderer must use the exact stage lease, never naked Browser geometry').not.toHaveBeenCalled()
    register.mockClear()
    const shownLayout = { ...layout, groups: layout.groups.map(group => ({ ...group, activeTabId: tab.id })) }
    await act(async () => {
      useAppStore.setState({ layouts: { ...useAppStore.getState().layouts, [workspace.id]: shownLayout } })
      root.render(createElement(WorkspaceWorkbench, { workspaceId: workspace.id, visible: true, viewTargets: {}, windowTargets: [{ windowId: childScope.windowId, target }] }))
    })
    await vi.waitFor(() => expect(register.mock.calls.some(([request]) => request.browserId === page.id && request.window?.windowId === mainScope.windowId && request.geometry.visible &&
      !('kind' in request.occurrence.location) && request.occurrence.location.displayWorkspaceId === workspace.id)).toBe(true))
    expect(register.mock.calls.filter(([request]) => request.browserId === page.id && request.window?.windowId === mainScope.windowId && request.geometry.visible)
      .every(([request]) => !('kind' in request.occurrence.location) && request.occurrence.location.displayWorkspaceId === workspace.id),
    'A detached occurrence never replaces Main’s already confirmed display address').toBe(true)
  } finally {
    adoption.forEach(spy => spy.mockRestore())
    await act(async () => root.unmount()); releaseChild(); releaseMain(); container.remove(); frame.remove(); useAppStore.setState(before, true)
    if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor)
    else delete (navigator as unknown as Record<string, unknown>).mediaDevices
    for (const spy of [register, update, remove, activate, arm, ack, events, rect, unscopedBounds]) spy.mockRestore()
    vi.unstubAllGlobals()
  }
})
