import {createRoot} from 'react-dom/client'
import type {AgentSessionHistoryPage} from '@agentmux/core'
import type {SessionSnapshot} from '../../../src/shared/contracts'
import {SessionPane} from '../../../src/renderer/src/components/SessionPane'
import {useAppStore} from '../../../src/renderer/src/store'
import {api} from '../../../src/renderer/src/lib/api'
import question from './pending-inputs/question.json'
import permission from './pending-inputs/permission.json'
import unsupported from './pending-inputs/unsupported.json'
import '../../../src/renderer/src/styles/index.css'
import './pending.css'

// These three snapshots come from authenticated production Hook ingress/public Core/Store.
// Browser response, native page and terminal bytes remain controlled; no Agent Run is connected.
type SceneInput={session:Extract<SessionSnapshot,{kind:'agent'}>;config:NonNullable<ReturnType<typeof useAppStore.getState>['config']>;providerCatalog:ReturnType<typeof useAppStore.getState>['providerCatalog'];originalDraft:string}
const params=new URLSearchParams(location.search),kind=params.get('kind')??'question'
const inputs:Record<string,unknown>={question,permission,unsupported}
const input=(inputs[kind]??question) as SceneInput
const session=input.session,id=session.id,readOnly=params.get('readonly')==='1'
const mode=params.get('mode')==='terminal'?'terminal':'activity',reply=params.get('reply')??'pending'
const responses:unknown[]=[],blockedControls:string[]=[],reads:unknown[]=[],paint:string[]=[],copies:string[]=[]
const page:AgentSessionHistoryPage={agentSessionId:id,source:{providerId:session.providerId,nativeSessionId:'controlled-private-native-page'},items:[{id:'user-1',kind:'user-message',contentParts:[{kind:'text',text:'Original native message — keep this text, selection and unsent draft while answering.'}]}],nextCursor:null}
api.sessions.historyPage=async(...args)=>{reads.push(args);return page}
api.sessions.timeline=async()=>({agentSessionId:id,revision:1,items:[]})
api.ui.writeClipboardText=async text=>{copies.push(text)}
api.sessions.respondInteraction=async(control,response)=>{
  responses.push({control,response})
  if(reply==='failure')throw new Error('Private response was not applied. The original request is retained.')
  if(reply==='pending')await new Promise<void>(resolve=>{confirm=resolve})
  const current=useAppStore.getState().sessions[0]
  if(current?.kind==='agent'&&current.pendingInteraction?.id===response.requestId){
    const {pendingInteraction:_request,interactionResponseUnavailableReason:_reason,...confirmed}=current
    useAppStore.setState({sessions:[confirmed]})
  }
}
let confirm:(()=>void)|undefined
for(const name of ['launchAgent','launchTerminal','submitPrompt','write','paste','resume','recover','stop','interrupt','setPosture'] as const){
  api.sessions[name]=async()=>{blockedControls.push(name);throw new Error('Private request scene forbids Agent input/lifecycle')}
}
api.sessions.attach=async()=>{
  paint.push('attach');const data='Controlled terminal paint only. No Agent process is connected.\r\n'
  return{attachmentId:'private-paint',session,currentSize:{cols:80,rows:24},gap:null,terminal:{type:'unknown',reason:'origin_unknown'},resizeRevision:0,replay:[{type:'data',runId:session.control.run.runId,startByte:0,endByte:new TextEncoder().encode(data).byteLength,data,dataBytes:new TextEncoder().encode(data)}]}
}
api.sessions.resize=async(_attachment,cols,rows)=>{paint.push('resize');return{cols,rows}}
api.sessions.detach=async()=>{paint.push('detach')}
api.sessions.onEvent=()=>()=>{}
useAppStore.setState({sessions:[session],providerCatalog:input.providerCatalog,config:input.config,viewModes:{[id]:mode},pendingAgentLaunches:{},recoveryCandidates:[],runtimeOwnershipWarnings:[],agentComposerDrafts:{[id]:input.originalDraft},agentSteerQueues:{},agentSteerInFlight:{},timelines:{},loading:false})
Object.assign(window,{pendingPreview:{input,readOnly,mode,reply,responses,blockedControls,reads,paint,copies,confirm:()=>confirm?.(),switchMode:(next:'terminal'|'activity')=>useAppStore.getState().setViewMode(id,next)}})
createRoot(document.getElementById('root')!).render(<main className="request-preview">
  <div className="request-preview__context"><strong>Current Agent request</strong><span>Actual public producer snapshot · controlled preview input · no Agent Run</span></div>
  <div className="request-preview__pane"><SessionPane sessionId={id} surfaceKind="agent" interactiveResize={false} visible readOnly={readOnly} linkOrigin={{workspaceId:'ws',tabGroupId:'group',regionId:'request-region'}} /></div>
</main>)
