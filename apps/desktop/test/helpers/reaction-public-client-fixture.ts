import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '@agentmux/core'

/** The public Client and durable FileStore are real; only PTY transport is a deterministic adapter. */
export async function reactionPublicClientFixture(id: string, runId: string) {
 const root=await mkdtemp(join(tmpdir(),'amux-reaction-client-'))
 const store=new AgentMuxFileAgentSessionStore(join(root,'sessions.json'))
 await store.compareAndSwap(null,{kind:'agent',agentSessionId:id,providerId:'traex',executorId:'traex',hostId:'local',workspacePath:root,
  run:{runId},retiredRuns:[],hookBindingId:'reaction-binding',hookToken:'reaction-token',createdAt:1,updatedAt:1})
 const client=new AgentMuxClient({store})
 const internal=client as unknown as {kernel:Record<string,unknown>;registry:{load(host:string):Promise<void>};connected:boolean}
 await internal.registry.load('local')
 let cursor=0
 const writes:string[]=[]
 const applied=new Map<string,{data:string;range:{startByte:number;endByte:number}}>()
 const run=()=>({nativeService:null,runId,lifecycleOperationId:null,program:'traex',args:[],workspacePath:root,pid:999,state:{type:'running'},cols:80,rows:24,latestOutputBytes:0,firstAvailableByte:0,acceptedInputBytes:cursor})
 internal.kernel.isConnected=()=>true
 internal.kernel.identity=()=>({daemonInstanceId:'reaction-adapter',protocolVersion:1,buildIdentity:'private-adapter'})
 internal.kernel.status=async()=>run()
 internal.kernel.input=async(_id:string,op:{operationId:string;expectedByte:number;data:string})=>{
  const previous=applied.get(op.operationId)
  if(previous){if(previous.data!==op.data)throw new Error('Input identity changed');return {run:run(),appliedByteRange:previous.range}}
  writes.push(op.data);const range={startByte:op.expectedByte,endByte:op.expectedByte+Buffer.byteLength(op.data)};cursor=range.endByte;applied.set(op.operationId,{data:op.data,range})
  return {run:run(),appliedByteRange:range}
 }
 internal.connected=true
 return {client,store,writes,close:async()=>{await client.dispose();await rm(root,{recursive:true})}}
}
