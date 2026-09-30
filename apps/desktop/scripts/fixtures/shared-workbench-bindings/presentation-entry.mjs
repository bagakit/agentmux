import {createElement} from 'react'
import {createRoot} from 'react-dom/client'
import {createWorkspaceLayout, splitWorkbenchRegion} from '@agentmux/layout'
import {App} from '../../../src/renderer/src/App'
import {api} from '../../../src/renderer/src/lib/api'
import {useAppStore} from '../../../src/renderer/src/store'
import {createWorkbenchTab} from '../../../src/renderer/src/lib/workbench-tabs'
import {workbenchProjectionSlotId} from '../../../src/renderer/src/lib/workbench-projection'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get(), snapshot = await api.sessions.snapshot()
const resource = {...config.workspaces.find(item => item.id === 'workspace-demo'), path:'/private/resource-a', name:'Resource A'}
const display = {...resource, id:'display-b', path:'/private/display-b', name:'Display B'}
const session = {...snapshot.sessions.find(item => item.id === 'session-codex'), workspacePath:resource.path}
if (!session.control?.run?.runId || !resource.id) throw new Error('Existing typed preview facts must be nonempty')
const decoy = createWorkbenchTab('decoy-first-tab', {regionId:'decoy-region', workspaceId:resource.id, kind:'agent', phase:'attached', sessionId:session.id}, 'Inserted first')
const exact = createWorkbenchTab('explicit-exact-tab', {regionId:'exact-r1', workspaceId:resource.id, kind:'agent', phase:'attached', sessionId:session.id}, 'Exact occurrence')
exact.regions['exact-r2'] = {regionId:'exact-r2', workspaceId:resource.id, kind:'agent', phase:'attached', sessionId:session.id}
exact.layout = splitWorkbenchRegion(exact.layout, 'exact-r1', 'right', 'exact-r2')
const first = createWorkspaceLayout('display-first-group', [exact.id])
const displayLayout = {...first, root:{type:'split', direction:'horizontal', ratio:.5, first:first.root, second:{type:'leaf', groupId:'display-exact-group'}},
  groups:[...first.groups, {...first.groups[0], id:'display-exact-group'}], activeGroupId:first.activeGroupId}
useAppStore.setState({loading:false, initialize:async()=>()=>{}, config:{...config, workspaces:[resource,display]}, sessions:[session],
  activeWorkspaceId:resource.id, mainSurface:'workbench', toolsOpen:false, projectRailOpen:false,
  tabs:{[decoy.id]:decoy,[exact.id]:exact}, layouts:{[resource.id]:createWorkspaceLayout('resource-home-group',[decoy.id,exact.id]),[display.id]:displayLayout},
  agentFocus:{execution:{sessionId:null,history:[]},pmo:{sessionId:null}}, agentComposerDrafts:{[session.id]:'Unsent original draft'}})
window.presentationLeaves = {mounts:[],unmounts:[]}
const calls = {stop:0,resume:0,launchAgent:0,write:0,interrupt:0}
for (const key of Object.keys(calls)) {const original=api.sessions[key]; api.sessions[key]=(...args)=>{calls[key]++;return original(...args)}}
const reads = {historyPage:0,timeline:0,historySources:0}
for (const key of Object.keys(reads)) {const original=api.sessions[key];api.sessions[key]=(...args)=>{reads[key]++;return original(...args)}}
createRoot(document.getElementById('root')).render(createElement(App))
const reference = {displayWorkspaceId:display.id,groupId:'display-exact-group',tabId:exact.id,regionId:'exact-r2'}
let primary, originalDraft, originalHost
window.focusPresentationProof = {
  ready:true, reference,
  existingExactEntry(){useAppStore.getState().focusRegion(display.id,exact.id,reference.regionId,'pointer',reference.groupId);primary=useAppStore.getState()
    originalDraft=document.querySelector('[data-owner-tab="explicit-exact-tab"][data-owner-region="exact-r2"] textarea')
    originalHost=originalDraft?.closest('.retained-workbench-view')
    if (!originalDraft || !originalHost) throw new Error('Original Tab leaf must exist before Focus')
    originalDraft.setSelectionRange(7,15)
  },
  identityOnly(){useAppStore.getState().focusExecutionSession(session.id)},
  facts(){const state=useAppStore.getState(),slot=document.querySelector('.focused-tab-workspace');return {
    selectedTab:slot?.dataset.focusTabId??null, reference:state.agentFocus.execution.reference??null,
    expectedHost:workbenchProjectionSlotId('focus-workbench-slot',reference), actualHost:originalHost?.parentElement?.id??null,
    sameHost:originalDraft?.closest('.retained-workbench-view')===originalHost,
    sameDraftElement:document.querySelector('[data-owner-tab="explicit-exact-tab"][data-owner-region="exact-r2"] textarea')===originalDraft,
    draft:originalDraft?.value, range:[originalDraft?.selectionStart,originalDraft?.selectionEnd], connected:originalDraft?.isConnected,
    sameTabs:state.tabs===primary?.tabs,sameLayouts:state.layouts===primary?.layouts,sameSessions:state.sessions===primary?.sessions,
    sameDrafts:state.agentComposerDrafts===primary?.agentComposerDrafts,primaryWorkspace:state.activeWorkspaceId,
    originalRun:state.sessions[0]?.control.run.runId, mounts:[...window.presentationLeaves.mounts],unmounts:[...window.presentationLeaves.unmounts],
    calls:{...calls},reads:{...reads},choices:document.querySelectorAll('[aria-label="Choose Focus location"] button').length,
    settings:!!document.querySelector('.settings-page'),workspaceInert:document.querySelector('.app-shell__workspace')?.inert??false,
    originalSourceRect:originalHost?{width:originalHost.getBoundingClientRect().width,height:originalHost.getBoundingClientRect().height}:null
  }}
}
