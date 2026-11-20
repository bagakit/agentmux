import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createTakeoverOwnerFixture } from './helpers/takeover-owner.js'
import { spatialAgentOpenDigest, spatialAgentOpenRecord, type AgentMuxSpatialAgentOpenRequest } from '../src/spatial-agent-open.js'
import { AgentMuxError } from '../src/errors.js'
import { ScratchTopics } from '../../../apps/host/src/mote-resources.js'
import { registerKnowledgeTopic, TopicSpatialOwner } from '../../../apps/host/src/topic-spatial-owner.js'
import { topicContentSpaceId, topicContentZoneId } from '../../../apps/host/src/topic-categories.js'
import { mintObjectId } from '../src/object-id.js'
import type { AgentMuxHostAgentCreateInput } from '../src/client-contract.js'
import { createHostSpatialAgentControl } from '../../../apps/host/src/spatial-agent-control.js'
import { AgentExecutionBindingService, type AgentExecutionOpenInput } from '../src/agent-execution-coordinator.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
type Owner = Awaited<ReturnType<typeof createTakeoverOwnerFixture>>
const fixture = () => createTakeoverOwnerFixture(cleanup)
const inputFor = (f: Owner, operationId: string) => ({ operationId,
  content: { kind: 'takeover-agent' as const, executorId: 'codex', agentMuxNote: 'Original caller-authored note.',
    source: { hostId: 'local', expectedRuntimeId: f.owner.runtimeId, agentSessionId: f.source.agentSessionId, expectedRun: f.source.run, organization: { runtimeId: f.owner.runtimeId, spaceId: f.a.spaceId } } },
  destination: { spaceId: f.b.spaceId, zoneId: f.b.zoneId, displayWorkspaceId: 'project-a', groupId: 'original-group', newTab: true }, focus: false })
const interrupt = (f: Owner) => vi.spyOn(f.client, 'createSpatialHostAgentWithDelivery').mockRejectedValueOnce(new AgentMuxError('Private interruption before the original creator.', 'PRIVATE_PRE_CREATOR_INTERRUPTION'))
const originalRecord = async (f: Owner, id: string) => spatialAgentOpenRecord((await f.spatial.read())!.graph, id)!

it('explicit continuation advances a C-only original Takeover exactly once while inspect stays read-only', async () => {
  const f = await fixture(), input = inputFor(f, 'continue-original-c'), creator = interrupt(f)
  const first = await f.rpc.call('agent.open', input), record = await originalRecord(f, input.operationId)
  expect(first.outcome).toBe('unknown'); expect(record.takeoverSourceAgentMuxNote).toContain('read-via="agent context --help"'); expect(record.takeoverOptionalContext).toBeUndefined()
  expect(record.takeoverContent!.agentMuxNote).toBe(input.content.agentMuxNote)
  const original = await readFile(f.spatial.path, 'utf8')
  await f.rpc.call('space.inspect', { target: { operationId: input.operationId } })
  expect(creator).toHaveBeenCalledTimes(1); expect(f.started).toHaveLength(0); expect(await readFile(f.spatial.path, 'utf8')).toBe(original)
  // No current source/profile/inventory read can replace the already frozen C.
  await writeFile(f.configurationPath, JSON.stringify({ profile: { displayName: 'Changed profile', about: 'New settings', avatar: '', shareWithAgents: true } }))
  const readSource = vi.spyOn(f.client, 'readAgentSession'), inventory = vi.spyOn(f.client, 'listHostExecutors').mockRejectedValue(Error('An accepted C does not reread inventory.'))
  const next = await f.rpc.call('agent.open', input)
  expect(next.outcome, JSON.stringify(next)).toBe('opened'); expect(next.agent!.agentSessionId).toBe(record.agentSessionId)
  expect(next.agent!.takeover).toEqual(record.takeover); expect(f.started).toHaveLength(1)
  expect(creator.mock.calls[1]![0]).toEqual(creator.mock.calls[0]![0]); expect(inventory).not.toHaveBeenCalled()
  expect(readSource.mock.calls.some(args => args[0] === f.source.agentSessionId)).toBe(false)
  const writes = f.submit.mock.calls.length
  await f.rpc.call('space.inspect', { target: { operationId: input.operationId } }); await f.rpc.call('agent.open', input)
  expect(f.started).toHaveLength(1); expect(f.submit).toHaveBeenCalledTimes(writes)
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})

