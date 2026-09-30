import {createElement} from 'react'
import {createRoot} from 'react-dom/client'
import {createWorkspaceLayout,splitWorkbenchRegion} from '@agentmux/layout'
import {App} from '../../../src/renderer/src/App'
import {api} from '../../../src/renderer/src/lib/api'
import {useAppStore} from '../../../src/renderer/src/store'
import {createWorkbenchTab} from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'
const config=await api.config.get(),snapshot=await api.sessions.snapshot()
const resource={...config.workspaces.find(w=>w.id==='workspace-demo'),path:'/private/resource-a',name:'Resource A'}
const display={...resource,id:'display-b',path:'/private/display-b',name:'Display B'}
const session={...snapshot.sessions.find(s=>s.id==='session-codex'),workspacePath:resource.path}
if(!session.control?.run?.runId||!resource.id)throw new Error('Actual typed preview identity required')
const decoy=createWorkbenchTab('decoy-first-tab',{regionId:'decoy-region',workspaceId:resource.id,kind:'agent',phase:'attached',sessionId:session.id},'Decoy first')
const exact=createWorkbenchTab('explicit-exact-tab',{regionId:'exact-r1',workspaceId:resource.id,kind:'file',path:'selection.txt'},'Original mixed Tab')
exact.regions['exact-r2']={regionId:'exact-r2',workspaceId:resource.id,kind:'agent',phase:'attached',sessionId:session.id}
exact.layout=splitWorkbenchRegion(exact.layout,'exact-r1','right','exact-r2')
const first=createWorkspaceLayout('display-first-group',[exact.id])
const layout={...first,root:{type:'split',direction:'horizontal',ratio:.5,first:first.root,second:{type:'leaf',groupId:'display-exact-group'}},
 groups:[...first.groups,{...first.groups[0],id:'display-exact-group'}],activeGroupId:first.activeGroupId}
useAppStore.setState({loading:false,initialize:async()=>()=>{},config:{...config,workspaces:[resource,display]},sessions:[session],
 activeWorkspaceId:resource.id,mainSurface:'workbench',toolsOpen:false,projectRailOpen:false,
 tabs:{[decoy.id]:decoy,[exact.id]:exact},layouts:{[resource.id]:createWorkspaceLayout('resource-home-group',[decoy.id,exact.id]),[display.id]:layout},
 agentFocus:{execution:{sessionId:null,history:[]},pmo:{sessionId:null}},agentComposerDrafts:{[session.id]:'Original unsent draft'}})
window.presentationLeaves={mounts:[],unmounts:[]}
const calls={stop:0,resume:0,launchAgent:0,write:0,interrupt:0}
for(const key of Object.keys(calls)){const original=api.sessions[key];api.sessions[key]=(...args)=>{calls[key]++;return original(...args)}}
const reads={historyPage:0,timeline:0,historySources:0}
for(const key of Object.keys(reads)){const original=api.sessions[key];api.sessions[key]=(...args)=>{reads[key]++;return original(...args)}}
createRoot(document.getElementById('root')).render(createElement(App))
const reference={displayWorkspaceId:display.id,groupId:'display-exact-group',tabId:exact.id,regionId:'exact-r2'}
let before,originalDraft,originalHost
window.focusLocalProof={ready:true,
 enter(){useAppStore.getState().focusRegion(display.id,exact.id,reference.regionId,'pointer',reference.groupId);before=useAppStore.getState()
  originalDraft=document.querySelector('[data-owner-tab="explicit-exact-tab"][data-owner-region="exact-r2"] textarea')
  originalHost=originalDraft?.closest('.retained-workbench-view');if(!originalDraft||!originalHost)throw new Error('Original leaf required')
  originalDraft.setSelectionRange(7,15);useAppStore.getState().setMainSurface('agents')},
 facts(){const state=useAppStore.getState(),slot=document.querySelector('.focused-tab-workspace'),r=state.agentFocus.execution.reference;return{
  selectedTab:slot?.dataset.focusTabId??null,reference:r??null,semanticAgent:state.agentFocus.execution.sessionId,
  actualLauncher:Boolean(slot?.querySelector('.launch-surface')),actualFile:Boolean(slot?.querySelector('[data-workbench-region-id="exact-r1"] [data-file-paint]')),
  sameHost:originalDraft?.closest('.retained-workbench-view')===originalHost,connected:originalDraft?.isConnected,
  sameDraftElement:document.querySelector('[data-owner-tab="explicit-exact-tab"][data-owner-region="exact-r2"] textarea')===originalDraft,
  draft:originalDraft?.value,range:[originalDraft?.selectionStart,originalDraft?.selectionEnd],sameSessions:state.sessions===before.sessions,
  sameHistory:state.agentFocus.execution.history===before.agentFocus.execution.history,sameDrafts:state.agentComposerDrafts===before.agentComposerDrafts,
  sameTabs:state.tabs===before.tabs,sameLayouts:state.layouts===before.layouts,primary:state.activeWorkspaceId,
  originalRun:state.sessions[0]?.control.run.runId,calls:{...calls},reads:{...reads},mounts:[...window.presentationLeaves.mounts],unmounts:[...window.presentationLeaves.unmounts],
  created:Object.keys(state.tabs).filter(id=>!before.tabs[id]),primarySelection:Object.fromEntries(Object.entries(state.layouts).map(([id,l])=>[id,{group:l.activeGroupId,tabs:l.groups.map(g=>[g.id,g.activeTabId])}]))
 }}}
