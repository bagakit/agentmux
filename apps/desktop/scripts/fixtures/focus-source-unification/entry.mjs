import { createElement } from 'react'
import { createClientUiRoot as createRoot } from '../../../test/helpers/client-ui-render'
import { createWorkspaceLayout } from '@agentmux/layout'
import { updateThemeSelection } from '@agentmux/client-ui/theme'
import { App } from '../../../src/renderer/src/App'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { spaceMountKey } from '../../../src/shared/space-mount'
import '../../../src/renderer/src/styles/index.css'

// Original authority/Native process IO are controlled preview leaves. The App,
// source adapter, normal Context/lane/card/Reader/filter/menu remain production.
const memberStateMode=window.__memberStateScene===true,unconfirmedMode=window.__unconfirmedScene===true
const config=await api.config.get(),initial=await api.sessions.snapshot(),base=initial.sessions.find(s=>s.kind==='agent')
if(!base?.control?.run?.runId)throw Error('Existing typed preview Agent required')
const {pendingInteraction:_pending,...agent}=base,now=Date.now(),path='/original/analysis-project'
const workspace={id:'ordinary-analysis',hostId:'local',kind:'folder',path,name:'业务分析项目'}
const definitions=[['working','核对发布版本与业务数据','working','running',now],['reading','核查跨版本分析记录','working','running',now-20*60000],['interrupted','继续上次保留的分析任务','disconnected','interrupted',now]]
const sessions=definitions.map(([id,label,state,processState,at])=>({...agent,id,hostId:'local',workspacePath:path,label,processState,status:{state,source:'native-hook',observedAt:at},semanticStatus:{state:'working',source:'native-hook',observedAt:at,stateEnteredAt:at},control:{...agent.control,hostId:'local',agentSessionId:id,run:{runId:'original-run-'+id}}}))
const localReply='已核对原始数据与发布记录，接下来定位异常项并给出可验证的结论。'
const timelines=Object.fromEntries(sessions.map(s=>[s.id,{agentSessionId:s.id,revision:1,items:[{id:'original-answer-'+s.id,agentSessionId:s.id,kind:'assistant_message',title:'Original answer',source:'native-hook',status:'complete',content:s.id==='working'?localReply:'原始分析内容与恢复位置仍然保留。',createdAt:now-30000,updatedAt:now-30000}]}]))
const tab=createWorkbenchTab('ordinary-tab',{regionId:'ordinary-region',workspaceId:workspace.id,kind:'agent',phase:'attached',sessionId:'working'})
window.presentationLeaves={mounts:[],unmounts:[]}
api.workspaces.listBranches=async()=>({kind:'not-a-git-repository',hostId:'local',workspacePath:path})
api.scratch.listTopics=async()=>[]
const reference={runtimeId:'original-local-runtime',spaceId:'original-project-space'},source={runtimeId:reference.runtimeId,ownerInstanceId:'original-source-instance'},key=spaceMountKey(reference)
const target={hostId:'local',reference,zoneId:'original-zone',workspaceId:workspace.id}
const members=[['working',reference.runtimeId,'local'],['interrupted',reference.runtimeId,'local'],['reading',reference.runtimeId,'local'],['working','original-other-runtime','original-agent-device'],['unobserved','unavailable-original-runtime','unavailable-agent-device']]
const sourceTabs=members.map((_,i)=>({tabId:'source-tab-'+i,zoneId:target.zoneId,workspaceId:workspace.id,name:null,regionIds:['source-region-'+i]}))
const sourceRegions=members.map(([sid,runtimeId,hostId],i)=>({regionId:'source-region-'+i,tabId:'source-tab-'+i,kind:'agent',agentSessionId:sid,runId:'source-run-'+i,creationOperationId:'source-create-'+i,execution:{hostId,runtimeId,cwd:path}}))
if(unconfirmedMode){
 Object.assign(sourceRegions[4],{regionId:'R6A39kP2s4Bd',agentSessionId:'4iSNA9U2sBCU',execution:null,runId:null});sourceTabs[4].regionIds=['R6A39kP2s4Bd']
 sourceTabs.push({tabId:'unknown-source-tab',zoneId:target.zoneId,workspaceId:workspace.id,name:null,regionIds:['B7C48mQ3t5Ce']})
 sourceRegions.push({regionId:'B7C48mQ3t5Ce',tabId:'unknown-source-tab',kind:'agent',agentSessionId:'4iSNA9U2sBCU',runId:null,execution:null})
}
for(let i=5;i<12;i++){sourceTabs.push({tabId:'source-tab-'+i,zoneId:target.zoneId,workspaceId:workspace.id,name:null,regionIds:['source-region-'+i]});sourceRegions.push({regionId:'source-region-'+i,tabId:'source-tab-'+i,kind:i===11?'launcher':'browser',agentSessionId:null,runId:null})}
// This original foreign Tab is mixed: primary selection must retain both Regions.
const browserPosition=sourceRegions.find(region=>region.regionId==='source-region-5')
if(!memberStateMode){browserPosition.tabId='source-tab-3';sourceTabs[3].regionIds.push(browserPosition.regionId);sourceTabs.splice(sourceTabs.findIndex(tab=>tab.tabId==='source-tab-5'),1)}
if(new Set(sourceRegions.map(region=>region.regionId)).size!==sourceRegions.length||new Set(sourceTabs.map(tab=>tab.tabId)).size!==sourceTabs.length)throw Error('Original scene topology identities must be unique')
const snapshot={reference,source,revision:5,scope:{space:{spaceId:reference.spaceId,kind:'folder',name:workspace.name,hostId:'local',directoryPath:path,projectId:'original-analysis'},zones:[{zoneId:target.zoneId,workspaceId:workspace.id,hostId:'local',kind:'directory',directoryPath:path,branch:'main'}],tabs:sourceTabs,regions:sourceRegions,bindings:[{zoneId:target.zoneId,spaceId:reference.spaceId}]}}
const opening={reference,source,revision:5},events=members.map(([sid,runtimeId,hostId],i)=>({...opening,type:'member',member:{hostId,runtimeId,agentSessionId:sid},state:i===4?{status:'unavailable',issue:{code:'ORIGINAL_SESSION_UNAVAILABLE',message:'原 Agent 的当前观察暂不可用，保留原任务与工作位置。'}}:{status:'observed',authority:{runtimeId,ownerInstanceId:runtimeId+'-instance'},session:{kind:'agent',sessionProjection:'summary',agentSessionId:sid,hostId,providerId:'codex',executorId:'codex',workspacePath:path,run:{runId:sourceRegions[i].runId},retiredRuns:[],createdAt:now-1000,updatedAt:now,semanticStatus:{state:'working',source:'native-hook',observedAt:now}}}}))
api.spaceMounts.watch=async()=>({initial:snapshot,dispose(){}})
let memberReadMode='missing',sourceChecks=0
const sessionObservers=new Set(),memberCalls=[]
const originalEvents=()=>events.filter((_,index)=>!unconfirmedMode||index!==4).map((event,index)=>memberStateMode&&index===3?{...event,state:memberReadMode==='observed'?event.state:memberReadMode==='pending'?{status:'pending'}:{status:'missing',authority:{runtimeId:event.member.runtimeId,ownerInstanceId:event.member.runtimeId+'-instance'}}}:event).concat(unconfirmedMode?[{...opening,type:'member',member:{hostId:null,runtimeId:null,agentSessionId:'4iSNA9U2sBCU'},occurrences:[{regionId:'R6A39kP2s4Bd'},{regionId:'B7C48mQ3t5Ce'}],state:{status:'unknown',issue:{code:'SPACE_SESSION_IDENTITY_UNCONFIRMED',message:'The original member has no confirmed execution Host or Runtime. Its membership and Run reference are retained.'}}}]:[])
api.spaceMounts.sessions=async(_target,emit,signal)=>{sourceChecks++;sessionObservers.add(emit);signal?.addEventListener('abort',()=>sessionObservers.delete(emit),{once:true});queueMicrotask(()=>originalEvents().forEach(observation=>emit({type:'observation',observation})));return{initial:opening,dispose(){sessionObservers.delete(emit)}}}