it('a real Club freezes its original Profile, Topic instructions and optional context before C admission', async () => {
  const f = await fixture(), workspace = { id: '__scratch__', hostId: 'local', path: join(f.root, 'scratch') }, topics = new ScratchTopics()
  const topic = await topics.ensureMote(workspace, mintObjectId()), home = topic.physicalDirectoryPath!
  const category = { categoryId: mintObjectId(), title: 'Original category', hostId: 'local', spaceId: mintObjectId(), directoryPath: join(f.root, 'category'), revision: null }
  const state = (await f.spatial.read())!, graph = state.graph
  registerKnowledgeTopic(graph, workspace, topic, category)
  await f.spatial.commit({ expectedRevision: state.revision, graph })
  const topology = new TopicSpatialOwner({ state: f.spatial, workspace: () => workspace, topics: async () => [topic], categories: async () => [category], ensureDefaultCategory: async () => category })
  await topology.promoteTopic(topic, { zoneId: topicContentZoneId(workspace, topic), contentIdentity: topicContentSpaceId(workspace, topic) })
  await writeFile(join(home, 'AGENTS.md'), 'Original Club instructions.'); await writeFile(join(home, 'MEMORY.md'), 'Original Club memory.')
  const soul = await readFile(join(home, 'SOUL.md'), 'utf8')
  await writeFile(f.configurationPath, JSON.stringify({ workspaces: [workspace], promotion: { enabled: true }, profile: { displayName: 'Original name', about: 'Original profile.', avatar: '', shareWithAgents: true } }))
  const input = { ...inputFor(f, 'frozen-club-c'), destination: { ...inputFor(f, 'unused').destination, spaceId: topicContentSpaceId(workspace, topic), zoneId: topicContentZoneId(workspace, topic) } }, creator = interrupt(f)
  const first = await f.rpc.call('agent.open', input), record = await originalRecord(f, input.operationId)
  expect(first.outcome).toBe('unknown'); expect(record.takeoverSourceAgentMuxNote).toContain('Original profile.')
  expect(record.takeoverOptionalContext!.some(item => item.text.includes('Original Club instructions.'))).toBe(true)
  expect(record.takeoverOptionalContext!.some(item => item.text.includes('Original Club memory.'))).toBe(true)
  await writeFile(join(home, 'AGENTS.md'), 'Changed instructions.'); await writeFile(join(home, 'MEMORY.md'), 'Changed memory.'); await writeFile(join(home, 'SOUL.md'), soul + '\nChanged personality.\n')
  await writeFile(f.configurationPath, JSON.stringify({ workspaces: [workspace], promotion: { enabled: false }, profile: { displayName: 'Changed name', about: 'Changed profile.', avatar: '', shareWithAgents: true } }))
  const continued = await f.rpc.call('agent.open', input)
  expect(continued.outcome, JSON.stringify(continued)).toBe('opened'); expect(f.started).toHaveLength(1)
  expect(creator.mock.calls[1]![0]).toEqual(creator.mock.calls[0]![0])
  const contribution = JSON.stringify(creator.mock.calls[1]![0])
  expect(contribution).toContain('Original profile.'); expect(contribution).not.toContain('Changed profile.'); expect(contribution).not.toContain('Changed instructions.'); expect(contribution).not.toContain('Changed memory.'); expect(contribution).not.toContain('Changed personality.')
  expect((await originalRecord(f, input.operationId))).toEqual(record)
})

it('the trusted original C rejects every changed context contribution before dispatch', async () => {
  const f = await fixture(), input = inputFor(f, 'context-integrity'), creator = interrupt(f)
  await f.rpc.call('agent.open', input)
  const frozen = creator.mock.calls[0]![0]
  const changes: Partial<AgentMuxHostAgentCreateInput>[] = [
    { sourceAgentMuxNote: 'Unrecorded source note.' }, { optionalContext: [{ text: 'Unrecorded context.', omittedText: 'Unrecorded omission.' }] },
    { agentMuxNote: 'Changed caller note.' }, { agentMuxTask: 'Unrecorded task.' }, { spatialIntent: { ...frozen.spatialIntent!, executionWorkspaceId: 'unrecorded-workspace' } }
  ]
  for (const change of changes) await expect(f.client.createSpatialHostAgentWithDelivery({ ...frozen, ...change }, f.spatial)).rejects.toMatchObject({ code: 'AGENT_TAKEOVER_ADMISSION_UNCONFIRMED' })
  expect(f.started).toHaveLength(0)
  expect((await f.rpc.call('agent.open', input)).outcome).toBe('opened'); expect(f.started).toHaveLength(1)
})

