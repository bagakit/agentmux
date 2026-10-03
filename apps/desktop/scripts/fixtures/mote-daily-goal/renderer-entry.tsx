import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { GoalExecution } from '../../../src/renderer/src/components/GoalExecution'
import { AgentSessionComposer } from '../../../src/renderer/src/components/AgentSessionComposer'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { projectDemands } from '../../../src/renderer/src/lib/global-demand-board'
import { api } from '../../../src/renderer/src/lib/api'
import type { ContinuousProgressLoop } from '@agentmux/core'
import { agentPromptCondition } from '@agentmux/core/prompt-condition'
import type { Demand } from '@agentmux/demand'
import type { AppConfig, SessionSnapshot } from '../../../src/shared/contracts'
import '../../../src/renderer/src/styles/index.css'
const params=new URLSearchParams(location.search), phase=params.get('phase'), workspacePath=params.get('workspacePath')!
const session:Extract<SessionSnapshot,{kind:'agent'}>={id:'exact-goal-agent',kind:'agent',hostId:'local',providerId:'codex',executorId:'proof',workspacePath,label:'Research colleague',createdAt:1,updatedAt:2,agentSessionUpdatedAt:2,processState:'running',latestOutputBytes:0,status:{state:'done',source:'native-hook',observedAt:2},capabilities:{terminal:true,timeline:'complete-events',permission:'observe',providerResume:true,replyCorrelation:'none'},control:{kind:'agent',hostId:'local',agentSessionId:'exact-goal-agent',run:{runId:'same-goal-run'}}}
const config:AppConfig={version:9,hosts:[{id:'local',kind:'local',label:'Private Host'}],workspaces:[{id:'work',hostId:'local',path:workspacePath,name:'Original work',kind:'folder'}],executors:{},appearance:{terminalTheme:'graphite'},browser:{toolbar:{selectElement:true,screenshot:true,devTools:true,viewport:true,saveBookmark:true,more:true}}}
const goal:Demand={id:'goal',title:'Make the first experiment useful',description:'Compare two small experiments and leave an inspectable recommendation.',sessionIds:[session.id],status:'in_progress',priority:'normal',projectId:null,projectName:null,executorId:null,tags:[],plannedStartAt:null,targetAt:null,parentDemandId:null,phaseIndex:null,activities:[],decisions:[],createdAt:10,updatedAt:20,alignment:{revision:1,confirmedAt:20,summary:'A useful first experiment',criteria:[{id:'evidence',text:'An inspectable comparison with original sources.'}],openQuestions:[]}}
let loop:ContinuousProgressLoop={loopId:'original-goal-loop',hostId:'local',agentSessionId:session.id,providerId:session.providerId,workspacePath,prompt:'Continue the original confirmed Goal.',intervalMs:1800000,nextCheckAt:Date.now()+1800000,status:'active',taskSource:{kind:'goal',goalId:goal.id,alignmentRevision:1},revision:1,creationOperationId:'durable-original-start',initialDelivery:{operationId:'durable-original-start',prompt:goal.description,condition:agentPromptCondition({run:session.control.run}),state:'confirmed',startedAt:20}}
const calls:unknown[]=[];let showLoop=true
api.config.get=async()=>config;api.providers.list=async()=>[]
api.sessions.snapshot=async()=>({sessions:[session],timelines:{},recoveryCandidates:[],runtimeOwnershipWarnings:[],runtimeEndpointWarnings:[]})
api.demands.list=async()=>[goal]
api.spatial.read=async()=>{throw new Error('Private fixture excludes the Core spatial transport; retained Chromium workbench remains visible.')}
api.spatial.commit=async()=>{throw new Error('Private fixture does not acknowledge a Core spatial write.')}
api.continuousProgress.goals=async()=>showLoop?[structuredClone(loop)]:[]
api.continuousProgress.list=async()=>[structuredClone(loop)]
api.continuousProgress.pauseForInput=async()=>{}
api.continuousProgress.goalAction=async(goalId,loopId,action,expectedRevision,operationId)=>{calls.push({goalId,loopId,action,expectedRevision,operationId});if(goalId!==goal.id||loopId!==loop.loopId)throw Error('Foreign Goal');loop={...loop,status:action==='stop'?'stopped':action==='resume'?'active':action==='pause'?'paused':loop.status,revision:expectedRevision+1,lastMutation:{action,expectedRevision,operationId}};return structuredClone(loop)}
api.continuousProgress.prepareGoal=async input=>{calls.push(input);throw new Error('The original Goal input receipt is still unconfirmed. No new operation was sent.')}
api.sessions.historyPage=async()=>({agentSessionId:session.id,source:{providerId:session.providerId,nativeSessionId:'private-ui-native'},items:[],nextCursor:null})
await useAppStore.getState().initialize()
if(phase==='seed'){
 const tab={...createWorkbenchTab('original-tab',{kind:'agent',phase:'attached',regionId:'original-region',workspaceId:'work',sessionId:session.id}),name:'Original discussion'}
 const utility={...createWorkbenchTab('original-utility',{kind:'launcher',regionId:'utility-region',workspaceId:'work'}),name:'Original notes'}
 useAppStore.setState({tabs:{[tab.id]:tab,[utility.id]:utility},layouts:{work:createWorkspaceLayout('original-group',[tab.id,utility.id])},activeWorkspaceId:'work',workbenchSpaceSelection:{workspaceId:'work',groupId:'original-group',tabId:tab.id,regionId:'original-region',topicId:null,spaceId:null,zoneId:null},agentComposerDrafts:{[session.id]:'A later manual draft stays here.','utility-region':'Original utility draft stays here.'}})
}
const demand=()=>projectDemands(config,[session],useAppStore.getState().demands).find(item=>item.id===goal.id)!
function Scene(){const [epoch,setEpoch]=useState(0),tabs=useAppStore(s=>s.tabs);Object.assign(window,{goalScene:{calls,empty:()=>{showLoop=false;setEpoch(x=>x+1)},active:()=>{showLoop=true;setEpoch(x=>x+1)},theme:(light:boolean)=>{document.documentElement.dataset.appearance=light?'light':'dark'},unknown:()=>{loop={...loop,status:'paused',initialDelivery:{...loop.initialDelivery!,state:'unknown'},lastDecision:'The original start receipt is unconfirmed. Your Agent and manual input are kept.'};setEpoch(x=>x+1)},facts:()=>{const s=useAppStore.getState();return{tabs:s.tabs,layouts:s.layouts,selection:s.workbenchSpaceSelection,drafts:s.agentComposerDrafts,sessions:s.sessions.map(x=>({id:x.id,control:x.control,processState:x.processState})),calls,loop}},flush:()=>{window.dispatchEvent(new Event('pagehide'))}}});return <DesktopClientUiProvider><main style={{height:'100vh',overflow:'auto',padding:'24px',boxSizing:'border-box',background:'var(--surface-1)'}}><div style={{maxWidth:'800px',margin:'0 auto'}}><div style={{color:'var(--text-3)',fontSize:'var(--fs-meta)',marginBottom:12}}>{Object.values(tabs).map(t=>t.name).join(' · ')}</div><h1 style={{fontSize:22,lineHeight:1.35,margin:'0 0 12px'}}>Make the first experiment useful</h1><p style={{color:'var(--text-2)',lineHeight:1.6}}>Compare two small experiments and leave an inspectable recommendation.</p><GoalExecution key={epoch} demand={demand()} onUpdate={()=>{}}/><div style={{marginTop:24}}><AgentSessionComposer sessionId={session.id}/></div></div></main></DesktopClientUiProvider>}
createRoot(document.getElementById('root')!).render(<Scene/> )
