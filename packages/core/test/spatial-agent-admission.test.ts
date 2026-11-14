import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { sourceCreationFixture } from './helpers/source-creation-fixture.js'
import { AgentMuxError } from '@agentmux/core'
import type { AgentExecutionInspection } from '../src/agent-execution-coordinator.js'
import { rpcControlRequest } from '../src/rpc-business-codec.js'
import { spatialAgentOpenDigest, spatialAgentOpenRecord } from '../src/spatial-agent-open.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
const releases: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of releases.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const fixture = () => sourceCreationFixture(releases, 'Original Source context', { realBindings: true })
function reference(f: Awaited<ReturnType<typeof fixture>>) {
 return { bindingId: createHash('sha256').update(JSON.stringify(['runtime-b','D-in-B','original-d-session',f.input.operationId])).digest('hex'),agentSessionId:'original-d-session',createOperationId:f.input.operationId }
}
function noCurrentConfiguration(f: Awaited<ReturnType<typeof fixture>>) {
 f.client.listHostExecutors.mockRejectedValue(Error('Current inventory must not replace frozen input.'))
 f.client.hostEnvironment.mockRejectedValue(Error('Current home must not replace frozen cwd.'))
 f.sourceNote.mockRejectedValue(Error('Current note must not replace frozen Source context.'))
}
function request(f: Awaited<ReturnType<typeof fixture>>) {
 const value=rpcControlRequest('agent.open',f.input)
 if(value.operation!=='agent.open'||value.content.kind!=='new-agent')throw Error('Original new-Agent request required')
 return value
}
it('a refused Core admission leaves no Source placement, frozen intent or first effect',async()=>{
 const f=await fixture(),before=await readFile(f.spatial.path,'utf8')
 f.bindings.admit.mockRejectedValueOnce(new AgentMuxError('The original execution coordinator already has a writer.','EXECUTION_OWNER_UNAVAILABLE'))
 await expect(f.rpc.call('agent.open',f.input)).rejects.toMatchObject({code:'EXECUTION_OWNER_UNAVAILABLE'})
 expect(await readFile(f.spatial.path,'utf8')).toBe(before)
 expect(spatialAgentOpenRecord((await f.spatial.read())!.graph,f.input.operationId)).toBeNull()
 expect(await f.bindings.inspect(reference(f).bindingId,'association')).toBeNull()
 expect(f.bindings.continueOriginal).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();expect(f.starts).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();expect(f.agentInput).not.toHaveBeenCalled()
})
it('a lost durable Core admission ACK recovers through original witness before current configuration, including owner reopen',async()=>{
 const f=await fixture(),admit=f.bindings.admit.getMockImplementation()!
 f.bindings.admit.mockImplementationOnce(async input=>{await admit(input);throw Error('Core admission ACK lost')})
 await expect(f.rpc.call('agent.open',f.input)).rejects.toThrow('Core admission ACK lost')
 expect(spatialAgentOpenRecord((await f.spatial.read())!.graph,f.input.operationId)).toBeNull();expect(f.prepare).not.toHaveBeenCalled()
 const key=reference(f),frozen=await f.bindings.inspect(key.bindingId,'association')
 expect(frozen?.association).toMatchObject({state:'confirmed',reference:key,sourceRequestDigest:spatialAgentOpenDigest(request(f)),agent:{executorId:'d-executor',executorRevision:'d'.repeat(64),workspacePath:'/d/home'}})
 expect(JSON.stringify(frozen)).not.toContain('Original Source context')
 noCurrentConfiguration(f);await f.restartBindings()
 const cli=await runSourceObjectCli(['--endpoint','unix:'+f.server.path,'agent','open','--executor','d-executor','--agent-host','D-in-B','--agent-runtime','runtime-d','--space',f.folder.spaceId,'--zone',f.folder.zoneId,'--new-tab','--operation-id',f.input.operationId],objectCliEnvironment(f.root),'',15000,process.env.T012_CLI_LOADER?new URL(process.env.T012_CLI_LOADER):undefined)
 expect(cli.code,cli.stderr+'\n'+cli.stdout).toBe(1) // successful read with business-unknown outcome
 expect(cli.stdout,cli.stderr).not.toBe('')
 expect(JSON.parse(cli.stdout)).toMatchObject({ok:true,result:{outcome:'unknown',execution:{reference:key},issues:expect.arrayContaining([expect.objectContaining({step:'creation',code:'EXECUTION_HELPER_UNAVAILABLE'})])}})
 const record=spatialAgentOpenRecord((await f.spatial.read())!.graph,f.input.operationId)!
 expect(record.executionBinding).toEqual(key);expect(record.execution).toMatchObject({workspacePath:'/d/home',executorRevision:'d'.repeat(64)});expect(record.placement).toMatchObject({runtimeId:'runtime-b',workspacePath:'/b/project'})
 expect(f.bindings.admit).toHaveBeenCalledOnce();expect(f.bindings.create).not.toHaveBeenCalled();expect(f.bindings.continueOriginal).toHaveBeenCalledExactlyOnceWith(key,expect.anything())
 expect(f.client.listHostExecutors).toHaveBeenCalledOnce();expect(f.client.hostEnvironment).toHaveBeenCalledOnce();expect(f.sourceNote).toHaveBeenCalledOnce()
 expect(f.prepare).toHaveBeenCalledOnce();expect(f.starts).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled();expect(f.agentInput).not.toHaveBeenCalled()
})
it('a lost Source placement ACK leaves the frozen original request recoverable without another admission or current note',async()=>{
 const f=await fixture(),save=f.spatial.admitAgentOpen.bind(f.spatial)
 vi.spyOn(f.spatial,'admitAgentOpen').mockImplementationOnce(async input=>{await save(input);throw Error('Source placement ACK lost')})
 await expect(f.rpc.call('agent.open',f.input)).rejects.toThrow('Source placement ACK lost')
 const record=spatialAgentOpenRecord((await f.spatial.read())!.graph,f.input.operationId)!
 expect(record.executionBinding).toEqual(reference(f));expect(f.prepare).not.toHaveBeenCalled();expect(f.bindings.continueOriginal).not.toHaveBeenCalled()
 noCurrentConfiguration(f);await f.restartBindings()
 await expect(f.rpc.call('agent.open',f.input)).resolves.toMatchObject({outcome:'unknown',execution:{reference:record.executionBinding}})
 expect(spatialAgentOpenRecord((await f.spatial.read())!.graph,f.input.operationId)).toEqual(record)
 expect(f.bindings.admit).toHaveBeenCalledOnce();expect(f.bindings.continueOriginal).toHaveBeenCalledExactlyOnceWith(record.executionBinding,expect.anything())
 expect(f.sourceNote).toHaveBeenCalledOnce();expect(f.prepare).toHaveBeenCalledOnce();expect(f.starts).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled()
})
it('the retained Core request digest rejects a changed same-CID request before any Source admission or current discovery',async()=>{
 const f=await fixture(),admit=f.bindings.admit.getMockImplementation()!
 f.bindings.admit.mockImplementationOnce(async input=>{await admit(input);throw Error('Core admission ACK lost')})
 await expect(f.rpc.call('agent.open',f.input)).rejects.toThrow('Core admission ACK lost')
 const before=await readFile(f.spatial.path,'utf8'),original=await f.bindings.inspect(reference(f).bindingId,'association')
 noCurrentConfiguration(f)
 await expect(f.rpc.call('agent.open',{...f.input,content:{...f.input.content,prompt:'different same-CID request'}})).rejects.toMatchObject({code:'EXECUTION_INTENT_UNCONFIRMED'})
 expect(await readFile(f.spatial.path,'utf8')).toBe(before);expect(await f.bindings.inspect(reference(f).bindingId,'association')).toEqual(original)
 expect(f.bindings.admit).toHaveBeenCalledOnce();expect(f.bindings.continueOriginal).not.toHaveBeenCalled();expect(f.sourceNote).toHaveBeenCalledOnce();expect(f.prepare).not.toHaveBeenCalled()
})
it('an old frozen intent without the Source request digest stays unknown and cannot be rebuilt from current configuration',async()=>{
 const f=await fixture(),key=reference(f)
 await f.bindings.admit({bindingId:key.bindingId,agentHostId:'D-in-B',agentRuntimeId:'runtime-d',resourceHostId:'local',resourceRuntimeId:'runtime-b',resourceWorkspacePath:'/b/project',resourceGrant:{scope:'host-user',bindingId:key.bindingId},agent:{agentSessionId:key.agentSessionId,createOperationId:key.createOperationId,executorId:'d-executor',executorRevision:'d'.repeat(64),workspacePath:'/d/home',prompt:'Legacy frozen input'}})
 noCurrentConfiguration(f)
 await expect(f.rpc.call('agent.open',f.input)).rejects.toMatchObject({code:'EXECUTION_INTENT_UNCONFIRMED'})
 expect(spatialAgentOpenRecord((await f.spatial.read())!.graph,f.input.operationId)).toBeNull();expect(f.sourceNote).not.toHaveBeenCalled();expect(f.client.listHostExecutors).not.toHaveBeenCalled();expect(f.bindings.continueOriginal).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled()
})
it('a legacy Source locator with no frozen Core intent stays visible and unknown without admitting a replacement',async()=>{
 const f=await fixture(),key=reference(f)
 await f.spatial.admitAgentOpen({request:request(f),agentSessionId:key.agentSessionId,placement:{runtimeId:'runtime-b',hostId:'local',workspacePath:'/b/project',workspaceId:'b-workspace'},execution:{hostId:'D-in-B',runtimeId:'runtime-d',workspacePath:'/d/home',workspaceId:null,executorRevision:'d'.repeat(64)},executionBinding:key,regionResource:{}})
 const original=spatialAgentOpenRecord((await f.spatial.read())!.graph,f.input.operationId)
 noCurrentConfiguration(f)
 await expect(f.rpc.call('agent.open',f.input)).resolves.toMatchObject({outcome:'unknown',agent:null,issues:expect.arrayContaining([expect.objectContaining({step:'creation',code:'EXECUTION_INTENT_UNCONFIRMED'})])})
 expect(spatialAgentOpenRecord((await f.spatial.read())!.graph,f.input.operationId)).toEqual(original)
 expect(f.bindings.admit).not.toHaveBeenCalled();expect(f.bindings.continueOriginal).toHaveBeenCalledExactlyOnceWith(key,expect.anything());expect(f.client.listHostExecutors).not.toHaveBeenCalled();expect(f.sourceNote).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled()
})
it('an ACK for another exact reference cannot grant Source placement',async()=>{
 const f=await fixture(),admit=f.bindings.admit.getMockImplementation()!
 f.bindings.admit.mockImplementationOnce(async input=>({...await admit(input),agentSessionId:'another-session'}))
 await expect(f.rpc.call('agent.open',f.input)).rejects.toMatchObject({code:'EXECUTION_INTENT_UNCONFIRMED'})
 expect(spatialAgentOpenRecord((await f.spatial.read())!.graph,f.input.operationId)).toBeNull();expect(f.bindings.continueOriginal).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled()
})

