import { AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS } from '../../../packages/core/src/control.js'
import { observeSpaceSessionStates } from '../../../packages/core/src/space-session-stream.js'
import type { SpaceSessionsObservation } from '../../../packages/core/src/space-sessions.js'
import { pathToFileURL } from 'node:url'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createHostGoals } from '../src/goals.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import type { AgentProvider } from '../../../packages/core/src/agent-provider.js'
import type { AgentMuxHeadlessRuntime } from '../../../packages/core/src/headless-runtime.js'
import type { DemandSpaceMemberReference } from '@agentmux/demand/relations'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const d = await rpcOwnerFixture(['original-SID']); cleanup.push(d.close)
  expect(process.env.AGENTMUX_RUNTIME_DIRECTORY).toBe(d.root); expect(process.env.AGENTMUX_STATE_DIRECTORY).toBe(join(d.root, 'state'))
  const b = await rpcOwnerFixture(['B-namesake']); cleanup.push(b.close)
  expect(process.env.AGENTMUX_RUNTIME_DIRECTORY).toBe(b.root); expect(process.env.AGENTMUX_STATE_DIRECTORY).toBe(join(b.root, 'state'))
  expect(d.client.agentMessageQueuePath().startsWith(d.root + '/')).toBe(true)
  expect(b.client.agentMessageQueuePath().startsWith(b.root + '/')).toBe(true)
  expect(d.client.agentMessageQueuePath()).not.toBe(b.client.agentMessageQueuePath())
  const bOwner = { runtimeId: 'runtime-b', ownerInstanceId: 'original-B-instance', protocolVersion: 2 as const, processId: process.pid, availability: 'connected' as const, ctxmux: null }
  const dOwner = { ...bOwner, runtimeId: 'runtime-d', ownerInstanceId: 'original-D-instance' }
  const session = (await d.store.readMetadata('original-SID'))!, actor = { protocolId: 'public-goal-native', actorId: 'original-D-actor', lifecycleOperationId: 'original-lifecycle', token: 'b'.repeat(64), launch: { command: 'codex', args: [] } }
  await d.store.compareAndSwapMetadata(session, { ...session, nativeActor: actor, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-D-native' } })
  await d.inner.registry.load('local')
  d.inner.kernel.status = async (id: string) => ({ ...d.run(id), pid: 2345 })
  const raw = vi.fn(async () => { throw Error('A qualified Goal must never use terminal fallback') }), stop = vi.fn(); d.inner.kernel.input = raw; d.inner.kernel.stop = stop
  const provider = d.client.providers.get('codex'), previous = provider.prepareNativeInput
  const send = vi.fn<NonNullable<Awaited<ReturnType<NonNullable<AgentProvider['prepareNativeInput']>>>>['send']>(async () => ({ outcome: 'admitted', turnId: 'original-public-turn' }))
  provider.prepareNativeInput = async (_context, selected) => ({ plan: { kind: 'native-rpc', protocolId: actor.protocolId, actorId: actor.actorId, sourceId: JSON.stringify([selected.providerId, selected.nativeSessionId]), threadId: selected.nativeSessionId, operation: 'start-or-steer' }, assertCurrent: async () => {}, send, dispose: async () => {} })
  cleanup.push(() => { if (previous) provider.prepareNativeInput = previous; else delete provider.prepareNativeInput })
  const spatial = new AgentMuxSpatialStateStore(join(b.root, 'spatial.json')), folder = await spatial.registerFolder({ id: 'original-B-resource', hostId: 'local', name: 'Original B Project', path: '/original/B/project' })
  const admitted = await spatial.admitAgentOpen({ request: { schemaVersion: 5, requestId: 'original-C', operation: 'agent.open', content: { kind: 'new-agent', executorId: 'codex', agentTarget: { hostId: 'D-in-B', runtimeId: dOwner.runtimeId } }, destination: { spaceId: folder.spaceId, zoneId: folder.zoneId, newTab: true }, focus: false }, agentSessionId: session.agentSessionId,
    execution: { hostId: 'D-in-B', runtimeId: dOwner.runtimeId, executorRevision: 'original-executor-revision', workspacePath: d.root, workspaceId: null }, placement: { runtimeId: bOwner.runtimeId, hostId: 'local', workspacePath: '/original/B/project', workspaceId: 'original-B-resource' }, regionResource: {} })
  const reference: DemandSpaceMemberReference = { kind: 'space-member', source: { runtimeId: bOwner.runtimeId, spaceId: folder.spaceId, regionId: admitted.record.address.regionId, admission: { kind: 'creation', operationId: 'original-C' } }, execution: { runtimeId: dOwner.runtimeId, agentSessionId: session.agentSessionId } }
  const bHosted = new AgentMuxHostedRuntimeService(b.client, b.store.path, () => bOwner), dHosted = new AgentMuxHostedRuntimeService(d.client, d.store.path, () => dOwner)
  cleanup.push(() => bHosted.dispose(), () => dHosted.dispose())
  const socketPath = join(b.root, 'goal-public.sock'), dServer = new AgentMuxControlServer({ socketPath: join(d.root, 'execution.sock'), coreClients: d.coreClients, hostedRuntime: () => dHosted })
  await dServer.start(); cleanup.push(() => dServer.stop())
  const dRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: dServer.path } }); cleanup.push(() => dRpc.dispose())
  const configuredD = await connectHostedAgentMux({ rpc: dRpc, connectOnDemand: true, subscribeRpc: dRpc.subscribe.bind(dRpc), forwardRpc: (method, params, context = {}) => dRpc.call(method, params, { ...(context.signal === undefined ? {} : { signal: context.signal }), ...(context.caller === undefined ? {} : { credentials: context.caller }), ...(context.runtimeFence === undefined ? {} : { runtimeFence: context.runtimeFence }), ...(context.principal?.kind === 'device' ? { forwarding: context.forwarding! } : {}) }) }); cleanup.push(() => configuredD.dispose())
  const configurationPath = join(b.root, 'goal-config.json'); await writeFile(configurationPath, '{}')
  let goalServer!: AgentMuxControlServer
  const runtime = { client: b.client, get server() { return goalServer }, ownerIdentity: () => bOwner } as unknown as AgentMuxHeadlessRuntime
  const goals = createHostGoals({ configurationPath, runtime: () => runtime, projects: async () => [], coreCall: (hostId, method, params, context) => { if (hostId !== 'local') throw Error('No alternate target'); return goalServer.callRpc(method, params, context) } })
  cleanup.push(() => goals.dispose())
  goalServer = new AgentMuxControlServer({ socketPath, spatialState: spatial, hostedRuntime: () => bHosted, coreClients: () => [{ hostId: 'local', client: b.client }, { hostId: 'D-in-B', client: configuredD }], goalControl: goals.execute, goalDelegations: goals.goalDelegations })
  await goalServer.start(); cleanup.push(() => goalServer.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: goalServer.path } }); cleanup.push(() => rpc.dispose())
  const goal = (await goals.demands.create({ id: 'original-goal', title: 'Original public Goal', description: 'Original frozen public input', assigneeSessionIds: [reference] })).demand
  const access = { source: { hostId: 'local' } }
  const bInventory = vi.spyOn(b.client, 'readAgentSessions'), dInventory = vi.spyOn(d.client, 'readAgentSessions'), bRuns = vi.spyOn(b.client, 'listRuns'), dRuns = vi.spyOn(d.client, 'listRuns')
  return { sourceRoot: b.root, spatial, b: { inventory: bInventory, runs: bRuns }, d: { core: d.client, store: d.store, inner: d.inner, inventory: dInventory, runs: dRuns }, goal, goals, goalServer, rpc, reference, access, send, raw, stop, session }
}

