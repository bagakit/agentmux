import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../../../src/renderer/src/lib/desktop-spatial-state'
import { reducePersistedTab, hydratePersistedTab } from '../../../src/renderer/src/lib/workbench-persistence'
import { preserveOriginalSourceProjection } from '../../../src/renderer/src/lib/original-space-navigation'
import { workbenchZoneProjection } from '../../../src/renderer/src/lib/desktop-focus-navigation'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { spaceNewTabFixture } from '../../../test/fixtures/space-new-tab'
import '../../../src/renderer/src/styles/index.css'

const root = createRoot(document.getElementById('root'))
const preview = await api.config.get(), session = (await api.sessions.snapshot()).sessions.find(value => value.kind === 'agent')
let projectionSelections = 0
function ProjectedWorkbench() {
  const choice = useAppStore(state => state.workbenchSpaceSelection)
  useAppStore(state => state.tabs)
  useAppStore(state => state.layouts)
  const projection = workbenchZoneProjection(useAppStore.getState(), choice, [], () => { projectionSelections++ })
  return createElement(WorkspaceWorkbench, { workspaceId: choice.workspaceId, projection: projection ?? undefined })
}
const render = (projected = false) => root.render(createElement(DesktopClientUiProvider, null,
  projected ? createElement(ProjectedWorkbench) : createElement(WorkspaceWorkbench, { workspaceId: useAppStore.getState().activeWorkspaceId })))
const apply = (state, projected) => {
  useAppStore.setState({ ...state, loading: false, mainSurface: 'workbench', retainedSpatialFocus: null, scratchTopicSnapshots: {},
    prewarmTerminal: async () => {}, detectExecutors: async () => {}, error: null })
  render(projected)
}
window.spaceNewTabProof = {
  prepare(runtimeId, projected = false) {
    const fixture = spaceNewTabFixture({ ...preview, workspaces: [preview.workspaces[0]] }, session, runtimeId)
    const state = fixture.state
    projectionSelections = 0
    if (projected) {
      const extra = createWorkbenchTab('original-unplaced-tab', { kind: 'launcher', regionId: 'original-unplaced-region',
        workspaceId: fixture.tab.workspaceId })
      state.tabs = { ...state.tabs, [extra.id]: { ...extra, space: fixture.tab.space } }
    }
    apply({ ...state, agentComposerDrafts: { [session.id]: 'Original unsent input' } }, projected)
  },
  facts() {
    const state = useAppStore.getState(), selected = state.workbenchSpaceSelection
    return { tabIds: Object.keys(state.tabs).sort(), selected, layouts: state.layouts, drafts: state.agentComposerDrafts, projectionSelections,
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
