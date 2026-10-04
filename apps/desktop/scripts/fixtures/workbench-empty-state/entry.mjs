import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { workbenchSelectionCatalog } from '../../../src/renderer/src/lib/desktop-focus-navigation'
import { MoteWorkfaceContext } from '../../../src/renderer/src/lib/mote-workface'
import { createWorkspaceLayout } from '@agentmux/layout'
import { directoryIdentity, workspaceZoneId } from '../../../src/shared/space-addresses'
import { applyAppAppearance } from '../../../src/renderer/src/lib/app-appearance'
import '../../../src/renderer/src/styles/index.css'

const preview = await api.config.get()
const workspace = { id: 'empty-proof', name: 'ctxmux', hostId: 'local', path: _hygiene_fixturePath("private/empty-workbench-proof"), kind: 'folder' }
const config = { ...preview, workspaces: [workspace] }
const tab = createWorkbenchTab('retained-tab', { regionId: 'retained-region', kind: 'launcher', workspaceId: workspace.id })
const layout = createWorkspaceLayout('original-group', [tab.id])
const spaceId = directoryIdentity(workspace.hostId, workspace.path)
const zoneId = workspaceZoneId(spaceId, workspace.id)
const choice = { spaceId, zoneId, workspaceId: workspace.id, groupId: layout.activeGroupId, tabId: tab.id, regionId: tab.layout.activeRegionId, topicId: null }
const calls = []
for (const key of ['launchAgent', 'launchTerminal', 'resume', 'stop', 'write', 'submitPrompt']) {
  api.sessions[key] = async () => { calls.push(key); throw new Error('No Runtime operation in the empty-workbench presentation proof') }
}
const root = createRoot(document.getElementById('root'))
let serial = 0
let baseline
const render = content => root.render(createElement(DesktopClientUiProvider, null, content))
window.emptyWorkbenchProof = {
  scenario(kind, theme = 'dark') {
    const empty = createWorkspaceLayout('original-group')
    const visibleLayout = kind === 'unknown-app' || kind === 'unknown' ? empty : layout
    useAppStore.setState({ loading: false, initialize: async () => () => {}, config: { ...config, appearance: { ...config.appearance, appAppearance: theme } }, sessions: [], timelines: {},
      activeWorkspaceId: workspace.id, mainSurface: 'workbench', toolsOpen: kind === 'unknown-app', projectRailOpen: kind === 'unknown-app',
      tabs: { [tab.id]: tab }, layouts: { [workspace.id]: visibleLayout }, workbenchSpaceSelection: choice,
      prewarmTerminal: async () => {}, error: null, agentComposerDrafts: { [tab.layout.activeRegionId]: 'Original unsent draft' } })
    const state = useAppStore.getState()
    baseline = { tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts }
    if (kind === 'unknown-app' || kind === 'with-body') render(createElement(App, { key: ++serial }))
    else {
      let projection
      if (kind === 'unknown' || kind === 'tab' || kind === 'region') {
        const catalog = workbenchSelectionCatalog(useAppStore.getState())
        projection = { entity: kind === 'region' ? { kind: 'region', regionId: tab.layout.activeRegionId } : { kind: 'tab', tabId: tab.id },
          presentationId: 'empty-proof', displayWorkspaceId: workspace.id, catalog, selection: [], onSelect: () => {} }
      }
      if (kind === 'empty' || kind === 'discussion') useAppStore.setState({ layouts: { [workspace.id]: empty } })
      const bench = createElement(WorkspaceWorkbench, { key: ++serial, workspaceId: workspace.id, viewOwnership: 'projection', projection,
        onCreateTab: groupId => calls.push({ kind: 'create', groupId }) })
      const content = kind === 'discussion' ? createElement(MoteWorkfaceContext.Provider, { value: {
        workspace, topic: { id: 'empty-topic', title: 'Design discussion', collaborators: [] }, rootPath: _hygiene_fixturePath("private/empty-topic"),
        floating: false, selectTab: () => {} } }, bench) : bench
      render(createElement('div', { style: { height: '100vh', display: 'flex' } }, content))
    }
    applyAppAppearance(theme)
  },
  unknownWithBody() {
    useAppStore.setState({ workbenchSpaceSelection: { ...choice, groupId: 'unconfirmed-group' } })
  },
  facts() {
    const visible = [...document.querySelectorAll('.workbench-empty-state,.service-window')].filter(node => {
      const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[inert],[hidden]')
    })
    const state = useAppStore.getState()
    return { states: visible.map(node => ({ title: node.querySelector('h1')?.textContent, text: node.textContent, busy: node.getAttribute('aria-busy'), className: node.className })),
      tabsKept: state.tabs === baseline.tabs, layoutsKept: state.layouts === baseline.layouts, draftsKept: state.agentComposerDrafts === baseline.drafts,
      calls: [...calls], launcher: !!document.querySelector('.launch-surface'), error: state.error }
  }
}
window.emptyWorkbenchProof.scenario('unknown-app')
