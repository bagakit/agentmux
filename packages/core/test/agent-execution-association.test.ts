import { afterEach, expect, test, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentExecutionCoordinator, type AgentExecutionHostPort, type AgentExecutionOpenInput } from '../src/agent-execution-coordinator.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxAgentSession } from '../src/types.js'
import { parseAgentExecutionInspection } from '../src/public-rpc-agent-execution.js'
import { inspectCoordinatorAgentReference } from '../src/agent-open-reference.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { sourceCreationFixture } from './helpers/source-creation-fixture.js'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(),'amux-association-witness-'));cleanups.push(()=>rm(root,{recursive:true,force:true}))
  let handler = false, present = false
  const prepare = vi.fn(async () => {throw new AgentMuxError('The original preparation remains pending.','FIXTURE_PREPARATION_WAIT')})
  const forbidden = vi.fn(async () => {throw Error('No Native Start, attachment or input belongs to this read-contract proof')})
  const session = (): AgentMuxAgentSession => ({kind:'agent',agentSessionId:'original-SID',hostId:'local',providerId:'fixture',executorId:'selected',workspacePath:'/A/home',run:{runId:'original-run'},retiredRuns:[],createdAt:1,updatedAt:1,creation:{createOperationId:'original-CID',initialPrompt:'not-requested',agentMuxContext:'confirmed'},toolExecution:{bindingId:'original-binding',resourceHostId:'B-in-A',resourceRuntimeId:'runtime-B',workspacePath:'/B/project'}})
  const create = vi.fn(async () => ({session:session(),creation:session().creation!,promptConfirmed:true}))
  const port: AgentExecutionHostPort = {
    runtimeIdentity:()=>{throw Error('No Native identity read belongs to this metadata proof')},
    listHostExecutors:vi.fn(async()=>({runtimeId:'runtime-A',executors:[{executorId:'selected',label:'Original',providerId:'fixture',command:'fixture',source:'registered' as const,configRevision:'original-revision',availability:'unknown' as const,...(handler?{creationContract:{ordinaryLaunch:1 as const}}:{})}]})),
    readAgentSession:async()=>present?session():null,
    prepareAgentExecutionHelper:prepare,inspectPreparedTerminal:forbidden,createPreparedTerminal:forbidden,onRunEvent:()=>()=>{},
    attachTerminal:forbidden,releaseRunAttachment:forbidden,readRunReplay:forbidden,writeTerminal:forbidden,createHostAgentWithDelivery:create
  }
  const resolve = vi.fn(async(hostId:string)=>({runtimeId:hostId==='local'?'runtime-A':'runtime-B',client:port}))
  let owner = await AgentExecutionCoordinator.open(join(root,'coordinator'),{resolveHost:resolve});cleanups.push(()=>owner.dispose())
  const bindings = {create:(...args:Parameters<AgentExecutionCoordinator['create']>)=>owner.create(...args),continueOriginal:(...args:Parameters<AgentExecutionCoordinator['continueOriginal']>)=>owner.continueOriginal(...args),
    inspect:(...args:Parameters<AgentExecutionCoordinator['inspect']>)=>owner.inspect(...args),rejoin:(...args:Parameters<AgentExecutionCoordinator['rejoin']>)=>owner.rejoin(...args)}
  const server = new AgentMuxControlServer({executionBindings:bindings},join(root,'rpc.sock'));await server.start();cleanups.push(()=>server.stop())
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanups.push(()=>rpc.dispose())
  const input: AgentExecutionOpenInput = {bindingId:'original-binding',agentHostId:'local',agentRuntimeId:'runtime-A',resourceHostId:'B-in-A',resourceRuntimeId:'runtime-B',resourceWorkspacePath:'/B/project',
    resourceGrant:{scope:'host-user',bindingId:'original-binding'},agent:{agentSessionId:'original-SID',createOperationId:'original-CID',executorId:'selected',executorRevision:'original-revision',workspacePath:'/A/home'}}
  return {root,rpc,input,prepare,forbidden,create,resolve,port,bindings,server,owner:()=>owner,enableHandler:()=>{handler=true},hideHandler:()=>{handler=false},present:()=>{present=true},
    restart:async(change?:(file:string)=>void)=>{await owner.dispose();change?.(join(root,'coordinator','bindings.sqlite'));owner=await AgentExecutionCoordinator.open(join(root,'coordinator'),{resolveHost:resolve})}}
}

