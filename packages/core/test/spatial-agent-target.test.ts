import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
// The Host's borrowed client reports errors from the canonical Core SDK.
import { AgentMuxError } from '@agentmux/core'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { spatialAgentOpenRecord, isHeadlessSpatialAgentOpen, isBackgroundLocalAgentOpen } from '../src/spatial-agent-open.js'
import { readSpaceSnapshot } from '../src/space-authority-stream.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { rpcControlRequest } from '../src/rpc-business-codec.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { createHostSpatialAgentControl } from '../../../apps/host/src/spatial-agent-control.js'
import type { AgentMuxHeadlessRuntime } from '../src/headless-runtime.js'
import type { AgentExecutionOpenInput } from '../src/agent-execution-coordinator.js'
import type { AgentMuxAgentSession } from '../src/types.js'

const releases: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); vi.restoreAllMocks() })

/** This preflight isolates spatial ownership: target control/Native creation are
 * explicit leaves. It is not the separate two-Core Native execution proof. */
async function fixture(sourceContext = '  Source business context\n') {
  const root = await mkdtemp(join(tmpdir(), 'amx-spatial-target-')); releases.push(() => rm(root, { recursive: true, force: true }))
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const folder = await spatial.registerFolder({ id: 'b-workspace', hostId: 'local', name: 'B project', path: '/b/project' })
  let observed: AgentMuxAgentSession | undefined, runtimeId = 'runtime-d', pending = false, partialAfterStart = false, bindingConnected = false, frozen: AgentExecutionOpenInput | undefined
  const create = vi.fn(async (input: AgentExecutionOpenInput['agent']) => {
    observed = { kind: 'agent', agentSessionId: input.agentSessionId, hostId: 'local', providerId: 'codex', executorId: input.executorId,
      workspacePath: input.workspacePath, run: { runId: 'original-d-run' }, createdAt: 1, updatedAt: 1, retiredRuns: [],
      ...(frozen ? { toolExecution: { bindingId: frozen.bindingId, resourceHostId: frozen.resourceHostId, resourceRuntimeId: frozen.resourceRuntimeId, workspacePath: frozen.resourceWorkspacePath } } : {}),
      hookBindingId: 'test-binding', hookToken: 'test-token', creation: { createOperationId: input.createOperationId,
        executorRevision: input.executorRevision, createdRun: { runId: 'original-d-run' }, initialPrompt: 'not-requested' } } as AgentMuxAgentSession
    return { session: observed, creation: observed.creation! }
  })
  const agentInput = vi.fn(async () => { throw Error('No Agent input belongs to this Host continuation fixture.') })
  const client = { writeAgent: agentInput, pasteAgent: agentInput, submitAgentPrompt: agentInput, resolveAgentCreationSessionId: vi.fn(async () => 'original-d-session'),
    inspectAgentCreation: vi.fn(async () => { if (!observed) throw new AgentMuxError('No original creation is observed.', 'AGENT_CREATION_UNKNOWN'); return observed }),
    listHostExecutors: vi.fn(async () => ({ runtimeId, executors: [{ executorId: 'd-executor', configRevision: 'd-original-revision', creationContract: { ordinaryLaunch: 1 } }] })),
    hostEnvironment: vi.fn(async () => ({ homeDirectory: '/d/home' })), createHostAgentWithDelivery: create }
  const bindings = { create: vi.fn(async (input: AgentExecutionOpenInput) => {
      frozen = structuredClone(input)
      if (pending) throw new AgentMuxError('Original helper preparation remains unconfirmed.', 'EXECUTION_HELPER_UNAVAILABLE')
      const created = await create(input.agent)
      bindingConnected = !partialAfterStart
      if (partialAfterStart) throw new AgentMuxError('The Agent exists but its original binding is not connected.', 'EXECUTION_READER_UNAVAILABLE')
      return { ...created, execution: {} }
    }), continueOriginal: vi.fn(async reference => {
      expect(reference).toEqual({ bindingId: frozen!.bindingId, agentSessionId: frozen!.agent.agentSessionId, createOperationId: frozen!.agent.createOperationId })
      bindingConnected = true
      return observed ? { session: observed, creation: observed.creation!, execution: {} } : { ...await create(frozen!.agent), execution: {} }
    }), inspect: vi.fn(async (bindingId: string) => frozen && bindingId === frozen.bindingId ? { bindingId: frozen.bindingId, agentHostId: frozen.agentHostId,
      resourceHostId: frozen.resourceHostId, agentSessionId: frozen.agent.agentSessionId, resourceWorkspacePath: frozen.resourceWorkspacePath,
      continuation: { bindingId: frozen.bindingId, agentSessionId: frozen.agent.agentSessionId, createOperationId: frozen.agent.createOperationId },
      state: bindingConnected ? 'connected' as const : 'unavailable' as const,
      ...(!bindingConnected ? { diagnostic: { code: 'EXECUTION_READER_UNAVAILABLE', message: 'The original binding is not connected.' } } : {}) } : null) }
  const identity = { runtimeId: 'runtime-b', ownerInstanceId: 'instance-b', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' }
  const runtime = { client: { inspectAgentCreation: vi.fn(async () => { throw Error('A B-local SID lookup cannot locate a D Session.') }) }, ownerIdentity: () => identity,
    executionHost: vi.fn(async (hostId: string) => { expect(hostId).toBe('D-in-B'); return { runtimeId, client } }), executionBindings: bindings } as unknown as AgentMuxHeadlessRuntime
  const control = createHostSpatialAgentControl({ configurationPath: join(root, 'unused-local-executor-config.json'), spatial, runtime: () => runtime,
    agentMuxContext: async () => sourceContext })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), spatialState: spatial, coreClients: () => [], spatialAgentControl: control,
    hostedRuntime: () => ({ call: async () => ({ owner: identity }), assertFence: () => {}, subscribe: async () => { throw Error('General Host events are not a source admission prerequisite.') } }) as never })
  releases.push(() => server.stop()); await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); releases.push(() => rpc.dispose())
  const input = { operationId: 'source-create-operation', content: { kind: 'new-agent' as const, executorId: 'd-executor', agentTarget: { hostId: 'D-in-B', runtimeId } },
    destination: { spaceId: folder.spaceId, zoneId: folder.zoneId, newTab: true as const }, focus: false }
  return { root, rpc, spatial, runtime, client, create, bindings, input, folder, control, agentInput,
    pending: () => { pending = true }, partialAfterStart: () => { partialAfterStart = true }, changeRuntime: () => { runtimeId = 'another-runtime' }, frozen: () => frozen }
}

