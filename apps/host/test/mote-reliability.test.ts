import { expect, it, vi } from 'vitest'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager'

it('one blocked original maintenance qualifier must not hold a different due arrangement', async () => {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const loop = (id: string) => ({loopId:id,hostId:'local',agentSessionId:id,providerId:'generic',workspacePath:'/private/'+id,prompt:'Internal check '+id,intervalMs:1000,everyMs:60000,nextCheckAt:1000,status:'active',creationOperationId:'create-'+id,futureIntentId:'future-'+id,managedSource:{sourceId:'source-'+id,revision:'role-1'},revision:1})
  const observed: string[] = []
  const manager = new ContinuousProgressLoopManager({load:async()=>[loop('slow'),loop('healthy')],save:async()=>{}} as any, async()=>{throw Error('No input authorized')},()=>1000,async target=>{observed.push(target.loopId);throw Error('Read-only audit ends before input')})
  const qualify = vi.fn(async (target:any) => {if(target.loopId==='slow')await blocked;return {action:'continue' as const}})
  const dispose = manager.setMaintenanceOwner({maintain:async()=>{},qualify})
  await manager.start()
  const check = manager.check(1000)
  try {
    await vi.waitFor(()=>expect(qualify).toHaveBeenCalled(),{timeout:100})
    await new Promise(resolve=>setTimeout(resolve,50))
    expect(observed, 'A healthy exact due target must run while another qualifier is blocked').toContain('healthy')
  } finally {release();await check;dispose();await manager.stop()}
})

import { deliverContinuousProgress } from '../src/continuous-progress-delivery'
it('a final observation failure before any Core input dispatch must leave the original heartbeat eligible', async () => {
  const loop:any={loopId:'read-failure',hostId:'local',agentSessionId:'main',providerId:'generic',workspacePath:'/private/original',prompt:'Original internal heartbeat',intervalMs:1000,everyMs:60000,nextCheckAt:1000,status:'active',creationOperationId:'create-original',futureIntentId:'original-future',managedSource:{sourceId:'original-source',revision:'original-role'},revision:1}
  const observation=(tickId:string)=>({session:{agentSessionId:'main',hostId:'local',providerId:'generic',workspacePath:'/private/original',run:{runId:'original-run'},semanticStatus:{state:'done',source:'native-hook',observedAt:100},futurePromptIntents:{'original-future':{active:true,operationId:'create-original',message:{userContent:loop.prompt,systemContext:'Original system context'}}}},observation:{process:'running',semantic:'idle',readiness:'ready',stale:false},inputByte:0,tickId,now:1000})
  const submitPrompt=vi.fn(async()=>{throw Error('No input is expected')})
  const runtime={observeContinuousProgress:vi.fn(async()=>{throw Error('Original Host disconnected during final read; no input dispatched')}),submitPrompt}
  const manager=new ContinuousProgressLoopManager({load:async()=>[loop],save:async()=>{}} as any,(...args)=>deliverContinuousProgress(runtime as any,...args),()=>1000,async(_loop,tickId)=>observation(tickId) as any)
  const dispose=manager.setMaintenanceOwner({maintain:async()=>{},qualify:async()=>({action:'continue'})})
  await manager.start()
  try {
    await manager.check(1000)
    expect(runtime.observeContinuousProgress).toHaveBeenCalledOnce();expect(submitPrompt).not.toHaveBeenCalled()
    expect(manager.inspectLoop('read-failure')!.status,'A read failure before Core dispatch must not persist a user-resume-required pause').toBe('active')
  } finally {dispose();await manager.stop()}
})

