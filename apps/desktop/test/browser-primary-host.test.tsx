import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act, createElement } from 'react'
import { expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { previewFrame, previewMedia } from './helpers/browser-preview-media'
import { installNativePopover } from './fixtures/mote-workface'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab, focusWorkbenchTabRegion } from '../src/renderer/src/lib/workbench-tabs'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { surveyInitialZoneSelection } from '../src/renderer/src/lib/survey-workface'
import type { BrowserPresentationGeometry, BrowserPresentationOccurrence } from '../src/shared/contracts'

it.each([
  { surface: 'survey', direction: 'right' },
  { surface: 'survey', direction: 'bottom' },
  { surface: 'workbench', direction: 'right' }
] as const)('actual mixed Tab keeps its authoritative primary host in $surface/$direction', async ({ surface: mainSurface, direction }) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.localStorage.clear()
  const initial = useAppStore.getState(), restorePopover = installNativePopover()
  const workspace = { id: 'primary-host-workspace', hostId: 'local', path: _hygiene_fixturePath("primary-host"), name: 'Research', kind: 'folder' as const }
  const config = await api.config.get(), page = await api.browser.create('primary-host-page', 'https://example.invalid/retained', workspace.id)
  const browser = { ...page, kind: 'browser' as const, regionId: 'primary-browser-region', workspaceId: workspace.id, browserId: page.id }
  const launcher = { kind: 'launcher' as const, regionId: 'primary-launcher-region', workspaceId: workspace.id, title: 'Start' }
  const tab = focusWorkbenchTabRegion(addWorkbenchRegion(createWorkbenchTab('primary-tab', browser), browser.regionId, direction, launcher), browser.regionId)
  useAppStore.setState({ ...initial, loading: false, initialize: async () => () => {}, config: { ...config, workspaces: [workspace] }, sessions: [], activeWorkspaceId: workspace.id,
    mainSurface, tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('primary-group', [tab.id]) }, toolsOpen: false, projectRailOpen: false,
    surveyToolsOpen: false, surveyZoneSelection: null, surveyCollectedZones: {}, surveySidebarCollapsed: true }, true)
  const catalog = spatialCatalog(useAppStore.getState(), []), zoneId = catalog.tabs.find(value => value.tabId === tab.id)!.zoneId!
  useAppStore.setState({ surveyCollectedZones: { [zoneId]: true }, surveyZoneSelection: surveyInitialZoneSelection(catalog, zoneId, useAppStore.getState().layouts, useAppStore.getState().tabs, workspace.id) })
  const held = new Map<string, { occurrence: BrowserPresentationOccurrence; geometry: BrowserPresentationGeometry }>()
  let serial = 0
  const register = vi.spyOn(api.browser, 'registerPresentation').mockImplementation(async request => { const leaseId = 'lease-' + ++serial; held.set(leaseId, request); return { leaseId } })
  const update = vi.spyOn(api.browser, 'updatePresentation').mockImplementation(async (id, geometry) => { held.set(id, { ...held.get(id)!, geometry }) })
  const remove = vi.spyOn(api.browser, 'removePresentation').mockImplementation(async id => { held.delete(id) })
  const select = vi.spyOn(api.browser, 'activatePresentation').mockImplementation(async id => { expect(held.get(id)?.geometry.visible).toBe(true); return { outcome: 'selected' } })
  const arm = vi.spyOn(api.browser, 'armPresentationCapture').mockResolvedValue({ captureId: 'primary-capture', browserId: page.id })
  const ack = vi.spyOn(api.browser, 'ackPresentationCapture').mockResolvedValue(undefined), events = vi.spyOn(api.browser, 'onPresentationEvent').mockImplementation(() => () => {})
  const { stream } = previewMedia('primary-frame'), capture = vi.fn(async () => stream)
  const priorMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: capture } })
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 80, 480, 320))
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function () { previewFrame(this); return Promise.resolve() })
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(App)))
    const displayed = () => mainSurface === 'survey' ? container.querySelector('.global-survey-surface [data-native-browser-stage]') : container.querySelector('.main-content [data-native-browser-stage]')
    await vi.waitFor(async () => { await act(async () => {}); expect(capture).toHaveBeenCalledTimes(1) })
    expect(select).toHaveBeenCalledTimes(1)
    const chosen = held.get(select.mock.calls[0]![0])!
    expect(chosen.geometry.visible).toBe(true)
    expect(chosen.occurrence.presentationId).toContain(mainSurface === 'survey' ? 'survey-workbench' : 'workbench-tab')
    expect(chosen.occurrence.location).toEqual({ displayWorkspaceId: workspace.id, groupId: 'primary-group', tabId: tab.id, regionId: browser.regionId })
    expect(select.mock.calls[0]![1]).toEqual({ kind: 'select', focus: 'preserve' })
    const stage = displayed() ?? [...container.querySelectorAll('[data-native-browser-stage]')].find(node => !(node as HTMLElement).closest('[hidden]'))!
    expect(stage).not.toBeNull()
    const pane = stage!.closest('.browser-surface')!, address = pane.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')!
    expect(address.disabled).toBe(false)
    expect(pane.querySelector('video')?.srcObject).toBe(stream)
    expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
    expect(tab.regions[browser.regionId]).toBe(browser)
    const hidden = [...held.values()].filter(value => !value.geometry.visible)
    expect(hidden.every(value => value.occurrence.presentationId !== chosen.occurrence.presentationId)).toBe(true)
    await act(async () => useAppStore.setState({ mainSurface: 'agents' }))
    await vi.waitFor(async () => { await act(async () => {}); expect([...held.values()].every(value => !value.geometry.visible)).toBe(true) })
    expect(capture).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().tabs[tab.id]).toBe(tab)
  } finally {
    await act(async () => root.unmount()); container.remove(); restorePopover(); useAppStore.setState(initial, true)
    if (priorMedia) Object.defineProperty(navigator, 'mediaDevices', priorMedia); else delete (navigator as unknown as Record<string, unknown>).mediaDevices
    for (const spy of [register, update, remove, select, arm, ack, events, rect, play]) spy.mockRestore()
    vi.unstubAllGlobals()
  }
})