it('an admitted Executor revision cannot be replaced when a C-only Takeover continues', async () => {
  const f = await fixture(), input = inputFor(f, 'frozen-executor'), creator = interrupt(f)
  await f.rpc.call('agent.open', input)
  const record = await originalRecord(f, input.operationId)
  await f.inner.hostExecutorOwner.configure({ executorId: 'codex', expectedRevision: record.execution.executorRevision, config: { label: 'Changed executor', providerId: 'codex', command: 'codex', args: ['--changed'], env: {}, injectAgentMuxGuide: false } })
  const result = await f.rpc.call('agent.open', input)
  expect(result.outcome).toBe('unknown'); expect(result.issues.some(item => item.code === 'EXECUTOR_REVISION_CONFLICT')).toBe(true)
  expect(creator.mock.calls[1]![0]).toEqual(creator.mock.calls[0]![0]); expect(f.started).toHaveLength(0)
  expect(await originalRecord(f, input.operationId)).toEqual(record); expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})

it('an explicit execution target on this Runtime freezes its original reference and continues through the same original C', async () => {
  const f = await fixture(), base = inputFor(f, 'same-runtime-target'), input = { ...base, content: { ...base.content, agentTarget: { hostId: 'local', runtimeId: f.owner.runtimeId } } }
  Object.assign(f.runtime, { executionHost: async () => ({ runtimeId: f.owner.runtimeId, client: f.client }) })
  const creator = interrupt(f)
  expect((await f.rpc.call('agent.open', input)).outcome).toBe('unknown')
  const record = await originalRecord(f, input.operationId)
  expect(record.takeoverSourceAgentMuxNote).toContain('read-via="agent context --help"'); expect(record.executionBinding).toBeUndefined()
  const result = await f.rpc.call('agent.open', input)
  expect(result.outcome, JSON.stringify(result)).toBe('opened'); expect(result.agent!.agentSessionId).toBe(record.agentSessionId)
  expect(creator.mock.calls[1]![0]).toEqual(creator.mock.calls[0]![0]); expect(f.started).toHaveLength(1)
  await f.rpc.call('agent.open', input); expect(f.started).toHaveLength(1)
})

it('rechecks the complete frozen split Takeover input from its retained placement before continuation', async () => {
  const f = await fixture(), base = inputFor(f, 'split-takeover-admission'), target = { hostId: 'agent-host', runtimeId: 'agent-runtime' }
  const input = { ...base, content: { ...base.content, agentTarget: target } }
  const resolveHost = vi.fn(async () => { throw new AgentMuxError('Isolated helper route unavailable.', 'CONTROL_CONNECTION_FAILED') })
  const bindings = new AgentExecutionBindingService(join(f.root, 'execution-bindings'), { resolveHost },
    { spatial: f.spatial, runtimeId: () => f.owner.runtimeId })
  cleanup.push(() => bindings.dispose())
  const admit = bindings.admit.bind(bindings), received: AgentExecutionOpenInput[] = []
  vi.spyOn(bindings, 'admit').mockImplementation(async (...args) => {
    received.push(args[0])
    if (received.length === 1) {
      // Retain a foreign-shaped intent with the same address and original
      // spatial digest, but without the actual frozen Agent input or provenance.
      await admit({ ...args[0], agent: { ...args[0].agent, prompt: 'Different stored input' } }, args[1])
      throw new AgentMuxError('Original admission reply interrupted.', 'CONTROL_CONNECTION_FAILED')
    }
    return await admit(...args)
  })
  const client = {
    resolveAgentCreationSessionId: async () => 'split-original-agent',
    listHostExecutors: async () => ({ runtimeId: target.runtimeId, executors: [{ executorId: 'codex', providerId: 'codex', configRevision: 'split-original-revision', creationContract: { ordinaryLaunch: 1 } }] }),
    inspectAgentCreation: async () => { throw new AgentMuxError('No matching target Agent yet.', 'AGENT_CREATION_UNKNOWN') },
    hostEnvironment: async () => ({ agentWorkspace: { workspacePath: f.directory } }),
    readAgentInputEpoch: async () => undefined
  }
  Object.assign(f.runtime, { executionBindings: bindings, executionHost: async () => ({ runtimeId: target.runtimeId, client }) })
  await expect(f.rpc.call('agent.open', input)).rejects.toMatchObject({ code: 'CONTROL_CONNECTION_FAILED' })
  const record = await originalRecord(f, input.operationId)
  expect(record.executionBinding).toBeDefined()
  await expect(f.rpc.call('agent.open', input)).rejects.toMatchObject({ code: 'EXECUTION_BINDING_CONFLICT' })
  expect(received).toHaveLength(2)
  expect(received[1]).toEqual(received[0])
  expect(await originalRecord(f, input.operationId)).toEqual(record)
  expect(resolveHost).not.toHaveBeenCalled()
  expect(f.started).toHaveLength(0)
})