test('the actual public binding association view reads the original frozen Runtime tuple across owner restart without Native or a reverse route',async()=>{
  const f=await fixture()
  await expect(f.rpc.call('agent.execution.create',f.input)).rejects.toMatchObject({code:'FIXTURE_PREPARATION_WAIT'})
  const original=await f.rpc.call('agent.execution.binding',{bindingId:f.input.bindingId}),bytes=JSON.stringify(original)
  const durable=await readFile(join(f.root,'coordinator','bindings.sqlite'))
  expect(original).not.toHaveProperty('association');const before=f.resolve.mock.calls.length
  const pendingView=f.rpc.call('agent.execution.binding',{bindingId:f.input.bindingId,view:'association'})
  const settled=await pendingView.then(value=>({value}),error=>({error}))
  expect(settled).toHaveProperty('value')
  const view='value' in settled?settled.value:undefined
  expect(view?.association).toEqual({state:'confirmed',reference:{bindingId:'original-binding',agentSessionId:'original-SID',createOperationId:'original-CID'},agentRuntimeId:'runtime-A',resourceRuntimeId:'runtime-B',resourceWorkspacePath:'/B/project',
    agent:{executorId:'selected',executorRevision:'original-revision',workspacePath:'/A/home'}})
  expect(parseAgentExecutionInspection(view,{bindingId:f.input.bindingId,view:'association'})).toEqual(view)
  expect(()=>parseAgentExecutionInspection({...view,association:undefined},{bindingId:f.input.bindingId,view:'association'})).toThrow()
  expect(()=>parseAgentExecutionInspection({...view,association:{...view!.association,reference:{bindingId:'original-binding',agentSessionId:'same-SID-other-owner',createOperationId:'original-CID'}}},{bindingId:f.input.bindingId,view:'association'})).toThrow()
  expect(JSON.stringify(await f.rpc.call('agent.execution.binding',{bindingId:f.input.bindingId}))).toBe(bytes)
  const nativeBefore=f.forbidden.mock.calls.length,prepareBefore=f.prepare.mock.calls.length
  await f.restart()
  expect((await f.rpc.call('agent.execution.binding',{bindingId:f.input.bindingId,view:'association'}))?.association).toEqual(view?.association)
  const file=join(f.root,'original-read.json');await writeFile(file,JSON.stringify({bindingId:f.input.bindingId,view:'association'}))
  const cli=await runSourceObjectCli(['--endpoint','unix:'+f.server.path,'agent','execution','binding','--input',file],objectCliEnvironment(f.root))
  expect(cli.code,cli.stderr).toBe(0);expect(JSON.parse(cli.stdout).result.association).toEqual(view?.association)
  expect(f.resolve.mock.calls.length).toBe(before);expect(f.prepare.mock.calls.length).toBe(prepareBefore);expect(f.forbidden.mock.calls.length).toBe(nativeBefore)
  expect(await readFile(join(f.root,'coordinator','bindings.sqlite'))).toEqual(durable)
  await expect(f.rpc.call('agent.execution.rejoin',{bindingId:f.input.bindingId,view:'association'} as never)).rejects.toMatchObject({code:'INVALID_CONTROL_REQUEST'})
})

test('a legacy journal without frozen Runtime facts remains explicitly unconfirmed without filling from the current owner',async()=>{
  const f=await fixture()
  await expect(f.rpc.call('agent.execution.create',f.input)).rejects.toMatchObject({code:'FIXTURE_PREPARATION_WAIT'})
  // A private legacy fixture only; production readers never rewrite this row.
  await f.restart(file=>{const db=new DatabaseSync(file)
  const row=db.prepare('SELECT input FROM binding_intents WHERE id=?').get(f.input.bindingId)!
  const original=JSON.parse(String(row.input));delete original.agentRuntimeId;delete original.resourceRuntimeId
  db.prepare('UPDATE binding_intents SET input=? WHERE id=?').run(JSON.stringify(original),f.input.bindingId);db.close()})
  const before=await readFile(join(f.root,'coordinator','bindings.sqlite')),calls=f.resolve.mock.calls.length
  const observed=await f.rpc.call('agent.execution.binding',{bindingId:f.input.bindingId,view:'association'})
  expect(observed?.association).toEqual({state:'unconfirmed',reference:{bindingId:'original-binding',agentSessionId:'original-SID',createOperationId:'original-CID'},issue:{code:'EXECUTION_RUNTIME_WITNESS_UNCONFIRMED',message:expect.any(String)}})
  expect(await readFile(join(f.root,'coordinator','bindings.sqlite'))).toEqual(before);expect(f.resolve.mock.calls.length).toBe(calls)
  expect(f.forbidden).not.toHaveBeenCalled()
})

