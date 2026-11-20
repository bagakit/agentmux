import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
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
import { AgentHookServer } from '../../../packages/core/src/hook-server.js'
import { AgentMuxFileAgentSessionStore } from '../../../packages/core/src/agent-session-store.js'
import type { AgentMuxAcpBinding, AgentMuxAcpBridge } from '../../../packages/core/src/acp-adapter.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import type { AgentProvider } from '../../../packages/core/src/agent-provider.js'
import type { AgentMuxHeadlessRuntime } from '../../../packages/core/src/headless-runtime.js'
import type { DemandSpaceMemberReference } from '@agentmux/demand/relations'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(localMember = false) {
  const d = await rpcOwnerFixture(['original-SID']); cleanup.push(d.close)
  expect(process.env.AGENTMUX_RUNTIME_DIRECTORY).toBe(d.root); expect(process.env.AGENTMUX_STATE_DIRECTORY).toBe(join(d.root, 'state'))
  const b = localMember ? d : await rpcOwnerFixture(['B-namesake']); if (!localMember) cleanup.push(b.close)
  expect(process.env.AGENTMUX_RUNTIME_DIRECTORY).toBe(b.root); expect(process.env.AGENTMUX_STATE_DIRECTORY).toBe(join(b.root, 'state'))
  expect(d.client.agentMessageQueuePath().startsWith(d.root + '/')).toBe(true)
  expect(b.client.agentMessageQueuePath().startsWith(b.root + '/')).toBe(true)
  if (!localMember) expect(d.client.agentMessageQueuePath()).not.toBe(b.client.agentMessageQueuePath())
  const bOwner = { runtimeId: 'runtime-b', ownerInstanceId: 'original-B-instance', protocolVersion: 2 as const, processId: process.pid, availability: 'connected' as const, ctxmux: null }
  const dOwner = localMember ? bOwner : { ...bOwner, runtimeId: 'runtime-d', ownerInstanceId: 'original-D-instance' }
  const session = (await d.store.readMetadata('original-SID'))!, actor = { protocolId: 'public-goal-native', actorId: 'original-D-actor', lifecycleOperationId: 'original-lifecycle', token: 'b'.repeat(64), launch: { command: 'codex', args: [] } }
  await d.store.compareAndSwapMetadata(session, { ...session, nativeActor: actor, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-D-native' } })
  await d.inner.registry.load('local')
  d.inner.kernel.status = async (id: string) => ({ ...d.run(id), pid: 2345 })
  const raw = vi.fn(async () => { throw Error('A qualified Goal must never use terminal fallback') }), stop = vi.fn(); d.inner.kernel.input = raw; d.inner.kernel.stop = stop
  const provider = d.client.providers.get('codex'), previous = provider.prepareNativeInput
  const send = vi.fn<NonNullable<Awaited<ReturnType<NonNullable<AgentProvider['prepareNativeInput']>>>>['send']>(async () => ({ outcome: 'admitted', turnId: 'original-public-turn' }))
  provider.prepareNativeInput = async (_context, selected) => ({ plan: { kind: 'native-rpc', protocolId: actor.protocolId, actorId: actor.actorId, sourceId: JSON.stringify([selected.providerId, selected.nativeSessionId]), threadId: selected.nativeSessionId, operation: 'start-or-steer' }, assertCurrent: async () => {}, send, dispose: async () => {} })
  cleanup.push(() => { if (previous) provider.prepareNativeInput = previous; else delete provider.prepareNativeInput })
  const spatial = new AgentMuxSpatialStateStore(join(b.root, 'spatial.json')), folder = await spatial.registerFolder({ id: 'original-B-resource', hostId: 'local', name: 'Original B Project', path: localMember ? d.root : '/original/B/project' })
  const admitted = await spatial.admitAgentOpen({ request: { schemaVersion: 5, requestId: 'original-C', operation: 'agent.open', content: { kind: 'new-agent', executorId: 'codex', ...(!localMember ? { agentTarget: { hostId: 'D-in-B', runtimeId: dOwner.runtimeId } } : {}) }, destination: { spaceId: folder.spaceId, zoneId: folder.zoneId, newTab: true }, focus: false }, agentSessionId: session.agentSessionId,
    execution: { hostId: localMember ? 'local' : 'D-in-B', runtimeId: dOwner.runtimeId, executorRevision: 'original-executor-revision', workspacePath: d.root, workspaceId: localMember ? 'original-B-resource' : null }, ...(!localMember ? { placement: { runtimeId: bOwner.runtimeId, hostId: 'local', workspacePath: '/original/B/project', workspaceId: 'original-B-resource' } } : {}), regionResource: {} })
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
  const goals = createHostGoals({ configurationPath, runtime: () => runtime, clients: () => [{ hostId: 'D-current', client: configuredD }], projects: async () => [], coreCall: (hostId, method, params, context) => { if (hostId !== 'local') throw Error('No alternate target'); return goalServer.callRpc(method, params, context) } })
  cleanup.push(() => goals.dispose())
  goalServer = new AgentMuxControlServer({ socketPath, spatialState: spatial, hostedRuntime: () => bHosted, coreClients: () => [
    { hostId: 'local', client: b.client }, ...(!localMember ? [{ hostId: 'D-in-B', client: configuredD }] : [])
  ], goalControl: goals.execute, goalDelegations: goals.goalDelegations, goalApproval: goals.approval, goalChanges: goals.goalChanges })
  await goalServer.start(); cleanup.push(() => goalServer.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: goalServer.path } }); cleanup.push(() => rpc.dispose())
  const goal = (await seedStoredDemand(goals.demands, { id: 'original-goal', title: 'Original public Goal', description: 'Original frozen public input', assigneeSessionIds: [reference] })).demand
  const access = { source: { hostId: 'local' } }
  const bInventory = vi.spyOn(b.client, 'readAgentSessions'), dInventory = vi.spyOn(d.client, 'readAgentSessions'), bRuns = vi.spyOn(b.client, 'listRuns'), dRuns = vi.spyOn(d.client, 'listRuns')
  return { sourceRoot: b.root, spatial, b: { inventory: bInventory, runs: bRuns }, d: { core: d.client, store: d.store, inner: d.inner, inventory: dInventory, runs: dRuns }, goal, goals, goalServer, configuredD, rpc, reference, access, send, raw, stop, session }
}