it('public Goal Start obtains the exact Source C/current Run, uses the original member input owner and explicitly rejoins the same frozen operation', async () => {
  const f = await fixture(), operationId = 'original-public-Start'
  let startFailure: unknown
  await f.rpc.call('goal.start', { goalId: f.goal.id, operationId, agentReference: f.reference, access: f.access, expectedUpdatedAt: f.goal.updatedAt }).catch(error => { startFailure = error; expect(error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' }) })
  const initial = (await f.goals.demands.inspectDispatch(f.goal.id, operationId))!
  expect(initial, String(startFailure)).toMatchObject({ target: f.reference, runId: f.session.run.runId, prompt: f.goal.description, execution: 'finite' })
  expect(initial).not.toHaveProperty('hostId'); expect(initial).not.toHaveProperty('agentSessionId')
  const inputKey = { kind: 'prompt' as const, agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: operationId }
  try { await expect.poll(async () => (await f.d.core.inspectAgentInput({ key: inputKey }))?.status).toBe('admitted') }
  catch (error) { throw Error('Canonical original input: ' + JSON.stringify(await f.d.core.inspectAgentInput({ key: inputKey })) + '; Start error: ' + String(startFailure), { cause: error }) }
  const observed = await f.rpc.call('goal.inspect', { goalId: f.goal.id, dispatchOperationId: operationId, access: f.access })
  const { stage: _stage, issue: _issue, receipt: _receipt, ...frozen } = initial
  const confirmed = observed.goal?.dispatches?.find(row => row.operationId === operationId)
  expect(confirmed).toMatchObject({ ...frozen, stage: 'confirmed', receipt: { kind: 'core-input', inputKey } }); expect(confirmed).not.toHaveProperty('issue')
  const continued = await f.rpc.call('goal.start', { goalId: f.goal.id, operationId, agentReference: f.reference, access: f.access, resumeOriginal: true })
  expect(continued.receipt).toMatchObject({ agentReference: f.reference, run: f.session.run }); expect(continued.receipt).not.toHaveProperty('sessionId')
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + f.goalServer.path, 'goal', 'start', '--goal', f.goal.id, '--operation-id', operationId, '--agent-ref', JSON.stringify(f.reference), '--access', JSON.stringify(f.access), '--resume-original'], objectCliEnvironment(f.sourceRoot), '', 15000, process.env.T012_FINITE_CLI_LOADER ? pathToFileURL(process.env.T012_FINITE_CLI_LOADER) : new URL('./helpers/goal-relations-source-loader.mjs', import.meta.url))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.receipt).toMatchObject({ agentReference: f.reference, run: f.session.run })
  const skill = await runSourceObjectCli(['goal', '--skill'], objectCliEnvironment(f.sourceRoot), '', 15000, process.env.T012_FINITE_CLI_LOADER ? pathToFileURL(process.env.T012_FINITE_CLI_LOADER) : new URL('./helpers/goal-relations-source-loader.mjs', import.meta.url))
  expect(skill.code, skill.stderr).toBe(0); expect(skill.stdout).toContain('--resume-original'); expect(skill.stdout).toContain('Unknown effects are not automatically resent')
  const responsibility = await f.rpc.call('goal.delegations', { goalId: f.goal.id })
  expect(responsibility.dispatches).toMatchObject([{ target: f.reference, operationId, receipt: { kind: 'core-input' } }])
  expect(responsibility.responsibility?.executions).toMatchObject([{ execution: { target: f.reference, operationId, runId: f.session.run.runId }, binding: 'unconfirmed', phase: 'unknown' }])

  expect(f.send).toHaveBeenCalledTimes(1); expect(f.raw).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect(f.b.inventory).not.toHaveBeenCalled(); expect(f.d.inventory).not.toHaveBeenCalled(); expect(f.b.runs).not.toHaveBeenCalled(); expect(f.d.runs).not.toHaveBeenCalled()
  expect(await f.d.core.readAgentSession(f.session.agentSessionId)).toMatchObject({ run: f.session.run, nativeHandle: { sessionId: 'original-D-native' } })
})