it.each([false, true])('a retained C without complete frozen context preserves its existing Agent state (%s) without reconstructing input', async completed => {
  const f = await fixture(), input = inputFor(f, 'unconfirmed-old-context'), creator = vi.spyOn(f.client, 'createSpatialHostAgentWithDelivery')
  if (!completed) creator.mockRejectedValueOnce(new AgentMuxError('Private pre-creator interruption.', 'PRIVATE_PRE_CREATOR_INTERRUPTION'))
  await f.rpc.call('agent.open', input)
  const record = await originalRecord(f, input.operationId), saved = { ...record }
  delete saved.takeoverSourceAgentMuxNote
  // Retain the original durable shape from before complete-context admissions.
  // This is private old-data fixture input, never a public layout writer bypass.
  const durable = JSON.parse(await readFile(f.spatial.path, 'utf8'))
  durable.graph.resources['core:agent-open'].requests[input.operationId] = saved
  await writeFile(f.spatial.path, JSON.stringify(durable) + '\n')
  creator.mockClear()
  await writeFile(f.configurationPath, JSON.stringify({ profile: { displayName: 'Current profile cannot reconstruct history', about: '', avatar: '', shareWithAgents: true } }))
  const observed = await f.rpc.call('space.inspect', { target: { operationId: input.operationId } }), continued = await f.rpc.call('agent.open', input)
  expect(continued.outcome).toBe(completed ? 'opened' : 'unknown'); expect(continued.agent).toEqual(observed.request!.report!.agent)
  expect(creator).not.toHaveBeenCalled(); expect(f.started).toHaveLength(completed ? 1 : 0)
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})

it('an already confirmed original Agent remains a read after its Executor configuration changes', async () => {
  const f = await fixture(), input = inputFor(f, 'healthy-original-c'), creator = vi.spyOn(f.client, 'createSpatialHostAgentWithDelivery')
  const first = await f.rpc.call('agent.open', input), record = await originalRecord(f, input.operationId)
  await f.inner.hostExecutorOwner.configure({ executorId: 'codex', expectedRevision: record.execution.executorRevision, config: { label: 'Changed executor', providerId: 'codex', command: 'codex', args: ['--changed'], env: {}, injectAgentMuxGuide: false } })
  creator.mockClear()
  const inventory = vi.spyOn(f.client, 'listHostExecutors').mockRejectedValue(Error('A healthy creation is already confirmed.'))
  const continued = await f.rpc.call('agent.open', input), inspected = await f.rpc.call('space.inspect', { target: { operationId: input.operationId } })
  expect(continued.outcome).toBe('opened'); expect(continued.agent).toEqual(first.agent); expect(inspected.request!.report!.agent).toEqual(first.agent)
  expect(creator).not.toHaveBeenCalled(); expect(inventory).not.toHaveBeenCalled(); expect(f.started).toHaveLength(1)
})

it('a Native-prepared creation with no confirmed Run stays unknown without repeating Start or input', async () => {
  const f = await fixture(), input = inputFor(f, 'native-unknown-c')
  const start = vi.spyOn(f.inner.kernel, 'start').mockRejectedValue(new AgentMuxError('Private Native Start acknowledgement is unknown.', 'PRIVATE_NATIVE_UNKNOWN'))
  vi.spyOn(f.inner.kernel, 'inspectCreation').mockResolvedValue(null)
  expect((await f.rpc.call('agent.open', input)).outcome).toBe('unknown')
  const record = await originalRecord(f, input.operationId)
  expect(await f.store.loadCreationCorrelation(record.agentSessionId)).not.toBeNull()
  await f.rpc.call('space.inspect', { target: { operationId: input.operationId } })
  await f.rpc.call('agent.open', input); await f.rpc.call('agent.open', input)
  expect(start).toHaveBeenCalledTimes(1); expect(f.submit).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})