it('links an original permission answer to the selected Start when two inputs share one Run', async () => {
  const f = await fixture(true), sessionId = f.session.agentSessionId, run = f.session.run
  const start = async (operationId: string) => {
    await f.rpc.call('goal.start', { goalId: f.goal.id, operationId, agentReference: f.reference, access: f.access })
      .catch(error => expect(error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' }))
    const key = { kind: 'prompt' as const, agentSessionId: sessionId, expectedRun: run, submissionId: operationId }
    await expect.poll(async () => (await f.d.core.inspectAgentInput({ key }))?.status).toBe('admitted')
    const source = await f.rpc.call('goal.inspect', { goalId: f.goal.id, dispatchOperationId: operationId, access: f.access })
    expect(source.goal?.dispatches?.find(row => row.operationId === operationId)).toMatchObject({ stage: 'confirmed', receipt: { inputKey: key } })
    return key
  }
  const first = await start('first-start')
  const second = await start('second-start')
  const native = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-D-native', transcriptPath: join(f.sourceRoot, 'approval-source.jsonl') }
  await writeFile(native.transcriptPath, '')
  vi.spyOn(f.d.core.providers.get('codex'), 'discoverNativeSession').mockResolvedValue({ handle: native, assertCurrent: async () => {} })
  Reflect.get(f.d.core, 'hookNativeWitnesses').set(run.runId, { candidate: JSON.stringify(native.sessionId), handle: native })
  const hooks = Reflect.get(f.d.core, 'hookServer') as AgentHookServer
  Object.defineProperty(hooks, 'port', { value: 0 }); await hooks.start()
  const binding = hooks.createBinding(sessionId, 'codex'); await binding.bindRun(run.runId)
  cleanup.push(() => binding.close())
  async function permission(id: string) {
    const pending = fetch(binding.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: id, eventName: 'PermissionRequest', decision: true, payload: {
        hook_event_name: 'PermissionRequest', session_id: native.sessionId, transcript_path: native.transcriptPath, cwd: f.sourceRoot,
        turn_id: 'same-provider-turn', prompt_id: second.submissionId, tool_name: 'Bash', tool_input: { command: 'true' }
      } }) })
    const request = async () => {
      const state = (await f.rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: sessionId } })).session.pendingInteraction
      return [state?.request, ...(state?.additionalRequests ?? [])].find(row => row?.evidence.hookReceiptId === id)
    }
    await expect.poll(async () => (await request())?.kind).toBe('permission')
    await expect.poll(() => hooks.hasPermissionCallback(sessionId, run.runId, id)).toBe(true)
    return { pending, input: { agentSessionId: sessionId, expectedRun: run, expectedRequest: (await request())!, operationId: 'decision-' + id,
      response: { kind: 'permission' as const, requestId: id, decision: { outcome: 'selected' as const, optionId: 'allow-once' } } } }
  }
  const cli = async (args: string[], body?: unknown) => {
    const result = await runSourceObjectCli(['--endpoint', 'unix:' + f.goalServer.path, ...args], objectCliEnvironment(f.sourceRoot), body ? JSON.stringify(body) : '', 15000,
      new URL('./helpers/goal-relations-source-loader.mjs', import.meta.url))
    expect(result.code, result.stderr).toBe(0)
    return JSON.parse(result.stdout).result
  }
  const selection = { goalId: f.goal.id, dispatchOperationId: first.submissionId }
  const answer = await permission('ordinary-native-permission')
  const plain = await f.rpc.call('agent.interaction.respond', answer.input)
  expect(await (await answer.pending).json()).toHaveProperty('hookSpecificOutput.decision.behavior', 'allow')
  expect(plain).not.toHaveProperty('goalApproval')
  const request = await permission('explicit-native-permission')
  await expect(f.rpc.call('agent.interaction.respond', { ...request.input, goalApproval: { ...selection, dispatchOperationId: 'missing-start' } }))
    .rejects.toMatchObject({ code: 'GOAL_APPROVAL_SOURCE_UNCONFIRMED' })
  expect(hooks.hasPermissionCallback(sessionId, run.runId, 'explicit-native-permission')).toBe(true)
  const invalidated: string[][] = []
  const watch = await f.rpc.subscribe('goal.watch', {}, { onInitial: value => expect(value.goalIds).toContain(f.goal.id),
    onEvent: event => { if (event.type === 'change') invalidated.push(event.data.goalIds) } })
  cleanup.push(() => watch.dispose())
  const beforeAnswer = Date.now()
  const original = await cli(['agent', 'interaction', 'respond', '--input', '-'], { ...request.input, goalApproval: selection })
  await expect.poll(() => invalidated).toEqual([[f.goal.id]])
  expect(await (await request.pending).json()).toHaveProperty('hookSpecificOutput.decision.behavior', 'allow')
  expect(original).toMatchObject({ delivery: 'hook-written', nativeAdoption: 'unknown', goalApproval: { ...selection,
    kind: 'explicit-goal-selection', actor: { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` }, inputKey: first } })
  expect(original.goalApproval.at).toBeGreaterThanOrEqual(beforeAnswer)
  expect(original.goalApproval.at).toBeLessThanOrEqual(Date.now())
  await expect(f.rpc.call('agent.interaction.respond', { ...request.input, goalApproval: { ...selection, dispatchOperationId: second.submissionId } }))
    .rejects.toMatchObject({ code: 'AGENT_INTERACTION_RESPONSE_CONFLICT' })
  expect(await cli(['agent', 'interaction', 'respond', '--input', '-'], { ...request.input, goalApproval: selection })).toEqual(original)
  expect(await cli(['agent', 'interaction', 'inspect', '--session', sessionId, '--operation-id', original.operationId])).toEqual({ receipt: original })
  expect((await new AgentMuxFileAgentSessionStore(f.d.store.path).readMetadata(sessionId))?.interactionOperations?.[original.operationId]).toEqual(original)
  const neighbor = (await seedStoredDemand(f.goals.demands, { id: 'approval-neighbor-goal', title: 'Same Session elsewhere', assigneeSessionIds: [f.reference] })).demand
  expect((await f.rpc.call('goal.inspect', { goalId: neighbor.id })).goal?.approvalObservations ?? []).toEqual([])
  const goal = await cli(['goal', 'inspect', '--goal', f.goal.id])
  expect(goal.goal.approvalObservations).toEqual([{ operationId: original.operationId, requestId: 'explicit-native-permission',
    attribution: original.goalApproval, decision: 'approved', delivery: 'hook-written', nativeCompleted: false }])

  const interrupted = await permission('before-dispatch-native-permission')
  const inlet = f.d.core as unknown as { respondPermissionHook(...args: unknown[]): Promise<void> }
  const interruption = vi.spyOn(inlet, 'respondPermissionHook').mockRejectedValueOnce(new Error('temporary failure before original permission transport'))
  const originalIntent = { ...interrupted.input, goalApproval: selection }
  await expect(f.rpc.call('agent.interaction.respond', originalIntent)).rejects.toThrow('temporary failure before original permission transport')
  expect(hooks.hasPermissionCallback(sessionId, run.runId, 'before-dispatch-native-permission')).toBe(true)
  const saved = (await f.rpc.call('agent.interaction.inspect', { agentSessionId: sessionId, operationId: originalIntent.operationId })).receipt
  expect(saved).toMatchObject({ delivery: 'saved', goalApproval: { ...selection, inputKey: first } })
  expect(await f.rpc.call('agent.interaction.respond', interrupted.input)).toEqual(saved)
  await expect(f.rpc.call('agent.interaction.respond', { ...originalIntent, goalApproval: { ...selection, dispatchOperationId: second.submissionId } }))
    .rejects.toMatchObject({ code: 'AGENT_INTERACTION_RESPONSE_CONFLICT' })
  await expect(f.rpc.call('agent.interaction.respond', { ...originalIntent, response: { ...originalIntent.response, decision: { outcome: 'cancelled' } } }))
    .rejects.toMatchObject({ code: 'AGENT_INTERACTION_RESPONSE_CONFLICT' })
  expect(interruption).toHaveBeenCalledTimes(1)
  interruption.mockRestore()
  const resumed = await cli(['agent', 'interaction', 'respond', '--input', '-'], originalIntent)
  expect(resumed).toEqual({ ...saved, delivery: 'hook-written' })
  expect(await (await interrupted.pending).json()).toHaveProperty('hookSpecificOutput.decision.behavior', 'allow')

  const shared = await permission('concurrent-native-permission')
  const sharedIntent = { ...shared.input, goalApproval: selection }
  const originalHook = inlet.respondPermissionHook.bind(inlet)
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const contenders = vi.spyOn(inlet, 'respondPermissionHook').mockImplementation(async (...args) => {
    await barrier
    return await originalHook(...args)
  })
  const transport = vi.spyOn(hooks, 'respondPermission')
  const submissions = Promise.allSettled([f.rpc.call('agent.interaction.respond', sharedIntent), f.rpc.call('agent.interaction.respond', sharedIntent)])
  try { await expect.poll(() => contenders.mock.calls.length).toBe(2) }
  finally { release() }
  expect((await submissions).filter(result => result.status === 'fulfilled')).not.toHaveLength(0)
  expect(await (await shared.pending).json()).toHaveProperty('hookSpecificOutput.decision.behavior', 'allow')
  expect(transport).toHaveBeenCalledTimes(1)
  const sharedReceipt = (await f.rpc.call('agent.interaction.inspect', { agentSessionId: sessionId, operationId: sharedIntent.operationId })).receipt!
  expect(sharedReceipt).toMatchObject({ delivery: 'hook-written', goalApproval: { ...selection, inputKey: first } })
  contenders.mockRestore(); transport.mockRestore()

  const uncertain = await permission('unknown-native-permission'), respond = hooks.respondPermission.bind(hooks)
  const lost = vi.spyOn(hooks, 'respondPermission').mockImplementation(async (...args) => {
    await respond(...args)
    throw Error('Native connection write acknowledgement was lost')
  })
  const uncertainInput = { ...uncertain.input, goalApproval: { ...selection, dispatchOperationId: second.submissionId } }
  await expect(f.rpc.call('agent.interaction.respond', uncertainInput)).rejects.toThrow('acknowledgement was lost')
  expect(await (await uncertain.pending).json()).toHaveProperty('hookSpecificOutput.decision.behavior', 'allow')
  const unknown = await f.rpc.call('agent.interaction.respond', uncertainInput)
  expect(unknown).toMatchObject({ delivery: 'unknown', nativeAdoption: 'unknown', goalApproval: { inputKey: second } })
  expect(lost).toHaveBeenCalledTimes(1)
  expect((await f.rpc.call('goal.inspect', { goalId: f.goal.id })).goal?.approvalObservations).toEqual(expect.arrayContaining([
    { operationId: unknown.operationId, requestId: 'unknown-native-permission', attribution: unknown.goalApproval,
      decision: 'approved', delivery: 'unknown', nativeCompleted: false }
  ]))
  expect(f.raw).not.toHaveBeenCalled()
  expect(f.stop).not.toHaveBeenCalled()
  expect((await f.d.core.readAgentSession(sessionId))?.run).toEqual(run)

  // Retire the isolated test Store with the production lifecycle commit. A fresh
  // Store and independent CLI must still read only the explicit original receipts.
  const retirementId = 'retire-test-original-run'
  const retirement = { kind: 'stop' as const, agentSessionId: sessionId, expectedRun: run, operationId: retirementId,
    reservationId: retirementId, ownerId: 'test-owner', ownerPid: process.pid, expiresAt: Date.now() + 10_000,
    stopOperation: { operationKey: retirementId, daemonInstance: 'fixture-runtime', runId: run.runId } }
  await f.d.store.reserveLifecycle(retirement)
  await f.d.store.commitLifecycle(retirement, null)
  const reopenedStore = new AgentMuxFileAgentSessionStore(f.d.store.path)
  expect(await reopenedStore.readMetadata(sessionId)).toBeNull()
  expect((await reopenedStore.readRetiredAgentSession(sessionId))?.interactionOperations).toEqual({
    [original.operationId]: original, [resumed.operationId]: resumed, [sharedReceipt.operationId]: sharedReceipt, [unknown.operationId]: unknown
  })
  expect(await cli(['agent', 'interaction', 'inspect', '--session', sessionId, '--operation-id', unknown.operationId])).toEqual({ receipt: unknown })
  expect((await cli(['goal', 'inspect', '--goal', f.goal.id])).goal.approvalObservations).toHaveLength(4)
}, 60_000)

it('concurrent responses share one original ACP permission dispatch', async () => {
  const f = await fixture(true), agentSessionId = f.session.agentSessionId, expectedRun = f.session.run
  const acp = Reflect.get(f.d.core, 'acp') as AgentMuxAcpBridge
  let emit!: Parameters<AgentMuxAcpBinding['onEvent']>[0]
  let acknowledge!: () => void
  const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve })
  const owner = vi.fn(async () => { await acknowledgement })
  const native = { adapterId: 'original-acp-adapter', sessionId: 'original-D-native',
    onEvent(listener: typeof emit) { emit = listener; return () => {} }, respondPermission: owner, close: async () => {} }
  await acp.bind(agentSessionId, native, expectedRun, { providerId: 'codex', actorId: 'original-D-actor' })
  emit({ type: 'permission', requestId: 'original-acp-request', title: 'Original ACP permission',
    options: [{ id: 'deny', kind: 'reject-once', label: 'Deny' }] })
  const request = async () => (await f.rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId } })).session.pendingInteraction?.request
  await expect.poll(async () => (await request())?.evidence.source).toBe('acp')
  const expectedRequest = (await request())!
  const input = { agentSessionId, expectedRun, expectedRequest, operationId: 'original-acp-decision',
    response: { kind: 'permission' as const, requestId: expectedRequest.id, decision: { outcome: 'selected' as const, optionId: 'deny' } } }
  const bridge = vi.spyOn(acp, 'preparePermissionResponse')
  const coreDispatch = f.d.core as unknown as { dispatchAgentInteraction(...args: unknown[]): Promise<void> }
  const originalDispatch = coreDispatch.dispatchAgentInteraction.bind(coreDispatch)
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const entrants = vi.spyOn(coreDispatch, 'dispatchAgentInteraction').mockImplementation(async (...args) => {
    await barrier
    return await originalDispatch(...args)
  })
  const submissions = [f.rpc.call('agent.interaction.respond', input), f.rpc.call('agent.interaction.respond', input)]
  const settled = Promise.allSettled(submissions)
  try {
    await expect.poll(() => entrants.mock.calls.length).toBe(2)
    release()
    expect(await Promise.race(submissions)).toMatchObject({ operationId: input.operationId, delivery: 'unknown' })
    expect(bridge).toHaveBeenCalledTimes(1)
    expect(owner).toHaveBeenCalledTimes(1)
    expect(owner).toHaveBeenCalledWith('original-acp-request', input.response.decision, expect.any(AbortSignal))
  } finally { release(); acknowledge() }
  expect(await settled).toEqual(expect.arrayContaining([
    { status: 'fulfilled', value: expect.objectContaining({ delivery: 'acp-acknowledged' }) },
    { status: 'fulfilled', value: expect.objectContaining({ delivery: 'unknown' }) }
  ]))
  expect((await f.rpc.call('agent.interaction.inspect', { agentSessionId, operationId: input.operationId })).receipt).toMatchObject({ delivery: 'acp-acknowledged' })
  expect(f.raw).not.toHaveBeenCalled()
  expect(f.stop).not.toHaveBeenCalled()
})

it('keeps an admitted ACP answer off a replacement binding with the same request ID', async () => {
  const f = await fixture(true), agentSessionId = f.session.agentSessionId, expectedRun = f.session.run
  const acp = Reflect.get(f.d.core, 'acp') as AgentMuxAcpBridge
  let emit!: Parameters<AgentMuxAcpBinding['onEvent']>[0]
  const original = vi.fn(async () => {}), replacement = vi.fn(async () => {})
  const native: AgentMuxAcpBinding = { adapterId: 'original-acp-adapter', sessionId: 'original-D-native',
    onEvent(listener) { emit = listener; return () => {} }, respondPermission: original, close: async () => {} }
  const requestId = 'reused-acp-request'
  const event = { type: 'permission' as const, requestId, title: 'Original permission',
    options: [{ id: 'deny', kind: 'reject-once' as const, label: 'Deny' }] }
  const readRequest = async () => (await f.rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId } })).session.pendingInteraction?.request
  await acp.bind(agentSessionId, native, expectedRun, { providerId: 'codex', actorId: 'original-D-actor' })
  emit(event)
  await expect.poll(async () => (await readRequest())?.evidence.acpBindingId).toBe('original-D-actor')
  const expectedRequest = (await readRequest())!
  const input = { agentSessionId, expectedRun, operationId: 'original-acp-decision', expectedRequest,
    response: { kind: 'permission' as const, requestId, decision: { outcome: 'selected' as const, optionId: 'deny' } } }
  const persistence = f.d.core as unknown as { updateExactAgentSession(...args: unknown[]): Promise<{
    interactionOperations?: Record<string, { delivery: string }>
  }> }
  const update = persistence.updateExactAgentSession.bind(persistence)
  let switched = false
  const afterClaim = vi.spyOn(persistence, 'updateExactAgentSession').mockImplementation(async (...args) => {
    const saved = await update(...args)
    if (!switched && saved.interactionOperations?.[input.operationId]?.delivery === 'unknown') {
      switched = true
      await acp.unbind(agentSessionId)
      await acp.bind(agentSessionId, { ...native, sessionId: 'replacement-D-native', respondPermission: replacement }, expectedRun,
        { providerId: 'codex', actorId: 'replacement-D-actor' })
      emit(event)
      await expect.poll(async () => (await readRequest())?.evidence.acpBindingId).toBe('replacement-D-actor')
    }
    return saved
  })
  const failure = await f.rpc.call('agent.interaction.respond', input).then(() => null, error => error.code)
  expect(switched).toBe(true)
  expect(replacement).not.toHaveBeenCalled()
  expect(failure).toBe('AGENT_INTERACTION_UNCONFIRMED')
  expect(original).not.toHaveBeenCalled()
  afterClaim.mockRestore()
  const readOriginal = async () => (await f.rpc.call('agent.interaction.inspect', { agentSessionId, operationId: input.operationId })).receipt
  const held = await readOriginal()
  expect(held).toMatchObject({ delivery: 'unknown', expectedRequest })
  expect(await f.rpc.call('agent.interaction.respond', input)).toEqual(held)
  const successor = (await readRequest())!
  expect(successor).toMatchObject({ id: requestId, evidence: { run: expectedRun, acpBindingId: 'replacement-D-actor', acpSessionId: 'replacement-D-native' } })
  expect(successor).not.toHaveProperty('responseUnavailableReason')
  await expect(f.rpc.call('agent.interaction.respond', { ...input, expectedRequest: successor })).rejects.toMatchObject({ code: 'AGENT_INTERACTION_RESPONSE_CONFLICT' })
  expect(await f.rpc.call('agent.interaction.respond', { ...input, operationId: 'replacement-acp-decision', expectedRequest: successor }))
    .toMatchObject({ delivery: 'acp-acknowledged', expectedRequest: successor })
  expect(replacement).toHaveBeenCalledExactlyOnceWith(requestId, input.response.decision, expect.any(AbortSignal))
  expect(await readOriginal()).toEqual(held)
  expect(f.raw).not.toHaveBeenCalled()
  expect(f.stop).not.toHaveBeenCalled()
})

it('a public local-member Goal input outlives its temporary reader while retaining the original Core claim', async () => {
  const f = await fixture(true), provider = f.d.core.providers.get('codex'), prepare = provider.prepareNativeInput!
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  provider.prepareNativeInput = async (...args) => { await held; return await prepare(...args) }
  cleanup.push(() => { release(); provider.prepareNativeInput = prepare })
  const operationId = 'original-reader-lifetime-input'
  const beforeRequest = Date.now()
  // The original Goal owner disposes its temporary SDK in finally after this
  // waiting receipt. Native preparation deliberately finishes only afterwards.
  await f.rpc.call('goal.start', { goalId: f.goal.id, operationId, agentReference: f.reference, access: f.access,
    expectedUpdatedAt: f.goal.updatedAt }).catch(error => expect(error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' }))
  expect(f.send).not.toHaveBeenCalled()
  release()
  const key = { kind: 'prompt' as const, agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: operationId }
  await expect.poll(async () => {
    const receipt = await f.d.core.inspectAgentInput({ key })
    return receipt?.status === 'admitted' || receipt?.status === 'not-applied' ||
      receipt?.control.waiting?.phase === 'authorization' || receipt?.control.waiting?.phase === 'observer'
  }).toBe(true)
  expect((await f.d.core.inspectAgentInput({ key }))?.status).toBe('admitted')
  const observed = await f.rpc.call('goal.inspect', { goalId: f.goal.id, dispatchOperationId: operationId, access: f.access })
  const original = observed.goal?.dispatches?.find(row => row.operationId === operationId)
  const requestedBy = { kind: 'device', id: `local-user:${process.getuid?.() ?? 'current'}` }
  expect(original).toMatchObject({ operationId, target: f.reference, prompt: f.goal.description,
    request: { requestedBy, goalUpdatedAt: f.goal.updatedAt }, runId: f.session.run.runId, stage: 'confirmed',
    receipt: { kind: 'core-input', inputKey: key, outcome: 'admitted' } })
  expect(original!.request!.requestedAt).toBeGreaterThanOrEqual(beforeRequest)
  expect(original!.request!.requestedAt).toBeLessThanOrEqual(original!.preparedAt!)
  expect(await f.goals.demands.inspectDispatch(f.goal.id, operationId)).toEqual(original)

  const loader = process.env.T012_FINITE_CLI_LOADER ? pathToFileURL(process.env.T012_FINITE_CLI_LOADER) : new URL('./helpers/goal-relations-source-loader.mjs', import.meta.url)
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + f.goalServer.path, 'goal', 'inspect', '--goal', f.goal.id,
    '--dispatch-operation', operationId, '--access', JSON.stringify(f.access)], objectCliEnvironment(f.sourceRoot), '', 15000, loader)
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.goal.dispatches).toEqual([original])

  const other = (await seedStoredDemand(f.goals.demands, { id: 'neighbor-goal', title: 'Same member, different Goal',
    assigneeSessionIds: [f.reference] })).demand
  const decoy = await f.rpc.call('goal.inspect', { goalId: other.id })
  expect(decoy.goal?.dispatches ?? []).toEqual([])
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.raw).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect(await f.d.core.readAgentSession(f.session.agentSessionId)).toMatchObject({ run: f.session.run })
})

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
  expect(skill.code, skill.stderr).toBe(0)
  expect(skill.stdout).toContain('--dispatch-operation OP')
  expect(skill.stdout).toContain('--resume-original')
  expect(skill.stdout).toContain('A missing read does not establish that input was never sent.')
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
  const retained = await f.goals.demands.get(f.goal.id)
  expect(retained).toMatchObject({ id: before!.id, title: before!.title, description: before!.description, assigneeSessionIds: before!.assigneeSessionIds })
  expect(retained?.dispatches?.find(value => value.operationId === 'stale-C-Start')).toMatchObject({ stage: 'requested', target: wrong, prompt: before!.description })
  expect(retained?.dispatches?.find(value => value.operationId === 'stale-C-Start')).not.toHaveProperty('runId')
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
    expect(await f.goals.demands.get(f.goal.id)).toMatchObject({ id: before!.id, title: before!.title, description: before!.description })
    expect(await f.goals.demands.inspectDispatch(f.goal.id, operationId)).toMatchObject({ stage: 'requested', target: f.reference, prompt: before!.description })
    expect(f.send).not.toHaveBeenCalled(); expect(f.raw).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
    expect(observations.some(event => event.type === 'member' && event.state.status === 'observed')).toBe(false)
    release()
    await vi.waitFor(() => expect(observations.some(event => event.type === 'member' && event.member.agentSessionId === f.session.agentSessionId && event.state.status === 'observed' && event.state.session.run.runId === f.session.run.runId)).toBe(true))
    // Explicit continuation advances the same saved business request, never a fresh Start or automatic retry.
    await f.rpc.call('goal.start', { goalId: f.goal.id, operationId, agentReference: f.reference, access: f.access, resumeOriginal: true }).catch(error => expect(error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' }))
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


it('original pending Check reads its canonical input through independent current Coordinator access while its Source is unavailable', async () => {
  const f = await fixture(), operationId = 'independent-original-Check'
  const frozen = { operationId, target: f.reference, runId: f.session.run.runId, execution: 'finite' as const, prompt: 'Frozen original Goal input', agentMuxNote: 'Independent original Goal note' }
  await f.goals.demands.prepareDispatch(f.goal.id, frozen)
  await f.goals.demands.recordDispatchPhase(f.goal.id, operationId, { stage: 'submitted' })
  await f.goals.demands.recordDispatchPhase(f.goal.id, operationId, { stage: 'unknown', issue: 'Original acknowledgement unconfirmed' })
  const key = { kind: 'prompt' as const, agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: operationId }
  await f.d.core.submitAgentPrompt({ agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, operationId, prompt: frozen.prompt, agentMuxNote: frozen.agentMuxNote,
    execution: 'immediate', admissionIntent: { kind: 'session-conversation' }, authorHuman: false, sourceChannel: 'api' })
  await expect.poll(async () => (await f.d.core.inspectAgentInput({ key }))?.status).toBe('admitted')
  expect(await f.goals.demands.inspectDispatch(f.goal.id, operationId)).toMatchObject({ ...frozen, stage: 'unknown' })
  const source = vi.spyOn(f.goalServer, 'callRpc').mockRejectedValue(Object.assign(new Error('The original Source read is unavailable'), { code: 'SPACE_SESSION_SOURCE_UNAVAILABLE' }))
  const result = await f.rpc.call('goal.inspect', { goalId: f.goal.id, dispatchOperationId: operationId, access: { ...f.access, coordinator: { hostId: 'D-current' } } })
  expect(result.goal?.dispatches?.find(item => item.operationId === operationId)).toMatchObject({ target: f.reference, runId: f.session.run.runId, stage: 'confirmed', receipt: { kind: 'core-input', inputKey: key } })
  expect(source).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledTimes(1); expect(f.raw).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('independent original Check never claims another producer canonical input with the same key but another body', async () => {
  const f = await fixture(), operationId = 'foreign-body-original-Check'
  await f.goals.demands.prepareDispatch(f.goal.id, { operationId, target: f.reference, runId: f.session.run.runId, execution: 'finite', prompt: 'Frozen original Goal body' })
  await f.goals.demands.recordDispatchPhase(f.goal.id, operationId, { stage: 'submitted' })
  const key = { kind: 'prompt' as const, agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: operationId }
  await f.d.core.submitAgentPrompt({ agentSessionId: key.agentSessionId, expectedRun: key.expectedRun, operationId, prompt: 'Another producer body', execution: 'immediate', admissionIntent: { kind: 'session-conversation' }, authorHuman: false, sourceChannel: 'api' })
  await expect.poll(async () => (await f.d.core.inspectAgentInput({ key }))?.status).toBe('admitted')
  const source = vi.spyOn(f.goalServer, 'callRpc').mockRejectedValue(Object.assign(new Error('The original Source read is unavailable'), { code: 'SPACE_SESSION_SOURCE_UNAVAILABLE' }))
  await expect(f.rpc.call('goal.inspect', { goalId: f.goal.id, dispatchOperationId: operationId, access: { ...f.access, coordinator: { hostId: 'D-current' } } })).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(await f.goals.demands.inspectDispatch(f.goal.id, operationId)).toMatchObject({ stage: 'submitted', prompt: 'Frozen original Goal body' })
  expect((await f.goals.demands.inspectDispatch(f.goal.id, operationId))?.receipt).toBeUndefined()
  expect(source).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledTimes(1); expect(f.raw).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('a rejected current Coordinator Check does not switch to the Source strategy or send input', async () => {
  const f = await fixture(), operationId = 'rejected-original-Check'
  await f.goals.demands.prepareDispatch(f.goal.id, { operationId, target: f.reference, runId: f.session.run.runId, execution: 'finite', prompt: 'Frozen original Goal body' })
  await f.goals.demands.recordDispatchPhase(f.goal.id, operationId, { stage: 'submitted' })
  const originalForward = f.configuredD.forwardRpc
  let coordinatorReads = 0
  f.configuredD.forwardRpc = async () => { coordinatorReads++; throw Object.assign(new Error('Current original Coordinator read is denied'), { code: 'CONTROL_PERMISSION_DENIED' }) }
  cleanup.push(() => { if (originalForward) f.configuredD.forwardRpc = originalForward; else delete f.configuredD.forwardRpc })
  const source = vi.spyOn(f.goalServer, 'callRpc')
  await expect(f.rpc.call('goal.inspect', { goalId: f.goal.id, dispatchOperationId: operationId, access: { ...f.access, coordinator: { hostId: 'D-current' } } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(coordinatorReads).toBe(1); expect(source).not.toHaveBeenCalled()
  expect(await f.goals.demands.inspectDispatch(f.goal.id, operationId)).toMatchObject({ stage: 'submitted', prompt: 'Frozen original Goal body' })
  expect(f.send).not.toHaveBeenCalled(); expect(f.raw).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})
