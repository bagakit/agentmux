import { afterEach, expect, it, vi } from 'vitest'
import { sourceCreationFixture } from './helpers/source-creation-fixture.js'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
// The Host's borrowed client reports errors from the canonical Core SDK.
import { AgentMuxError } from '@agentmux/core'
import { spatialAgentOpenRecord, isHeadlessSpatialAgentOpen, isBackgroundLocalAgentOpen } from '../src/spatial-agent-open.js'
import { readSpaceSnapshot } from '../src/space-authority-stream.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { rpcControlRequest, parseRpcControlResult } from '../src/rpc-business-codec.js'
import { runSourceObjectCli as originalSourceObjectCli } from './helpers/source-object-cli.js'
const runSourceObjectCli: typeof originalSourceObjectCli = (args,env,stdin,timeout,loader) => originalSourceObjectCli(args,env,stdin,timeout,loader ?? (process.env.T012_CLI_LOADER ? new URL(process.env.T012_CLI_LOADER) : undefined))
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'

const releases: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const release of releases.splice(0).reverse()) await release(); vi.restoreAllMocks() })

const fixture = (sourceContext?: string) => sourceCreationFixture(releases, sourceContext)

it('the actual Source and CLI return the original binding before Agent creation without another Start or input', async () => {
  const f = await fixture(); f.pending()
  const initial = await f.rpc.call('agent.open', f.input)
  expect(initial).toMatchObject({ outcome: 'unknown', agent: null, execution: { coordinatorRuntimeId: 'runtime-b',
    reference: { agentSessionId: 'original-d-session', createOperationId: f.input.operationId }, inspection: { state: 'unavailable', continuation: { agentSessionId: 'original-d-session', createOperationId: f.input.operationId } } } })
  expect(initial.issues).toContainEqual(expect.objectContaining({ step: 'creation', executionFailure: expect.objectContaining({ hostId: 'local', role: 'executor', stage: 'prepare' }) }))
  expect(f.create).not.toHaveBeenCalled(); expect(f.agentInput).not.toHaveBeenCalled()
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + f.server.path, 'space', 'inspect', '--operation-id', f.input.operationId], objectCliEnvironment(f.root))
  // CLI retains the business-unknown exit status while returning a successful
  // read and the exact original diagnostic; unknown is not a completed Agent.
  expect(cli.code, cli.stderr + '\n' + cli.stdout).toBe(1)
  const response = JSON.parse(cli.stdout)
  expect(response.ok).toBe(true)
  const report = response.result.request.report
  expect(report.agent).toBeNull()
  expect(report.execution).toEqual(initial.execution)
  expect(report.issues).toContainEqual(expect.objectContaining({ step: 'observation', code: 'AGENT_CREATION_UNKNOWN' }))
  expect(f.bindings.admit).toHaveBeenCalledTimes(1); expect(f.bindings.continueOriginal).toHaveBeenCalledTimes(1)
  expect(f.create).not.toHaveBeenCalled(); expect(f.agentInput).not.toHaveBeenCalled()
})

it('a managed observer cannot obtain protected binding facts through Source inspection and its error is not a creation failure', async () => {
  const f = await fixture(); f.pending(); await f.rpc.call('agent.open', f.input)
  const count = f.bindings.inspect.mock.calls.length
  const value = await f.control({ operation: 'space.inspect', target: { requestId: f.input.operationId } } as never,
    { transport: 'unix', principal: { kind: 'user', id: 'private-local-user' }, caller: { agentSessionId: 'managed-observer', capability: 'private-fixture-capability' } } as never)
  expect(value?.operation).toBe('space.inspect')
  const report = value?.operation === 'space.inspect' ? value.request?.report : undefined
  expect(report?.execution).toMatchObject({ inspection: null, diagnostics: null })
  expect(report?.issues.some(item => item.code === 'CONTROL_PERMISSION_DENIED' && item.step === 'creation')).toBe(false)
  expect(f.bindings.inspect.mock.calls.length).toBe(count)
  expect(f.bindings.admit).toHaveBeenCalledTimes(1); expect(f.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.create).not.toHaveBeenCalled()
})

