import { createElement } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import { updateThemeSelection } from '@agentmux/client-ui/theme'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { surveyInitialZoneSelection, surveySelectReference } from '../../../src/renderer/src/lib/survey-workface'
import { fixturePath } from '../../lib/fixture-values.mjs'
import '../../../src/renderer/src/styles/index.css'

const input = window.startPageFixtureInput
if (!input?.previews?.length) throw new Error('Actual native fixture captures are required')
const config = await api.config.get(), sessionSnapshot = await api.sessions.snapshot()
const workspace = { ...config.workspaces.find(item => item.id === 'workspace-demo'), path: fixturePath('private/start-page-research'), name: 'Research' }
const unrelatedWorkspace = { ...workspace, id: 'start-page-unrelated', name: 'Retained work', path: fixturePath('private/start-page-retained') }
const session = { ...sessionSnapshot.sessions.find(item => item.id === 'session-codex'), workspacePath: workspace.path }
const pages = [], native = new Map(), previewById = new Map()
const control = { owner: 'human', activeOperationId: null, revision: 1, inputIsolation: 'inactive', agent: null }
async function browser(tabId, regionId, title, url) {
  const snapshot = { ...await api.browser.create(regionId, url, workspace.id), control }
  native.set(snapshot.id, snapshot)
  return createWorkbenchTab(tabId, { ...snapshot, regionId, kind: 'browser', workspaceId: workspace.id, browserId: snapshot.id, title }, title)
}
for (const [index, preview] of input.previews.entries()) {
  const tab = await browser(`start-page-source-${index}`, `start-page-source-browser-${index}`, preview.title, preview.url)
  const region = Object.values(tab.regions)[0]
  pages.push(tab)
  previewById.set(region.browserId, { ...preview, scope: { browserId: region.browserId, workspaceId: workspace.id, profileId: region.profileId, mode: 'normal' }, navigationId: region.navigationId })
}
const start = await browser('start-page-new-tab', 'start-page-browser', 'New Tab', 'about:blank')
pages.push(start)
const originalRegion = Object.values(start.regions)[0], profileId = originalRegion.profileId
const scope = { workspaceId: workspace.id, profileId }
const historyTexts = [input.previews[0].url, 'distributed systems reading list', input.previews[1].url, 'https://atlas.example.test/research/interaction', input.previews[2].url, 'https://code.example.test/workbench/pull/42', 'browser workspace visual references', input.previews[3].url, 'https://journal.example.test/notes/field-research', 'http://localhost:5173/', 'https://design.example.test/library/components', 'semantic recovery protocol', 'https://archive.example.test/collections/browser-history', 'https://maps.example.test/studies', 'keyboard navigation patterns', 'https://workshop.example.test/toolkit', 'http://127.0.0.1:9443/workspace', 'search history interface ideas']
let entries = historyTexts.map((text, index) => ({ text, submittedAt: input.capturedAt - index * 3600000 }))
const calls = { list: [], previews: [], navigate: [], record: [], agent: [] }
function requireScope(target) {
  if (target.kind !== 'browser' || !native.has(target.browserId) || target.profileId !== profileId) throw new Error('Fixture target does not identify its original Browser/Profile')
  return { ...scope }
}
api.browser.listInputHistory = async target => { calls.list.push({ ...target }); return { scope: requireScope(target), entries: structuredClone(entries) } }
api.browser.recordInputHistory = async (target, text) => {
  calls.record.push({ target: { ...target }, text }); return { scope: requireScope(target), entries: structuredClone(entries), outcome: 'recorded' }
}
api.browser.getRecoveryPreview = async id => {
  calls.previews.push(id)
  const preview = previewById.get(id)
  return preview ? { status: 'available', preview: structuredClone(preview) } : { status: 'missing' }
}
const originalNavigate = api.browser.navigate
const navigate = async (id, text) => ({ ...await originalNavigate(id, text), control })
api.browser.navigate = async (id, text) => { calls.navigate.push({ id, text }); return navigate(id, text) }
for (const method of ['stop', 'resume', 'launchAgent', 'write', 'interrupt']) {
  const previous = api.sessions[method]
  api.sessions[method] = (...args) => { calls.agent.push(method); return previous(...args) }
}
useAppStore.setState({ loading: false, initialize: async () => () => {}, config: { ...config, workspaces: [workspace, ...(input.scene === 'personalization' ? [unrelatedWorkspace] : [])] }, sessions: [session],
  activeWorkspaceId: workspace.id, mainSurface: 'survey', toolsOpen: false, projectRailOpen: false, surveyToolsOpen: false,
  tabs: Object.fromEntries(pages.map(tab => [tab.id, tab])), layouts: { [workspace.id]: createWorkspaceLayout('start-page-group', pages.map(tab => tab.id)) },
  surveySidebarWidth: 260, surveySidebarCollapsed: false, surveyCollectedZones: {}, surveyExplorationNames: {}, surveyZoneSelection: null,
  agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { [session.id]: 'Original research draft remains untouched' } })
