import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { agentOperationKey } from '../../../src/renderer/src/lib/agent-operation'
import { checkpointAgentOperations } from '../../../src/renderer/src/store'
import { restorePersistedWorkbench } from '../../../src/renderer/src/lib/workbench-persistence'

// Only the original owner IO is a typed preview leaf. The actual operation
// consumer, cancellation parser, writer, copy controls and confirmation remain.
export async function prepareTakeoverFeedback({ api, useAppStore, workspace, sessions, tab }) {
 const owner={runtimeId:'original-spatial-owner',ownerInstanceId:'original-owner-instance'}
 const operationId='takeover:opaque-original-request-'+('original-reference-'.repeat(9))
 const request={operationId,focus:false,destination:{spaceId:'destination-space',zoneId:'destination-zone',displayWorkspaceId:workspace.id,groupId:'ordinary-group',newTab:true},content:{kind:'takeover-agent',executorId:'codex',source:{hostId:'local',agentSessionId:'working',expectedRun:sessions[0].control.run,organization:{runtimeId:owner.runtimeId,spaceId:'original-project-space'}}}}
 const operation={kind:'takeover',operationId,phase:'unconfirmed',startedAt:1,subject:{hostId:'local',agentSessionId:'working',regionId:'ordinary-region'},message:'原接手请求已保留，检查尚未返回准确结果。',takeoverSource:{kind:'session',hostId:'local',cwd:workspace.path,agentSessionId:'working',presentationSessionId:'working',expectedRun:sessions[0].control.run,executorId:'codex',label:sessions[0].label,diagnostic:'',coreRuntimeId:owner.runtimeId,coreRequest:request,origin:{workspaceId:workspace.id,tabGroupId:'ordinary-group',tabId:tab.id,regionId:'ordinary-region'}}}
 const neighbor={...operation,operationId:'takeover:adjacent-original',subject:{hostId:'local',agentSessionId:'reading'},takeoverSource:{...operation.takeoverSource,agentSessionId:'reading',presentationSessionId:'reading',expectedRun:sessions[1].control.run,label:sessions[1].label,coreRequest:{...request,operationId:'takeover:adjacent-original',content:{...request.content,source:{...request.content.source,agentSessionId:'reading',expectedRun:sessions[1].control.run}}}}}
 const key=agentOperationKey(operation),calls=[],copied=[]
 const created={...sessions[0],id:'created-takeover-agent',label:'接手核对发布版本与业务数据并继续原分析任务的 Agent',control:{kind:'agent',hostId:'local',agentSessionId:'created-takeover-agent',run:{runId:'created-takeover-run'}}}
 const createdTab=createWorkbenchTab('created-takeover-tab',{regionId:'created-takeover-region',workspaceId:workspace.id,kind:'agent',phase:'attached',sessionId:created.id})
 const to={workspaceId:workspace.id,spaceId:'destination-space',zoneId:'destination-zone',displayWorkspaceId:workspace.id,groupId:'ordinary-group',tabId:createdTab.id,regionId:'created-takeover-region'}
 let outcome='unconfirmed',durability='unconfirmed',pendingResolve,checks=0
 const result=input=>({owner,operationId:input.operationId,createOperationId:input.request.operationId,cancellationAdmission:'observed',outcome,agent:outcome==='created'?{agentSessionId:created.control.agentSessionId,run:created.control.run,hostId:'local',runtimeId:'created-execution-runtime'}:null,to:outcome==='created'?to:null,initialInput:outcome==='created'?'already-dispatched':'held',diskDurability:durability,issue:outcome==='unconfirmed'?'原取消请求已保留；本次检查尚未确认原 Owner 的业务结果。':null})
 api.spatial.owner=async()=>({owner})
 api.sessions.owner=async()=>({owner:{runtimeId:'created-execution-runtime',ownerInstanceId:'created-execution-instance'}})
 api.sessions.takeoverCancel=async input=>{calls.push({method:'cancel',input:structuredClone(input)});await new Promise(resolve=>{pendingResolve=resolve});return result(input)}
 api.sessions.takeoverCancelInspect=async input=>{checks++;calls.push({method:'inspect',input:structuredClone(input)});return result(input)}
 api.spatial.openAgent=async input=>{calls.push({method:'open',input});throw Error('No open is authorized by this capture')}
 api.sessions.send=async input=>{calls.push({method:'send',input});throw Error('No send is authorized by this capture')}
 api.sessions.stop=async input=>{calls.push({method:'stop',input});throw Error('Capture never confirms Stop')}
 api.ui.writeClipboardText=async text=>{copied.push(text)}
 api.ui.requestStorageFlush=async()=>{}
 useAppStore.setState({sessions:[...sessions,created],refreshSpatialState:async()=>{}})
 if(!window.__feedbackRestoreSerialized)useAppStore.setState({mountedSpaceInputs:{},mountedSpaceObservations:{},mountedSpaceSessions:{},agentOperations:{[key]:operation,[agentOperationKey(neighbor)]:neighbor},sessions:[...sessions,created],refreshSpatialState:async()=>{},tabs:{[tab.id]:tab,[createdTab.id]:createdTab},layouts:{[workspace.id]:createWorkspaceLayout('ordinary-group',[tab.id,createdTab.id])}})
 globalThis.__feedbackSpatialGraph={regions:[{tabId:to.tabId,regionId:to.regionId,agentSessionId:created.control.agentSessionId,execution:{hostId:'local',runtimeId:'created-execution-runtime'}}]}
 if(window.__feedbackRestoreSerialized)localStorage.setItem('agentmux-workbench-v1',window.__feedbackRestoreSerialized)
 await useAppStore.persist.rehydrate()
 if(window.__feedbackRestoreSerialized){const state=useAppStore.getState();useAppStore.setState({...restorePersistedWorkbench({config:state.config,sessions:state.sessions,persisted:state.restoredWorkbench,createTabGroupId:()=>{throw Error('Original group must be retained')},retiredSessionIds:new Set()}),restoredWorkbench:null})}
 globalThis.__feedbackAdmitWriter()
 const held=()=>useAppStore.getState().agentOperations[key]
 window.takeoverFeedbackProof={ready:true,calls,copied,key,operationId,checks:()=>checks,
  complete(next='unconfirmed',save='unconfirmed'){outcome=next;durability=save;pendingResolve?.();pendingResolve=undefined},
  observe(next,save='unconfirmed'){outcome=next;durability=save},
  async checkpoint(){await checkpointAgentOperations();return localStorage.getItem('agentmux-workbench-v1')},
  facts(){const s=useAppStore.getState();return{operation:held(),tabs:s.tabs,layouts:s.layouts,drafts:s.agentComposerDrafts,runs:s.sessions.map(x=>x.control.run),calls:structuredClone(calls),copied:[...copied]}},
  async restore(serialized){
   localStorage.setItem('agentmux-workbench-v1',serialized)
   // This is the original persist merge followed by the exact startup topology
   // restoration function. No operation, draft, Tab or layout is seeded here.
   await useAppStore.persist.rehydrate()
   const state=useAppStore.getState(),restored=restorePersistedWorkbench({config:state.config,sessions:state.sessions,persisted:state.restoredWorkbench,createTabGroupId:()=>{throw Error('Original group must be retained')},retiredSessionIds:new Set()})
   useAppStore.setState({...restored,restoredWorkbench:null})
   return this.facts()
  }
 }
}