import { afterEach } from 'vitest'
import { AgentMuxError, type ContinuousProgressLoop, type ContinuousProgressObservation } from '@agentmux/core'
import { createGoalRuntime } from '../src/goal-runtime.js'
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const deferred = () => Promise.withResolvers<void>()
function standing(id: string, patch: Partial<ContinuousProgressLoop> = {}): ContinuousProgressLoop {
  return { loopId:id, hostId:'local',agentSessionId:id,providerId:'generic',workspacePath:'/private/'+id,
    prompt:'Original internal check '+id,intervalMs:1000,everyMs:60000,nextCheckAt:1000,status:'active',
    creationOperationId:'create-'+id,futureIntentId:'future-'+id,managedSource:{sourceId:'source-'+id,revision:'role-1'},revision:1,...patch }
}
function idle(loop: ContinuousProgressLoop, tickId: string): ContinuousProgressObservation {
  return { session:{...loop,run:{runId:'original-'+loop.loopId},semanticStatus:{state:'done',source:'native-hook',observedAt:100},
    futurePromptIntents:{[loop.futureIntentId!]:{active:true,operationId:loop.creationOperationId!,prompt:loop.prompt,message:{userContent:loop.prompt,systemContext:'Original system context'}}}},
    observation:{process:'running',semantic:'idle',readiness:'ready',stale:false},inputByte:0,tickId,now:1000 } as ContinuousProgressObservation
}
async function fixture(records = [standing('original')]) {
  let clock=1000, saved=structuredClone(records)
  const submitPrompt=vi.fn(async(..._args:any[])=>undefined)
  const runtime={ observeContinuousProgress:vi.fn(async(loop:ContinuousProgressLoop,tickId:string)=>idle(loop,tickId)),submitPrompt }
  const observe=vi.fn(async(loop:ContinuousProgressLoop,tickId:string)=>idle(loop,tickId))
  const store={ load:async()=>structuredClone(saved),save:vi.fn(async(next:readonly ContinuousProgressLoop[])=>{saved=structuredClone([...next])}) }
  const manager=new ContinuousProgressLoopManager(store as never,(...args)=>deliverContinuousProgress(runtime as never,...args),()=>clock,observe)
  manager.setMaintenanceOwner({maintain:async()=>{},qualify:async()=>({action:'continue'})})
  await manager.start();closes.push(()=>manager.stop())
  return {manager,runtime,observe,store,saved:()=>saved,at:(value:number)=>clock=value}
}
it('each due target is single-flight while newly due targets continue past an indefinitely held read', async()=>{
  const f=await fixture([standing('blocked'),standing('healthy'),standing('later',{nextCheckAt:2000})])
  const gate=deferred(),entered=deferred()
  f.observe.mockImplementation(async(loop,tick)=>{if(loop.loopId==='blocked'){entered.resolve();await gate.promise}return idle(loop,tick)})
  const first=f.manager.check(1000);await entered.promise
  let repeated:Promise<void>|undefined
  try {
    await vi.waitFor(()=>expect(f.runtime.submitPrompt).toHaveBeenCalledOnce())
    repeated=f.manager.check(1000)
    await new Promise<void>(resolve=>setImmediate(resolve))
    expect(f.observe.mock.calls.filter(([loop])=>loop.loopId==='blocked')).toHaveLength(1)
    await f.manager.check(2000)
    expect(f.runtime.submitPrompt).toHaveBeenCalledTimes(2)
    expect(f.observe.mock.calls.filter(([loop])=>loop.loopId==='blocked')).toHaveLength(1)
    expect(f.manager.inspectLoop('later')).toMatchObject({lastOutcome:'sent',nextCheckAt:62000})
  } finally {gate.resolve();await first;await repeated}
})
it('cancelling a held qualifier releases only that original tick and a late answer cannot revive it',async()=>{
  const f=await fixture(),gate=deferred(),entered=deferred()
  ;(f.manager as any).maintenanceOwner.qualify=async()=>{entered.resolve();await gate.promise;return {action:'continue'}}
  const checking=f.manager.check(1000);await entered.promise
  f.manager.cancelTarget({hostId:'local',agentSessionId:'original'})
  await checking
  expect(f.observe).not.toHaveBeenCalled();expect(f.runtime.submitPrompt).not.toHaveBeenCalled()
  gate.resolve();await Promise.resolve();await Promise.resolve()
  expect(f.manager.inspectLoop('original')).toMatchObject({status:'active',nextCheckAt:1000})
  expect(f.manager.inspectLoop('original')!.lastTickId).toBeUndefined()
})
it('a final read can be cancelled without waiting for its offline Host, then its due occurrence retries',async()=>{
  const f=await fixture(),entered=deferred(),gate=deferred()
  f.runtime.observeContinuousProgress.mockImplementationOnce(async(loop,tick)=>{entered.resolve();await gate.promise;return idle(loop,tick)})
  const checking=f.manager.check(1000);await entered.promise
  f.manager.cancelTarget({hostId:'local',agentSessionId:'original'});await checking
  expect(f.runtime.submitPrompt).not.toHaveBeenCalled()
  expect(f.manager.inspectLoop('original')).toMatchObject({status:'active',nextCheckAt:1000,lastOutcome:'skipped'})
  expect(f.manager.inspectLoop('original')!.pendingCompletion).toBeUndefined()
  await f.manager.check(1000);expect(f.runtime.submitPrompt).toHaveBeenCalledOnce()
  gate.resolve()
})
it('a lost Core input ACK keeps the original unknown operation across later automatic checks and cancellation',async()=>{
  const f=await fixture(),entered=deferred(),gate=deferred()
  f.runtime.submitPrompt.mockImplementation(async()=>{entered.resolve();await gate.promise;throw new Error('Core input ACK disconnected')})
  const checking=f.manager.check(1000);await entered.promise
  const pending=structuredClone(f.manager.inspectLoop('original')!.pendingCompletion)
  f.manager.cancelTarget({hostId:'local',agentSessionId:'original'})
  gate.resolve();await checking
  expect(f.manager.inspectLoop('original')).toMatchObject({status:'paused',lastOutcome:'unknown',pendingCompletion:pending})
  await f.manager.check(1000000000);expect(f.runtime.submitPrompt).toHaveBeenCalledOnce()
  expect(f.saved()[0]!.pendingCompletion).toEqual(pending)
})
it.each(['read','claim-save','pending-save'] as const)('a known pre-input %s failure retries only the latest occurrence after a long offline gap',async stage=>{
  const f=await fixture(),offlineAt=60000*1000+1234
  if(stage==='read')f.runtime.observeContinuousProgress.mockRejectedValueOnce(new Error('Original Host offline'))
  else {
    let writes=0
    const original=f.store.save.getMockImplementation()!
    f.store.save.mockImplementation(async loops=>{if(++writes===(stage==='claim-save'?1:2))throw new Error('Original durable store temporarily unavailable');return original(loops)})
  }
  await f.manager.check(1000).catch(()=>{})
  expect(f.runtime.submitPrompt).not.toHaveBeenCalled()
  expect(f.manager.inspectLoop('original')).toMatchObject({status:'active',nextCheckAt:1000})
  expect(f.manager.inspectLoop('original')!.pendingCompletion).toBeUndefined()
  await f.manager.check(offlineAt)
  expect(f.runtime.submitPrompt).toHaveBeenCalledOnce()
  const pending=f.runtime.submitPrompt.mock.calls[0]![4] as any
  expect(pending.futureIntent.occurrenceAt).toBe(60001000)
  expect(f.manager.inspectLoop('original')).toMatchObject({status:'active',lastOutcome:'sent',lastOccurrenceAt:60001000,nextCheckAt:60061000})
})
it.each(['AGENT_COMPLETION_CHANGED','not-applied'] as const)('Core authoritative %s before write leaves a new occurrence due',async failure=>{
  const f=await fixture()
  f.runtime.submitPrompt.mockRejectedValueOnce(new AgentMuxError('Exact input boundary changed',failure==='not-applied'?'PRIVATE_INPUT_REJECTED':failure,undefined,failure==='not-applied'?{disposition:'not_applied',confirmedInputBytes:0}:undefined))
  await f.manager.check(1000)
  expect(f.manager.inspectLoop('original')).toMatchObject({status:'active',lastOutcome:'skipped',nextCheckAt:1000})
  expect(f.manager.inspectLoop('original')!.pendingCompletion).toBeUndefined()
})
it('reinspection of an older unknown cannot become skipped because its current observation or input was cancelled',async()=>{
  const f=await fixture()
  f.runtime.submitPrompt.mockRejectedValueOnce(new Error('Unknown original Core write'))
  await f.manager.check(1000)
  const unknown=structuredClone(f.manager.inspectLoop('original')!.pendingCompletion)
  await f.manager.resume('original')
  f.runtime.observeContinuousProgress.mockRejectedValueOnce(new Error('Cannot inspect the original Host'))
  await f.manager.check(1000)
  expect(f.manager.inspectLoop('original')).toMatchObject({status:'paused',lastOutcome:'unknown',pendingCompletion:unknown})
  expect(f.runtime.submitPrompt).toHaveBeenCalledOnce()
})
it('the original Goal runtime marks only errors before it enters the Core input port as undispatched',async()=>{
  const record=standing('original'),observation=idle(record,'original-tick')
  const submit=vi.fn(async()=>{throw new Error('Core connection lost after entry')})
  let available=false
  const runtime=createGoalRuntime({clients:()=>available?[{hostId:'local',client:{submitAgentPrompt:submit} as any}]:[],checkIn:async()=>({known:false,reason:'unused'})})
  const control={kind:'agent' as const,hostId:'local',agentSessionId:'original',run:observation.session.run}
  const {agentPromptCondition}=await import('@agentmux/core')
  const condition=agentPromptCondition(observation.session),automation={isCurrent:()=>true,signal:new AbortController().signal}
  await expect(runtime.submitPrompt(control,record.prompt,'original-tick',condition,automation)).rejects.toMatchObject({name:'AutomaticInputNotDispatchedError'})
  expect(submit).not.toHaveBeenCalled()
  available=true
  await expect(runtime.submitPrompt(control,record.prompt,'original-tick',condition,automation)).rejects.toMatchObject({name:'Error',message:'Core connection lost after entry'})
  expect(submit).toHaveBeenCalledOnce()
})

