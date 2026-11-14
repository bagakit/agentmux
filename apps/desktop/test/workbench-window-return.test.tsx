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
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import type { BrowserPresentationGeometry, BrowserPresentationOccurrence } from '../src/shared/contracts'
import type { WorkbenchWindowDocument } from '../src/shared/workbench-windows'

it.each(['tab', 'region', 'cross-display-tab', 'cross-display-region'] as const)('returns off-surface original %s to Main without a fabricated presentation slot', async kind => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const before = useAppStore.getState(), config = await api.config.get()
  const workspace = { id: 'window-workspace', hostId: 'local', path: fixturePath('window-workspace'), name: 'Window', kind: 'folder' as const }
  const page = await api.browser.create('window-background-page', 'https://example.invalid/window', workspace.id)
  const surface = { ...page, kind: 'browser' as const, browserId: page.id, regionId: 'window-browser-region', workspaceId: workspace.id }
  const tab = createWorkbenchTab('window-browser-tab', surface)
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
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 60, 640, 320))
  const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: vi.fn().mockRejectedValue(new Error('Capture is unavailable in this bounded consumer')) } })
  const container = document.createElement('div'), frame = document.createElement('iframe'); document.body.append(container, frame)
  const child = frame.contentDocument!, destination = child.createElement('div'); child.body.append(destination)
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
    await act(async () => {})
    expect(activate).not.toHaveBeenCalled()
    const originalStage = container.querySelector('[data-native-browser-stage]')!
    expect(originalStage).not.toBeNull()
    let moving!: Promise<void>
    await act(() => { moving = placeWorkbenchWindow(target, { destination, window: childScope }) })
    await act(async () => { await moving })
    expect(child.querySelector('[data-native-browser-stage]')).toBe(originalStage)
    let returned = false, returning!: Promise<void>
    await act(() => { returning = placeWorkbenchWindow(target, null); void returning.then(() => { returned = true }, () => {}) })
    await act(async () => {})
    expect(returned, 'the exact original host physically returns before its ACK').toBe(true)
    await returning
    expect(container.querySelector('[data-native-browser-stage]')).toBe(originalStage)
    expect(child.querySelector('[data-native-browser-stage]')).toBeNull()
    expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
    expect(useAppStore.getState().layouts[workspace.id]).toBe(layout)
    expect(layout.groups[0]!.activeTabId).toBe(launcher.id)
  } finally {
    adoption.forEach(spy => spy.mockRestore())
    await act(async () => root.unmount()); releaseChild(); releaseMain(); container.remove(); frame.remove(); useAppStore.setState(before, true)
    if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor)
    else delete (navigator as unknown as Record<string, unknown>).mediaDevices
    for (const spy of [register, update, remove, activate, arm, ack, events, rect]) spy.mockRestore()
    vi.unstubAllGlobals()
  }
})