const catalog = spatialCatalog(useAppStore.getState(), [])
const zoneId = catalog.tabs.find(tab => tab.tabId === start.id)?.zoneId
if (!zoneId) throw new Error('Actual Survey Zone required')
const selection = surveySelectReference(surveyInitialZoneSelection(catalog, zoneId, useAppStore.getState().layouts, useAppStore.getState().tabs, workspace.id), { tabId: start.id, regionId: originalRegion.regionId })
useAppStore.setState({ surveyCollectedZones: { [zoneId]: true }, surveyExplorationNames: { [zoneId]: 'Open research' }, surveyZoneSelection: selection })
if (input.scene === 'personalization') {
  const committed = await window.startPageNativeConfig.initialize(useAppStore.getState().config)
  const listeners = new Set()
  api.config.get = () => window.startPageNativeConfig.read()
  api.config.save = async (value, expected) => {
    const saved = await window.startPageNativeConfig.save(value, expected)
    for (const listener of listeners) listener(structuredClone(saved))
    return saved
  }
  api.config.onChange = listener => { listeners.add(listener); return () => listeners.delete(listener) }
  useAppStore.setState({ config: committed })
}
const original = useAppStore.getState()
window.startPageProof = {
  retainTabs(count) {
    const tabs = Object.fromEntries(pages.map(tab => [tab.id, useAppStore.getState().tabs[tab.id]]))
    const retained = Array.from({ length: count }, (_, index) => createWorkbenchTab(`start-page-retained-${index}`, { regionId: `start-page-retained-region-${index}`, kind: 'launcher', workspaceId: unrelatedWorkspace.id }, `Retained ${index}`))
    for (const tab of retained) tabs[tab.id] = tab
    useAppStore.setState({ tabs, layouts: { ...useAppStore.getState().layouts, [unrelatedWorkspace.id]: createWorkspaceLayout('start-page-retained-group', retained.map(tab => tab.id)) } })
  },
  ready: true, originalBrowserId: originalRegion.browserId, firstHistory: historyTexts[0], scope,
  theme(mode) { return updateThemeSelection({ ...useAppStore.getState().config.appearance, appAppearance: mode }) },
  async reset() { useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: await navigate(originalRegion.browserId, 'about:blank') }) },
  facts() {
    const state = useAppStore.getState(), toolbar = document.querySelector('input[aria-label="Browser address"]'), central = document.querySelector('input[aria-label="Search or enter a web address"]')
    const pane = document.querySelector('.browser-start-page'), box = pane?.getBoundingClientRect()
    return { scope, originalBrowserId: originalRegion.browserId, region: state.tabs[start.id]?.regions[originalRegion.regionId],
      sameSessions: state.sessions === original.sessions, sameDrafts: state.agentComposerDrafts === original.agentComposerDrafts, originalDraft: state.agentComposerDrafts[session.id],
      selection: state.surveyZoneSelection, calls: structuredClone(calls), toolbar: toolbar ? { value: toolbar.value, disabled: toolbar.disabled } : null,
      central: central ? { value: central.value, disabled: central.disabled } : null, count: document.querySelectorAll('.browser-start-history__card').length,
      images: [...document.querySelectorAll('.browser-start-history__card img')].map(image => ({ complete: image.complete, width: image.naturalWidth, title: image.title })),
      pane: box ? { x: box.x, y: box.y, width: box.width, height: box.height, scrollWidth: pane.scrollWidth, clientWidth: pane.clientWidth } : null,
      appearance: document.documentElement.dataset.appearance, retained: Object.keys(state.tabs).filter(id => id.startsWith('start-page-retained-')).length, savedStartPage: state.config.browser.startPage, plane: (() => { const plane = document.querySelector('.browser-start-atmosphere__plane'); return plane ? { inline: plane.style.transform, computed: getComputedStyle(plane).transform, rect: plane.getBoundingClientRect().toJSON() } : null })() }
  }
}
createClientUiRoot(document.getElementById('root')).render(createElement(App))
