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
 // A client running inside AgentMux inherits its public journal authority. This
 // fixture owns only this new directory, so bind the constructor explicitly.
 const inherited=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('AGENTMUX_')||key.startsWith('CTXMUX_')))
 const clearScope=()=>{for(const key of Object.keys(process.env))if(key.startsWith('AGENTMUX_')||key.startsWith('CTXMUX_'))delete process.env[key]}
 let client:AgentMuxClient
 try {
  clearScope()
  Object.assign(process.env,{AGENTMUX_MESSAGE_QUEUE_PATH:join(root,'global-messages.ndjson'),
   AGENTMUX_AGENT_SESSION_STORE:store.path,AGENTMUX_STATE_DIRECTORY:join(root,'state'),AGENTMUX_RUNTIME_DIRECTORY:join(root,'runtime')})
  client=new AgentMuxClient({store,controlSocketPath:join(root,'control.sock')})
 } finally {clearScope();Object.assign(process.env,inherited)}
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
 const queuePath=client.agentMessageQueuePath()
 if(queuePath!==join(root,'global-messages.ndjson'))throw new Error('Private FileStore must own the original message journal')
 return {client,store,writes,settle:async()=>{
  const owner=client as unknown as {inputWaitingRecipients:Map<string,{pending:Promise<void>}>}
  await Promise.all([...owner.inputWaitingRecipients.values()].map(value=>value.pending))
 },close:async()=>{await client.dispose();await rm(root,{recursive:true})}}
}
