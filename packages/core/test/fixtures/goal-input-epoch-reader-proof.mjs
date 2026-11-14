import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { assertSpaceMemberCall } from '../../src/space-member-codec.ts'
import { encodeHostedValue } from '../../src/hosted-value.ts'
import { AgentMuxClient, AgentMuxMemoryAgentSessionStore, AgentMuxHostedRuntimeService, AgentMuxControlServer, connectAgentMuxRpc, AgentMuxRpcService, connectSpaceMember, parseGoalInputEpoch, parseGoalInputEpochInput } from '../../src/index.ts'
import { readGoalInputEpoch } from '../../../../apps/host/src/goal-finite-runtime.ts'
import { parseAgentMuxCliInvocation } from '../../src/agentmux-cli-commands.ts'
const cp=createRequire(import.meta.url)('node:child_process'), actualFork=cp.fork
cp.fork=(path,args,options)=>actualFork(String(path).endsWith('/control-endpoint-listener-worker.js')?process.env.AGENTMUX_SOURCE_LISTENER_ASSET:path,args,options);syncBuiltinESMExports()
let server,rpc;const directory=await mkdtemp(join(tmpdir(),'amux-goal-reader-'))
const target={kind:'conversation',reference:{runtimeId:'source',spaceId:'space'},regionId:'region',runtimeId:'execution',agentSessionId:'sid',expectedAdmission:{kind:'creation',operationId:'cid'}}
const call=method=>({method:'runtime.invoke',params:{fence:{runtimeId:'execution',ownerInstanceId:'instance'},consumerId:'consumer',invocation:encodeHostedValue({method,args:method==='readAgentInputEpoch'?[]:['sid']})}})
assert.doesNotThrow(()=>assertSpaceMemberCall(target,call('readAgentInputEpoch'),false),'exact conversation-only namespace reader remains usable')
assert.throws(()=>assertSpaceMemberCall(target,call('readAgentSession'),false),'namespace reader cannot open full Session metadata')
assert.throws(()=>assertSpaceMemberCall(target,call('submitAgentPrompt'),false),'namespace reader cannot grant input')
const wrong=call('readAgentInputEpoch');wrong.params.fence.runtimeId='another';assert.throws(()=>assertSpaceMemberCall(target,wrong,false))
const store=new AgentMuxMemoryAgentSessionStore();let reads=0;store.readInputEpoch=async()=>{reads++;return'E1'}
const client=new AgentMuxClient({store}),owner={runtimeId:'execution',ownerInstanceId:'instance',protocolVersion:2,processId:process.pid,availability:'connected',ctxmux:null}
const hosted=new AgentMuxHostedRuntimeService(client,'/not-opened',()=>owner),calls=[]
try{
 const member=await connectSpaceMember({call:async(method,params)=>{calls.push(method);assertSpaceMemberCall(target,params.call,false);return hosted.call(params.call.method,params.call.params)},subscribe:async()=>assert.fail('pure reader does not subscribe')},target)
 assert.equal(await member.readAgentInputEpoch(),'E1','actual Hosted SDK consumer reads original namespace without Run');await member.dispose()
 const reference={kind:'space-member',source:{runtimeId:'source',spaceId:'space',regionId:'region',admission:{kind:'creation',operationId:'cid'}},execution:{runtimeId:'execution',agentSessionId:'sid'}}
 const params=parseGoalInputEpochInput({agentReference:reference,access:{source:{hostId:'local'}}})
 const catalog={regions:[{regionId:'region',tabId:'tab',creationOperationId:'cid',agentSessionId:'sid',execution:{runtimeId:'execution'}}],tabs:[{tabId:'tab',zoneId:'zone'}],bindings:[{spaceId:'space',zoneId:'zone'}]}
 const sourceRuntime={server:{callRpc:async(method,input)=>{
  calls.push(method)
  if(method==='runtime.owner.identity')return{owner:{...owner,runtimeId:'source'}}
  if(method==='space.inspect')return input.target.operationId?{request:{known:true,report:{outcome:'opened',to:{spaceId:'space',regionId:'region'},association:{operationId:'association',resource:{runtimeId:'source'},reference:{runtimeId:'execution',binding:{agentSessionId:'sid'}}}}}}:{catalog}
  assert.equal(method,'space.member.call');assertSpaceMemberCall(input.target,input.call,false);return hosted.call(input.call.method,input.call.params)
 }}}
 const options={runtime:()=>sourceRuntime,clients:()=>[]},context={principal:{kind:'user',id:'person'}}
 const service=new AgentMuxRpcService({coreClients:()=>[],goalInputEpoch:(input,ctx)=>readGoalInputEpoch(options,input,ctx)})
 const result=await service.call('goal.input.epoch',params,context);assert.deepEqual(result,{runtimeId:'execution',inputEpoch:'E1'},'actual public Goal owner uses the original no-Run carrier')
 assert.throws(()=>parseGoalInputEpoch({...result,runtimeId:'another'},params),'Goal reader refuses a different Runtime pin');assert.throws(()=>parseGoalInputEpoch({...result,inputEpoch:undefined},params));assert.throws(()=>parseGoalInputEpochInput({agentReference:'sid',access:params.access}))
 const before=reads;await assert.rejects(()=>service.call('goal.input.epoch',{...params,agentReference:{...reference,source:{...reference.source,admission:{kind:'creation',operationId:'different'}}}},context));assert.equal(reads,before,'wrong source cannot consult another namespace')
 const association={...reference,source:{...reference.source,admission:{kind:'association',operationId:'association'}}}
 await assert.rejects(()=>service.call('goal.input.epoch',{...params,agentReference:association},context),'association cannot borrow Source authority for its Coordinator')
 const peer={forwardRpc:async(method,input)=>{calls.push(method);return hosted.call(method,input)},subscribeRpc:async()=>assert.fail('metadata does not subscribe')}
 const independent=new AgentMuxRpcService({coreClients:()=>[],goalInputEpoch:(input,ctx)=>readGoalInputEpoch({runtime:()=>sourceRuntime,clients:()=>[{hostId:'coordinator',client:peer}]},input,ctx)})
 assert.deepEqual(await independent.call('goal.input.epoch',{agentReference:association,access:{source:{hostId:'local'},coordinator:{hostId:'coordinator'}}},context),result,'independent Coordinator keeps its original namespace authority')
 const cli=await parseAgentMuxCliInvocation(['goal','input','epoch','--agent-ref',JSON.stringify(reference),'--access',JSON.stringify(params.access)]);assert.equal(cli.command.method,'goal.input.epoch');assert.deepEqual(cli.params,params,'CLI freezes the exact same typed read selectors')
 server=new AgentMuxControlServer({socketPath:join(directory,'control.sock'),coreClients:()=>[],goalInputEpoch:(input,ctx)=>readGoalInputEpoch(options,input,ctx)})
 await server.start();rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}})
 assert.deepEqual(await rpc.call('goal.input.epoch',params),result,'actual Unix RPC consumes the typed Goal input reader')
 const env={...process.env};for(const key of Object.keys(env))if(/^(AGENTMUX_|CTXMUX_)/u.test(key)&&!/^AGENTMUX_SOURCE_/u.test(key))delete env[key]
 const cliProcess=spawn(process.execPath,['--import',fileURLToPath(new URL('../../scripts/helpers/core-source-loader.mjs',import.meta.url)),fileURLToPath(new URL('../../src/agentmux.ts',import.meta.url)),'--endpoint','unix:'+server.path,'goal','input','epoch','--agent-ref',JSON.stringify(reference),'--access',JSON.stringify(params.access)],{env,stdio:['ignore','pipe','pipe']})
 let stdout='',stderr='';cliProcess.stdout.on('data',data=>stdout+=data);cliProcess.stderr.on('data',data=>stderr+=data)
 const status=await new Promise(resolve=>cliProcess.on('exit',resolve));assert.equal(status,0,stderr);assert.deepEqual(JSON.parse(stdout),{ok:true,operation:'goal.input.epoch',result},'actual source CLI consumes the original typed Goal input reader')
 assert.ok(calls.length>0);assert.ok(!calls.some(method=>method.includes('watch')||method.includes('bootstrap')),'reader opens no Session subscription or Run observation')
 console.log('GOAL_INPUT_EPOCH_READER_PASS: actual public/CLI/Host/Hosted pure reader; creation and independent association; pinned source, no raw SID, no input/Run/subscription/Native')
}finally{await rpc?.dispose();await server?.stop();await hosted.dispose();await client.dispose();await rm(directory,{recursive:true,force:true})}
