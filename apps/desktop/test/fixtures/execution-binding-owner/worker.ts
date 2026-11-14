// Private-process test harness. Only endpoint preparation/Native leaves and the
// Runtime routing port are controlled; all owner, RPC, IPC and preload code is real.
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { AgentExecutionBindingService, type AgentExecutionHostPort } from '../../../../../packages/core/src/agent-execution-coordinator'
import { AgentMuxError } from '../../../../../packages/core/src/errors'
import { AgentMuxControlServer } from '../../../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../../../packages/core/src/public-rpc-client'
import { AgentMuxSpatialStateStore } from '../../../../../packages/core/src/spatial-state'
import { createWorkspaceLayout } from '../../../../../packages/core/src/spatial-layout'
import { createDesktopExecutionBindings } from '../../../src/main/desktop-execution-bindings'
import { registerExecutionBindingIpc } from '../../../src/main/execution-binding-ipc'
import { createExecutionBindingApi } from '../../../src/preload/execution-binding'
const [mode, directory] = process.argv.slice(2), socket = join(directory!, 'core.sock')
let prepares = 0, starts = 0, agents = 0
const input = { bindingId: 'original-binding', agentHostId: 'agent-host', agentRuntimeId: 'agent-core', resourceHostId: 'resource-host', resourceRuntimeId: 'resource-core', resourceWorkspacePath: '/original/project', resourceGrant: { scope: 'host-user' as const, bindingId: 'original-binding' }, agent: {agentSessionId:'original-sid',createOperationId:'original-cid',executorId:'selected',executorRevision:'frozen-revision',workspacePath:'/original/agent',prompt:'original unsent input'} }
const host = { readAgentSession: async () => null, listHostExecutors: async () => ({executors:[{executorId:'selected',configRevision:'frozen-revision'}]}), prepareAgentExecutionHelper: async () => { prepares++; throw new AgentMuxError('Controlled preparation leaf; no Native or input submitted.', 'EXECUTION_HELPER_UNAVAILABLE') }, createPreparedTerminal: async () => {starts++; throw Error('Unexpected Start')}, createHostAgentWithDelivery: async () => {agents++; throw Error('Unexpected Agent create')} } as unknown as AgentExecutionHostPort
const spatial = new AgentMuxSpatialStateStore(join(directory!, 'spatial.json'))
let close: () => Promise<void>, command: (name:string,value:any)=>Promise<any>
if(mode==='core') {
 const service = new AgentExecutionBindingService(join(directory!, 'execution-bindings'), {resolveHost:async id=>({runtimeId:id==='agent-host'?'agent-core':'resource-core',client:host})})
 const server = new AgentMuxControlServer({socketPath:socket,executionBindings:service,spatialState:spatial,coreClients:()=>[]}); await server.start()
 command=async(name,value)=> {
  if(name==='seed') {if(await spatial.read())throw Error('Refuse reseed'); return spatial.commit({expectedRevision:0,graph:{spaces:[{spaceId:'space',kind:'topic',name:'Original',hostId:'local',directoryPath:'/original/project',projectId:'project'}],zones:[{zoneId:'zone',workspaceId:'space',kind:'directory',hostId:'local',directoryPath:'/original/project',branch:null}],tabs:[{tabId:'original-tab',zoneId:'zone',workspaceId:'space',name:null,regionIds:['original-region']}],regions:[{regionId:'original-region',tabId:'original-tab',kind:'agent',agentSessionId:'original-sid',runId:null,execution:{hostId:'agent-host',cwd:'/original/agent'}}],bindings:[{zoneId:'zone',spaceId:'space'}],layouts:{space:createWorkspaceLayout('original-group',['original-tab'])},tabLayouts:{'original-tab':{root:{type:'leaf',regionId:'original-region'},activeRegionId:'original-region'}},resources:{'original-tab':{draft:'retained spatial resource draft'}}}})}
  if(name==='freeze')return service.create(input)
  if(name==='facts')return {pid:process.pid,prepares,starts,agents,spatial:await spatial.read()}
  if(name==='inspect')return service.inspect(input.bindingId,'association')
  throw Error(name)
 }
 close=async()=>{await server.stop();await service.dispose()}
} else {
 const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:socket}})
 const runtime={callOriginalCore:async(_host:string,method:any,params:any,context:any)=>rpc.call(method,params,context),subscribeOriginalCore:async(_host:string,method:any,params:any,handlers:any,context:any)=>rpc.subscribe(method,params,{...handlers,...(context.signal?{signal:context.signal}:{})})}
 const transport=createDesktopExecutionBindings(runtime as never)
 const handlers=new Map<string,Function>(),events=new EventEmitter(),sender=Object.assign(new EventEmitter(),{isDestroyed:()=>false,send:(channel:string,value:unknown)=>events.emit(channel,{},value)})
 registerExecutionBindingIpc({handle:(channel,fn)=>{handlers.set(channel,fn)},bindings:transport.bindings,readers:transport.readers,coordinatorTarget:async()=>({hostId:'local',runtimeId:'original-core'}),coordinator:async()=>{},project:async()=>{throw Error('Unexpected projection')}})
 const preload=createExecutionBindingApi({invoke:async(channel:string,...args:unknown[])=>{const fn=handlers.get(channel);if(!fn)throw Error(channel);return fn({sender},...args)},on:(channel:string,fn:any)=>{events.on(channel,fn)},off:(channel:string,fn:any)=>{events.off(channel,fn)}} as never)
 const observations:unknown[]=[],errors:string[]=[],readers=new Map<string,()=>void>()
 command=async(name,value)=>{
  if(name==='create')return transport.bindings.create(value??input)
  if(name==='inspect')return preload.executionBinding(input.bindingId,'association')
  if(name==='watch'){readers.set(value??'first',preload.observeExecutionBinding(input.bindingId,v=>observations.push(v),e=>errors.push(e)));return true}
  if(name==='release'){readers.get(value??'first')?.();readers.delete(value??'first');return true}
  if(name==='facts')return {pid:process.pid,observations,errors}
  throw Error(name)
 }
 close=async()=>{for(const dispose of readers.values())dispose();transport.dispose();await rpc.dispose()}
}
process.on('message',async(raw:any)=>{try {if(raw.name==='close'){await close();process.send?.({id:raw.id,result:true});process.disconnect();return} const result=await command(raw.name,raw.value);process.send?.({id:raw.id,result})}catch(error:any){process.send?.({id:raw.id,error:{code:error.code,message:error.message,executionFailure:error.executionFailure}})}})
process.send?.({ready:true,pid:process.pid,input})
