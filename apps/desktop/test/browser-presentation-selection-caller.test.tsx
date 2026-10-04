import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
import { selectedBrowserPresentationId } from '../src/renderer/src/lib/browser-presentation-selection'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import type { WorkbenchBrowserPresentation } from '../src/renderer/src/components/BrowserPresentationStage'

it.each([['focus', 'agents', 'active'], ['survey', 'survey', 'active'], ['survey', 'survey', 'sole-fallback'], ['survey', 'survey', 'explicit-current-tab'], ['survey', 'survey', 'ambiguous']] as const)('actual BrowserPane retains %s Tab sibling and input during %s / %s selection with failed capture', async (surface, mainSurface, selection) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const before = useAppStore.getState(), config = await api.config.get()
  const workspace = { id: 'caller-workspace', hostId: 'local', path: _hygiene_fixturePath("browser-caller"), name: 'Caller', kind: 'folder' as const }
  const page = await api.browser.create('caller-page', 'https://example.invalid/page', workspace.id)
  const browser = { ...page, kind: 'browser' as const, browserId: page.id, regionId: 'caller-browser-region', workspaceId: workspace.id }
  const tab = createWorkbenchTab('caller-tab', { kind: 'agent', phase: 'attached', sessionId: 'caller-session', regionId: 'caller-agent-region', workspaceId: workspace.id })
  tab.regions[browser.regionId] = browser
  tab.layout = { ...splitWorkbenchRegion(tab.layout, 'caller-agent-region', 'right', browser.regionId), activeRegionId: 'caller-agent-region' }
  const reference = { displayWorkspaceId: workspace.id, groupId: 'caller-group', tabId: tab.id, regionId: 'caller-agent-region' }
  const presentation: WorkbenchBrowserPresentation = { occurrence: { presentationId: surface + '-caller', location: { ...reference, regionId: browser.regionId } },
    stageHostId: surface + '-caller', visible: true, active: true, yieldToFocusRing: false,
    target: { hostId: surface + '-caller', surface, visible: true, active: true, reference, projection: {
      entity: { kind: 'tab', tabId: tab.id }, displayWorkspaceId: workspace.id, presentationId: surface, selection: [reference], catalog: {} as never, onSelect: () => {}
    } } }
  const otherReference = { ...reference, tabId: 'caller-other-tab' }
  const other = { ...presentation, occurrence: { presentationId: surface + '-other', location: { ...otherReference, regionId: browser.regionId } },
    stageHostId: surface + '-other', target: { ...presentation.target, hostId: surface + '-other', reference: otherReference,
      projection: { ...presentation.target.projection!, entity: { kind: 'tab' as const, tabId: otherReference.tabId } } } }
  const duplicate = { ...presentation, occurrence: { ...presentation.occurrence, presentationId: surface + '-duplicate' },
    stageHostId: surface + '-duplicate', target: { ...presentation.target, hostId: surface + '-duplicate' } }
  const presentations = selection === 'explicit-current-tab' ? [other, presentation] : selection === 'ambiguous' ? [presentation, duplicate] : [presentation]
  useAppStore.setState({ ...before, config: { ...config, workspaces: [workspace] }, mainSurface, tabs: { [tab.id]: tab },
    layouts: { [workspace.id]: createWorkspaceLayout('caller-group', [tab.id]) }, toolsOpen: false,
    surveyZoneSelection: { zoneId: 'caller-zone', active: selection === 'sole-fallback' ? otherReference : reference, selection: [reference] } }, true)
  const register = vi.spyOn(api.browser, 'registerPresentation').mockImplementation(async request => ({ leaseId: request.occurrence.presentationId + '-actual-lease' }))
  const update = vi.spyOn(api.browser, 'updatePresentation').mockResolvedValue(undefined)
  const remove = vi.spyOn(api.browser, 'removePresentation').mockResolvedValue(undefined)
  const activate = vi.spyOn(api.browser, 'activatePresentation').mockResolvedValue({ outcome: 'selected' })
  const arm = vi.spyOn(api.browser, 'armPresentationCapture').mockResolvedValue({ captureId: 'caller-capture', browserId: page.id })
  const ack = vi.spyOn(api.browser, 'ackPresentationCapture').mockResolvedValue(undefined)
  const events = vi.spyOn(api.browser, 'onPresentationEvent').mockImplementation(() => () => {})
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 60, 640, 320))
  const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices'), capture = vi.fn().mockRejectedValue(new Error('Timeout starting video source'))
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia: capture } })
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  const portalHosts = presentations.slice(1).map(presentation => { const host = document.createElement('div'); host.id = presentation.stageHostId; document.body.append(host); return host })
  try {
    await act(async () => root.render(createElement(BrowserPane, { tab: browser, presentations, renderPresentationFrame: content => content, visible: true })))
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(presentations.length))
    if (selection === 'ambiguous') expect(activate).not.toHaveBeenCalled()
    else await vi.waitFor(() => expect(activate.mock.calls).toEqual([[surface + '-caller-actual-lease', { kind: 'select', focus: 'preserve' }]]))
    expect(register).toHaveBeenCalledTimes(presentations.length); expect(capture).toHaveBeenCalledTimes(1)
    const stage = container.querySelector('[data-native-browser-stage]')
    expect(stage).not.toBeNull(); expect(container.textContent).toContain('Timeout starting video source')
    const address = container.querySelector<HTMLInputElement>('input[aria-label="Browser address"]')
    expect(address).not.toBeNull()
    address!.focus(); expect(document.activeElement).toBe(address)
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(document.activeElement).toBe(address); expect(activate).toHaveBeenCalledTimes(selection === 'ambiguous' ? 0 : 1)
    expect(capture).toHaveBeenCalledTimes(1); expect(container.querySelector('[data-native-browser-stage]')).toBe(stage)
  } finally {
    await act(async () => root.unmount()); container.remove(); portalHosts.forEach(host => host.remove()); useAppStore.setState(before, true)
    if (mediaDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDescriptor)
    else delete (navigator as unknown as Record<string, unknown>).mediaDevices
    for (const spy of [register, update, remove, activate, arm, ack, events, rect]) spy.mockRestore()
    vi.unstubAllGlobals()
  }
})