test('the public original Coordinator retains a new Source-field intent while an old target cannot be bypassed with continue',async()=>{
  const f=await fixture(),input={...f.input,agent:{...f.input.agent,sourceAgentMuxNote:'Original Source note'}}
  await expect(f.rpc.call('agent.execution.create',input)).rejects.toMatchObject({code:'EXECUTION_CREATION_CONTRACT_UNCONFIRMED'})
  const ref=(await f.rpc.call('agent.execution.binding',{bindingId:input.bindingId}))!.continuation!
  await expect(f.rpc.call('agent.execution.continue',ref)).rejects.toMatchObject({code:'EXECUTION_CREATION_CONTRACT_UNCONFIRMED'})
  expect(f.prepare).not.toHaveBeenCalled();expect(f.forbidden).not.toHaveBeenCalled()
  await expect(f.rpc.call('agent.execution.create',{...input,agent:{...input.agent,sourceAgentMuxNote:'changed'}})).rejects.toMatchObject({code:'EXECUTION_BINDING_CONFLICT'})
  f.enableHandler()
  await expect(f.rpc.call('agent.execution.continue',ref)).rejects.toMatchObject({code:'FIXTURE_PREPARATION_WAIT'})
  expect(f.prepare).toHaveBeenCalledTimes(1);f.hideHandler();await f.restart()
  const confirmedReads=vi.mocked(f.port.listHostExecutors).mock.calls.length
  await expect(f.rpc.call('agent.execution.continue',ref)).rejects.toMatchObject({code:'FIXTURE_PREPARATION_WAIT'})
  expect(f.prepare).toHaveBeenCalledTimes(2);expect(f.forbidden).not.toHaveBeenCalled()
  expect(f.port.listHostExecutors).toHaveBeenCalledTimes(confirmedReads)
  const inventoryBefore=vi.mocked(f.port.listHostExecutors).mock.calls.length
  f.present()
  expect(await f.rpc.call('agent.execution.continue',ref)).toMatchObject({session:{agentSessionId:'original-SID',run:{runId:'original-run'}}})
  expect(f.create).toHaveBeenCalledTimes(1);expect(f.prepare).toHaveBeenCalledTimes(2);expect(vi.mocked(f.port.listHostExecutors).mock.calls.length).toBe(inventoryBefore)
})

test('the real Source freezes the selected Executor observation before helper preparation without an additional inventory call', async () => {
  const f = await sourceCreationFixture(cleanups, 'Source launch contribution', { realBindings: true })
  f.bindingInventory.mockRejectedValue(new AgentMuxError('Independent inventory is unavailable', 'CONTROL_UNAVAILABLE'))
  const opened = await f.rpc.call('agent.open', f.input)
  expect(opened.execution?.reference).toMatchObject({ agentSessionId: 'original-d-session', createOperationId: f.input.operationId })
  expect(f.client.listHostExecutors).toHaveBeenCalledOnce()
  expect(f.client.readAgentInputEpoch).toHaveBeenCalledOnce()
  expect(f.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ role: 'executor', providerId: 'codex' }))
  expect(f.bindingInventory).not.toHaveBeenCalled()
  await f.restartBindings()
  await expect(f.rpc.call('agent.execution.continue', opened.execution!.reference)).rejects.toMatchObject({ code: 'EXECUTION_HELPER_UNAVAILABLE' })
  expect(f.bindingInventory).not.toHaveBeenCalled()
  expect(f.prepare).toHaveBeenCalledTimes(2)
  expect(f.starts).not.toHaveBeenCalled()
})