it('the public Source codec refuses another creation inside either the original continuation or preparation failure', async () => {
  const f = await fixture(); f.pending()
  const original = await f.rpc.call('agent.open', f.input)
  const changedContinuation = structuredClone(original)
  changedContinuation.execution!.inspection!.continuation!.createOperationId = 'another-original-operation'
  expect(() => parseRpcControlResult('agent.open', changedContinuation, f.input)).toThrow('another original creation')
  const changedFailure = structuredClone(original)
  const failure = changedFailure.issues.find(item => item.executionFailure)!
  failure.executionFailure!.reference.createOperationId = 'another-original-operation'
  expect(() => parseRpcControlResult('agent.open', changedFailure, f.input)).toThrow('another original creation')
  expect(f.bindings.admit).toHaveBeenCalledTimes(1); expect(f.create).not.toHaveBeenCalled(); expect(f.agentInput).not.toHaveBeenCalled()
})

it('the public Source codec rejects a wrong-SID failure against a confirmed Agent even when the execution view is absent', async () => {
  const f = await fixture(), original = await f.rpc.call('agent.open', f.input)
  const { execution: _execution, ...withoutExecution } = original
  const value = { ...withoutExecution, issues: [{ step: 'creation', code: 'EXECUTION_CREATION_UNCONFIRMED', message: 'Original failure', recovery: 'Inspect the original request.',
    executionFailure: { reference: { bindingId: 'wrong-binding', agentSessionId: 'wrong-agent', createOperationId: f.input.operationId }, hostId: 'D-in-B', role: 'agent', stage: 'create' } }] }
  expect(() => parseRpcControlResult('agent.open', value, f.input)).toThrow('another original creation')
  expect(original.agent?.agentSessionId).toBe('original-d-session')
})

