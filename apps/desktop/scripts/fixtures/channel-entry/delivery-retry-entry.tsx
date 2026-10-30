import type { ConnectionDelivery, ConnectionDeliveryContinuation, ConnectionDeliveryRetrySource } from '@agentmux/core/connections'
import { deliveryFacts } from '@agentmux/core/connections'
import { api } from '../../../src/renderer/src/lib/api'
import { channelFixture } from './facts'
import { retainConnectorRoomIntent } from '../../../src/renderer/src/store'
const { proof, connection, target }=channelFixture
const scene={active:false,mode:'message' as 'message'|'upload'|'unknown',state:'not-applied' as ConnectionDelivery['state'],loseReply:false,extraUnknown:false,
  sourceOverride:null as ConnectionDeliveryRetrySource|null,continuation:null as ConnectionDeliveryContinuation|null,bindingId:'',bindingRevision:1,room:'',operations:new Map<string,ConnectionDeliveryContinuation>()}
Object.assign(scene,{submit:async(source:ConnectionDeliveryRetrySource)=>retainConnectorRoomIntent({method:'connection.delivery.retry',input:{operationId:'preview-original-delivery',source},target,hostingTarget:channelFixture.hostingTarget,phase:'may-have-dispatched'})})
Object.assign(proof,{deliveryRetry:scene})
function delivery(operationId='preview-original-delivery'):ConnectionDelivery{
 const unknown=scene.mode==='unknown'||operationId==='preview-unknown-message',confirmed=scene.state==='confirmed'&&!unknown
 const retrySource=unknown||confirmed?undefined:scene.sourceOverride??(scene.continuation?undefined:{kind:scene.mode==='upload'?'content-upload' as const:'message' as const,attempt:1})
 return{operationId,projectionId:'preview-original-projection',sourceRevision:'preview-source',bindingId:scene.bindingId,bindingRevision:scene.bindingRevision,
  reference:{hostId:target.executionHostId,agentSessionId:target.agentSessionId,source:{kind:'captured',recordId:operationId}},target:{connectionId:connection.config.connectionId,application:connection.config.application,externalConversationId:scene.room},effect:'upsert',fragment:{ordinal:0,count:1},
  state:unknown?'unknown':scene.state,...(retrySource?{retrySource}:{}),...(scene.continuation&&!unknown?{lastContinuation:scene.continuation}:{}),
  ...(confirmed?{receipt:{state:'confirmed' as const,mapping:{messageId:'preview-platform-message'}}}:unknown?{receipt:{state:'unknown' as const,reason:'effect-unconfirmed' as const}}:scene.state==='not-applied'&&scene.mode!=='upload'?{receipt:{state:'not-applied' as const,reason:'rate-limited' as const}}:{})}
}
const original=api.connections.call
api.connections.call=(async(method:any,input:any,owner:any)=>{
 if(method==='connection.delivery.inspect'){proof.calls.push(method);proof.requests.push({method,input:structuredClone(input),owner:structuredClone(owner)});return{delivery:delivery(input.operationId)}}
 if(method==='connection.delivery.retry'){
  proof.calls.push(method);proof.requests.push({method,input:structuredClone(input),owner:structuredClone(owner)})
  const key=JSON.stringify(input),continuation=scene.operations.get(key)??{source:structuredClone(input.source),acceptedAt:Date.now()}
  scene.operations.set(key,continuation);scene.continuation=continuation;scene.state='pending'
  if(scene.loseReply){scene.loseReply=false;throw Error('Controlled original retry reply lost')}
  return{delivery:delivery(input.operationId),continuation}
 }
 const result:any=await original(method,input,owner)
 if(method==='connection.diagnose')for(const group of result.groups.value?.items??[]){
  scene.bindingId=group.target.bindingId;scene.bindingRevision=group.target.publicationRevision;scene.room=group.target.externalConversationId
  if(!scene.active)continue
  group.connection.value={...group.connection.value,receiver:{ref:'preview-receiver',state:'ready'},transport:{state:'ready'},intake:{state:'ready'}}
  group.outgoing.value.deliveries=[deliveryFacts(delivery()),...(scene.extraUnknown?[deliveryFacts(delivery('preview-unknown-message'))]:[])]
 }
 return result
}) as typeof api.connections.call
await import('./entry')