it('trusted spatial composition preserves real caller authentication and provenance while public managed admission stays closed', async () => {
  const f = await fixture(), input = inputFor(f, 'original-person-c'), creator = interrupt(f)
  await f.rpc.call('agent.open', input)
  const original = await originalRecord(f, input.operationId)
  // Internal Host composition retains the real caller capability; this does
  // not open the public person/device-only Takeover admission to managed Agents.
  const request: AgentMuxSpatialAgentOpenRequest = { schemaVersion: 5, requestId: 'original-caller-c', operation: 'agent.open', content: input.content,
    destination: input.destination, focus: false, caller: { ...f.credentials, capability: 'wrong' } }
  const context = { principal: { kind: 'user' as const, id: 'private-original-user' }, agentTakeover: { requestId: request.requestId,
    requestDigest: spatialAgentOpenDigest(request), preparation: original.takeover!, prompt: original.takeoverContent!.prompt! } }
  const host = createHostSpatialAgentControl({ configurationPath: f.configurationPath, spatial: f.spatial, runtime: () => f.runtime as never })
  const refused = await host(request, context)
  expect(refused?.operation).toBe('agent.open')
  if (refused?.operation !== 'agent.open') throw Error('The original Host must return its creation report.')
  expect(refused.outcome).toBe('unknown'); expect(refused.issues.some(item => item.code === 'AGENT_CAPABILITY_INVALID')).toBe(true)
  expect(f.started).toHaveLength(0)
  const continued = await host({ ...request, caller: f.credentials }, context)
  if (continued?.operation !== 'agent.open') throw Error('The original Host must return its continuation report.')
  expect(continued.outcome, JSON.stringify(continued)).toBe('opened')
  const created = await f.client.readAgentSession(continued.agent!.agentSessionId)
  expect(created!.creation!.takeover).toEqual((await originalRecord(f, request.requestId)).takeover)
  expect(created!.creation!.createdBy!.agentSessionId).toBe(f.source.agentSessionId); expect(f.started).toHaveLength(1)
  await expect(f.rpc.call('agent.open', { ...input, operationId: 'managed-new-takeover' }, { credentials: f.credentials })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.started).toHaveLength(1); expect(await f.client.readAgentSession(f.source.agentSessionId)).toEqual(f.source)
})

it('independent Host and Core processes continue the original C after restart and never replay the completed creation', async () => {
  const f = await fixture(), input = inputFor(f, 'restart-original-c'), creator = interrupt(f)
  await f.rpc.call('agent.open', input)
  const record = await originalRecord(f, input.operationId), requestFile = join(f.root, 'original-takeover-input.json')
  await writeFile(requestFile, JSON.stringify(input))
  const worker = new URL('./fixtures/agent-takeover-continuation-worker.mjs', import.meta.url), loader = new URL('./fixtures/agent-takeover-source-loader.mjs', import.meta.url)
  const read = () => new Promise<Record<string, any>>((resolve, reject) => {
    const registration = `import { register } from 'node:module'; register(${JSON.stringify(loader.href)}, ${JSON.stringify(import.meta.url)});`
    const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(registration), worker.pathname, f.root, f.owner.runtimeId, requestFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Private continuation worker exceeded its deadline.')) }, 20000)
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', error => { clearTimeout(timer); reject(error) }); child.once('close', code => { clearTimeout(timer); if (code !== 0) reject(Error(stderr + stdout)); else try { resolve(JSON.parse(stdout)) } catch (error) { reject(error) } })
  })
  const first = await read(), second = await read()
  if (process.env.AGENTMUX_TEST_TAKEOVER_CONTINUATION_RESTART) await writeFile(process.env.AGENTMUX_TEST_TAKEOVER_CONTINUATION_RESTART,
    JSON.stringify({ schema: 'agentmux.takeover-continuation-restart.v1', parentPid: process.pid, operation: record, first, second }, null, 2) + '\n')
  expect(first.pid).not.toBe(process.pid); expect(second.pid).not.toBe(first.pid)
  expect(first.before).toMatchObject({ controls: 0, sameGraph: true, sameSource: true })
  expect(first.open).toMatchObject({ outcome: 'opened', agent: { agentSessionId: record.agentSessionId, takeover: record.takeover } }); expect(first.starts).toBe(1)
  expect(second.before).toMatchObject({ controls: 0, sameGraph: true, sameSource: true }); expect(second.open.agent).toEqual(first.open.agent)
  expect(second.starts).toBe(0); expect(second.inputs).toBe(0); expect(second.stops).toBe(0); expect(second.sourceUnchanged).toBe(true)
  expect(second.operation.takeoverSourceAgentMuxNote).toBe(record.takeoverSourceAgentMuxNote); expect(second.operation.address).toEqual(record.address)
  expect(first.creation).toEqual(second.creation); expect(f.started).toHaveLength(0); expect(creator).toHaveBeenCalledTimes(1)
})
