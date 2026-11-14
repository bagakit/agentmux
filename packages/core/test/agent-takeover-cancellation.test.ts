import { DatabaseSync } from 'node:sqlite'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createTakeoverOwnerFixture } from './helpers/takeover-owner.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
it('cancels a complete original public takeover before admission and keeps its source workface', async () => {
  const f = await createTakeoverOwnerFixture(cleanup)
  const request = { operationId: 'cancel-before-admission', content: { kind: 'takeover-agent' as const, executorId: 'codex', source: { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } } },
    destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, newTab: true as const, displayWorkspaceId: 'project-a', groupId: 'original-group' }, focus: false }
  const before = await f.spatial.read(), input = { expectedRuntimeId: f.owner.runtimeId, operationId: 'cancel-control', request }
  const cancelled = await f.rpc.call('agent.takeover.cancel', input)
  expect(cancelled).toMatchObject({ outcome: 'cancelled', initialInput: 'held', diskDurability: 'confirmed', agent: null })
  expect(await f.rpc.call('agent.takeover.cancel.inspect', input)).toMatchObject({ outcome: 'cancelled', diskDurability: 'unconfirmed' })
  await expect(f.rpc.call('agent.open', request)).rejects.toMatchObject({ code: 'AGENT_TAKEOVER_CANCELLED' })
  expect(f.started).toHaveLength(0)
  const after = (await f.spatial.read())!
  expect(after.graph.tabs).toEqual(before!.graph.tabs); expect(after.graph.regions).toEqual(before!.graph.regions)
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})
it('keeps an already-created exact target when cancelling future execution', async () => {
  const f = await createTakeoverOwnerFixture(cleanup)
  const request = { operationId: 'cancel-created', content: { kind: 'takeover-agent' as const, executorId: 'codex', source: { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } } },
    destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, newTab: true as const, displayWorkspaceId: 'project-a', groupId: 'original-group' }, focus: false }
  const created = await f.rpc.call('agent.open', request)
  expect(created.outcome,JSON.stringify(created)).toBe('opened')
  const cancelled = await f.rpc.call('agent.takeover.cancel', { expectedRuntimeId: f.owner.runtimeId, operationId: 'cancel-created-control', request })
  expect(cancelled).toMatchObject({ outcome:'created', agent: { agentSessionId: created.agent!.agentSessionId, run:{runId:created.agent!.runId} } })
  expect(f.started).toHaveLength(1)
})
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); cleanup.push(async()=>resolve()); return { promise, resolve } }
function originalRequest(f: Awaited<ReturnType<typeof createTakeoverOwnerFixture>>, operationId: string) {
  return { operationId, content: { kind: 'takeover-agent' as const, executorId: 'codex', source: { hostId: 'local', agentSessionId: f.source.agentSessionId, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } } },
    destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, newTab: true as const, displayWorkspaceId: 'project-a', groupId: 'original-group' }, focus: false }
}
it.each(['existing', 'retired', 'closed', 'prepared'] as const)('Hosted cancellation rejects an unrelated CID paired with an %s Session before writing or consuming its facts', async state => {
  const f = await createTakeoverOwnerFixture(cleanup), request = originalRequest(f, 'paired-original')
  const reached = deferred(), release = deferred()
  if (state === 'prepared') {
    const prepare = f.inner.registry.prepareCreate.bind(f.inner.registry)
    vi.spyOn(f.inner.registry, 'prepareCreate').mockImplementation(async (...args: unknown[]) => {
      const value = await prepare(...args); reached.resolve(); await release.promise; return value
    })
  }
  if (state === 'closed') vi.spyOn(f.inner.kernel, 'startPrepared').mockRejectedValue(Error('Original Start acknowledgement is unavailable.'))
  const opening = f.rpc.call('agent.open', request), settled = opening.catch(error => error)
  if (state === 'prepared') await reached.promise
  else await settled
  const record = ((await f.spatial.read())!.graph.resources['core:agent-open'] as any).requests[request.operationId]
  const agentSessionId = record.agentSessionId as string
  if (state === 'retired') {
    const session = (await f.client.readAgentSession(agentSessionId))!
    f.inner.kernel.prepareStop = async (runId: string, operationKey: string) => ({ daemonInstance: 'fixture-runtime', operationKey, runId })
    f.inner.kernel.remove = async () => {}
    await f.client.stopAgent(agentSessionId, session.run, { operationId: 'paired-original-stop' })
    expect(await f.store.readRetiredAgentSession(agentSessionId)).not.toBeNull()
  }
  if (state === 'closed') {
    await f.client.resolveAgentCreation({ createOperationId: request.operationId, agentSessionId, operationId: 'paired-original-resolution' })
    expect((await f.store.loadClosedCreation(agentSessionId))?.creationResolution?.receipt.outcome).toBe('fenced')
  }
  const remote = await hostedTestClient(f.client); cleanup.push(() => remote.dispose())
  remote.port.call = async (method, params, options) => await remote.service.call(method, structuredClone(params),
    { ...options, principal: { kind: 'user', id: 'paired-cancellation-user' } }) as never
  const input = { createOperationId: 'unrelated-creation', agentSessionId, operationId: 'unrelated-cancellation' }
  expect(await f.store.loadCreationSessionId(input.createOperationId)).toBeNull()
  const before = { metadata: await f.store.readMetadata(agentSessionId), retired: await f.store.readRetiredAgentSession(agentSessionId),
    closed: await f.store.loadClosedCreation(agentSessionId), correlation: await f.store.loadCreationCorrelation(agentSessionId) }
  const stop = vi.spyOn(f.inner.kernel, 'stop'), start = vi.spyOn(f.inner.kernel, 'startPrepared'), inputCount = f.inner.kernel.input.mock.calls.length
  start.mockClear(); stop.mockClear()
  await expect(remote.sdk.cancelAgentCreation(input)).rejects.toMatchObject({ code: 'AGENT_CREATION_OPERATION_CONFLICT' })
  expect(await f.store.readCreationCancellation(input.createOperationId)).toBeNull()
  // A control persisted by an older client is not evidence that this Session belongs to that CID.
  await f.store.admitCreationCancellation({ ...input, runtimeId: f.owner.runtimeId })
  await expect(remote.sdk.inspectAgentCreationCancellation(input)).rejects.toMatchObject({ code: 'AGENT_CREATION_OPERATION_CONFLICT' })
  expect({ metadata: await f.store.readMetadata(agentSessionId), retired: await f.store.readRetiredAgentSession(agentSessionId),
    closed: await f.store.loadClosedCreation(agentSessionId), correlation: await f.store.loadCreationCorrelation(agentSessionId) }).toEqual(before)
  expect(start).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(f.inner.kernel.input).toHaveBeenCalledTimes(inputCount)
  if (state === 'prepared') { release.resolve(); expect((await settled).outcome).toBe('opened'); expect(f.started).toHaveLength(1) }
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})
it.each(['file', 'memory'] as const)('Hosted cancellation preserves its effect and reports the actual %s Store disk ACK', async kind => {
  const f = await createTakeoverOwnerFixture(cleanup), request = originalRequest(f, 'disk-ack-original')
  const created = await f.rpc.call('agent.open', request), agentSessionId = created.agent!.agentSessionId
  let client = f.client
  if (kind === 'memory') {
    const store = new AgentMuxMemoryAgentSessionStore()
    await store.compareAndSwapMetadata(null, (await f.store.readMetadata(agentSessionId))!)
    client = new AgentMuxClient({ store, providers: [f.provider], creationAuthority: f.inner.creationAuthority })
    // Hosted's initial projection uses the same deterministic Native facts without starting a daemon.
    const memory = client as typeof f.inner
    memory.connected = true
    Object.assign(memory.kernel, {
      isConnected: f.inner.kernel.isConnected,
      connect: f.inner.kernel.connect,
      identity: f.inner.kernel.identity,
      list: f.inner.kernel.list
    })
    cleanup.push(() => client.dispose())
  }
  const remote = await hostedTestClient(client); cleanup.push(() => remote.dispose())
  remote.port.call = async (method, params, options) => await remote.service.call(method, structuredClone(params),
    { ...options, principal: { kind: 'user', id: 'disk-ack-user' } }) as never
  const input = { createOperationId: request.operationId, agentSessionId, operationId: 'disk-ack-cancellation' }
  expect(await remote.sdk.cancelAgentCreation(input)).toMatchObject({ outcome: 'created', run: { runId: created.agent!.runId },
    diskDurability: kind === 'file' ? 'confirmed' : 'unconfirmed' })
  expect(await remote.sdk.inspectAgentCreationCancellation(input)).toMatchObject({ outcome: 'created', cancellation: input, diskDurability: 'unconfirmed' })
  expect((await client.readAgentSession(agentSessionId))?.run).toEqual({ runId: created.agent!.runId })
  expect(f.started).toHaveLength(1)
})
it('cancellation wins the real admission transaction after takeover preparation was already in flight', async () => {
  const f = await createTakeoverOwnerFixture(cleanup), reached = deferred(), release = deferred(), request = originalRequest(f, 'admission-race')
  const admit = f.spatial.admitAgentOpen.bind(f.spatial)
  vi.spyOn(f.spatial,'admitAgentOpen').mockImplementation(async (...args) => { reached.resolve(); await release.promise; return await admit(...args) })
  const opening = f.rpc.call('agent.open', request); const settled = opening.catch(error => error)
  await reached.promise
  const input = { expectedRuntimeId:f.owner.runtimeId, operationId:'admission-race-cancel', request }
  expect(await f.rpc.call('agent.takeover.cancel', input)).toMatchObject({ outcome:'cancelled' })
  release.resolve()
  expect(await settled).toMatchObject({ code:'AGENT_TAKEOVER_CANCELLED' }); expect(f.started).toHaveLength(0)
})
it('a spatial save cannot acknowledge a missing execution cancellation write', async () => {
  const f = await createTakeoverOwnerFixture(cleanup), request = originalRequest(f, 'execution-ack-gap')
  const opened = await f.rpc.call('agent.open', request)
  expect(opened.agent?.runId).toBeTruthy()
  const input = { expectedRuntimeId: f.owner.runtimeId, operationId: 'execution-ack-gap-cancel', request }
  const write = vi.spyOn(f.client, 'cancelAgentCreation').mockRejectedValueOnce(new Error('Original execution write is unavailable.'))
  expect(await f.rpc.call('agent.takeover.cancel', input)).toMatchObject({
    outcome: 'unconfirmed', diskDurability: 'unconfirmed', issue: 'Original execution write is unavailable.'
  })
  expect(await f.rpc.call('agent.takeover.cancel.inspect', input)).toMatchObject({
    operationId: input.operationId, outcome: 'unconfirmed', diskDurability: 'unconfirmed'
  })
  expect(write).toHaveBeenCalledTimes(1)
  expect(await f.rpc.call('agent.takeover.cancel', input)).toMatchObject({
    operationId: input.operationId, outcome: 'created', diskDurability: 'confirmed',
    agent: { agentSessionId: opened.agent!.agentSessionId, run: { runId: opened.agent!.runId } }
  })
  expect(f.started).toHaveLength(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
it('settling an existing first-input receipt never awaits the cancellation Store', async () => {
  const f = await createTakeoverOwnerFixture(cleanup), request = originalRequest(f, 'existing-first-input')
  const read = vi.spyOn(f.store, 'readCreationCancellation')
  const resume = f.inner.continueInitialInput.bind(f.inner)
  const observations: Array<{ state: string | undefined; reads: number }> = []
  vi.spyOn(f.inner, 'continueInitialInput').mockImplementation(async (...args: unknown[]) => {
    const before = read.mock.calls.length
    const settled = await resume(...args)
    observations.push({ state: settled.initialInput?.state, reads: read.mock.calls.length - before })
    return settled
  })
  const opened = await f.rpc.call('agent.open', request)
  expect(observations).toEqual([{ state: 'launch-carried', reads: 0 }])
  expect(opened.agent?.runId).toBeTruthy()
  expect(f.started).toHaveLength(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
it('holds a prepared live creator without stealing its lifecycle lease or starting after its barrier releases', async () => {
  const f = await createTakeoverOwnerFixture(cleanup), reached = deferred(), release = deferred(), request = originalRequest(f, 'prepared-race')
  const prepare = f.inner.registry.prepareCreate.bind(f.inner.registry)
  vi.spyOn(f.inner.registry,'prepareCreate').mockImplementation(async (...args: unknown[]) => { const value=await prepare(...args); reached.resolve(); await release.promise; return value })
  const opening = f.rpc.call('agent.open', request); const settled=opening.catch(error=>error)
  await reached.promise
  const input = { expectedRuntimeId:f.owner.runtimeId, operationId:'prepared-race-cancel', request }
  expect(await f.rpc.call('agent.takeover.cancel', input)).toMatchObject({ outcome:'unconfirmed' })
  expect(f.started).toHaveLength(0)
  release.resolve(); await settled
  const checked=await f.rpc.call('agent.takeover.cancel.inspect', input)
  expect(checked.outcome).toBe('unconfirmed'); expect(f.started).toHaveLength(0)
  await expect(f.rpc.call('agent.open', request)).rejects.toMatchObject({code:'AGENT_TAKEOVER_CANCELLED'})
})
it('cancellation after Session commit holds the not-yet-dispatched first input and keeps the healthy Run', async () => {
  const f = await createTakeoverOwnerFixture(cleanup,{postLaunch:true}), reached = deferred(), release = deferred(), request = originalRequest(f,'input-race')
  const continueInput = f.inner.continueInitialInput.bind(f.inner)
  vi.spyOn(f.inner,'continueInitialInput').mockImplementation(async (...args: unknown[])=>{ reached.resolve(); await release.promise; return await continueInput(...args) })
  const submit = vi.spyOn(f.inner.promptSubmission,'submitInputPlan')
  const stop = vi.spyOn(f.client,'stopAgent')
  const opening=f.rpc.call('agent.open',request), settled=opening.catch(error=>error)
  await reached.promise
  const result=await f.rpc.call('agent.takeover.cancel',{expectedRuntimeId:f.owner.runtimeId,operationId:'input-race-cancel',request})
  expect(result).toMatchObject({outcome:'created',initialInput:'held'}); expect(result.agent?.run).not.toBeNull()
  release.resolve(); await settled
  expect(submit).not.toHaveBeenCalled(); expect(f.rawInput).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(f.started).toHaveLength(1)
  expect((await f.client.readAgentSession(result.agent!.agentSessionId))?.run).toEqual(result.agent!.run)
  await f.client.submitAgentPrompt({agentSessionId:result.agent!.agentSessionId,expectedRun:result.agent!.run!,afterSubmissionId:null,
    operationId:'independent-user-input',prompt:'An independent explicit user instruction.'})
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
  const saved=await f.store.readMetadata(result.agent!.agentSessionId)
  expect(await f.client.inspectAgentPromptSubmission(saved!.initialInput!.key!)).toBeNull()
})
it('a lost cancellation reply is read with its original control and another actor or target cannot replace it', async()=>{
  const f=await createTakeoverOwnerFixture(cleanup), request=originalRequest(f,'lost-cancel'), input={expectedRuntimeId:f.owner.runtimeId,operationId:'lost-control',request}
  await f.rpc.call('agent.takeover.cancel',input)
  const checked=await f.rpc.call('agent.takeover.cancel.inspect',input)
  expect(checked).toMatchObject({operationId:input.operationId,createOperationId:request.operationId,outcome:'cancelled'})
  await expect(f.rpc.call('agent.takeover.cancel',{...input,operationId:'replacement-control'})).rejects.toMatchObject({code:'AGENT_TAKEOVER_CANCELLATION_CONFLICT'})
  await expect(f.rpc.call('agent.takeover.cancel',{...input,expectedRuntimeId:'another-spatial-core'})).rejects.toMatchObject({code:'RUNTIME_OWNER_MISMATCH'})
  expect(f.started).toHaveLength(0)
})

it.each(['before-creation','held-input'] as const)('a separate restarted public owner preserves %s cancellation without Native work or input replay',async mode=>{
  const f=await createTakeoverOwnerFixture(cleanup,{postLaunch:mode==='held-input'}),request=originalRequest(f,'restart-original'),input={expectedRuntimeId:f.owner.runtimeId,operationId:'restart-cancel',request}
  let sid:string|undefined,finishOpening:(()=>Promise<unknown>)|undefined
  if(mode==='held-input'){
    const reached=deferred(),release=deferred(),original=f.inner.continueInitialInput.bind(f.inner)
    vi.spyOn(f.inner,'continueInitialInput').mockImplementation(async(...args:unknown[])=>{reached.resolve();await release.promise;return await original(...args)})
    const opening=f.rpc.call('agent.open',request)
    await reached.promise
    const graph=(await f.spatial.read())!.graph,admission=graph.resources['core:agent-open'] as any
    sid=admission.requests[request.operationId].agentSessionId
    finishOpening=async()=>{release.resolve();return await opening}
  }
  const inputFile=join(f.root,'original-cancellation.json');await writeFile(inputFile,JSON.stringify(input))
  const read=async(mode?:'write')=>{
    const loader=new URL('./fixtures/agent-takeover-source-loader.mjs',import.meta.url)
    const registration=`import {register} from 'node:module';register(${JSON.stringify(loader.href)},${JSON.stringify(import.meta.url)});`
    const worker=new URL('./fixtures/agent-takeover-cancellation-reader.mjs',import.meta.url)
    return await new Promise<any>((resolve,reject)=>{
      const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(registration),worker.pathname,f.root,f.owner.runtimeId,inputFile,sid??'',...(mode?[mode]:[])],{env:{...process.env,AGENTMUX_MESSAGE_QUEUE_PATH:join(f.root,'messages.ndjson')},stdio:['ignore','pipe','pipe']})
      let stdout='',stderr=''
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Cancellation reader did not complete.'))},15000)
      child.stdout.on('data',value=>{stdout+=value});child.stderr.on('data',value=>{stderr+=value})
      child.once('error',error=>{clearTimeout(timer);reject(error)});child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(Error(stderr+stdout));else try{resolve(JSON.parse(stdout))}catch(error){reject(error)}})
    })
  }
  const writer=await read('write')
  expect(writer.written).toMatchObject({outcome:sid?'created':'cancelled',initialInput:'held',diskDurability:'confirmed'})
  await finishOpening?.()
  const first=await read(),second=await read()
  expect(writer.pid).not.toBe(first.pid)
  expect(first.pid).not.toBe(second.pid)
  for(const result of [first,second]){
    expect(result.checked).toMatchObject({operationId:input.operationId,outcome:mode==='held-input'?'created':'cancelled',initialInput:'held',diskDurability:'unconfirmed'})
    expect(result.replay).toBe('AGENT_TAKEOVER_CANCELLED');expect(result.controls).toBe(0);expect(result.graphUnchanged).toBe(true)
    if(sid)expect(result.held).toBe(true)
  }
})
it('the foreign execution binding and target Core consume the same original cancellation before any helper is started',async()=>{
  const f=await createTakeoverOwnerFixture(cleanup),foreign=await createTakeoverOwnerFixture(cleanup,{runtimeId:'foreign-execution-core'}),reached=deferred(),release=deferred()
  const {AgentExecutionBindingService}=await import('../src/agent-execution-coordinator.js')
  const helpers=vi.spyOn(foreign.client,'prepareAgentExecutionHelper'),resourceHelpers=vi.spyOn(f.client,'prepareAgentExecutionHelper')
  vi.spyOn(foreign.client,'hostEnvironment').mockResolvedValue({agentWorkspace:{workspacePath:foreign.directory},homeDirectory:foreign.root} as never)
  const bindings=new AgentExecutionBindingService(join(f.root,'original-bindings'),{resolveHost:async(hostId)=>{
    if(hostId==='local')return {runtimeId:f.owner.runtimeId,client:f.client}
    if(hostId!=='foreign-target')throw Error('Cancellation must address only the original configured Cores.')
    return {runtimeId:foreign.owner.runtimeId,client:foreign.client}
  }})
  cleanup.push(()=>bindings.dispose())
  const advance=bindings.continueOriginal.bind(bindings)
  vi.spyOn(bindings,'continueOriginal').mockImplementation(async(...args)=>{reached.resolve();await release.promise;return await advance(...args)})
  Object.assign(f.runtime,{executionBindings:bindings,executionHost:async(hostId:string)=>{
    expect(hostId).toBe('foreign-target');return {runtimeId:foreign.owner.runtimeId,client:foreign.client}
  }})
  const base=originalRequest(f,'foreign-original'),request={...base,content:{...base.content,agentTarget:{hostId:'foreign-target',runtimeId:foreign.owner.runtimeId}}}
  const opening=f.rpc.call('agent.open',request),settled=opening.catch(error=>error)
  await reached.promise
  const input={expectedRuntimeId:f.owner.runtimeId,operationId:'foreign-cancel',request}
  const coordinator=await (bindings as any).owner
  const graph=(await f.spatial.read())!.graph,admission=(graph.resources['core:agent-open'] as any).requests[request.operationId]
  const stale=coordinator.read(admission.executionBinding.bindingId)
  const result=await f.rpc.call('agent.takeover.cancel',input)
  expect(result).toMatchObject({outcome:'unconfirmed',initialInput:'unknown'})
  coordinator.save({...stale,diagnostic:{code:'ORIGINAL_OBSERVATION',message:'An earlier helper observation completed.'}})
  expect(coordinator.read(admission.executionBinding.bindingId).cancellation.operationId).toBe(input.operationId)
  expect(()=>coordinator.save({...stale,cancellation:{createOperationId:request.operationId,agentSessionId:admission.agentSessionId,operationId:'another-cancel'}})).toThrow('another cancellation control')
  release.resolve();await settled
  expect(helpers).not.toHaveBeenCalled();expect(resourceHelpers).not.toHaveBeenCalled();expect(foreign.started).toHaveLength(0);expect(f.started).toHaveLength(0)
  expect(await f.rpc.call('agent.takeover.cancel.inspect',input)).toMatchObject({outcome:'unconfirmed',operationId:input.operationId})
  await expect(f.rpc.call('agent.open',request)).rejects.toMatchObject({code:'AGENT_TAKEOVER_CANCELLED'})
})
it('another Core client can durably cancel an active original preparation without relying on its in-memory AbortController',async()=>{
  const f=await createTakeoverOwnerFixture(cleanup),reached=deferred(),release=deferred(),request=originalRequest(f,'other-client-race')
  const {AgentMuxClient}=await import('../src/client.js'),{AgentMuxFileAgentSessionStore}=await import('../src/agent-session-store.js')
  const other=new AgentMuxClient({store:new AgentMuxFileAgentSessionStore(f.store.path)}),inner=other as any
  inner.creationAuthority=f.inner.creationAuthority;inner.kernel=f.inner.kernel
  cleanup.push(()=>other.dispose())
  const prepare=f.inner.registry.prepareCreate.bind(f.inner.registry)
  vi.spyOn(f.inner.registry,'prepareCreate').mockImplementation(async(...args:unknown[])=>{const result=await prepare(...args);reached.resolve();await release.promise;return result})
  const opening=f.rpc.call('agent.open',request),settled=opening.catch(error=>error)
  await reached.promise
  const original=(await f.spatial.read())!.graph.resources['core:agent-open'] as any,sid=original.requests[request.operationId].agentSessionId
  expect(await other.cancelAgentCreation({createOperationId:request.operationId,agentSessionId:sid,operationId:'other-client-cancel'})).toMatchObject({outcome:'unconfirmed'})
  release.resolve();await settled
  expect(f.started).toHaveLength(0)
  const resolved=await f.client.cancelAgentCreation({createOperationId:request.operationId,agentSessionId:sid,operationId:'other-client-cancel'})
  expect(resolved).toMatchObject({outcome:'cancelled',initialInput:'unknown'})
})
it('the same healthy post-launch producer actually dispatches its first input when no cancellation exists',async()=>{
  const f=await createTakeoverOwnerFixture(cleanup,{postLaunch:true}),submit=vi.spyOn(f.inner.promptSubmission,'submitInputPlan')
  const created=await f.rpc.call('agent.open',originalRequest(f,'healthy-first-input'))
  expect(created.agent).not.toBeNull()
  expect(submit,JSON.stringify(created)).toHaveBeenCalled();expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
})
it('cancellation and a not-yet-committed first-input claim serialize at the original Session transaction',async()=>{
  const f=await createTakeoverOwnerFixture(cleanup,{postLaunch:true}),reached=deferred(),release=deferred(),request=originalRequest(f,'input-admission-race')
  cleanup.push(async()=>release.resolve())
  const compare=f.store.compareAndSwapMetadata.bind(f.store)
  vi.spyOn(f.store,'compareAndSwapMetadata').mockImplementation(async(...args)=>{
    const [before,next]=args
    if(next?.initialInput?.key&&JSON.stringify(next.promptCompletionAdmission?.inputKey)===JSON.stringify(next.initialInput.key)&&JSON.stringify(before?.promptCompletionAdmission?.inputKey)!==JSON.stringify(next.initialInput.key)){
      reached.resolve();await release.promise
    }
    return await compare(...args)
  })
  const opening=f.rpc.call('agent.open',request),settled=opening.catch(error=>error)
  await reached.promise
  const result=await f.rpc.call('agent.takeover.cancel',{expectedRuntimeId:f.owner.runtimeId,operationId:'input-admission-cancel',request})
  expect(result).toMatchObject({outcome:'created',initialInput:'held'})
  release.resolve();await settled
  const session=await f.store.readMetadata(result.agent!.agentSessionId)
  expect(await f.client.inspectAgentPromptSubmission(session!.initialInput!.key!)).toBeNull()
  expect(f.rawInput).not.toHaveBeenCalled()
})
it('an exact retained Native witness reports the created Run even before its original Start acknowledgement',async()=>{
  const f=await createTakeoverOwnerFixture(cleanup),reached=deferred(),release=deferred(),request=originalRequest(f,'start-ack-race')
  const start=f.inner.kernel.startPrepared.bind(f.inner.kernel)
  vi.spyOn(f.inner.kernel,'startPrepared').mockImplementation(async(...args:unknown[])=>{const run=await start(...args);reached.resolve();await release.promise;return run})
  const opening=f.rpc.call('agent.open',request),settled=opening.catch(error=>error)
  await reached.promise
  const input={expectedRuntimeId:f.owner.runtimeId,operationId:'start-ack-cancel',request}
  expect(await f.rpc.call('agent.takeover.cancel',input)).toMatchObject({outcome:'created',initialInput:'unknown',agent:{run:{runId:'fixture-run-0'}}})
  release.resolve();await settled
  const checked=await f.rpc.call('agent.takeover.cancel.inspect',input)
  expect(checked).toMatchObject({outcome:'created',agent:{run:{runId:'fixture-run-0'}}})
  expect(f.started).toHaveLength(1)
})

it('the real source CLI discovers and consumes the same cancellation and readback with no extra creation',async()=>{
  const f=await createTakeoverOwnerFixture(cleanup),request=originalRequest(f,'cli-cancellation'),input={expectedRuntimeId:f.owner.runtimeId,operationId:'cli-cancel-control',request}
  const loader=new URL('./fixtures/agent-takeover-source-loader.mjs',import.meta.url),env=objectCliEnvironment(f.root)
  const guide=await runSourceObjectCli(['agent','--skill'],env,'',15000,loader)
  expect(guide.code,guide.stderr).toBe(0);expect(guide.stdout).toContain('agent takeover cancel inspect --input FILE|-')
  const invoke=async(args:string[])=>await runSourceObjectCli(['--endpoint','unix:'+f.endpointPath,...args,'--input','-'],env,JSON.stringify(input),15000,loader)
  const cancelled=await invoke(['agent','takeover','cancel'])
  expect(cancelled.code,cancelled.stderr+cancelled.stdout).toBe(0);expect(JSON.parse(cancelled.stdout).result).toMatchObject({outcome:'cancelled',operationId:input.operationId})
  const checked=await invoke(['agent','takeover','cancel','inspect'])
  expect(checked.code,checked.stderr+checked.stdout).toBe(0);expect(JSON.parse(checked.stdout).result).toMatchObject({outcome:'cancelled',diskDurability:'unconfirmed'})
  expect(f.started).toHaveLength(0)
})

it('explicit cancellation advances an earlier retained exact-key fence without replacing its control identity',async()=>{
  const f=await createTakeoverOwnerFixture(cleanup),request=originalRequest(f,'prior-resolution')
  vi.spyOn(f.inner.kernel,'startPrepared').mockRejectedValue(Error('Original Native Start acknowledgement is unavailable.'))
  await f.rpc.call('agent.open',request)
  const graph=(await f.spatial.read())!.graph,record=(graph.resources['core:agent-open'] as any).requests[request.operationId]
  vi.spyOn(f.inner.kernel,'retirePreparedStart').mockRejectedValueOnce(Error('The exact original retirement acknowledgement is unavailable.'))
  await expect(f.client.resolveAgentCreation({createOperationId:request.operationId,agentSessionId:record.agentSessionId,operationId:'retained-resolution-control'})).rejects.toThrow('retirement acknowledgement')
  const result=await f.rpc.call('agent.takeover.cancel',{expectedRuntimeId:f.owner.runtimeId,operationId:'explicit-cancel-control',request})
  expect(result).toMatchObject({outcome:'cancelled',operationId:'explicit-cancel-control',initialInput:'unknown'})
  expect((await f.store.loadClosedCreation(record.agentSessionId))!.creationResolution!.request.operationId).toBe('retained-resolution-control')
  expect(f.started).toHaveLength(0)
})
it.each(['control','runtime','original','foreign-runtime'] as const)('a broken stored cancellation %s reference stays unknown and does not revoke an independent new intent',async field=>{
  const f=await createTakeoverOwnerFixture(cleanup),request=originalRequest(f,'broken-cancellation'),input={expectedRuntimeId:f.owner.runtimeId,operationId:'broken-control',request}
  await f.rpc.call('agent.takeover.cancel',input)
  const state=(await f.spatial.read())!,document=state.graph.resources['core:takeover-cancellations'] as any,stored=document[request.operationId].input
  if(field==='control')stored.operationId=''
  else if(field==='runtime')stored.expectedRuntimeId='invalid\nowner'
  else if(field==='original')stored.request.operationId='another-original'
  else stored.expectedRuntimeId='another-original-spatial-core'
  await f.spatial.commit({expectedRevision:state.revision,graph:state.graph})
  await expect(f.rpc.call('agent.open',request)).rejects.toMatchObject({code:'AGENT_TAKEOVER_CANCELLATION_UNCONFIRMED'})
  expect(f.started).toHaveLength(0)
  const independent=await f.rpc.call('agent.open',originalRequest(f,'independent-new-intent'))
  expect(independent.outcome).toBe('opened');expect(f.started).toHaveLength(1)
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})
it.each(['retained-native','observation-gap'] as const)('a missing Core creation record with an earlier healthy Native Start stays truthful under %s',async mode=>{
  const f=await createTakeoverOwnerFixture(cleanup),request=originalRequest(f,'missing-core-history')
  const created=await f.rpc.call('agent.open',request),sid=created.agent!.agentSessionId,original=await f.store.readMetadata(sid)
  expect(f.started).toHaveLength(1)
  await f.store.compareAndSwapMetadata(original,null)
  expect(await f.store.readMetadata(sid)).toBeNull();expect(await f.store.loadCreationCorrelation(sid)).toBeNull()
  if(mode==='observation-gap')vi.spyOn(f.inner.kernel,'inspectRetainedStart').mockResolvedValue(null)
  const stop=vi.spyOn(f.client,'stopAgent')
  const input={expectedRuntimeId:f.owner.runtimeId,operationId:'missing-core-cancel',request}
  const result=await f.rpc.call('agent.takeover.cancel',input)
  expect(result.outcome).toBe(mode==='retained-native'?'created':'unconfirmed')
  expect(result.initialInput).toBe('unknown')
  if(mode==='retained-native')expect(result.agent).toMatchObject({agentSessionId:sid,run:{runId:created.agent!.runId}})
  expect(stop).not.toHaveBeenCalled();expect(f.started).toHaveLength(1)
  expect(await f.store.readMetadata(sid)).toBeNull()
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})
it.each(['confirmed','unknown'] as const)('missing private initial-input history preserves the existing %s carrier fact',async initialPrompt=>{
  const f=await createTakeoverOwnerFixture(cleanup),request=originalRequest(f,'old-private-input')
  const created=await f.rpc.call('agent.open',request),sid=created.agent!.agentSessionId
  // Controlled historical representation, not a public mutation that would discard immutable input.
  const db=new DatabaseSync(f.store.path)
  try {
    const stored=JSON.parse(String(db.prepare('SELECT json FROM sessions WHERE id=?').get(sid)!.json))
    delete stored.initialInput;stored.creation.initialPrompt=initialPrompt;delete stored.creation.agentMuxContext
    db.prepare('UPDATE sessions SET json=? WHERE id=?').run(JSON.stringify(stored),sid)
  } finally {db.close()}
  const result=await f.rpc.call('agent.takeover.cancel',{expectedRuntimeId:f.owner.runtimeId,operationId:'old-input-cancel',request})
  expect(result).toMatchObject({outcome:'created',initialInput:initialPrompt==='confirmed'?'already-dispatched':'unknown'})
  expect(f.started).toHaveLength(1)
})
