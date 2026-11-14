import { afterEach, expect, it } from 'vitest'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { nodeRuntimeFixture } from './helpers/node-publishing-runtime.js'
import { issueAgentCapability, hashAgentCapability } from '../src/agent-capability.js'
const compiled=process.env.AGENTMUX_NODE_COMPILED_CORE_ROOT!
if(!compiled)throw Error('An explicit private current Core graph is required')
const load=(name:string)=>import(/* @vite-ignore */pathToFileURL(join(compiled,'dist',name+'.js')).href)
const {AgentMuxFileAgentSessionStore}=await load('agent-session-store') as typeof import('../src/agent-session-store.js')
const {connectAgentMuxRpc}=await load('public-rpc-client') as typeof import('../src/public-rpc-client.js')
const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function errorCode(work:Promise<unknown>){try{await work;return null}catch(error){return (error as {code?:string}).code??null}}
async function pair(legacyReceiver=false){
 const worker=resolve(import.meta.dirname,'fixtures/node-operator-core.mjs')
 const previous=process.env.NODE_OPERATOR_LEGACY_NODE_FENCE
 if(legacyReceiver)process.env.NODE_OPERATOR_LEGACY_NODE_FENCE='1'
 const b=await nodeRuntimeFixture(undefined,false,compiled,worker);cleanup.push(()=>b.cleanup())
 if(previous===undefined)delete process.env.NODE_OPERATOR_LEGACY_NODE_FENCE;else process.env.NODE_OPERATOR_LEGACY_NODE_FENCE=previous
 const a=await nodeRuntimeFixture(b,false,compiled,worker);cleanup.push(()=>a.cleanup())
 const store=new AgentMuxFileAgentSessionStore(join(a.stateDirectory,'sessions.json')),capability=issueAgentCapability(),agentSessionId='operator-agent'
 await store.compareAndSwap(null,{kind:'agent',agentSessionId,providerId:'codex',executorId:'codex',hostId:'local',workspacePath:a.root,run:{runId:'retained-original-run'},retiredRuns:[],hookBindingId:'fixture-hook',hookToken:'fixture-hook-token',capabilityHash:hashAgentCapability(capability),createdAt:1,updatedAt:1})
 const credentials={agentSessionId,capability},rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:a.socketPath},credentials});cleanup.push(()=>rpc.dispose())
 const root=join(b.root,'original-root');await mkdir(root)
 const before=await b.rpc.call('settings.node.inspect',{}),policy={alias:'original-b',shareResources:false,allowedPaths:[root],deniedPaths:[join(root,'private')],defaultPath:root}
 const saved=await b.rpc.call('settings.node.configure',{expectedRevision:before.policyRevision,operationId:'original-policy-save',policy})
 return{a,b,rpc,credentials,policy,saved,target:{hostId:'remote-b',expectedRuntimeId:b.owner.runtimeId}}
}
it('a real managed caller reads the exact operator policy through two original Core owners and CLI without publishing or writing',async()=>{
 const f=await pair()
 const input={target:f.target,operationId:'original-policy-save'}
 const reading=await f.rpc.call('settings.node.inspect',input).then(value=>({value}),error=>({value:null,error:{code:error.code,message:error.message}}))
 expect(reading).toMatchObject({value:{node:{runtimeId:f.b.owner.runtimeId},policy:f.policy,operation:{operationId:input.operationId}}})
 expect(await f.rpc.call('node.resources',{hostId:'remote-b',expectedRuntimeId:f.b.owner.runtimeId})).toMatchObject({status:'withheld'})
 const cli=await new Promise<{code:number;stdout:string;stderr:string}>(yes=>{const child=execFile(process.execPath,[join(compiled,'dist/agentmux.js'),'--endpoint','unix:'+f.a.socketPath,'settings','node','inspect','--host','remote-b','--expected-runtime',f.b.owner.runtimeId,'--input','-'],{env:{...f.a.env,AGENTMUX_AGENT_SESSION_ID:f.credentials.agentSessionId,AGENTMUX_AGENT_CAPABILITY:f.credentials.capability},encoding:'utf8'},(e,stdout,stderr)=>yes({code:e?1:0,stdout,stderr}));child.stdin!.end(JSON.stringify({operationId:input.operationId}))})
 expect(cli.code,cli.stderr).toBe(0);expect(JSON.parse(cli.stdout).result.policy).toEqual(f.policy)
 const localBefore=await f.a.rpc.call('settings.node.inspect',{})
 expect(await errorCode(f.rpc.call('settings.node.configure',{expectedRevision:localBefore.policyRevision,operationId:'never-write',policy:{...localBefore.policy,shareResources:true}}))).toBe('CONTROL_PERMISSION_DENIED')
 expect(await errorCode(f.rpc.call('settings.node.resources',{}))).toBe('CONTROL_PERMISSION_DENIED')
 expect((await f.b.rpc.call('settings.node.inspect',{})).policyRevision).toBe(f.saved.policyRevision)
 expect((await f.a.rpc.call('settings.node.inspect',{})).policyRevision).toBe(localBefore.policyRevision)
 const calls=(await readFile(join(f.b.stateDirectory,'calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line))
 expect(calls.filter(x=>x.method==='settings.node.configure')).toHaveLength(1)
 expect(calls.filter(x=>x.method==='settings.node.inspect'&&x.managed)).toHaveLength(0)
 expect(calls.filter(x=>['runtime.bootstrap','runtime.events'].includes(x.method))).toHaveLength(0)
},30000)
it('invalid caller, unconfigured Host and wrong Runtime cannot borrow operator policy',async()=>{
 const f=await pair()
 const bad=await connectAgentMuxRpc({endpoint:{transport:'unix',path:f.a.socketPath},credentials:{...f.credentials,capability:issueAgentCapability()}});cleanup.push(()=>bad.dispose())
 expect(await errorCode(bad.call('settings.node.inspect',{target:f.target}))).toBe('AGENT_CAPABILITY_INVALID')
 expect(await errorCode(f.rpc.call('settings.node.inspect',{target:{...f.target,hostId:'not-saved'}}))).toBe('UNKNOWN_HOST')
 expect(await errorCode(f.rpc.call('settings.node.inspect',{target:{...f.target,expectedRuntimeId:'another-runtime'}}))).toBe('RUNTIME_OWNER_MISMATCH')
 expect((await f.b.rpc.call('settings.node.inspect',{})).policyRevision).toBe(f.saved.policyRevision)
},30000)
it('real limited device transports at ingress and receiving Node remain public-only',async()=>{
 const f=await pair(),address=JSON.parse(await readFile(join(f.a.stateDirectory,'http.json'),'utf8'))
 const device=await connectAgentMuxRpc({endpoint:{transport:'http',url:'http://127.0.0.1:'+address.port,token:'private-device-fixture'},credentials:f.credentials});cleanup.push(()=>device.dispose())
 expect(await errorCode(device.call('settings.node.inspect',{target:f.target}))).toBe('CONTROL_PERMISSION_DENIED')
 expect(await errorCode(f.rpc.call('settings.node.inspect',{target:{...f.target,hostId:'public-b'}}))).toBe('CONTROL_PERMISSION_DENIED')
 expect(await f.rpc.call('node.inspect',{hostId:'public-b',expectedRuntimeId:f.b.owner.runtimeId})).toMatchObject({resourcesShared:false})
 expect((await f.b.rpc.call('settings.node.inspect',{})).policy).toEqual(f.policy)
},30000)
it('actual CLI requires one exact target carrier and rejects identity injection before dispatch',async()=>{
 const f=await pair()
 for(const args of [['--host','remote-b'],['--expected-runtime',f.b.owner.runtimeId],['--host','remote-b','--host','other','--expected-runtime',f.b.owner.runtimeId]]){
  const r=await f.a.cli(['settings','node','inspect',...args]);expect(r.code).not.toBe(0);expect(r.stderr).toContain('INVALID_CLI_ARGUMENT')
 }
 const r=await f.a.cli(['settings','node','inspect','--input','-'],{target:{...f.target,principal:{kind:'user',id:'forged'}}})
 expect(r.code).not.toBe(0);expect(r.stderr).toContain('INVALID_CONTROL_REQUEST')
},30000)
it('a same-Runtime Core restart cannot turn a legacy unfenced Node reply into the original pinned instance',async()=>{
 const f=await pair(true),before=f.b.owner,hold=join(f.a.stateDirectory,'hold-node-inspection')
 await writeFile(hold,'hold')
 const result=errorCode(f.rpc.call('settings.node.inspect',{target:f.target}))
 await expect.poll(()=>readFile(hold+'.ready','utf8').catch(()=>null)).toBe('ready')
 const after=await f.b.restart()
 expect(after.runtimeId).toBe(before.runtimeId);expect(after.ownerInstanceId).not.toBe(before.ownerInstanceId)
 await rm(hold)
 expect(await result).toBe('RUNTIME_OWNER_MISMATCH')
 expect((await f.rpc.call('settings.node.inspect',{target:f.target})).policy).toEqual(f.policy)
 const calls=(await readFile(join(f.b.stateDirectory,'calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line))
 expect(calls.filter(x=>x.method==='settings.node.configure')).toHaveLength(1)
},30000)
