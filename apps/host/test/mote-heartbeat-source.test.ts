import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import * as core from '@agentmux/core'
import { connectHostedAgentMux, type AgentMuxHostedRpcPort } from '@agentmux/core/hosted'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { AgentMuxNotesStorage } from '@agentmux/core/notebook-store'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { ObjectCliProbe } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { createHostContent } from '../src/content-owner.js'
import { createHostMoteMainReader } from '../src/mote-dialogue.js'
import { createHostMotePresence } from '../src/mote-presence.js'
import { motePresenceSourceId } from '@agentmux/core/mote-preferences'
import { ScratchTopics } from '../src/mote-resources.js'
import { directoryIdentity, homeZoneId, serializeMoteQuickMode, SCRATCH_WORKSPACE_ID } from '../src/mote-model.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager.js'
import { createGoalRuntime } from '../src/goal-runtime.js'
import { deliverContinuousProgress } from '../src/continuous-progress-delivery.js'

const closes: Array<() => Promise<unknown> | void> = []
async function evidence(name: string, value: unknown) { if (process.env.MOTE_SOURCE_EVIDENCE) { await mkdir(process.env.MOTE_SOURCE_EVIDENCE, { recursive: true }); await writeFile(join(process.env.MOTE_SOURCE_EVIDENCE, name + '.json'), JSON.stringify(value, null, 2) + '\n') } }
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture(options: { loseDeliveryReceipt?: boolean; interruptBeforeCore?: boolean } = {}) {
  const h = await rpcOwnerFixture(['main', 'stranger'], core)
  closes.push(h.close)
  for (const id of ['main', 'stranger']) {
    const old = (await h.store.readMetadata(id))!
    await h.store.compareAndSwapMetadata(old, { ...old, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: id === 'main' ? 'original-native' : 'stranger-native' } })
  }
  await h.inner.registry.load('local')
  let now = 100000, busy = false
  let sequence = 1
  const observers = new Set<Parameters<NonNullable<typeof original.observeSessionStatus>>[0]>()
  const original = h.client.providers.get('codex'), { discoverNativeSession: _d, observeSessionStatus: _s, ...rest } = original
  vi.spyOn(h.client as any, 'probePreparedAgent').mockResolvedValue({ providerId: 'codex', executable: process.execPath, installed: true, capabilities: original.catalog.capabilities })
  h.client.providers.replace({ ...rest,
    observeSessionStatus: async context => { observers.add(context); context.onStatus({ recordId: 'initial-' + context.nativeHandle?.sessionId, sequence: sequence++, nativeTurnId: 'prior-' + context.nativeHandle?.sessionId, state: 'done', endReason: 'completed', nativeObservedAt: Date.now() }); return { dispose() { observers.delete(context) } } },
    readPromptExecutionEvidence: async () => ({ state: busy ? 'working' : 'idle', sourceId: 'private-original-machine', id: 'original-opportunity-' + now }),

  })
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: join(h.root, 'scratch'), name: 'Private original', kind: 'folder' }
  await mkdir(workspace.path)
  const topic = await new ScratchTopics().ensureMote(workspace, 'view:heartbeat-source')
  const configurationPath = join(h.root, 'configuration.json')
  await writeFile(configurationPath, JSON.stringify({ workspaces: [workspace] }))
  const spaceId = directoryIdentity('local', topic.identityDirectoryPath!), zoneId = homeZoneId(spaceId)
  const target = { spaceId, zoneId, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  await writeFile(join(topic.physicalDirectoryPath!, 'MOTE.md'), serializeMoteQuickMode('---\nversion: 1\ndefaults: {}\n---\n', { conversation: { hostId: 'local', sessionId: 'main', displayWorkspaceId: workspace.id, groupId: 'g', tabId: 't', regionId: 'r' }, conversationRevision: 'role-original', presence: { enabled: true, intervalMs: 60000 } }))
  const spatial = new core.AgentMuxSpatialStateStore(join(h.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [{ spaceId, kind: 'mote', name: 'Original', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, projectId: null, topicId: topic.id }], zones: [{ zoneId, workspaceId: workspace.id, kind: 'home', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, branch: null }], bindings: [{ spaceId, zoneId }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} } })
  const storage = new AgentMuxNotesStorage(join(h.root, 'notes-location.json'), join(h.root, 'notes'))
  const files = createHostContent({ configurationPath, spatial, storage }).files!, main = createHostMoteMainReader({ configurationPath, spatial, files })
  const runtime = createGoalRuntime({ clients: h.coreClients, checkIn: async () => ({ known: false, reason: 'Unused' }) })
  const store = new ContinuousProgressLoopStore(join(h.root, 'loops.json'))
  let interruptBeforeCore = options.interruptBeforeCore
  const manager = new ContinuousProgressLoopManager(store, async (loop, op, current, signal) => {
    if (interruptBeforeCore) { interruptBeforeCore = false; return 'unknown' }
    const outcome = await deliverContinuousProgress(runtime, loop, op, current, signal)
    return outcome === 'sent' && options.loseDeliveryReceipt ? 'unknown' : outcome
  }, () => now, (loop, id, at, signal) => runtime.observeContinuousProgress(loop, id, at, signal), runtime)
  closes.push(() => manager.stop())
  const presence = createHostMotePresence({ configurationPath, spatial, files, main, schedules: manager, clients: h.coreClients })
  closes.push(() => presence.dispose())
  const snapshot = await main.readCurrentMoteMain(target)
  await vi.waitFor(async () => expect((await h.client.statusAgent('main')).observation.semantic).toBe('idle'))
  const loop = (await manager.call('schedule.create', { target: { hostId: 'local', agentSessionId: 'main', providerId: 'codex', workspacePath: h.root }, everyMs: 60000, prompt: 'Original private standing heartbeat body', managedSource: { sourceId: motePresenceSourceId(snapshot.identity!), revision: snapshot.roleRevision! }, operationId: 'source-original-create' })).schedule
  await evidence('fixture-' + loop.loopId, { root: h.root })
  await presence.start()
  await manager.check(now)
  return { ...h, target, main, runtime, coreStore: h.store, store, storage, manager, presence, loop, at(value: number) { now = value }, busy(value: boolean) { busy = value; for (const observer of observers) observer.onStatus({ recordId: 'activity-' + now, sequence: sequence++, nativeTurnId: 'activity-' + now, state: value ? 'working' : 'done', nativeObservedAt: Date.now() }) }, async due() { now = loop.nextCheckAt; await manager.check(now); await manager.check(now + 1); return manager.inspectLoop(loop.loopId)! } }
}

