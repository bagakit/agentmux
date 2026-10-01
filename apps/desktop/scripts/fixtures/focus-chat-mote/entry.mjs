import { createElement as h, useEffect, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { useShallow } from 'zustand/react/shallow'
import { createWorkspaceLayout, moveTabToNewGroup, addTabOccurrence, activateTab } from '@agentmux/layout'
import { useAppStore, prepareRendererUpdate } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectPersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'
import { executionFocusPresentation } from '../../../src/renderer/src/lib/focus-tab-projection'
import { workbenchProjectionSlotId } from '../../../src/renderer/src/lib/workbench-projection'
import { spatialCatalog } from '../../../src/renderer/src/lib/space-agent-control'
import { GlobalFocusSurface } from '../../../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { readPmoTeamsTopicFloatingState } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import { moteConfig, moteSessions, moteTabs, moteTopics, executionAgent, customMoteId, quietMoteId, savedMoteKey } from '../../../test/fixtures/mote-workface'
import '../../../src/renderer/src/styles/index.css'
const phase=new URL(location.href).searchParams.get('phase')
if(!['seed','restore'].includes(phase))throw new Error('Exact ordinary GUI phase required')
window.sceneErrors=[]
window.addEventListener('error',event=>window.sceneErrors.push({message:event.message,stack:event.error?.stack}))
window.addEventListener('unhandledrejection',event=>window.sceneErrors.push({message:String(event.reason),stack:event.reason?.stack}))
const sourceId='chat-original-tab',sourceRegion='chat-original-region'
const reference={displayWorkspaceId:'project',groupId:'chat-original-exact-group',tabId:sourceId,regionId:sourceRegion}
const longName='Release review · original complete Tab with two Regions and a long exact retained title'
const topics=moteTopics.map(topic=>topic.id===quietMoteId?{...topic,moteArchive:{state:'archived',version:'private-archive-v1'}}:topic)
let directory=topics
const config={...moteConfig,executors:{}}
const originalSnapshot=await api.sessions.snapshot()
api.config.get=async()=>config
api.sessions.snapshot=async()=>({...originalSnapshot,sessions:moteSessions,recoveryCandidates:[]})
api.providers.list=async()=>[]
api.demands.list=async()=>[]
api.workspaces.listBranches=async id=>{const workspace=config.workspaces.find(item=>item.id===id);if(!workspace)throw new Error('Exact fixture workspace unavailable');return{kind:'not-a-git-repository',hostId:workspace.hostId,workspacePath:workspace.path}}
api.scratch.listTopics=async()=>directory
api.scratch.readTopic=async(_workspace,id)=>directory.find(topic=>topic.id===id)??null
const reads={timeline:0,historyPage:0,historySources:0,topics:0},control={launchAgent:0,stop:0,resume:0,recover:0,write:0,ensureMote:0}
for(const key of Object.keys(reads)){const port=key==='topics'?api.scratch:api.sessions,method=key==='topics'?'listTopics':key,original=port[method];port[method]=(...args)=>{reads[key]++;return original(...args)}}
for(const key of Object.keys(control)){const port=key==='ensureMote'?api.scratch:api.sessions,original=port[key];port[key]=(...args)=>{control[key]++;return original(...args)}}
if(phase==='seed'){
 const agent=createWorkbenchTab(sourceId,{kind:'agent',phase:'attached',workspaceId:'project',regionId:sourceRegion,sessionId:executionAgent.id},longName)
 const source=addWorkbenchRegion(agent,sourceRegion,'right',{kind:'agent',phase:'attached',workspaceId:'project',regionId:'chat-second-region',sessionId:executionAgent.id})
 const neighbor=createWorkbenchTab('chat-neighbor-tab',{kind:'agent',phase:'attached',workspaceId:'project',regionId:'chat-neighbor-region',sessionId:executionAgent.id},'Other original Tab')
 const split=moveTabToNewGroup(createWorkspaceLayout('chat-first-group',[neighbor.id,source.id]),source.id,'chat-first-group','chat-first-group','right',reference.groupId)
 const layout=activateTab(addTabOccurrence(split,'chat-first-group',source.id),'chat-first-group',source.id)
 const {name,version}=useAppStore.persist.getOptions()
 localStorage.setItem(name,JSON.stringify({version,state:{
  restoredWorkbench:projectPersistedWorkbench({tabs:{...moteTabs,[source.id]:source,[neighbor.id]:neighbor},layouts:{[SCRATCH_WORKSPACE_ID]:createWorkspaceLayout('mote-group',Object.keys(moteTabs)),project:{...layout,activeGroupId:'chat-first-group'}}}),
  activeWorkspaceId:'project',mainSurface:'agents',projectRailOpen:false,toolsOpen:false,
  agentFocus:{execution:{sessionId:executionAgent.id,history:[],reference},pmo:{sessionId:'default-agent'}},
  agentComposerDrafts:{[sourceRegion]:'Original Region unsent · retain exact text','chat-second-region':'Second original draft','execution-agent':'Exact Session unsent','default-agent':'Default Mote unsent','custom-agent':'Analyst unsent'}
 }}))
}
// Original initializer consumes the existing profile in both ordinary processes;
// restore executes no seed/setState/localStorage preference copying.
await useAppStore.getState().initialize()
const rect=node=>node?.getBoundingClientRect().toJSON()??null
window.chatMoteProbe={ready:false,phase,seedCount:phase==='seed'?1:0,preferenceSeedCount:0,sourceId,sourceRegion,reference,customMoteId,quietMoteId,
 async missingRecipient(missing){if(phase!=='seed')throw new Error('Restore cannot replace directory inputs');directory=missing?topics.filter(topic=>topic.id!==customMoteId):topics;await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID,true)},
 churn(){if(phase!=='seed')throw new Error('Restore cannot inject output');for(let n=0;n<200;n++)useAppStore.setState(state=>({sessions:state.sessions.map(session=>session.id==='ordinary-agent'?{...session,latestOutputBytes:n+1}:session)}))},
 flush:()=>prepareRendererUpdate('quit'),
 facts(){const state=useAppStore.getState(),workface=projectPersistedWorkbench(state);return{tabs:workface.tabs,layouts:workface.layouts,drafts:state.agentComposerDrafts,focus:state.agentFocus,activeWorkspaceId:state.activeWorkspaceId,mainSurface:state.mainSurface,identities:state.sessions.map(session=>({sid:session.id,control:session.control})),floating:readPmoTeamsTopicFloatingState(),persistedFloating:JSON.parse(localStorage.getItem(savedMoteKey)??'null'),reads:{...reads},control:{...control},errors:window.sceneErrors}},
 geometry(){const nodes=[document.documentElement,document.querySelector('.focus-toolbar'),document.querySelector('.focus-toolbar__context'),document.querySelector('[role="menu"]')].filter(Boolean);return{width:innerWidth,toolbar:rect(document.querySelector('.focus-toolbar')),context:rect(document.querySelector('.focus-toolbar__context')),workface:rect(document.querySelector('.focused-tab-workspace')),menu:rect(document.querySelector('[role="menu"]')),horizontalOverflow:nodes.some(node=>node.scrollWidth>node.clientWidth+1),controls:[...document.querySelectorAll('.focus-toolbar__context button')].map(node=>({label:node.getAttribute('aria-label'),rect:rect(node),disabled:node.disabled}))}}
}
function Scene(){
 const state=useAppStore(useShallow(state=>({tabs:state.tabs,layouts:state.layouts,focus:state.agentFocus,mainSurface:state.mainSurface,snapshots:state.scratchTopicSnapshots})))
 const presentation=useMemo(()=>executionFocusPresentation(state.focus.execution,state.tabs,spatialCatalog(useAppStore.getState(),directory),choice=>useAppStore.getState().selectExecutionFocusReference(choice,state.focus.execution)),[state.focus.execution,state.tabs,state.layouts,state.snapshots])
 const projection=presentation.projection,selected=projection?.selection[0]
 const viewTargets=selected&&projection?{[selected.tabId]:[{hostId:workbenchProjectionSlotId(`${projection.presentationId}-slot`,selected),active:true,visible:true,surface:'focus',retainedRegionId:selected.regionId,headerPortalTargetId:'focus-workspace-slot-header',projection,reference:selected,onSelectRegion:regionId=>projection.onSelect({...selected,regionId})}]}:{}
 useEffect(()=>{window.chatMoteProbe.ready=true},[])
 return h('section',{className:'workspace-main-surface',style:{width:'100vw',height:'100vh',position:'relative'}},
  h(GlobalFocusSurface,{presentation,viewTargets}),
  h('div',{className:'workspace-workbench-registry','aria-hidden':false},
   h('div',{className:'workspace-workbench-slot workspace-workbench-slot--focus-source','data-workspace-id':'project','data-visible':'true'},h(WorkspaceWorkbench,{workspaceId:'project',visible:false,viewTargets})),
   h('div',{className:'workspace-workbench-slot workspace-workbench-slot--parked','data-workspace-id':SCRATCH_WORKSPACE_ID,'data-visible':'false','aria-hidden':true,inert:true},h(WorkspaceWorkbench,{workspaceId:SCRATCH_WORKSPACE_ID,visible:false}))))
}
createRoot(document.getElementById('root')).render(h(DesktopClientUiProvider,null,h(Scene)))
