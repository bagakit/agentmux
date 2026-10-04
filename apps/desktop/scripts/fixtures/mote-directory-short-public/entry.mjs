import { createElement } from 'react'
import { createClientUiRoot } from '../../../test/helpers/client-ui-render'
import { App } from '../../../src/renderer/src/App'
import { useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import { readTerminalViewObservation } from '../../../src/renderer/src/lib/terminal-view-observation'
import '../../../src/renderer/src/styles/index.css'

// These unrelated capabilities are outside this private public/Runtime proof. The original
// control, sessions, scratch, spatial, Files read and workbench storage ports stay intact.
for (const key of ['providers', 'demands', 'browser', 'workspaces', 'ui', 'continuousProgress', 'schedule', 'files']) api[key] = { ...api[key] }
api.providers.list = async () => []; api.demands.list = async () => []
api.workspaces.listBranches = async () => []; api.workspaces.appearance = async () => ({ icon: null })
api.files.observe = async () => {}; api.files.unobserve = async () => {}; api.files.onInvalidated = () => () => {}
api.browser.onEvent = () => () => {}; api.browser.onPresentationEvent = () => () => {}; api.browser.updatePresentations = async () => {}
api.ui.publishNativeOverlays = async () => ({ projected: 0, capturedPixels: 0 }); api.ui.setAgentAttentionCount = async () => false
api.ui.notifyAgentAttention = async () => ({ status: 'unsupported', reason: 'Private fixture excludes native notifications.' })
api.ui.onWindowResize = () => () => {}; api.ui.nativeOverlayRegions = async () => {}
api.continuousProgress.list = async () => []; api.continuousProgress.pauseForInput = async () => {}; api.schedule.list = async () => ({ schedules: [] })
// No unrelated shell Run is part of this fixture; the existing optional slot stays unready.
api.sessions = { ...api.sessions, launchTerminal: async () => new Promise(() => {}) }
// App owns startup once. Observe its original completion without invoking a second initializer.
const initialize = useAppStore.getState().initialize
useAppStore.setState({ initialize: async () => { const dispose = await initialize(); window.publicSetup.initializationComplete = true; return dispose } })
const root = createClientUiRoot(document.getElementById('root')); root.render(createElement(App))
const state = () => useAppStore.getState()
const tabId = () => localStorage.getItem('public-original-tab')
function facts() {
  const s = state(), tab = s.tabs[tabId()]
  return { ready: Boolean(window.publicSetup.initializationComplete && s.config && !s.loading), error: s.error, tabId: tab?.id,
    draft: tab ? s.agentComposerDrafts[tab.layout.activeRegionId] : null, sessions: s.sessions,
    selection: s.workbenchSpaceSelection, scratchSnapshots: s.scratchTopicSnapshots, allTabIds: Object.keys(s.tabs), setup: window.publicSetup }
}
function durable() {
  const s = state()
  return { tabs: s.tabs, layouts: s.layouts, activeWorkspaceId: s.activeWorkspaceId, workbenchSpaceSelection: s.workbenchSpaceSelection,
    agentFocus: s.agentFocus, retainedSpatialFocus: s.retainedSpatialFocus, spaceZoneBindings: s.spaceZoneBindings,
    spatialRequests: s.spatialRequests, drafts: s.agentComposerDrafts, launcherState: (({ sections, drafts, executors, moteTopicId }) => ({ sections, drafts, executors, moteTopicId }))(useLauncherState.getState()) }
}
window.publicProof = { facts, durable,
  async openOriginal(id) {
    if (!tabId()) {
      await state().openScratchTopic(id, undefined, { newTab: true }); const selection = state().workbenchSpaceSelection
      if (!selection?.tabId) throw Error('Original exact Mote Tab was not selected')
      localStorage.setItem('public-original-tab', selection.tabId)
    }
    await prepareRendererUpdate(); return facts()
  }, async createNew() { const topic = await state().createScratchTopic('mote'); const selection = state().workbenchSpaceSelection; state().setAgentComposerDraft(selection.regionId, 'New Mote unsent request'); useLauncherState.getState().setDraft(selection.regionId, 'note', 'New Mote utility draft'); await prepareRendererUpdate(); return { id: topic.id, physicalDirectoryPath: topic.physicalDirectoryPath, identityDirectoryPath: topic.identityDirectoryPath, selection } }, draft(text) { const tab = state().tabs[tabId()]; state().setAgentComposerDraft(tab.layout.activeRegionId, text); return facts() },
  async input(id, text) { const session = state().sessions.find(s => s.kind === 'agent' && s.id === id); if (!session?.control) throw Error('Original Agent control is unavailable'); return api.sessions.write(session.control, text, 'user') },
  async refresh() { await state().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true); return facts() },
  nativeReady(regionId, sessionId, runId) { return readTerminalViewObservation({ regionId, sessionId, runId })?.liveReady === true },
  async save() { await prepareRendererUpdate(); await api.ui.requestStorageFlush(); return durable() },
  dispose() { root.unmount() }
}
window.publicSetup.phase = 'ready'