it('real due delivery freezes the original input reference, survives busy checks and is consumed through schedule CLI without private input disclosure', async () => {
  const h = await fixture(), loop = await h.due(), reference = loop.lastInputRef!
  expect(loop.lastOutcome, JSON.stringify({ decision: loop.lastDecision, status: loop.status, pause: loop.pause })).toBe('sent')
  expect(reference).toBeDefined()
  const original = await h.client.inspectAgentPromptSubmission(reference.inputKey)
  expect(['pty', undefined]).toContain(original!.admission!.transport)
  expect((await h.client.statusAgent('main')).run.acceptedInputBytes).toBeGreaterThan(0)
  expect(reference).toMatchObject({ inputKey: original!.admission!.inputKey, futureIntent: { intentId: h.loop.futureIntentId, occurrenceAt: h.loop.nextCheckAt }, definitionOperationId: h.loop.creationOperationId, managedSource: h.loop.managedSource })
  expect(loop.pendingCompletion).toBeUndefined()
  const reading = await h.manager.call('schedule.inspect', { operationId: core.agentPromptInputId(reference.inputKey) })
  expect(reading.input).toMatchObject({ reference, status: 'confirmed', delivery: 'terminal-confirmed', nativeResult: { state: 'unsupported' } })
  const safe = JSON.stringify(reading.input)
  for (const privateValue of ['Original private standing heartbeat body', 'private-actor', 'clientCorrelation', 'nativeHandle', 'systemContext', 'private-provider-protocol']) expect(safe).not.toContain(privateValue)
  h.busy(true); h.at(loop.nextCheckAt); await h.manager.check(loop.nextCheckAt)
  expect(h.manager.inspectLoop(loop.loopId)?.lastInputRef).toEqual(reference)
  expect(h.manager.inspectLoop(loop.loopId)?.lastInputRef).toEqual(reference)
  const service = new core.AgentMuxRpcService({ coreClients: h.coreClients, schedules: h.manager }); closes.push(() => service.dispose())
  const probe = new ObjectCliProbe(request => service.call(request.method as any, request.params as any, { caller: h.credentials })); await probe.start(); closes.push(() => probe.stop())
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + probe.socketPath, 'schedule', 'inspect', '--data', '-'], probe.environment(), JSON.stringify({ scheduleId: loop.loopId }))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.input.reference).toEqual(reference)
  await expect(service.call('agent.input.inspect', { key: reference.inputKey }, { caller: { ...h.credentials, agentSessionId: 'stranger' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a one-time future input keeps its exact reference after the arrangement ends; list performs no input lookup', async () => {
  const h = await fixture()
  const once = (await h.manager.call('schedule.create', { target: { hostId: 'local', agentSessionId: 'stranger', providerId: 'codex', workspacePath: h.root }, afterMs: 100, prompt: 'One original future message', operationId: 'source-once' })).schedule
  await vi.waitFor(async () => expect((await h.client.statusAgent('stranger')).observation.semantic).toBe('idle'))
  h.at(once.nextCheckAt); await h.manager.check(once.nextCheckAt)
  const ended = h.manager.inspectLoop(once.loopId)!
  expect(ended.status).toBe('stopped'); expect(ended.lastInputRef?.inputKey.agentSessionId).toBe('stranger')
  const spy = vi.spyOn(h.runtime, 'inspectInput')
  const listed = await h.manager.call('schedule.list', {})
  expect(listed.schedules.some(value => value.loopId === ended.loopId)).toBe(true); expect(spy).not.toHaveBeenCalled()
  expect((await h.manager.call('schedule.inspect', { scheduleId: ended.loopId })).input).toMatchObject({ status: 'confirmed', delivery: 'terminal-confirmed', nativeResult: { state: 'unsupported' } })
})

it('a held original input observation leaves policy checks and real manual terminal input available', async () => {
  const h = await fixture(), loop = await h.due(), reference = loop.lastInputRef!
  let entered!: () => void, release!: () => void
  const reached = new Promise<void>(yes => entered = yes), held = new Promise<void>(yes => release = yes)
  const original = h.runtime.inspectInput.bind(h.runtime)
  vi.spyOn(h.runtime, 'inspectInput').mockImplementation(async selected => { entered(); await held; return original(selected) })
  const reading = h.manager.call('schedule.inspect', { scheduleId: loop.loopId })
  await reached
  h.at(170000); await h.manager.check(170000)
  expect(h.manager.inspectLoop(loop.loopId)?.status).toBe('active')
  const before = (await h.client.statusAgent('main')).run.acceptedInputBytes
  await h.client.writeAgent({ agentSessionId: 'main', expectedRun: reference.inputKey.expectedRun, data: 'Authorized original human terminal input\r', source: 'user' })
  expect(before).not.toBeNull()
  expect((await h.client.statusAgent('main')).run.acceptedInputBytes).toBeGreaterThan(before!)
  release()
  expect((await reading).input).toMatchObject({ status: 'confirmed', reference, nativeResult: { state: 'unsupported' } })
  expect(h.manager.inspectLoop(loop.loopId)?.lastInputRef).toEqual(reference)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a foreign stored pointer is refused before private archive access, and a mismatched immutable message stays unknown', async () => {
  const h = await fixture(), loop = await h.due(), reference = loop.lastInputRef!
  const read = vi.spyOn(h.client, 'inspectAgentPromptSubmission')
  const foreign = { ...loop, lastInputRef: { ...reference, inputKey: { ...reference.inputKey, agentSessionId: 'stranger' } } }
  expect((await h.runtime.inspectInput(foreign))?.status).toBe('unconfirmed')
  expect(read).not.toHaveBeenCalled()
  const original = h.client.readAgentFuturePromptIntent.bind(h.client)
  vi.spyOn(h.client, 'readAgentFuturePromptIntent').mockImplementation(async (id, intentId) => {
    const value = await original(id, intentId)
    return value && intentId === reference.futureIntent.intentId ? { ...value, message: { ...value.message, systemContext: 'Foreign private system content' } } : value
  })
  const unknown = await h.runtime.inspectInput(loop)
  expect(unknown).toMatchObject({ status: 'unconfirmed', nativeResult: { state: 'unknown' } })
  expect(JSON.stringify(unknown)).not.toContain('Foreign private system content')
  expect(h.manager.inspectLoop(loop.loopId)?.status).toBe('active')
})

it('the report source qualifier uses the explicit original key/Run/role/occurrence and preserves the private participant guard', async () => {
  const h = await fixture(), loop = await h.due(), ref = loop.lastInputRef!, snapshot = await h.main.readCurrentMoteMain(h.target)
  const service = new core.AgentMuxRpcService({ coreClients: h.coreClients }); closes.push(() => service.dispose())
  const readInput = vi.fn(async (_host: string, key: core.AgentPromptInputKey) => (await service.call('agent.input.inspect', { key }, { caller: h.credentials })).record ?? null)
  const context = { caller: { hostId: 'local', agentSessionId: 'main', run: ref.inputKey.expectedRun }, readInput }
  const source = { scheduleId: loop.loopId, inputKey: ref.inputKey, definitionIntentId: ref.futureIntent.intentId, occurrenceAt: ref.futureIntent.occurrenceAt, mainRoleRevision: ref.managedSource!.revision }
  await expect(h.presence.qualifyHeartbeatSource(source, snapshot, context)).resolves.toBeUndefined()
  readInput.mockClear()
  await expect(h.presence.qualifyHeartbeatSource({ ...source, mainRoleRevision: 'foreign-role' }, snapshot, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(h.presence.qualifyHeartbeatSource(source, snapshot, { ...context, caller: { ...context.caller, run: { runId: 'foreign-run' } } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(readInput).not.toHaveBeenCalled()
  await expect(h.presence.qualifyHeartbeatSource({ ...source, occurrenceAt: source.occurrenceAt + 1 }, snapshot, context)).rejects.toMatchObject({ code: 'SCHEDULE_INPUT_SOURCE_UNCONFIRMED' })
  await expect(h.presence.qualifyHeartbeatSource(source, snapshot, { ...context, readInput: async (_host, key) => (await service.call('agent.input.inspect', { key }, { caller: { ...h.credentials, agentSessionId: 'stranger' } })).record ?? null })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a failed exact input read remains isolated to that inspection and recovers on the next read', async () => {
  const h = await fixture(), loop = await h.due()
  const known = (await h.manager.call('schedule.inspect', { scheduleId: loop.loopId })).input!
  const read = vi.spyOn(h.client, 'inspectAgentPromptSubmission').mockRejectedValueOnce(Error('Private original archive unavailable'))
  const failed = await h.manager.call('schedule.inspect', { scheduleId: loop.loopId })
  expect(failed.input).toMatchObject({ reference: known.reference, status: 'unconfirmed', nativeResult: { state: 'unknown' } })
  expect(h.manager.inspectLoop(loop.loopId)?.status).toBe('active')
  read.mockRestore()
  expect((await h.manager.call('schedule.inspect', { scheduleId: loop.loopId })).input).toEqual(known)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('the original Mote schedule recovers a lost Host acknowledgement from Core and exposes that occurrence through the actual CLI', async () => {
  const h = await fixture({ loseDeliveryReceipt: true }), due = h.loop.nextCheckAt
  h.at(due)
  await h.manager.check(due)
  const held = h.manager.inspectLoop(h.loop.loopId)!
  expect(held).toMatchObject({ status: 'paused', pause: { reason: 'input-unconfirmed' }, pendingCompletion: { operationId: held.lastInputRef?.inputKey.submissionId } })
  const reference = held.lastInputRef!
  const before = (await h.client.statusAgent('main')).run.acceptedInputBytes
  expect(before).toBeGreaterThan(0)

  await h.manager.check(due)
  const service = new core.AgentMuxRpcService({ coreClients: h.coreClients, schedules: h.manager }); closes.push(() => service.dispose())
  const probe = new ObjectCliProbe(request => service.call(request.method as any, request.params as any, { caller: h.credentials })); await probe.start(); closes.push(() => probe.stop())
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + probe.socketPath, 'schedule', 'inspect', '--data', '-'], probe.environment(), JSON.stringify({ scheduleId: h.loop.loopId }))
  expect(cli.code, cli.stderr).toBe(0)
  const readback = JSON.parse(cli.stdout).result
  expect(readback).toMatchObject({ schedule: { loopId: h.loop.loopId, status: 'active', revision: h.loop.revision, lastInputRef: reference, lastOutcome: 'sent', lastOccurrenceAt: due, nextCheckAt: due + 60_000 },
    input: { reference, status: 'confirmed', delivery: 'terminal-confirmed', nativeResult: { state: 'unsupported' } } })
  expect(readback.schedule.pendingCompletion).toBeUndefined()
  expect((await h.store.load()).find(loop => loop.loopId === h.loop.loopId)).toEqual(readback.schedule)
  expect((await h.client.statusAgent('main')).run.acceptedInputBytes).toBe(before)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('reopens the due occurrence only after Core confirms the superseded Run never claimed it', async () => {
  const h = await fixture({ interruptBeforeCore: true }), due = h.loop.nextCheckAt
  h.at(due)
  await h.manager.check(due)
  const held = h.manager.inspectLoop(h.loop.loopId)!
  const reference = held.lastInputRef!
  expect(held).toMatchObject({ status: 'paused', pendingCompletion: { operationId: reference.inputKey.submissionId } })
  const source = { reference, providerId: held.providerId, workspacePath: held.workspacePath }
  expect(await h.client.supersededScheduledInputWasUnclaimed(source)).toBe(false)
  expect(await h.client.inspectAgentPromptSubmission(reference.inputKey)).toBeNull()

  const original = (await h.coreStore.readMetadata('main'))!
  await h.coreStore.compareAndSwapMetadata(original, { ...original, run: { runId: 'recovered-main' }, retiredRuns: [...original.retiredRuns, original.run] })
  await h.inner.registry.load('local')
  expect(await h.client.supersededScheduledInputWasUnclaimed(source)).toBe(false)
  const status = h.inner.kernel.status as ReturnType<typeof vi.fn>
  status.mockRejectedValueOnce(new core.AgentMuxError('The connected owner cannot find the original Run.', 'CTXMUX_run_not_found'))
  expect(await h.client.supersededScheduledInputWasUnclaimed(source)).toBe(false)
  status.mockImplementation(async (runId: string) => runId === original.run.runId
    ? { ...h.run(runId), state: { type: 'exited', code: 1, signal: null } } : h.run(runId))
  expect(await h.client.supersededScheduledInputWasUnclaimed({ ...source, inputEpoch: 'another-cut' })).toBe(false)
  expect(await h.client.supersededScheduledInputWasUnclaimed({ ...source, reference: { ...reference, definitionOperationId: 'another-definition' } })).toBe(false)
  expect(await h.client.supersededScheduledInputWasUnclaimed(source)).toBe(true)
  const service = new AgentMuxHostedRuntimeService(h.client, null, () => hostedTestOwner(h.client))
  closes.push(() => service.dispose())
  const requests: number[] = []
  let asAgent = false
  const port: AgentMuxHostedRpcPort = {
    call: async (method, params, options) => {
      const payload = JSON.parse(JSON.stringify(params))
      if (payload.invocation?.method === 'supersededScheduledInputWasUnclaimed') requests.push(payload.invocation.args.length)
      return await service.call(method, payload, { ...options, principal: { kind: 'user', id: 'original-person' }, ...(asAgent ? { caller: h.credentials } : {}) }) as never
    },
    subscribe: async (method, params, handlers) => {
      const stream = await service.subscribe(method, params, handlers.onEvent, handlers.signal ? { signal: handlers.signal } : {})
      handlers.onInitial(stream.initial as never); await stream.start?.()
      return { dispose: async () => await stream.dispose() }
    },
  }
  const borrowed = await connectHostedAgentMux({ rpc: port })
  closes.push(() => borrowed.dispose())
  expect(await borrowed.supersededScheduledInputWasUnclaimed(source, { signal: new AbortController().signal })).toBe(true)
  const cancelled = AbortSignal.abort(new Error('Only this receipt read was cancelled'))
  await expect(borrowed.supersededScheduledInputWasUnclaimed(source, { signal: cancelled })).rejects.toBe(cancelled.reason)
  asAgent = true
  await expect(borrowed.supersededScheduledInputWasUnclaimed(source)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(requests).toEqual([1, 1])
  await h.manager.check(due)
  expect(h.manager.inspectLoop(h.loop.loopId)).toMatchObject({ status: 'active', lastInputRef: reference, lastOutcome: 'skipped', nextCheckAt: due })
  expect(h.manager.inspectLoop(h.loop.loopId)!.pendingCompletion).toBeUndefined()
  expect((await h.coreStore.readMetadata('main'))!.nativeHandle).toEqual(original.nativeHandle)
  expect(h.inner.kernel.input).not.toHaveBeenCalled()
  h.busy(false)
  await vi.waitFor(async () => expect((await h.client.statusAgent('main')).observation.semantic).toBe('idle'))
  h.at(due + 1); await h.manager.check()
  const delivered = h.manager.inspectLoop(h.loop.loopId)!
  expect(delivered).toMatchObject({ status: 'active', lastOutcome: 'sent', lastOccurrenceAt: due,
    lastInputRef: { inputKey: { expectedRun: { runId: 'recovered-main' } }, futureIntent: reference.futureIntent } })
  expect(delivered.lastInputRef!.inputKey.submissionId).not.toBe(reference.inputKey.submissionId)
  expect(await h.client.inspectAgentPromptSubmission(reference.inputKey)).toBeNull()
  expect((await h.manager.call('schedule.inspect', { scheduleId: h.loop.loopId })).input?.delivery).toBe('terminal-confirmed')
  expect(await h.client.supersededScheduledInputWasUnclaimed(source)).toBe(false)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('two real OS owners read the same retained original input and safe result after scheduler restart without sending input', async () => {
  const h = await fixture(), loop = await h.due(), known = (await h.manager.call('schedule.inspect', { scheduleId: loop.loopId })).input!
  h.presence.dispose(); await h.manager.stop()
  async function owner(index: number) {
    const input = join(h.root, 'read-owner-' + index + '.json'), output = join(h.root, 'read-result-' + index + '.json')
    await writeFile(input, JSON.stringify({ root: h.root, loopId: loop.loopId, output }))
    await new Promise<void>((yes, no) => {
      const child = spawn(process.execPath, ['--experimental-transform-types', '--import', resolve(import.meta.dirname, 'mote-presence-node-loader.mjs'), resolve(import.meta.dirname, 'fixtures/mote-heartbeat-source-owner.mjs'), input], { env: objectCliEnvironment(h.root), stdio: ['ignore', 'pipe', 'pipe'] })
      let err = ''; child.stderr.on('data', value => err += value); child.once('error', no); child.once('close', code => code === 0 ? yes() : no(Error(err)))
    })
    return JSON.parse(await readFile(output, 'utf8'))
  }
  const a = await owner(1), b = await owner(2)
  expect(a.pid).not.toBe(b.pid)
  expect(a.result.schedule.lastInputRef).toEqual(loop.lastInputRef)
  expect(b.result.schedule.lastInputRef).toEqual(loop.lastInputRef)
  expect(a.result.input).toEqual(known); expect(b.result.input).toEqual(known)
  expect(a.session).toEqual(b.session)
  await evidence('os-read', { root: h.root, a, b })
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
}, 60000)
