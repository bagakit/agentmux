import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { reducePersistedTab, hydratePersistedTab } from '../../../src/renderer/src/lib/workbench-persistence'
import { preserveOriginalSourceProjection } from '../../../src/renderer/src/lib/original-space-navigation'
import { spaceNewTabFixture } from '../../../test/fixtures/space-new-tab'
import '../../../src/renderer/src/styles/index.css'

const root = createRoot(document.getElementById('root'))
const preview = await api.config.get(), session = (await api.sessions.snapshot()).sessions.find(value => value.kind === 'agent')
const render = () => root.render(createElement(DesktopClientUiProvider, null,
  createElement(WorkspaceWorkbench, { workspaceId: useAppStore.getState().activeWorkspaceId })))
const apply = state => {
  useAppStore.setState({ ...state, loading: false, mainSurface: 'workbench', retainedSpatialFocus: null, scratchTopicSnapshots: {},
    prewarmTerminal: async () => {}, detectExecutors: async () => {}, error: null })
  render()
}
window.spaceNewTabProof = {
  prepare(runtimeId) {
    const state = spaceNewTabFixture({ ...preview, workspaces: [preview.workspaces[0]] }, session, runtimeId).state
    apply({ ...state, agentComposerDrafts: { [session.id]: 'Original unsent input' } })
  },
  facts() {
    const state = useAppStore.getState(), selected = state.workbenchSpaceSelection
    return { tabIds: Object.keys(state.tabs).sort(), selected, layouts: state.layouts, drafts: state.agentComposerDrafts,
      original: state.tabs['original-tab'], sessions: state.sessions, error: state.error,
      launcherVisible: [...document.querySelectorAll('.launch-surface')].some(node => node.getBoundingClientRect().height > 0 && !node.closest('[hidden],[inert]')) }
  },
  save() {
    const state = useAppStore.getState()
    return { graph: desktopSpatialGraph(state, []), config: state.config, sessions: state.sessions,
      activeWorkspaceId: state.activeWorkspaceId, workbenchSpaceSelection: state.workbenchSpaceSelection, agentComposerDrafts: state.agentComposerDrafts,
      tabs: Object.fromEntries(Object.values(state.tabs).filter(tab => tab.source).map(tab => [tab.id, reducePersistedTab(tab)])),
      layouts: Object.fromEntries(Object.entries(state.layouts).filter(([id]) => id !== state.activeWorkspaceId)) }
  },
  restore(saved) {
    const original = desktopWorkbenchFromSpatial(saved.graph)
    const restored = preserveOriginalSourceProjection(saved, original)
    apply({ ...saved, ...restored, tabs: Object.fromEntries(Object.entries(restored.tabs).map(([id, tab]) => [id, hydratePersistedTab(tab)])),
      spaceZoneBindings: {}, spatialRequests: {}, mountedSpaceInputs: {} })
  }
}