import * as core from '@agentmux/core'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
it.each(['prepare','dispatch'] as const)('the real Core native %s boundary reports only proven new input as not applied',async stage=>{
  const f=await rpcOwnerFixture(['original'],core,()=>({nativeHandle:{kind:'provider',providerId:'codex',sessionId:'native-original'}}));closes.push(f.close)
  const inner=f.inner as any,run=f.client.agentSession('original').run
  const stamp=Date.now()
  await inner.registry.update('original',run,(current:any)=>({...current,updatedAt:stamp,semanticStatus:{state:'done',source:'native-hook',observedAt:stamp,stateEnteredAt:stamp}}))
  inner.kernel.status=vi.fn(async(id:string)=>({...f.run(id),pid:700001}))
  const send=vi.fn(async()=>{throw new AgentMuxError('Private native ACK disconnected','PRIVATE_NATIVE_DISCONNECTED')})
  const prepare=vi.spyOn(f.client.providers.get('codex'),'prepareNativeInput').mockImplementation(async()=>{
    if(stage==='prepare')throw new AgentMuxError('Private native source unavailable','PRIVATE_NATIVE_UNAVAILABLE')
    return {plan:{kind:'native-rpc',protocolId:'private-protocol',sourceId:JSON.stringify(['codex','native-original']),actorId:'private-original-actor',threadId:'native-original',operation:'queue-idle'},assertCurrent:async()=>{},send,dispose:async()=>{}} as any
  })
  await f.client.saveAgentFuturePromptIntent({agentSessionId:'original',intentId:'original-future',operationId:'original-source',expectedRun:run,prompt:'Private original heartbeat',agentMuxNote:'Private original context',active:true})
  const request={agentSessionId:'original',operationId:'original-tick',prompt:'Private original heartbeat',agentMuxNote:'Private original context',...core.agentPromptCondition(f.client.agentSession('original')),expectedInputByte:0,expectedFutureIntent:{intentId:'original-future',occurrenceAt:1000}}
  const error=await f.client.submitAgentPrompt(request).then(()=>null,error=>error)
  expect(prepare).toHaveBeenCalledOnce()
  expect(error).toMatchObject({controlFailure:{disposition:stage==='prepare'?'not_applied':'unknown',confirmedInputBytes:stage==='prepare'?0:null}})
  const claim=await f.client.inspectAgentPromptSubmission({kind:'prompt',agentSessionId:'original',expectedRun:run,submissionId:'original-tick'})
  if(stage==='prepare') {
    expect(send).not.toHaveBeenCalled();expect(claim).toBeNull()
    expect(await f.client.readAgentFuturePromptIntent('original','original-future')).not.toHaveProperty('lastOccurrenceAt')
  } else {
    expect(send).toHaveBeenCalledOnce();expect(claim?.admission).toMatchObject({submissionId:'original-tick',acknowledged:false,native:{outcome:'unknown'}})
    // A fresh Provider preparation failure while inspecting this same frozen operation never erases its unknown.
    prepare.mockRejectedValue(new AgentMuxError('Private source still unavailable','PRIVATE_NATIVE_UNAVAILABLE'))
    await f.client.submitAgentPrompt(request).catch(()=>{})
    expect(send).toHaveBeenCalledOnce()
    expect((await f.client.inspectAgentPromptSubmission({kind:'prompt',agentSessionId:'original',expectedRun:run,submissionId:'original-tick'}))?.admission).toMatchObject({submissionId:'original-tick',native:{outcome:'unknown'}})
  }
  expect(inner.kernel.input).not.toHaveBeenCalled();expect(f.rawInput).not.toHaveBeenCalled()
})