it('a stale Source creation is refused before a Goal input is prepared, without borrowing a same-SID execution', async () => {
  const f = await fixture(), wrong = { ...f.reference, source: { ...f.reference.source, admission: { kind: 'creation' as const, operationId: 'another-C' } } }
  await f.goals.demands.update(f.goal.id, { assigneeSessionIds: [wrong] })
  const before = await f.goals.demands.get(f.goal.id)
  await expect(f.rpc.call('goal.start', { goalId: f.goal.id, operationId: 'stale-C-Start', agentReference: wrong, access: f.access })).rejects.toMatchObject({ code: 'GOAL_RELATION_SOURCE_UNCONFIRMED' })
  expect(await f.goals.demands.get(f.goal.id)).toEqual(before)
  expect(f.send).not.toHaveBeenCalled(); expect(f.raw).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('original continuation retains its frozen Run and never substitutes the selected Agent’s current new Run', async () => {
  const f = await fixture(), operationId = 'frozen-old-Run-Start'
  await f.goals.demands.prepareDispatch(f.goal.id, { operationId, target: f.reference, runId: f.session.run.runId, execution: 'finite', prompt: 'Frozen original body', agentMuxNote: 'Frozen original note' })
  await f.goals.demands.recordDispatchPhase(f.goal.id, operationId, { stage: 'submitted' })
  const stored = (await f.d.store.readMetadata(f.session.agentSessionId))!
  await f.d.store.compareAndSwapMetadata(stored, { ...stored, run: { runId: 'new-current-Run' } }); await f.d.inner.registry.load('local')
  await expect(f.rpc.call('goal.start', { goalId: f.goal.id, operationId, agentReference: f.reference, access: f.access, resumeOriginal: true })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(await f.goals.demands.inspectDispatch(f.goal.id, operationId)).toMatchObject({ operationId, target: f.reference, runId: f.session.run.runId, prompt: 'Frozen original body', agentMuxNote: 'Frozen original note', stage: 'unknown' })
  expect((await f.d.core.readAgentSession(f.session.agentSessionId))?.run).toEqual({ runId: 'new-current-Run' })
  expect(f.send).not.toHaveBeenCalled(); expect(f.raw).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})


it('a complete initial pending cut settles as unconfirmed within the ordinary read budget and leaves another reader and the same Agent usable', async () => {
  const f = await fixture(), operationId = 'pending-member-Start', before = await f.goals.demands.get(f.goal.id)
  const originalRead = f.d.core.readAgentSession.bind(f.d.core)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f.d.core, 'readAgentSession').mockImplementation(async id => { if (id === f.session.agentSessionId) await held; return originalRead(id) })
  const observations: SpaceSessionsObservation[] = [], controller = new AbortController()
  const reference = { runtimeId: f.reference.source.runtimeId, spaceId: f.reference.source.spaceId }
  const sibling = await observeSpaceSessionStates(f.rpc, { reference }, { onObservation: event => observations.push(event) })
  let deadline: ReturnType<typeof setTimeout> | undefined
  let start: Promise<{ value: unknown } | { error: unknown }> | undefined
  try {
    await vi.waitFor(() => expect(observations.some(event => event.type === 'member' && event.state.status === 'pending')).toBe(true))
    await vi.waitFor(() => expect(observations.some(event => event.type === 'membership-complete')).toBe(true))
    start = f.rpc.call('goal.start', { goalId: f.goal.id, operationId, agentReference: f.reference, access: f.access }, { signal: controller.signal }).then(value => ({ value }), error => ({ error }))
    const finite = await Promise.race([start.then(result => ({ kind: 'settled' as const, result })), new Promise<{ kind: 'still-pending' }>(resolve => { deadline = setTimeout(() => resolve({ kind: 'still-pending' }), AGENTMUX_CONTROL_REQUEST_TIMEOUT_MS + 500) })])
    expect(finite.kind).toBe('settled')
    if (finite.kind !== 'settled') throw Error('The finite Goal reader did not settle within the original read budget')
    expect(finite.result).toMatchObject({ error: { code: 'GOAL_RELATION_SOURCE_UNCONFIRMED' } })
    expect(await f.goals.demands.get(f.goal.id)).toEqual(before)
    expect(f.send).not.toHaveBeenCalled(); expect(f.raw).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
    expect(observations.some(event => event.type === 'member' && event.state.status === 'observed')).toBe(false)
    release()
    await vi.waitFor(() => expect(observations.some(event => event.type === 'member' && event.member.agentSessionId === f.session.agentSessionId && event.state.status === 'observed' && event.state.session.run.runId === f.session.run.runId)).toBe(true))
    // A new explicit call uses the same OP and original Goal, never an automatic retry.
    await f.rpc.call('goal.start', { goalId: f.goal.id, operationId, agentReference: f.reference, access: f.access }).catch(error => expect(error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' }))
    await expect.poll(async () => (await f.d.core.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: operationId } }))?.status).toBe('admitted')
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()
  } finally { clearTimeout(deadline); controller.abort(); release(); await start; await sibling.dispose() }
})


it('a normal asynchronous pending member becomes usable within the original read budget', async () => {
  const f = await fixture(), operationId = 'on-time-member-Start'
  const originalRead = f.d.core.readAgentSession.bind(f.d.core)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const read = vi.spyOn(f.d.core, 'readAgentSession').mockImplementation(async id => { if (id === f.session.agentSessionId) await held; return originalRead(id) })
  const controller = new AbortController()
  const start = f.rpc.call('goal.start', { goalId: f.goal.id, operationId, agentReference: f.reference, access: f.access }, { signal: controller.signal }).catch(error => { expect(error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' }) })
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith(f.session.agentSessionId))
    expect(f.send).not.toHaveBeenCalled()
    release()
    await start
    await expect.poll(async () => (await f.d.core.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: operationId } }))?.status).toBe('admitted')
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.raw).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  } finally { release(); controller.abort(); await start }
})
