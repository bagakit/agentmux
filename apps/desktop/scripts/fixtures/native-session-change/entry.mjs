import { createElement } from 'react'
import { createClientUiRoot as createRoot } from '../../../test/helpers/client-ui-render'
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
api.providers.list = async () => request('providers')
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
api.sessions.historySources = () => request('history-sources')
api.sessions.historyPage = (control, options) => request('history-page',control,options)
api.sessions.confirmNativeSession = (control,input) => request('confirm-native',control,input)
api.sessions.observeHistory = async () => { throw Object.assign(new Error('Private source observation stream isolated; explicit history reads remain real'), {code:'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED'}) }
api.spatial.read = () => request('spatial-read')
api.spatial.commit = input => request('spatial-commit',input)
api.spatial.retainLabels = values => request('spatial-labels',values)
api.spatial.onChange = () => () => {}
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
createRoot(document.getElementById('root')).render(createElement(App))
window.nativeReady = true
window.nativeTerminal = () => { useAppStore.getState().setViewMode(identity.sessionId,'terminal') }
window.nativeSetDraft = text => useAppStore.getState().setAgentComposerDraft(identity.sessionId,text)
const presentationFacts = node => {
 const ancestors=[]
 for(let current=node;current instanceof HTMLElement;current=current.parentElement)ancestors.push({tag:current.tagName,className:current.className,opacity:getComputedStyle(current).opacity,inert:current.inert,ariaBusy:current.getAttribute('aria-busy'),readOnly:current.getAttribute('data-read-only')})
 return {opacity:getComputedStyle(node).opacity,inert:!!node.closest('[inert]'),editable:node.contentEditable,ancestors}
}
const menuGeometry = () => {
 const menu=document.querySelector('.agent-region-menu')
 if(!menu)return null
 const {x,y,width,height,bottom}=menu.getBoundingClientRect(),style=getComputedStyle(menu)
 const items=[...menu.querySelectorAll('[role=menuitem]:not([data-disabled])')],last=items.at(-1),lastBounds=last?.getBoundingClientRect()
 return {x,y,width,height,bottom,viewport:{width:innerWidth,height:innerHeight},scrollTop:menu.scrollTop,scrollHeight:menu.scrollHeight,clientHeight:menu.clientHeight,overflowY:style.overflowY,maxHeight:style.maxHeight,availableHeight:style.getPropertyValue('--radix-dropdown-menu-content-available-height'),lastItem:last?.textContent.trim(),lastBounds:lastBounds?{top:lastBounds.top,bottom:lastBounds.bottom}:null,focused:document.activeElement?.textContent?.trim()}
}
window.nativeNativeFacts = () => ({ state:window.nativeState(), menuGeometry:menuGeometry(), marker:document.querySelector('[data-native-source-marker]')?.textContent, menu:document.querySelector('.agent-region-menu')?.textContent, history:document.querySelector('.session-history')?.textContent, historySource:document.querySelector('[data-history-native-session-id]')?.dataset.historyNativeSessionId,presentation:[...document.querySelectorAll('.agent-body,.session-history__viewport')].map(presentationFacts), composer:[...document.querySelectorAll('[contenteditable=true]')].map(input=>presentationFacts(input)),terminal:window.terminals.filter(t=>t.element?.isConnected).map(t=>({rows:t.rows,cols:t.cols})) })