it('the same exact target serializes two due inputs and keeps a possibly written original when a human cancels and the Provider ignores abort',async()=>{
  const f=await rpcOwnerFixture(['original'],core,()=>({nativeHandle:{kind:'provider',providerId:'codex',sessionId:'native-original'}}));closes.push(f.close)
  const inner=f.inner as any,run=f.client.agentSession('original').run,stamp=Date.now()
  await inner.registry.update('original',run,(current:any)=>({...current,updatedAt:stamp,semanticStatus:{state:'done',source:'native-hook',observedAt:stamp,stateEnteredAt:stamp}}))
  inner.kernel.status=vi.fn(async(id:string)=>({...f.run(id),pid:700001}))
  const entered=deferred(),release=deferred();let enteredNative=false
  const send=vi.fn(async()=>{enteredNative=true;entered.resolve();await release.promise;return {outcome:'admitted',queuedSubmissionId:'original-queue-item'}})
  vi.spyOn(f.client.providers.get('codex'),'prepareNativeInput').mockResolvedValue({plan:{kind:'native-rpc',protocolId:'private-protocol',sourceId:JSON.stringify(['codex','native-original']),actorId:'private-original-actor',threadId:'native-original',operation:'queue-idle'},assertCurrent:async()=>{},send,dispose:async()=>{}} as any)
  const runtime=createGoalRuntime({clients:f.coreClients,checkIn:async()=>({known:false,reason:'unused'})})
  let saved:ContinuousProgressLoop[]=[]
  const observed:string[]=[]
  const manager=new ContinuousProgressLoopManager({load:async()=>saved,save:async loops=>{saved=structuredClone([...loops])}} as any,(...args)=>deliverContinuousProgress(runtime,...args),()=>1000,async(loop,...args)=>{observed.push(loop.loopId);return runtime.observeContinuousProgress(loop,...args)},runtime)
  manager.setMaintenanceOwner({maintain:async()=>{},qualify:async()=>({action:'continue'})});closes.push(()=>manager.stop())
  const target={hostId:'local',agentSessionId:'original',providerId:'codex',workspacePath:f.root}
  const a=(await manager.call('schedule.create',{target,afterMs:50,prompt:'Original first input',operationId:'create-first'})).schedule
  const b=(await manager.call('schedule.create',{target,afterMs:50,prompt:'Original second input',operationId:'create-second'})).schedule
  const checking=manager.check(1050)
  let stopping:Promise<void>|undefined,writing:Promise<unknown>|undefined
  try {
    await vi.waitFor(()=>expect(enteredNative,JSON.stringify(manager.list())).toBe(true),{timeout:3000})
    await new Promise<void>(resolve=>setImmediate(resolve))
    expect(observed).not.toContain(b.loopId)
    const pending=structuredClone(manager.inspectLoop(a.loopId)!.pendingCompletion)
    manager.cancelTarget(target)
    // The original input lane retains a person's queued write behind an already entered native operation.
    writing=f.client.writeAgent({agentSessionId:'original',expectedRun:run,data:'Human terminal input',source:'user'})
    expect(inner.kernel.stop).not.toHaveBeenCalled()
    let stopped=false;stopping=manager.stop().then(()=>{stopped=true})
    await vi.waitFor(()=>expect(stopped).toBe(true))
    await checking
    expect(manager.inspectLoop(a.loopId)).toMatchObject({status:'paused',lastOutcome:'unknown',pendingCompletion:pending})
    expect(manager.inspectLoop(b.loopId)!.pendingCompletion).toBeUndefined()
    expect(manager.inspectLoop(b.loopId)!.lastTickId).toBeUndefined()
    expect(send).toHaveBeenCalledOnce()
    release.resolve()
    await writing
    expect(f.rawInput).toHaveBeenCalledOnce()
    await vi.waitFor(async()=>expect((await f.client.inspectAgentPromptSubmission({kind:'prompt',agentSessionId:'original',expectedRun:run,submissionId:pending!.operationId}))?.admission).toMatchObject({acknowledged:true,native:{outcome:'admitted'}}))
    expect(manager.inspectLoop(a.loopId)).toMatchObject({status:'paused',lastOutcome:'unknown',pendingCompletion:pending})
  } finally {release.resolve();await checking;await stopping;await writing}
})

it('automatic cadence uses only the latest due occurrence after a held read and a same-target queue span many intervals',async()=>{
  const f=await fixture([standing('first'),standing('second',{agentSessionId:'first'})]),entered=deferred(),release=deferred()
  f.observe.mockImplementationOnce(async(loop,tick)=>{entered.resolve();await release.promise;return idle(loop,tick)})
  const checking=f.manager.check();await entered.promise
  f.at(6001234);release.resolve();await checking
  expect(f.runtime.submitPrompt).toHaveBeenCalledTimes(2)
  expect(f.runtime.submitPrompt.mock.calls.map(args=>(args[4] as any).futureIntent.occurrenceAt)).toEqual([6001000,6001000])
  expect(f.manager.inspectLoop('first')).toMatchObject({lastOccurrenceAt:6001000,nextCheckAt:6061000})
  expect(f.manager.inspectLoop('second')).toMatchObject({lastOccurrenceAt:6001000,nextCheckAt:6061000})
})