it('the public Source describes its actual owner and preserves complete CLI launch fields into the foreign child', async () => {
  const f = await fixture()
  expect(await f.rpc.call('agent.open.describe', { expectedRuntimeId: 'runtime-b' })).toEqual({
    source: { runtimeId: 'runtime-b', ownerInstanceId: 'instance-b' }, contracts: { ordinaryLaunch: { revision: 1, destination: 'source-zone-background' }, externalAssociation: 1, takeover: 1 } })
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
  expect(f.frozen()).toEqual(original); expect(f.bindings.admit).toHaveBeenCalledTimes(1)
})
it('an old target creation handler cannot receive new Source fields after helper Start, while original reads stay independent', async () => {
  const f = await fixture()
  f.client.listHostExecutors.mockResolvedValueOnce({ runtimeId: 'runtime-d', executors: [{ executorId: 'd-executor', configRevision: 'd'.repeat(64) }] } as never)
  await expect(f.rpc.call('agent.open', f.input)).rejects.toMatchObject({ code: 'AGENT_OPEN_CONTRACT_UNCONFIRMED' })
  expect(f.create).not.toHaveBeenCalled(); expect(f.bindings.admit).not.toHaveBeenCalled()
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
  expect(original.execution).toMatchObject({ hostId: 'D-in-B', runtimeId: 'runtime-d', workspaceId: null, workspacePath: f.locatorWorkspacePath, executorRevision: 'd'.repeat(64) })
  expect(state.graph.zones[0]!.directoryPath).toBe('/b/project')
  expect(f.frozen()).toMatchObject({ agentHostId: 'D-in-B', agentRuntimeId: 'runtime-d', resourceHostId: 'local', resourceRuntimeId: 'runtime-b', resourceWorkspacePath: '/b/project', agent: { workspacePath: f.locatorWorkspacePath } })
  expect(f.client.inspectAgentCreation).toHaveBeenCalledWith('original-d-session')
  expect(f.client.hostEnvironment).toHaveBeenCalledExactlyOnceWith({ agentSessionId: 'original-d-session' })
  expect(f.client.inspectAgentCreation.mock.invocationCallOrder[0]).toBeLessThan(f.client.hostEnvironment.mock.invocationCallOrder[0]!)
  const snapshot = await readSpaceSnapshot(f.rpc, { runtimeId: 'runtime-b', spaceId: f.folder.spaceId })
  expect(snapshot.scope.regions).toMatchObject([{ execution: { hostId: 'D-in-B', runtimeId: 'runtime-d', cwd: f.locatorWorkspacePath }, runId: 'original-d-run' }])
  await f.rpc.call('agent.open', f.input)
  expect(f.bindings.admit).toHaveBeenCalledTimes(1); expect(f.client.listHostExecutors).toHaveBeenCalledTimes(1)
  expect(f.client.hostEnvironment).toHaveBeenCalledExactlyOnceWith({ agentSessionId: 'original-d-session' })
  expect(f.bindings.continueOriginal).toHaveBeenCalledTimes(1)
  expect(f.runtime.client.inspectAgentCreation).not.toHaveBeenCalled()
})
it('an explicit same-operation continuation uses only the original frozen binding while B placement stays independent of D home', async () => {
  const f = await fixture(); f.pending()
  expect(await f.rpc.call('agent.open', f.input)).toMatchObject({ outcome: 'unknown' })
  const admitted = spatialAgentOpenRecord((await f.spatial.read())!.graph, f.input.operationId)!
  expect(admitted.executionBinding).toEqual({ bindingId: f.frozen()!.bindingId, agentSessionId: 'original-d-session', createOperationId: f.input.operationId })
  f.client.listHostExecutors.mockRejectedValue(Error('Current inventory cannot replace a frozen executor.'))
  f.client.hostEnvironment.mockRejectedValue(Error('A continuation cannot recompute its frozen Agent locator.'))
  expect(await f.rpc.call('agent.open', f.input)).toMatchObject({ outcome: 'opened', agent: { runId: 'original-d-run' } })
  expect(f.bindings.admit).toHaveBeenCalledTimes(1); expect(f.bindings.continueOriginal).toHaveBeenCalledTimes(2)
  expect(f.client.listHostExecutors).toHaveBeenCalledTimes(1)
  expect(f.client.hostEnvironment).toHaveBeenCalledExactlyOnceWith({ agentSessionId: 'original-d-session' })
  expect(f.create).toHaveBeenCalledTimes(1)
})
it('a same-Runtime explicit target keeps the Source project cwd without an environment read', async () => {
  const f = await fixture()
  vi.mocked(f.runtime.executionHost).mockImplementation(async () => ({ runtimeId: 'runtime-b', client: f.client } as never))
  Object.assign(f.runtime.client, { inspectAgentCreation: f.client.inspectAgentCreation, agentCreationAuthority: async () => ({ runtimeId: 'runtime-b' }) })
  f.client.listHostExecutors.mockResolvedValue({ runtimeId: 'runtime-b', executors: [{ executorId: 'd-executor', configRevision: 'd'.repeat(64), creationContract: { ordinaryLaunch: 1 } }] } as never)
  const input = { ...f.input, content: { ...f.input.content, agentTarget: { ...f.input.content.agentTarget!, runtimeId: 'runtime-b' } } }
  await expect(f.rpc.call('agent.open', input)).resolves.toMatchObject({ outcome: 'opened', agent: { runId: 'original-d-run' } })
  expect(spatialAgentOpenRecord((await f.spatial.read())!.graph, input.operationId)?.execution).toMatchObject({ runtimeId: 'runtime-b', workspacePath: '/b/project', workspaceId: 'b-workspace' })
  expect(f.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspacePath: '/b/project' }))
  expect(f.client.hostEnvironment).not.toHaveBeenCalled(); expect(f.bindings.admit).not.toHaveBeenCalled()
})
it.each(['agent', 'retired-agent'] as const)('an existing %s reply is returned before any selected locator read', async kind => {
  const f = await fixture()
  await f.create({ agentSessionId: 'original-d-session', createOperationId: f.input.operationId, executorId: 'd-executor',
    executorRevision: 'd'.repeat(64), workspacePath: '/d/original-agent-workspace' })
  if (kind === 'retired-agent') f.retire('matching')
  f.create.mockClear()
  f.client.hostEnvironment.mockRejectedValue(new AgentMuxError('An existing creation must not require the selected locator.', 'REMOTE_CORE_UPGRADE_REQUIRED'))
  const report = await f.rpc.call('agent.open', f.input)
  expect(report).toMatchObject({ outcome: kind === 'retired-agent' ? 'retired' : 'unknown' })
  expect(f.client.inspectAgentCreation).toHaveBeenCalledExactlyOnceWith('original-d-session')
  expect(f.client.hostEnvironment).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled(); expect(f.bindings.admit).not.toHaveBeenCalled(); expect(f.bindings.continueOriginal).not.toHaveBeenCalled()
  expect(spatialAgentOpenRecord((await f.spatial.read())!.graph, f.input.operationId)).toBeNull()
})
it('an unsupported selected locator fails before admission without home retry or changing a healthy sibling', async () => {
  const f = await fixture()
  await expect(f.rpc.call('agent.open', f.input)).resolves.toMatchObject({ outcome: 'opened', agent: { runId: 'original-d-run' } })
  const before = await readFile(f.spatial.path, 'utf8'), input = { ...f.input, operationId: 'selected-locator-unsupported' }
  f.client.inspectAgentCreation.mockRejectedValueOnce(new AgentMuxError('No original creation exists for this new operation.', 'AGENT_CREATION_UNKNOWN'))
  f.client.hostEnvironment.mockRejectedValueOnce(new AgentMuxError('The selected target cannot resolve an exact Agent workspace.', 'REMOTE_CORE_UPGRADE_REQUIRED'))
  await expect(f.rpc.call('agent.open', input)).rejects.toMatchObject({ code: 'REMOTE_CORE_UPGRADE_REQUIRED' })
  expect(f.client.hostEnvironment).toHaveBeenCalledTimes(2)
  expect(f.client.hostEnvironment.mock.calls).toEqual([[{ agentSessionId: 'original-d-session' }], [{ agentSessionId: 'original-d-session' }]])
  expect(f.bindings.admit).toHaveBeenCalledOnce(); expect(f.bindings.continueOriginal).toHaveBeenCalledOnce(); expect(f.create).toHaveBeenCalledOnce()
  expect(f.starts).not.toHaveBeenCalled(); expect(f.agentInput).not.toHaveBeenCalled()
  expect(spatialAgentOpenRecord((await f.spatial.read())!.graph, input.operationId)).toBeNull()
  expect(await readFile(f.spatial.path, 'utf8')).toBe(before)
  await expect(f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } })).resolves.toMatchObject({ request: { report: { outcome: 'opened', agent: { runId: 'original-d-run' } } } })
  expect(f.client.hostEnvironment).toHaveBeenCalledTimes(2); expect(f.bindings.admit).toHaveBeenCalledOnce(); expect(f.create).toHaveBeenCalledOnce()
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
  expect(inspected.request?.report?.issues).toContainEqual(expect.objectContaining({ step: 'observation', code: 'EXECUTION_READER_UNAVAILABLE' }))
  expect(inspected.request?.report?.issues.some(item => item.step === 'creation' && item.code === 'EXECUTION_READER_UNAVAILABLE')).toBe(false)
  expect(f.bindings.continueOriginal).toHaveBeenCalledTimes(1)
  const result = await f.rpc.call('agent.open', structuredClone(f.input))
  expect(f.bindings.continueOriginal).toHaveBeenLastCalledWith(original.executionBinding, expect.anything())
  expect(result).toMatchObject({ outcome: 'opened', operationId: f.input.operationId,
    agent: { agentSessionId: first.agent!.agentSessionId, runId: first.agent!.runId }, to: first.to })
  expect(f.bindings.admit).toHaveBeenCalledTimes(1); expect(f.create).toHaveBeenCalledTimes(1)
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
  expect(f.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.agentInput).not.toHaveBeenCalled()
  expect((await f.spatial.read())!.graph.regions).toMatchObject([{ kind: 'agent', agentSessionId: first.agent!.agentSessionId, runId: first.agent!.runId }])
})
it('a same-SID binding receipt for another creation operation cannot complete the original partial request', async () => {
  const f = await fixture(); f.partialAfterStart()
  const first = await f.rpc.call('agent.open', f.input)
  const binding = await f.bindings.inspect(f.frozen()!.bindingId)
  if (!binding) throw Error('The fixture must retain its original binding.')
  const { diagnostic: _diagnostic, ...connected } = binding
  f.bindings.inspect.mockResolvedValueOnce({ ...connected, state: 'connected',
    continuation: { ...binding.continuation, createOperationId: 'another-creation-operation' } })
  const result = await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } })
  expect(result.request?.report).toMatchObject({ outcome: 'partial', agent: first.agent, to: first.to })
  expect(result.request?.report?.issues).toContainEqual(expect.objectContaining({ code: 'EXECUTION_INTENT_UNCONFIRMED' }))
  expect(f.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.agentInput).not.toHaveBeenCalled()
})
it('a changed original B Zone rejects only the replay and retains the admitted operation without dispatching a new binding', async () => {
  const f = await fixture(); f.pending(); await f.rpc.call('agent.open', f.input)
  const state = (await f.spatial.read())!
  await f.spatial.commit({ expectedRevision: state.revision, graph: { ...state.graph, zones: state.graph.zones.map(zone => ({ ...zone, directoryPath: '/changed-b-project' })) } })
  const before = await readFile(f.spatial.path, 'utf8')
  await expect(f.rpc.call('agent.open', f.input)).rejects.toMatchObject({ code: 'SPACE_TARGET_CHANGED' })
  expect(f.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.bindings.admit).toHaveBeenCalledTimes(1)
  expect(await readFile(f.spatial.path, 'utf8')).toBe(before)
})
it('a changed D Runtime and a managed self-grant cannot turn the retained Space into another execution target', async () => {
  const f = await fixture(); f.changeRuntime()
  await expect(f.rpc.call('agent.open', f.input)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(f.bindings.admit).not.toHaveBeenCalled(); expect((await f.spatial.read())!.graph.regions).toEqual([])
  await expect(f.control({ schemaVersion: 5, requestId: f.input.operationId, operation: 'agent.open', ...f.input } as never,
    { transport: 'unix', principal: { kind: 'user', id: 'test-owner' }, caller: {} as never })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.bindings.admit).not.toHaveBeenCalled()
})

it('a retained foreign creation without its original Runtime pin remains unconfirmed instead of reading a local same-SID creation', async () => {
  const f = await fixture(), operationId='legacy-foreign-original', sid='same-legacy-sid'
  const admitted = await f.spatial.admitAgentOpen({request:{schemaVersion:5,operation:'agent.open',requestId:operationId,
    content:{kind:'new-agent',executorId:'d-executor',executionWorkspaceId:'d-original-workspace'},
    destination:{spaceId:f.folder.spaceId,zoneId:f.folder.zoneId,newTab:true},focus:false},agentSessionId:sid,
    execution:{hostId:'D-in-B',workspacePath:'/d/home',workspaceId:'d-original-workspace'},regionResource:{}})
  vi.mocked(f.runtime.client.inspectAgentCreation).mockResolvedValue({kind:'agent',agentSessionId:sid,hostId:'local',providerId:'codex',executorId:'d-executor',workspacePath:'/d/home',run:{runId:'different-local-run'},retiredRuns:[],createdAt:1,updatedAt:1,
    creation:{createOperationId:operationId,createdRun:{runId:'different-local-run'},initialPrompt:'not-requested'}})
  const before=await readFile(f.spatial.path,'utf8'),result=await f.rpc.call('space.inspect',{target:{operationId}})
  expect(result.request?.report).toMatchObject({outcome:'unknown',agent:null,issues:[expect.objectContaining({code:'SPATIAL_CREATION_UNCONFIRMED'})]})
  expect(f.runtime.client.inspectAgentCreation).not.toHaveBeenCalled();expect(f.runtime.executionHost).not.toHaveBeenCalled()
  expect(await readFile(f.spatial.path,'utf8')).toBe(before)
  expect((await f.spatial.read())!.graph.regions).toMatchObject([{regionId:admitted.record.address.regionId,agentSessionId:sid,runId:null}])
})


it('an empty optional Source context does not add a contract gate to the original prompt-only creation', async () => {
  const f = await fixture('')
  f.client.listHostExecutors.mockResolvedValueOnce({runtimeId:'runtime-d',executors:[{executorId:'d-executor',configRevision:'d'.repeat(64)}]} as never)
  expect(await f.rpc.call('agent.open',f.input)).toMatchObject({outcome:'opened'})
  expect(f.frozen()!.agent).not.toHaveProperty('sourceAgentMuxNote');expect(f.bindings.admit).toHaveBeenCalledTimes(1)
})


it('the background local Host creator preserves the same ordinary fields without going through a foreign coordinator', async () => {
  const f = await fixture()
  await writeFile(join(f.root,'unused-local-executor-config.json'),JSON.stringify({executors:{'d-executor':{label:'Original',providerId:'codex',command:'codex',args:[],env:{},injectAgentMuxGuide:false}}}))
  const create = vi.fn(async (input: import('../src/client-contract.js').AgentMuxAgentCreateInput) => {
    if (!input.agentSessionId || !input.createOperationId) throw Error('Original local creation identities are required')
    return await f.create({...input,agentSessionId:input.agentSessionId,createOperationId:input.createOperationId,executorRevision:'local-config-revision'})
  })
  Object.assign(f.runtime.client,{resolveAgentCreationSessionId:f.client.resolveAgentCreationSessionId,inspectAgentCreation:f.client.inspectAgentCreation,createHostAgentWithDelivery:create,
    listHostExecutors:async()=>({runtimeId:'runtime-b',executors:[{executorId:'d-executor',configRevision:'local-config-revision',creationContract:{ordinaryLaunch:1}}]}),
    agentCreationAuthority:async()=>({runtimeId:'runtime-b'})})
  const {agentTarget:_target,...content} = f.input.content
  const fields = {agentMuxNote:'  caller note\n',launchOptions:{model:'selected'},cols:117,rows:39}
  const result = await f.rpc.call('agent.open',{...f.input,content:{...content,...fields,prompt:'  original task\n'}})
  expect(result, JSON.stringify(result.issues)).toMatchObject({outcome:'opened'})
  expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({...fields,prompt:'  original task\n',sourceAgentMuxNote:'  Source business context\n'}))
  expect(f.runtime.executionHost).not.toHaveBeenCalled();expect(f.bindings.admit).not.toHaveBeenCalled()
})


