import { createElement } from 'react'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { workbenchDocuments } from '../../../src/renderer/src/lib/workbench-window-registry'
import { updateThemeSelection } from '@agentmux/client-ui/theme'
import '../../../src/renderer/src/styles/index.css'

const boundary = (window as any).childrenUiBoundary
const native = (window as any).agentmux
const setup = await boundary.request('setup')
api.config.get = async () => setup.config
api.config.onChange = () => () => {}
api.sessions.snapshot = async () => ({ sessions: [], timelines: {}, recoveryCandidates: [] })
api.sessions.launchTerminal = async () => new Promise(() => {})
api.demands.list = async () => []
api.files.readDirectory = async () => []
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.scratch.listTopics = async () => []
api.spatial = { read: () => boundary.request('spatial-read'), commit: input => boundary.request('spatial-commit', input), onChange: () => () => {} }
api.browser = native.browser
for (const key of ['workbenchWindows', 'publishNativeOverlays', 'nativeOverlayFocus', 'onNativeOverlayWarning', 'onNativeBrowserInput', 'nativeBrowserVisibility', 'onNativeBrowserVisibility']) {
  ;(api.ui as any)[key] = native.ui[key]
}
api.ui.requestStorageFlush = async () => boundary.request('flush')
const state = () => useAppStore.getState()
const facts = () => ({ ...projectPersistedWorkbench(state()), loading: state().loading, mainSurface: state().mainSurface,
  activeWorkspaceId: state().activeWorkspaceId, surveyZoneSelection: state().surveyZoneSelection, workbenchSpaceSelection: state().workbenchSpaceSelection, surveyCollectedZones: state().surveyCollectedZones,
  surveyTabs: [...document.querySelectorAll('[data-survey-tab-id]')].map(e => ({ id: (e as HTMLElement).dataset.surveyTabId, current: e.getAttribute('aria-current'), label: e.getAttribute('aria-label') })),
  tabButtons: [...document.querySelectorAll('[role=tab]')].map(e => ({ text: e.textContent, current: e.getAttribute('aria-selected'), label: e.getAttribute('aria-label'), html: e.outerHTML.slice(0,700) })),
  errors: state().notificationEvents.map(event => event.message), error: state().error,
  documents: workbenchDocuments().map(document => ({ title: document.title, url: document.URL,
    browserPanes: document.querySelectorAll('.browser-surface').length, text: document.body.textContent?.slice(0, 9000),
    sourceButtons: [...document.querySelectorAll('button[aria-label="Go to source Browser"]')].map(element => ({ title: element.getAttribute('title'), text: element.textContent })) })) })
;(window as any).childrenUi = {
  facts,
  async create() {
    const current = state(), layout = current.layouts.repo
    await current.createBrowser(layout.activeGroupId, undefined, setup.pageUrl, undefined, 'repo', 'repo')
    return facts()
  },
  async prepareSurveyAlias(sourceId: string) {
    await state().selectWorkspace('alias')
    const source = Object.values(state().tabs).find(tab => Object.values(tab.regions).some(region => region.kind === 'browser' && region.browserId === sourceId))!
    const canonical = state().layouts.repo.groups.find(group => group.tabOrder.includes(source.id))!
    const alias = state().layouts.alias.groups.find(group => group.id === state().layouts.alias.activeGroupId)!
    const bound = await state().setTabDisplayPlacement(source.id, 'alias', alias.id, true)
    const unbound = await state().setTabDisplayPlacement(source.id, 'repo', canonical.id, false)
    await state().selectWorkspace('repo')
    const zone = spatialCatalog(state(), []).tabs.find(tab => tab.tabId === source.id)!.zoneId!
    state().setSurveyZoneCollected(zone, true)
    state().setSurveyZoneSelection({ zoneId: zone, selection: [{ tabId: source.id, regionId: sourceId }], active: { tabId: source.id, regionId: sourceId } })
    state().setMainSurface('survey')
    return { sourceTabId: source.id, aliasGroupId: alias.id, zoneId: zone, bound, unbound, facts: facts() }
  },
  async createSibling() { const current = state(); await current.createBrowser(current.layouts.repo.activeGroupId, undefined, setup.pageUrl.replace('/source', '/sibling'), undefined, 'repo', 'repo'); return facts() },
  select(tabId: string, regionId: string) {
    const current = state(), group = current.layouts.repo.groups.find(group => group.tabOrder.includes(tabId))!
    current.activateTab('repo', group.id, tabId, 'navigation'); state().focusRegion('repo', tabId, regionId, 'navigation', group.id)
  },
  promote(tabId: string, regionId: string) { state().promoteRegionToTab('repo', tabId, regionId); return facts() },
  split(tabId: string, regionId: string) { return state().splitRegion('repo', tabId, regionId, 'right') },
  closeTab(tabId: string) {
    const current = state(), group = current.layouts.repo.groups.find(group => group.tabOrder.includes(tabId))!
    return current.closeTab('repo', group.id, tabId)
  },
  async flush() { await prepareRendererUpdate(); await boundary.request('flush'); return facts() },
  theme(mode: 'light' | 'dark') { updateThemeSelection({ ...setup.config.appearance, appAppearance: mode }) },
  ready: true
}
createClientUiRoot(document.getElementById('root')!).render(createElement(App))