it('the public Source describes its actual owner and preserves complete CLI launch fields into the foreign child', async () => {
  const f = await fixture()
  expect(await f.rpc.call('agent.open.describe', { expectedRuntimeId: 'runtime-b' })).toEqual({
    source: { runtimeId: 'runtime-b', ownerInstanceId: 'instance-b' }, contracts: { ordinaryLaunch: { revision: 1, destination: 'source-zone-background' }, externalAssociation: null } })
  expect(f.runtime.executionHost).not.toHaveBeenCalled()
  const options = join(f.root, 'options.json'); await writeFile(options, JSON.stringify({ model: 'target-choice' }))
  const prompt = '  Original task\n', note = '  Caller note\n'
  const args = ['agent','open','--executor','d-executor','--agent-host','D-in-B','--agent-runtime','runtime-d',
    '--space',f.folder.spaceId,'--zone',f.folder.zoneId,'--new-tab','--operation-id',f.input.operationId,
    '--prompt',prompt,'--agentmux-note',note,'--launch-options',options,'--cols','117','--rows','39']
  const parsed = await parseAgentMuxCliInvocation(args)
  const request = rpcControlRequest('agent.open',parsed.params)
  if (request.operation !== 'agent.open' || request.content.kind !== 'new-agent') throw Error('Exact new Agent input required')
  const wire = {operationId:request.requestId,content:request.content,destination:request.destination,focus:request.focus}
  const described = await runSourceObjectCli(['--endpoint','unix:'+f.root+'/rpc.sock','agent','open','describe','--runtime','runtime-b'],objectCliEnvironment(f.root))
  expect(described.code,described.stderr).toBe(0);expect(JSON.parse(described.stdout).result.contracts.ordinaryLaunch).toEqual({revision:1,destination:'source-zone-background'})
  const skill = await runSourceObjectCli(['space','--skill'],objectCliEnvironment(f.root))
  expect(skill.code,skill.stderr).toBe(0);expect(skill.stdout).toContain('agent open describe');expect(skill.stdout).toContain('--launch-options')
  const launched = await runSourceObjectCli(['--endpoint','unix:'+f.root+'/rpc.sock',...args],objectCliEnvironment(f.root))
  expect(launched.code,launched.stderr).toBe(0);expect(JSON.parse(launched.stdout).result).toMatchObject({outcome:'opened'})
  expect(f.frozen()?.agent).toMatchObject({ prompt, agentMuxNote: note, sourceAgentMuxNote: '  Source business context\n', launchOptions: { model: 'target-choice' }, cols: 117, rows: 39 })
  const original = structuredClone(f.frozen())
  await expect(f.rpc.call('agent.open', { ...wire, content: { ...wire.content, rows: 40 } })).rejects.toMatchObject({ code: 'SPACE_REQUEST_CONFLICT' })
  expect(f.frozen()).toEqual(original); expect(f.bindings.create).toHaveBeenCalledTimes(1)
})
it('an old target creation handler cannot receive new Source fields after helper Start, while original reads stay independent', async () => {
  const f = await fixture()
  f.client.listHostExecutors.mockResolvedValueOnce({ runtimeId: 'runtime-d', executors: [{ executorId: 'd-executor', configRevision: 'd-original-revision' }] } as never)
  await expect(f.rpc.call('agent.open', f.input)).rejects.toMatchObject({ code: 'AGENT_OPEN_CONTRACT_UNCONFIRMED' })
  expect(f.create).not.toHaveBeenCalled(); expect(f.bindings.create).not.toHaveBeenCalled()
  expect(spatialAgentOpenRecord((await f.spatial.read())!.graph, f.input.operationId)).toBeNull()
  expect(await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } })).toMatchObject({ request: { known: false } })
  expect(f.input.operationId).toBe('source-create-operation')
})