test('the independent original A SDK refuses a frozen foreign Runtime despite a same-SID local Session, without a general Host stream',async()=>{
  const f=await fixture(),a=await rpcOwnerFixture(['original-SID']);cleanups.push(a.close)
  const prior=await a.store.readMetadata('original-SID')
  if(!prior)throw Error('Original controlled Agent registry required')
  await a.store.compareAndSwap(prior,{...prior,creation:{createOperationId:'original-CID',initialPrompt:'not-requested'},toolExecution:{bindingId:'original-binding',resourceHostId:'B-in-A',resourceRuntimeId:'runtime-B',workspacePath:'/B/project'}})
  await a.inner.registry.load('local')
  const service=new AgentMuxHostedRuntimeService(a.client,null,()=>({runtimeId:'runtime-A',ownerInstanceId:'A-current-instance',protocolVersion:2,processId:process.pid,availability:'connected',ctxmux:null}));cleanups.push(()=>service.dispose())
  const events=vi.spyOn(service,'subscribe'),native=vi.spyOn(a.client,'connectRuntime'),read=vi.spyOn(a.client,'inspectAgentCreation')
  const server=new AgentMuxControlServer({executionBindings:f.bindings,hostedRuntime:()=>service,coreClients:a.coreClients},join(f.root,'A-owned.sock'));await server.start();cleanups.push(()=>server.stop())
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanups.push(()=>rpc.dispose())
  const reference={kind:'coordinator-agent' as const,runtimeId:'runtime-A',binding:{bindingId:'original-binding',agentSessionId:'original-SID',createOperationId:'original-CID'}},resource={runtimeId:'runtime-B',workspaceId:'B-workspace',workspacePath:'/B/project'}
  // The original journal records D, while A genuinely has the same raw SID/C.
  await expect(f.rpc.call('agent.execution.create',{...f.input,agentRuntimeId:'runtime-D'})).rejects.toMatchObject({code:'EXECUTION_HOST_CHANGED'})
  expect(await inspectCoordinatorAgentReference(rpc,reference,resource)).toMatchObject({state:'unconfirmed',issue:{code:'AGENT_ASSOCIATION_TARGET_MISMATCH'}})
  expect(read).not.toHaveBeenCalled();expect(events).not.toHaveBeenCalled();expect(native).not.toHaveBeenCalled()
  expect(a.inner.kernel.stop).not.toHaveBeenCalled();expect(a.rawInput).not.toHaveBeenCalled()
})


test('one authenticated A SDK confirms only its original journal/Session/resource tuple and keeps permission failures explicit',async()=>{
  const f=await fixture(),a=await rpcOwnerFixture(['original-SID']);cleanups.push(a.close)
  const prior=await a.store.readMetadata('original-SID');if(!prior)throw Error('Original controlled Agent registry required')
  await a.store.compareAndSwap(prior,{...prior,creation:{createOperationId:'original-CID',initialPrompt:'not-requested'},toolExecution:{bindingId:'original-binding',resourceHostId:'B-in-A',resourceRuntimeId:'runtime-B',workspacePath:'/B/project'}})
  await a.inner.registry.load('local')
  const service=new AgentMuxHostedRuntimeService(a.client,null,()=>({runtimeId:'runtime-A',ownerInstanceId:'A-current-instance',protocolVersion:2,processId:process.pid,availability:'connected',ctxmux:null}));cleanups.push(()=>service.dispose())
  const events=vi.spyOn(service,'subscribe'),native=vi.spyOn(a.client,'connectRuntime'),read=vi.spyOn(a.client,'inspectAgentCreation')
  const server=new AgentMuxControlServer({executionBindings:f.bindings,hostedRuntime:()=>service,coreClients:a.coreClients},join(f.root,'A-owned.sock'));await server.start();cleanups.push(()=>server.stop())
  const rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path}});cleanups.push(()=>rpc.dispose())
  const reference={kind:'coordinator-agent' as const,runtimeId:'runtime-A',binding:{bindingId:'original-binding',agentSessionId:'original-SID',createOperationId:'original-CID'}},resource={runtimeId:'runtime-B',workspaceId:'B-workspace',workspacePath:'/B/project'}
  await expect(f.rpc.call('agent.execution.create',f.input)).rejects.toMatchObject({code:'FIXTURE_PREPARATION_WAIT'})
  expect(await inspectCoordinatorAgentReference(rpc,reference,resource)).toMatchObject({state:'confirmed',reference,run:{runId:'run-original-SID'}})
  expect(read).toHaveBeenCalledExactlyOnceWith('original-SID');expect(events).not.toHaveBeenCalled();expect(native).not.toHaveBeenCalled()
  const managed=await connectAgentMuxRpc({endpoint:{transport:'unix',path:server.path},credentials:a.credentials});cleanups.push(()=>managed.dispose())
  expect(await inspectCoordinatorAgentReference(managed,reference,resource)).toMatchObject({state:'unconfirmed',reference,issue:{code:'AGENT_CAPABILITY_INVALID'}})
  expect(read).toHaveBeenCalledTimes(1);expect(a.inner.kernel.stop).not.toHaveBeenCalled();expect(a.rawInput).not.toHaveBeenCalled()
})
