import { createElement } from 'react'
import { createClientUiRoot as createRoot } from '../../../test/helpers/client-ui-render'
import { App } from '../../../src/renderer/src/App'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createRendererSessionEvents } from '../../../src/renderer/src/lib/session-events'
import { readTerminalViewObservation } from '../../../src/renderer/src/lib/terminal-view-observation'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import '../../../src/renderer/src/styles/index.css'
const request = window.nativeBoundary.request
const { config, session, phase } = await request('setup')
const workspace = config.workspaces[0]
window.terminals = []
api.config.get = async () => config
api.providers.list = () => request('providers')
api.demands.list = async () => []
api.files.readDirectory = async () => []
api.files.observe = async () => {}
api.files.unobserve = async () => {}
api.sessions.snapshot = () => request('snapshot')
api.sessions.attach = (control, byte) => request('attach', control, byte)
api.sessions.replay = (id, byte) => request('replay', id, byte)
api.sessions.detach = id => request('detach', id)
api.sessions.resize = (id, cols, rows) => request('resize', id, cols, rows)
api.sessions.write = (control, data, source) => request('write', control, data, source)
api.sessions.paste = (control, text, data) => request('paste', control, text, data)
api.sessions.resolve = control => request('resolve', control)
api.sessions.refresh = control => request('refresh', control)
api.sessions.historyPage = (control, options) => request('history-page',control,options)
api.sessions.historySources = () => request('history-sources')
api.sessions.observeHistory = async () => { throw new Error('Explicit history reads remain real; this UI fixture isolates watch subscriptions.') }
api.sessions.launchAgent = input => request('launch',input)
api.sessions.creation = (hostId,id) => request('creation',hostId,id)
api.spatial.read = () => request('spatial-read')
api.spatial.commit = input => request('spatial-commit',input)
api.spatial.retainLabels = values => request('spatial-labels',values)
api.spatial.onChange = () => () => {}
api.sessions.onEvent = createRendererSessionEvents(listener => window.nativeBoundary.onEvent(listener))
api.ui.requestStorageFlush = () => request('flush')
const tab = createWorkbenchTab('original-tab', { regionId:'original-region', kind:'agent', phase:'attached',workspaceId:workspace.id,sessionId:session.id })
const layout = createWorkspaceLayout('original-group',[tab.id])
const { name, version } = useAppStore.persist.getOptions()
if(phase!=='restore')localStorage.setItem(name,JSON.stringify({version,state:{restoredWorkbench:projectPersistedWorkbench({tabs:{[tab.id]:tab},layouts:{[workspace.id]:layout}}),activeWorkspaceId:workspace.id,mainSurface:'workbench',toolsOpen:false,projectRailOpen:false,agentComposerDrafts:{[session.id]:'Keep this original unsent draft'}}}))
window.forkSource = session
window.forkLiveReady = () => readTerminalViewObservation({ regionId:'original-region', sessionId:session.id, runId:session.control.run.runId })?.liveReady === true
window.forkState = () => {
 const state=useAppStore.getState()
 return {tabs:state.tabs,layouts:state.layouts,sessions:state.sessions,drafts:state.agentComposerDrafts,activeWorkspaceId:state.activeWorkspaceId,spatialRequests:state.spatialRequests,error:state.error}
}
window.forkOriginal = () => {
 const state=useAppStore.getState()
 state.activateTab(workspace.id,'original-group','original-tab')
 state.focusRegion(workspace.id,'original-tab','original-region','keyboard','original-group')
}
window.forkDegrade = mode => {
 useAppStore.setState(state=>({sessions:state.sessions.map(value=>value.id!==session.id?value:mode==='unsupported'?{...value,capabilities:{...value.capabilities,providerFork:undefined}}:mode==='unknown'?{...value,capabilities:session.capabilities,nativeSourceObservation:{state:'unknown',run:value.control.run,observedAt:Date.now(),reason:'Fixture observation gap; raw remains healthy'}}:{...value,capabilities:session.capabilities,nativeSourceObservation:undefined})}))
}
window.forkLoseReceipt = () => {
 const execute=useAppStore.getState().executeControl
 useAppStore.setState({executeControl:async(request,signal)=>{
   const result=await execute(request,signal)
   if(request.operation==='agent.open') {useAppStore.setState({executeControl:execute});throw new Error('Private UI response lost after actual owner receipt')}
   return result
 }})
}
window.forkFlush=async()=>{prepareRendererUpdate();await request('flush')}
createRoot(document.getElementById('root')).render(createElement(App))
window.forkReady=true