it('the actual CLI retains a B-relative Agent route and Runtime and does not route it to a focused Desktop creator', async () => {
  const input = await parseAgentMuxCliInvocation(['agent', 'open', '--executor', 'd-executor', '--agent-host', 'D-in-B', '--agent-runtime', 'runtime-d', '--space', 'b-space', '--zone', 'b-zone', '--new-tab'])
  expect(input.command.method).toBe('agent.open')
  expect(input.params).toMatchObject({ content: { kind: 'new-agent', agentTarget: { hostId: 'D-in-B', runtimeId: 'runtime-d' } } })
  const request = { operation: 'agent.open', ...input.params }
  expect(isHeadlessSpatialAgentOpen(request)).toBe(true); expect(isBackgroundLocalAgentOpen(request)).toBe(false)
  await expect(parseAgentMuxCliInvocation(['agent', 'open', '--executor', 'd-executor', '--agent-host', 'D-in-B', '--space', 'b-space', '--zone', 'b-zone', '--new-tab'])).rejects.toThrow('--agent-host and --agent-runtime')
  await expect(parseAgentMuxCliInvocation(['agent', 'open', '--executor', 'd-executor', '--agent-host', 'D-in-B', '--agent-runtime', 'runtime-d', '--execution-workspace', 'wrong', '--space', 'b-space', '--zone', 'b-zone', '--new-tab'])).rejects.toThrow()
})
it('public source agent.open freezes B placement and D execution separately, and the original Space snapshot retains the D Runtime', async () => {
  const f = await fixture(), result = await f.rpc.call('agent.open', f.input)
  expect(result).toMatchObject({ outcome: 'opened', agent: { hostId: 'D-in-B', agentSessionId: 'original-d-session' }, save: { diskDurability: 'confirmed' } })
  const state = (await f.spatial.read())!, original = spatialAgentOpenRecord(state.graph, f.input.operationId)!
  expect(original.placement).toEqual({ runtimeId: 'runtime-b', hostId: 'local', workspaceId: 'b-workspace', workspacePath: '/b/project' })
  expect(original.execution).toMatchObject({ hostId: 'D-in-B', runtimeId: 'runtime-d', workspaceId: null, workspacePath: '/d/home', executorRevision: 'd-original-revision' })
  expect(state.graph.zones[0]!.directoryPath).toBe('/b/project')
  expect(f.frozen()).toMatchObject({ agentHostId: 'D-in-B', agentRuntimeId: 'runtime-d', resourceHostId: 'local', resourceRuntimeId: 'runtime-b', resourceWorkspacePath: '/b/project', agent: { workspacePath: '/d/home' } })
  const snapshot = await readSpaceSnapshot(f.rpc, { runtimeId: 'runtime-b', spaceId: f.folder.spaceId })
  expect(snapshot.scope.regions).toMatchObject([{ execution: { hostId: 'D-in-B', runtimeId: 'runtime-d', cwd: '/d/home' }, runId: 'original-d-run' }])
  await f.rpc.call('agent.open', f.input)
  expect(f.bindings.create).toHaveBeenCalledTimes(1); expect(f.client.listHostExecutors).toHaveBeenCalledTimes(1)
  expect(f.bindings.continueOriginal).not.toHaveBeenCalled()
  expect(f.runtime.client.inspectAgentCreation).not.toHaveBeenCalled()
})
it('an explicit same-operation continuation uses only the original frozen binding while B placement stays independent of D home', async () => {
  const f = await fixture(); f.pending()
  expect(await f.rpc.call('agent.open', f.input)).toMatchObject({ outcome: 'unknown' })
  const admitted = spatialAgentOpenRecord((await f.spatial.read())!.graph, f.input.operationId)!
  expect(admitted.executionBinding).toEqual({ bindingId: f.frozen()!.bindingId, agentSessionId: 'original-d-session', createOperationId: f.input.operationId })
  f.client.listHostExecutors.mockRejectedValue(Error('Current inventory cannot replace a frozen executor.'))
  expect(await f.rpc.call('agent.open', f.input)).toMatchObject({ outcome: 'opened', agent: { runId: 'original-d-run' } })
  expect(f.bindings.create).toHaveBeenCalledTimes(1); expect(f.bindings.continueOriginal).toHaveBeenCalledTimes(1)
  expect(f.client.listHostExecutors).toHaveBeenCalledTimes(1)
  expect(f.create).toHaveBeenCalledTimes(1)
})
it('a started Agent with an incomplete binding continues the same public Host operation without another Agent effect', async () => {
  const f = await fixture(); f.partialAfterStart()
  const first = await f.rpc.call('agent.open', f.input)
  expect(first).toMatchObject({ outcome: 'partial', agent: { agentSessionId: 'original-d-session', runId: 'original-d-run' } })
  const original = spatialAgentOpenRecord((await f.spatial.read())!.graph, f.input.operationId)!
  expect(await f.bindings.inspect(original.executionBinding!.bindingId)).toMatchObject({ state: 'unavailable' })
  expect(f.create).toHaveBeenCalledTimes(1)
  const inspected = await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } })
  expect(inspected.request?.report).toMatchObject({ outcome: 'partial', agent: first.agent })
  expect(f.bindings.continueOriginal).not.toHaveBeenCalled()
  const result = await f.rpc.call('agent.open', structuredClone(f.input))
  expect(f.bindings.continueOriginal).toHaveBeenCalledExactlyOnceWith(original.executionBinding, expect.anything())
  expect(result).toMatchObject({ outcome: 'opened', operationId: f.input.operationId,
    agent: { agentSessionId: first.agent!.agentSessionId, runId: first.agent!.runId }, to: first.to })
  expect(f.bindings.create).toHaveBeenCalledTimes(1); expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.client.listHostExecutors).toHaveBeenCalledTimes(1); expect(f.agentInput).not.toHaveBeenCalled()
  expect(spatialAgentOpenRecord((await f.spatial.read())!.graph, f.input.operationId)).toEqual(original)
})
it('a binding observation failure keeps the started Agent and original partial request without repeating effects', async () => {
  const f = await fixture(); f.partialAfterStart()
  const first = await f.rpc.call('agent.open', f.input)
  f.bindings.inspect.mockRejectedValueOnce(new Error('Original binding observation is temporarily unavailable.'))
  const result = await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } })
  expect(result.request?.report).toMatchObject({ outcome: 'partial', agent: first.agent, to: first.to })
  expect(result.request?.report?.issues).toContainEqual(expect.objectContaining({ message: 'Original binding observation is temporarily unavailable.' }))
  expect(f.bindings.continueOriginal).not.toHaveBeenCalled(); expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.agentInput).not.toHaveBeenCalled()
  expect((await f.spatial.read())!.graph.regions).toMatchObject([{ kind: 'agent', agentSessionId: first.agent!.agentSessionId, runId: first.agent!.runId }])
})
it('a same-SID binding receipt for another creation operation cannot complete the original partial request', async () => {
  const f = await fixture(); f.partialAfterStart()
  const first = await f.rpc.call('agent.open', f.input)
  const binding = await f.bindings.inspect(f.frozen()!.bindingId)
  if (!binding) throw Error('The fixture must retain its original binding.')
  f.bindings.inspect.mockResolvedValueOnce({ ...binding, state: 'connected',
    continuation: { ...binding.continuation, createOperationId: 'another-creation-operation' } })
  const result = await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } })
  expect(result.request?.report).toMatchObject({ outcome: 'partial', agent: first.agent, to: first.to })
  expect(result.request?.report?.issues).toContainEqual(expect.objectContaining({ code: 'EXECUTION_INTENT_UNCONFIRMED' }))
  expect(f.bindings.continueOriginal).not.toHaveBeenCalled(); expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.agentInput).not.toHaveBeenCalled()
})
it('a changed original B Zone rejects only the replay and retains the admitted operation without dispatching a new binding', async () => {
  const f = await fixture(); f.pending(); await f.rpc.call('agent.open', f.input)
  const state = (await f.spatial.read())!
  await f.spatial.commit({ expectedRevision: state.revision, graph: { ...state.graph, zones: state.graph.zones.map(zone => ({ ...zone, directoryPath: '/changed-b-project' })) } })
  const before = await readFile(f.spatial.path, 'utf8')
  await expect(f.rpc.call('agent.open', f.input)).rejects.toMatchObject({ code: 'SPACE_TARGET_CHANGED' })
  expect(f.bindings.continueOriginal).not.toHaveBeenCalled(); expect(f.bindings.create).toHaveBeenCalledTimes(1)
  expect(await readFile(f.spatial.path, 'utf8')).toBe(before)
})
it('a changed D Runtime and a managed self-grant cannot turn the retained Space into another execution target', async () => {
  const f = await fixture(); f.changeRuntime()
  await expect(f.rpc.call('agent.open', f.input)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(f.bindings.create).not.toHaveBeenCalled(); expect((await f.spatial.read())!.graph.regions).toEqual([])
  await expect(f.control({ schemaVersion: 5, requestId: f.input.operationId, operation: 'agent.open', ...f.input } as never,
    { transport: 'unix', principal: { kind: 'user', id: 'test-owner' }, caller: {} as never })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.bindings.create).not.toHaveBeenCalled()
})

it('a retained foreign creation without its original Runtime pin remains unconfirmed instead of reading a local same-SID creation', async () => {
  const f = await fixture(), operationId='legacy-foreign-original', sid='same-legacy-sid'
  const admitted = await f.spatial.admitAgentOpen({request:{schemaVersion:5,operation:'agent.open',requestId:operationId,
    content:{kind:'new-agent',executorId:'d-executor',executionWorkspaceId:'d-original-workspace'},
    destination:{spaceId:f.folder.spaceId,zoneId:f.folder.zoneId,newTab:true},focus:false},agentSessionId:sid,
    execution:{hostId:'D-in-B',workspacePath:'/d/home',workspaceId:'d-original-workspace'},regionResource:{}})
  vi.mocked(f.runtime.client.inspectAgentCreation).mockResolvedValue({kind:'agent',agentSessionId:sid,hostId:'local',providerId:'codex',executorId:'d-executor',workspacePath:'/d/home',run:{runId:'different-local-run'},hookBindingId:'private-binding',hookToken:'private-token',retiredRuns:[],createdAt:1,updatedAt:1,
    creation:{createOperationId:operationId,createdRun:{runId:'different-local-run'},initialPrompt:'not-requested'}})
  const before=await readFile(f.spatial.path,'utf8'),result=await f.rpc.call('space.inspect',{target:{operationId}})
  expect(result.request?.report).toMatchObject({outcome:'unknown',agent:null,issues:[expect.objectContaining({code:'SPATIAL_CREATION_UNCONFIRMED'})]})
  expect(f.runtime.client.inspectAgentCreation).not.toHaveBeenCalled();expect(f.runtime.executionHost).not.toHaveBeenCalled()
  expect(await readFile(f.spatial.path,'utf8')).toBe(before)
  expect((await f.spatial.read())!.graph.regions).toMatchObject([{regionId:admitted.record.address.regionId,agentSessionId:sid,runId:null}])
})


it('an empty optional Source context does not add a contract gate to the original prompt-only creation', async () => {
  const f = await fixture('')
  f.client.listHostExecutors.mockResolvedValueOnce({runtimeId:'runtime-d',executors:[{executorId:'d-executor',configRevision:'d-original-revision'}]} as never)
  expect(await f.rpc.call('agent.open',f.input)).toMatchObject({outcome:'opened'})
  expect(f.frozen()!.agent).not.toHaveProperty('sourceAgentMuxNote');expect(f.bindings.create).toHaveBeenCalledTimes(1)
})


it('the background local Host creator preserves the same ordinary fields without going through a foreign coordinator', async () => {
  const f = await fixture()
  await writeFile(join(f.root,'unused-local-executor-config.json'),JSON.stringify({executors:{'d-executor':{label:'Original',providerId:'codex',command:'codex',args:[],env:{},injectAgentMuxGuide:false}}}))
  const create = vi.fn(async (input: import('../src/client-contract.js').AgentMuxAgentCreateInput) => {
    if (!input.agentSessionId || !input.createOperationId) throw Error('Original local creation identities are required')
    return await f.create({...input,agentSessionId:input.agentSessionId,createOperationId:input.createOperationId,executorRevision:'local-config-revision'})
  })
  Object.assign(f.runtime.client,{resolveAgentCreationSessionId:f.client.resolveAgentCreationSessionId,inspectAgentCreation:f.client.inspectAgentCreation,createAgentWithDelivery:create})
  const {agentTarget:_target,...content} = f.input.content
  const fields = {agentMuxNote:'  caller note\n',launchOptions:{model:'selected'},cols:117,rows:39}
  expect(await f.rpc.call('agent.open',{...f.input,content:{...content,...fields,prompt:'  original task\n'}})).toMatchObject({outcome:'opened'})
  expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({...fields,prompt:'  original task\n',sourceAgentMuxNote:'  Source business context\n'}))
  expect(f.runtime.executionHost).not.toHaveBeenCalled();expect(f.bindings.create).not.toHaveBeenCalled()
})


it('an original launch with ordinary fields continues its frozen binding without a new description gate', async () => {
  const f = await fixture();f.partialAfterStart()
  const request = {...f.input,content:{...f.input.content,agentMuxNote:'original caller note',cols:117}}
  expect(await f.rpc.call('agent.open',request)).toMatchObject({outcome:'partial'})
  const original = structuredClone(f.frozen());delete f.control.describe
  f.client.listHostExecutors.mockRejectedValue(Error('Current discovery cannot replace an original creation.'))
  expect(await f.rpc.call('agent.open',request)).toMatchObject({outcome:'opened',agent:{runId:'original-d-run'}})
  expect(f.bindings.create).toHaveBeenCalledTimes(1);expect(f.bindings.continueOriginal).toHaveBeenCalledTimes(1);expect(f.frozen()).toEqual(original)
})
