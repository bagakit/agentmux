import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/renderer/src/App'
import { SessionPane } from '../../../src/renderer/src/components/SessionPane'
import { AttentionRequestPanel } from '../../../src/renderer/src/components/AttentionRequestPanel'
import { summarizeAgentAttention } from '../../../src/renderer/src/lib/agent-attention'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { readTerminalViewObservation } from '../../../src/renderer/src/lib/terminal-view-observation'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import '../../../src/renderer/src/styles/index.css'
window.terminals = []
const request = window.nativeBoundary.request
const setup = await request('setup')
const workspace = setup.config.workspaces[0]
api.config.get = async () => setup.config
api.providers.list = async () => []
api.demands.list = async () => []
api.files.readDirectory = async () => []
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.sessions.snapshot = async () => request('snapshot')
api.sessions.attach = async (control, byte) => request('attach', control, byte)
api.sessions.replay = async (id, byte) => request('replay', id, byte)
api.sessions.detach = async id => request('detach', id)
api.sessions.resize = async (id, cols, rows) => request('resize', id, cols, rows)
api.sessions.write = async (control, data, source) => request('write', control, data, source)
api.sessions.paste = async (control, text, data) => request('paste', control, text, data)
api.sessions.respondInteraction = async (control, response) => request('respond', control, response)
api.sessions.resolve = async control => request('resolve', control)
api.sessions.refresh = async control => request('refresh', control)
api.sessions.onEvent = createRendererSessionEvents(listener => window.nativeBoundary.onEvent(listener))
api.ui.requestStorageFlush = async () => request('flush')
let identity = setup.ids
if (setup.phase === 'seed') {
  const { session } = await request('launch')
  identity = { sessionId: session.id, run: session.control.run, tabId: 'native-tab', regionId: 'native-region' }
  await request('save-ids', identity)
  const tab = createWorkbenchTab(identity.tabId, { regionId: identity.regionId, kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: session.id })
  const layout = createWorkspaceLayout('native-group', [tab.id])
  const { name, version } = useAppStore.persist.getOptions()
  localStorage.setItem(name, JSON.stringify({ version, state: {
    restoredWorkbench: projectPersistedWorkbench({ tabs: { [tab.id]: tab }, layouts: { [workspace.id]: layout } }),
    activeWorkspaceId: workspace.id, mainSurface: 'workbench', toolsOpen: false, projectRailOpen: false,
    agentComposerDrafts: { [session.id]: 'Keep this unsent draft' }
  } }))
}
window.nativeIdentity = identity
window.nativeState = () => {
  const state = useAppStore.getState()
  const workbench = projectPersistedWorkbench(state)
  const session = state.sessions.find(one => one.id === identity.sessionId)
  return { tabs: workbench.tabs, layouts: workbench.layouts, drafts: state.agentComposerDrafts, focus: state.agentFocus,
    activeWorkspaceId: state.activeWorkspaceId, session, error: state.error,
    card: document.querySelector('.agent-interaction')?.textContent ?? null,
    terminalCount: window.terminals.filter(one => one.element?.isConnected).length }
}
window.nativeLiveReady = () => readTerminalViewObservation({ regionId: identity.regionId, sessionId: identity.sessionId, runId: identity.run.runId })?.liveReady === true
window.nativeFlush = async () => { prepareRendererUpdate(); await request('flush') }
window.nativeActivity = () => useAppStore.getState().setViewMode(identity.sessionId, 'activity')
window.nativeReviewHere = () => {
  useAppStore.setState(state => ({ mainSurface: 'agents', agentFocus: {
    ...state.agentFocus, execution: { sessionId: identity.sessionId, history: [] }
  } }))
}
let extraRoot
window.nativeObserveExtra = session => {
  useAppStore.setState(state => ({ sessions: [...state.sessions.filter(one => one.id !== session.id), session] }))
  const host = document.createElement('div')
  host.id = 'private-extra-consumers'
  document.body.append(host)
  extraRoot = createRoot(host)
  extraRoot.render(createElement('div', null,
    createElement(AttentionRequestPanel, { sessionId: session.id, onClose() {} }),
    createElement(SessionPane, { sessionId: session.id, surfaceKind: 'agent', interactiveResize: false, visible: false,
      linkOrigin: { workspaceId: workspace.id, tabGroupId: 'native-group' } })))
}
window.nativeExtraState = id => {
  const state = useAppStore.getState()
  return { session: state.sessions.find(one => one.id === id), needsYou: summarizeAgentAttention(state.sessions).needsYou,
    cards: [...document.querySelectorAll('#private-extra-consumers .agent-interaction')].map(card => card.dataset.requestId) }
}
window.nativeCloseExtra = () => { extraRoot.unmount(); document.getElementById('private-extra-consumers').remove() }
window.nativeRespond = () => useAppStore.getState().respondInteraction(identity.sessionId,
  { kind: 'permission', requestId: useAppStore.getState().sessions.find(one => one.id === identity.sessionId).pendingInteraction.id,
    decision: { outcome: 'selected', optionId: 'allow-once' } })
createRoot(document.getElementById('root')).render(createElement(App))
window.nativeReady = true