it('preserves Survey explicit-current-Tab priority and sole-qualified fallback from Main', () => {
  const agent = { displayWorkspaceId: 'w', groupId: 'g', tabId: 't', regionId: 'agent' }
  const browser = { ...agent, regionId: 'browser' }
  const make = (tabId: string): WorkbenchBrowserPresentation => ({
    occurrence: { presentationId: 'survey-' + tabId, location: { ...browser, tabId } }, stageHostId: 'survey-' + tabId,
    visible: true, active: true, yieldToFocusRing: false, target: { hostId: 'survey-' + tabId, surface: 'survey',
      visible: true, active: true, reference: { ...agent, tabId }, projection: {
        entity: { kind: 'tab', tabId }, displayWorkspaceId: 'w', presentationId: 'survey-' + tabId,
        selection: [{ ...agent, tabId }], catalog: {} as never, onSelect: () => {}
      } }
  })
  const first = make('t'), other = make('other-tab')
  const selected = { mainSurface: 'survey' as const, layouts: { w: { activeGroupId: 'g' } },
    surveyZoneSelection: { zoneId: 'z', selection: [agent], active: agent } }
  expect(selectedBrowserPresentationId([other, first], selected)).toBe('survey-t')
  expect(selectedBrowserPresentationId([other], selected)).toBe('survey-other-tab')
  expect(selectedBrowserPresentationId([first], { ...selected, surveyZoneSelection: null })).toBe('survey-t')
  const duplicate = { ...first, occurrence: { ...first.occurrence, presentationId: 'survey-duplicate' } }
  expect(selectedBrowserPresentationId([first, duplicate], selected)).toBeNull()
  const excluded = make('t'); excluded.target.projection!.entity = { kind: 'region', regionId: 'agent' }
  expect(selectedBrowserPresentationId([excluded], selected)).toBeNull()
})