it('an original launch with ordinary fields continues its frozen binding without a new description gate', async () => {
  const f = await fixture();f.partialAfterStart()
  const request = {...f.input,content:{...f.input.content,agentMuxNote:'original caller note',cols:117}}
  expect(await f.rpc.call('agent.open',request)).toMatchObject({outcome:'partial'})
  const original = structuredClone(f.frozen());delete f.control.describe
  f.client.listHostExecutors.mockRejectedValue(Error('Current discovery cannot replace an original creation.'))
  expect(await f.rpc.call('agent.open',request)).toMatchObject({outcome:'opened',agent:{runId:'original-d-run'}})
  expect(f.bindings.admit).toHaveBeenCalledTimes(1);expect(f.bindings.continueOriginal).toHaveBeenCalledTimes(2);expect(f.frozen()).toEqual(original)
})

it('the actual Host admissions keep two same-SID same-Run creation pins distinct at the Source resolver', async () => {
 const f=await fixture(),one=await f.rpc.call('agent.open',f.input),two=await f.rpc.call('agent.open',{...f.input,operationId:'other-source-C'})
 expect(one.agent?.agentSessionId).toBe(two.agent?.agentSessionId);expect(one.agent?.runId).toBe(two.agent?.runId)
 const {resolveSpaceMember}=await import('../src/space-member-owner.js')
 const target={reference:{runtimeId:'runtime-b',spaceId:f.folder.spaceId},regionId:one.to!.regionId,runtimeId:'runtime-d',agentSessionId:one.agent!.agentSessionId,expectedRun:{runId:one.agent!.runId!},expectedAdmission:{kind:'creation' as const,operationId:f.input.operationId}}
 expect(await resolveSpaceMember(f.spatial,target)).toMatchObject({createOperationId:f.input.operationId})
 await expect(resolveSpaceMember(f.spatial,{...target,expectedAdmission:{kind:'creation',operationId:'other-source-C'}})).rejects.toMatchObject({code:'SPACE_MEMBER_ADMISSION_UNCONFIRMED'})
 expect(f.agentInput).not.toHaveBeenCalled();expect(f.create).toHaveBeenCalledTimes(1)
})

it.each(['matching','missing','other-creation'] as const)('the public Source retains exact retirement history and does not substitute missing facts (%s)', async history => {
  const f = await fixture(); f.pending(); await f.rpc.call('agent.open', f.input)
  await f.create(f.frozen()!.agent); f.retire(history)
  const result = await f.rpc.call('space.inspect', { target: { operationId: f.input.operationId } })
  const report = result.request!.report!
  if (history === 'matching') expect(report).toMatchObject({ outcome: 'retired', to: null, agent: { agentSessionId: 'original-d-session', runId: 'original-d-run', createOperationId: f.input.operationId, retirement: { source: 'user', observedAt: 2 } } })
  else expect(report).toMatchObject({ outcome: 'unknown', agent: null, issues: expect.arrayContaining([expect.objectContaining({ code: 'AGENT_CREATION_UNCONFIRMED' })]) })
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.bindings.admit).toHaveBeenCalledTimes(1)
  expect(f.bindings.continueOriginal).toHaveBeenCalledTimes(1); expect(f.agentInput).not.toHaveBeenCalled()
})
