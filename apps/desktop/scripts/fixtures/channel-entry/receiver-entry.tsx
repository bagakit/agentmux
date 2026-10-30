import { api } from '../../../src/renderer/src/lib/api'
import { channelFixture } from './facts'
import type { ConnectionReceiverRecoveryOperation } from '@agentmux/core/connections'
const {proof,connection}=channelFixture
const scene={state:'ended' as 'ended'|'starting'|'recovering'|'ready',longName:false,loseReply:false,refusal:false,operations:new Map<string,ConnectionReceiverRecoveryOperation>()}
Object.assign(proof,{receiver:scene})
const read=api.connections.call
api.connections.call=(async(method:any,input:any,owner:any)=>{
 if(method==='connection.receiver.inspect')return{operation:scene.operations.get(input.operationId)??null,connection:null}
 if(method==='connection.receiver.recover'){
  proof.calls.push(method);proof.requests.push({method,input:structuredClone(input),owner:structuredClone(owner)})
  const operation=scene.operations.get(input.operationId)??{operationId:input.operationId,connectionId:input.connectionId,configurationRevision:input.expectedRevision,receiverRef:input.receiverRef,disposition:'scheduled'}
  scene.operations.set(input.operationId,operation)
  if(scene.loseReply){scene.loseReply=false;throw Error('Controlled lost original recovery reply')}
  scene.state='recovering';return{operation,connection:null}
 }
 const result:any=await read(method,input,owner)
 const receiver={ref:'preview-original-receiver',state:scene.state,...(scene.state==='ended'?{reason:'native-rejected'}:{})}
 const observed={authentication:{state:'ready'},transport:{state:scene.state==='ready'?'ready':scene.state==='ended'?'unavailable':'unknown'},intake:{state:'ready'},delivery:{state:'unknown'}}
 const update=(record:any)=>({...record,receiver,capabilities:{...record.capabilities,receiverRecovery:true},observation:observed})
 if(method==='connection.ls')result.connections=result.connections.map(update)
 if(method==='connection.inspect'&&result.connection)result.connection=update(result.connection)
 if(method==='connection.metadata.get'&&input.subject?.kind==='conversation'&&scene.longName&&result.entry?.observation?.profile)result.entry.observation.profile.name='Research and Engineering · Customer investigation and release planning'
 if(method==='connection.diagnose')for(const group of result.groups.value?.items??[]){
  group.connection.value={revision:1,enabled:true,receiver,...observed}
  group.incoming.value.rows=[{ingressId:'preview-receiver-original-message',sourceConnectionId:connection.config.connectionId,kind:'message',state:scene.refusal?'refused':'claimed',code:scene.refusal?'INGRESS_CONTENT_UNSUPPORTED':null,codeRecorded:scene.refusal,bindingId:group.target.bindingId,bindingRevision:1,targetConnectionId:connection.config.connectionId,scope:'current-binding',inputOperationId:scene.refusal?null:'preview-original-agent-input',recording:{state:'recorded'},coreStatus:scene.refusal?null:'admitted',coreObservation:scene.refusal?'not-started':'observed',nativeAdoption:null,waiting:null}]
 }
 return result
}) as typeof api.connections.call
await import('./entry')