it('a missing admit capability cannot silently fall back to Source placement or creation',async()=>{
 const f=await fixture(),before=await readFile(f.spatial.path,'utf8')
 delete f.runtime.executionBindings.admit
 await expect(f.rpc.call('agent.open',f.input)).rejects.toMatchObject({code:'CONTROL_UNAVAILABLE'})
 expect(await readFile(f.spatial.path,'utf8')).toBe(before);expect(f.bindings.continueOriginal).not.toHaveBeenCalled();expect(f.bindings.create).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();expect(f.starts).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled()
})

it.each(['agentRoute','resourceRoute'] as const)('a retained %s cannot change the Source original route or direct project placement',async field=>{
 const f=await fixture(),key=reference(f)
 // Route identity strings are controlled metadata leaves. The actual Service
 // parses/freezes/reads this route; no network route or signature is exercised.
 const route={source:{runtimeId:'other-route-source',publicKey:'controlled-source-key',fingerprint:'controlled-source-fingerprint'},hops:[{edgeId:'original-edge',target:{runtimeId:field==='agentRoute'?'runtime-d':'runtime-b',publicKey:'controlled-target-key',fingerprint:'controlled-target-fingerprint'}}]}
 await f.bindings.admit({bindingId:key.bindingId,agentHostId:'D-in-B',agentRuntimeId:'runtime-d',resourceHostId:'local',resourceRuntimeId:'runtime-b',resourceWorkspacePath:'/b/project',resourceGrant:{scope:'host-user',bindingId:key.bindingId},agent:{agentSessionId:key.agentSessionId,createOperationId:key.createOperationId,executorId:'d-executor',executorRevision:'d'.repeat(64),workspacePath:'/d/home'},sourceRequestDigest:spatialAgentOpenDigest(request(f)),[field]:route})
 const original:AgentExecutionInspection|null=await f.bindings.inspect(key.bindingId,'association')
 const before=await readFile(f.spatial.path,'utf8')
 expect(original?.[field]).toEqual(route);noCurrentConfiguration(f)
 await expect(f.rpc.call('agent.open',f.input)).rejects.toMatchObject({code:'EXECUTION_INTENT_UNCONFIRMED'})
 expect(await readFile(f.spatial.path,'utf8')).toBe(before);expect(spatialAgentOpenRecord((await f.spatial.read())!.graph,f.input.operationId)).toBeNull()
 expect(await f.bindings.inspect(key.bindingId,'association')).toEqual(original);expect(f.bindings.admit).toHaveBeenCalledOnce();expect(f.bindings.continueOriginal).not.toHaveBeenCalled();expect(f.client.listHostExecutors).not.toHaveBeenCalled();expect(f.sourceNote).not.toHaveBeenCalled();expect(f.prepare).not.toHaveBeenCalled();expect(f.starts).not.toHaveBeenCalled();expect(f.create).not.toHaveBeenCalled()
})
