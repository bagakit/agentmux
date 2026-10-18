import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { addWorkbenchRegion, createWorkbenchTab, documentKey } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { desktopSpatialGraph } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { workbenchObjectLayout, workbenchSelectionCatalog, workbenchZoneProjection } from '../../../src/renderer/src/lib/desktop-focus-navigation'
import { resolveWorkbenchZone } from '../../../src/renderer/src/lib/workbench-projection'
import '../../../src/renderer/src/styles/index.css'

const request = window.closedAgentTabsIO.request
const setup = await request('setup'), baseConfig = await api.config.get(), initial = await api.sessions.snapshot()
const { pendingInteraction: _interaction, ...base } = initial.sessions.find(one => one.kind === 'agent')
const workspace = { ...baseConfig.workspaces[0], id: 'closed-agent-tabs-workspace', hostId: 'local', path: setup.workspacePath, name: 'Original work' }
const otherWorkspace = { ...workspace, id: 'closed-agent-tabs-other-workspace', path: setup.otherWorkspacePath, name: 'Other project' }
const config = { ...baseConfig, workspaces: [workspace, otherWorkspace] }
const agent = id => ({ ...base, id, hostId: 'local', workspacePath: workspace.path, label: id, processState: id === 'unknown' ? 'interrupted' : 'running',
  status: { state: id === 'unknown' ? 'error' : 'working', source: 'run-process', observedAt: 1,
    ...(id === 'unknown' ? { detail: 'Runtime observation unavailable; original Run is unconfirmed.' } : {}) },
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'closed-agent-tabs-run-' + id } } })
const runtime = await request('initialize-runtime', ['retire', 'race', 'retained', 'mixed-retire', 'healthy', 'unknown'].map(agent))
api.config.get = async () => config
api.providers.list = async () => []
api.demands.list = async () => []
api.scratch.listTopics = async () => []
api.sessions.snapshot = () => request('snapshot')
api.sessions.stop = control => request('stop', control)
api.sessions.refresh = control => request('refresh', control)
api.sessions.onEvent = createRendererSessionEvents(listener => window.closedAgentTabsIO.onEvent(event => { if (event.kind !== 'spatial') listener(event) }))
api.spatial.read = () => request('spatial-read')
api.spatial.commit = input => request('spatial-commit', input)
api.spatial.retainLabels = input => request('spatial-retain-labels', input)
api.spatial.onChange = listener => window.closedAgentTabsIO.onEvent(event => { if (event.kind === 'spatial') listener(event.state) })
api.ui.requestStorageFlush = () => request('flush')
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.workspaces.listBranches = async () => ({ kind: 'not-a-git-repository', hostId: workspace.hostId, workspacePath: workspace.path })
const make = (id, sessionId) => createWorkbenchTab(id, { kind: 'agent', phase: 'attached', regionId: id + '-region', workspaceId: workspace.id, sessionId })
let seedCount = 0
if (setup.phase === 'first') {
  if (await api.spatial.read() !== null) throw new Error('First fixture requires absent private graph')
  seedCount++
  const mixed = addWorkbenchRegion(addWorkbenchRegion(make('mixed-tab', 'mixed-retire'), 'mixed-tab-region', 'right',
    { kind: 'agent', phase: 'attached', regionId: 'healthy-region', workspaceId: workspace.id, sessionId: 'healthy' }), 'healthy-region', 'right',
    { kind: 'file', regionId: 'file-region', workspaceId: workspace.id, path: 'original.md' })
  mixed.layout.root.second.ratio = .61
  mixed.layout.activeRegionId = 'healthy-region'
  const tabs = Object.fromEntries([mixed, make('retire-tab', 'retire'), make('race-tab', 'race'), make('retained-tab', 'retained'), make('unknown-tab', 'unknown')].map(tab => [tab.id, tab]))
  const layout = createWorkspaceLayout('original-group', ['mixed-tab', 'retire-tab', 'race-tab', 'retained-tab'])
  layout.groups.push({ id: 'other-group', tabOrder: ['unknown-tab'], activeTabId: 'unknown-tab', recentTabIds: ['unknown-tab'] })
  layout.root = { type: 'split', direction: 'horizontal', ratio: .58, first: { type: 'leaf', groupId: 'original-group' }, second: { type: 'leaf', groupId: 'other-group' } }
  layout.activeGroupId = 'original-group'
  await api.spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ config, tabs, layouts: { [workspace.id]: layout }, sessions: runtime.sessions, spaceZoneBindings: {}, spatialRequests: {} }, []) })
  const { name, version } = useAppStore.persist.getOptions()
  const key = documentKey(workspace.id, 'original.md')
  localStorage.setItem(name, JSON.stringify({ version, state: { activeWorkspaceId: workspace.id, mainSurface: 'workbench',
    agentComposerDrafts: { healthy: 'Original unsent healthy draft', unknown: 'Unknown state keeps this draft', retained: 'Retained conversation draft' },
    agentFocus: { execution: { sessionId: 'healthy', history: [{ sessionId: 'healthy', focusedAt: 1 }] }, pmo: { sessionId: null } },
    documents: { [key]: { path: 'original.md', content: 'Original unsaved note', revision: 'original-revision' } }, dirtyDocuments: { [key]: true } } }))
}
const originalInitialize = useAppStore.getState().initialize
await originalInitialize()
function facts() {
  const state = useAppStore.getState(), saved = projectPersistedWorkbench(state)
  const catalog = workbenchSelectionCatalog(state), zone = catalog.zones.find(item => item.workspaceId === workspace.id)
  const projection = zone ? resolveWorkbenchZone(zone.zoneId, catalog, state.layouts, state.tabs, 'closed-agent-tabs-original-zone', [], () => {}) : null
  return { seedCount, initialized: !state.loading, originalInitialize: state.initialize === originalInitialize,
    tabs: saved.tabs, layouts: saved.layouts, drafts: state.agentComposerDrafts, documents: state.documents, dirty: state.dirtyDocuments,
    focus: state.agentFocus, activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface,
    zoneProjection: projection ? { zoneId: zone.zoneId, composition: projection.composition, selection: projection.selection } : null,
    sessions: state.sessions.map(one => ({ id: one.id, control: one.control, processState: one.processState })), error: state.error,
    renderedTabs: [...new Set([...document.querySelectorAll('[data-workbench-tab-id]')].map(node => node.dataset.workbenchTabId))],
    renderedRegions: [...document.querySelectorAll('[data-workbench-region-id]')].map(node => node.dataset.workbenchRegionId),
    visibleRegions: [...document.querySelectorAll('[data-workbench-region-id]')].filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden').map(node => node.dataset.workbenchRegionId) }
}
window.closedAgentTabsProof = { ready: true, facts,
  stop: id => useAppStore.getState().stopSession(id),
  close: (id, keepAgentSessions = false) => useAppStore.getState().closeTab(workspace.id, 'original-group', id, { keepAgentSessions }),
  reopen: id => useAppStore.getState().selectSession(id),
  flush: async () => { await prepareRendererUpdate('quit'); await request('flush') }
}
function Scene() {
  const state = useAppStore(), { activeWorkspaceId, mainSurface } = state
  return h('main', { style: { width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' } },
    h('nav', { 'aria-label': 'Private fixture production navigation', style: { display: 'flex', gap: 12, padding: 8 } },
      h('button', { 'data-closed-agent-tabs-nav': 'other-project', onClick: () => useAppStore.getState().selectWorkspace(otherWorkspace.id) }, 'Other project'),
      h('button', { 'data-closed-agent-tabs-nav': 'original-project', onClick: () => useAppStore.getState().selectWorkspace(workspace.id) }, 'Original project'),
      h('button', { 'data-closed-agent-tabs-nav': 'agents-view', onClick: () => useAppStore.getState().setMainSurface('agents') }, 'Agents view'),
      h('button', { 'data-closed-agent-tabs-nav': 'workbench-view', onClick: () => useAppStore.getState().setMainSurface('workbench') }, 'Workbench view')),
    ...config.workspaces.map(item => {
      const visible = mainSurface === 'workbench' && activeWorkspaceId === item.id
      const choice = workbenchObjectLayout(state, item.id).choice
      const projection = workbenchZoneProjection(state, choice, [], () => {})
      return h('section', { key: item.id, hidden: !visible, 'data-private-workspace': item.id, style: { flex: 1, minHeight: 0 } },
        h(WorkspaceWorkbench, { workspaceId: item.id, visible, projection: projection ?? undefined }))
    }))
}
createRoot(document.getElementById('root')).render(h(DesktopClientUiProvider, null, h(Scene)))