const name='另一原设备上的独立核查任务'
api.spaceMounts.call=async(method,input)=>{
 if(method==='resources')return{hostId:input.hostId,runtimeId:reference.runtimeId,workspaces:[]}
 if(method==='memberNameInspect')return{target:{runtimeId:input.name.target.runtimeId,kind:'agent-session',id:input.name.target.agentSessionId},current:{override:name,source:'manual',nameRevision:1},record:null,diskAcknowledgement:'not-observed'}
 if(method==='memberNameChange')throw Error('Capture does not mutate original names')
 throw Error('Unsupported original preview read '+method)
}
api.spaceMounts.member=async(input,_listener)=>{
 const hostId=JSON.stringify(['original-member',input.target.runtimeId]),id=JSON.stringify(['original-member',input.target.runtimeId,input.target.agentSessionId])
 const session={...sessions[0],id,hostId,label:'Original foreign fallback',creation:{createOperationId:'source-create-3',initialPrompt:'unknown'},control:{kind:'agent',hostId,agentSessionId:input.target.agentSessionId,run:input.target.expectedRun}}
 return{initial:{id,hostId},dispose(){},async call(method,request){memberCalls.push({method,runtimeId:input.target.runtimeId,agentSessionId:input.target.agentSessionId});if(method==='read')return session;if(method==='conversationRead')return structuredClone(window.__originalForeignConversation);if(method==='conversationWatch')return {hostId:'local',agentSessionId:input.target.agentSessionId,sourceHostId:'local',scope:window.__originalForeignConversation.scope,coverage:window.__originalForeignConversation.coverage,readerId:'original-preview-reader'};if(method==='conversationUnwatch')return;if(method==='conversationRelease')return {hostId:'local',agentSessionId:input.target.agentSessionId,sourceHostId:'local',viewId:window.__originalForeignConversation.window.id,released:true};throw Error('Original bounded conversation preview is not configured: '+method)}}
}
useAppStore.setState({loading:false,initialize:async()=>()=>{},config:{...config,workspaces:[workspace],hosts:[{id:'local',kind:'local',label:'Original local device'}]},sessions,agentNames:Object.fromEntries(sessions.map(s=>[s.id,s.label])),timelines,
 tabs:{[tab.id]:tab},layouts:{[workspace.id]:createWorkspaceLayout('ordinary-group',[tab.id])},activeWorkspaceId:workspace.id,mainSurface:'agents',focusView:'list',toolsOpen:false,projectRailOpen:false,agentFocus:{execution:{sessionId:null,history:[]},pmo:{sessionId:null}},agentComposerDrafts:{working:'原未发送草稿'},mountedSpaceInputs:{[key]:{target,drafts:{}}},mountedSpaceObservations:{},mountedSpaceSessions:{},selectedSpaceMount:null})
createRoot(document.getElementById('root')).render(createElement(App))
window.unifiedFocusProof={ready:true,holdNextCheck(){memberReadMode='pending'},failCheck(){for(const emit of sessionObservers)emit({type:'error',error:{code:'ORIGINAL_METADATA_READER_UNAVAILABLE',message:'The original metadata stream became unavailable while checking. Your saved work is kept.'}})},finishCheck(){memberReadMode='observed';for(const emit of sessionObservers)for(const observation of originalEvents())emit({type:'observation',observation})},sourceChecks(){return sourceChecks},memberCalls,foreignRuntime:'original-other-runtime',localName:sessions[0].label,foreignName:name,localReply,foreignReply:window.__originalForeignBody,foreignInput:window.__originalForeignInput,theme(appAppearance){updateThemeSelection({themeId:'graphite',appAppearance})},facts(){const state=useAppStore.getState();return{selected:state.selectedSpaceMount,source:state.mountedSpaceInputs[key],runs:state.sessions.map(s=>s.control.run),drafts:state.agentComposerDrafts,sourceRegions:snapshot.scope.regions.length}}}
