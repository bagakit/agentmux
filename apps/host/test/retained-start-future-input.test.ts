import { expect, it, vi } from 'vitest'
import { mkdir, writeFile, access, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, cleanups, otherRuntime } from '../../../packages/core/test/helpers/prepared-resume-fixture.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { ObjectCliProbe } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli.js'
import { decodePreparedRun } from '../../../packages/core/src/prepared-run.js'
import { AgentMuxError } from '../../../packages/core/src/errors.js'
import { readGrokPromptExecutionEvidence, observeGrokSessionStatus } from '../../../packages/core/src/providers/grok-history.js'
import { encodeCwdDirname } from '../../../packages/providers/src/grok/native-history.js'
import { grokUser, grokDone } from '../../../packages/core/test/fixtures/grok-updates.js'
import { createGoalRuntime } from '../src/goal-runtime.js'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'
import { deliverContinuousProgress } from '../src/continuous-progress-delivery.js'

async function retainedStart(mode: 'legacy' | 'sdk' | 'business' = 'legacy') {
  const f = await fixture('positional-argv', false, 'file', 'grok'), originalHome = join(f.root, 'original-home'), nativeRoot = mode === 'business' ? join(originalHome, '.grok') : join(f.root, 'original-private-native')
  vi.stubEnv('HOME', originalHome)
  if (mode === 'business') vi.stubEnv('GROK_HOME', undefined)
  const privateEnv: Record<string, string> = mode === 'business' ? { ORIGINAL_BUSINESS_SETTING: 'retained' } : { GROK_HOME: nativeRoot }
  cleanups.unshift(async () => { await expect(access(f.root)).rejects.toMatchObject({ code: 'ENOENT' }); if (process.env.RETAINED_START_CLEANUP) await appendFile(process.env.RETAINED_START_CLEANUP, JSON.stringify({ root: f.root, absent: true }) + '\n') })
  f.provider.readPromptExecutionEvidence = readGrokPromptExecutionEvidence
  const directory = join(nativeRoot, 'sessions', encodeCwdDirname(f.root), 'original-native')
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'summary.json'), JSON.stringify({ info: { id: 'original-native', cwd: f.root } }))
  await writeFile(join(directory, 'updates.jsonl'), JSON.stringify(grokUser('original-native', 'Original unfinished turn', 'old-turn')) + '\n')
  const bound = await f.client.ensureAgentContinuity({ agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run,
    operationId: 'original-bound-start', trigger: 'manual', args: f.request.args!, env: privateEnv, policy: { continuationEnabled: false, reminderMode: 'off' } })
  expect(bound.kind).toBe('resumed')
  const first = f.client.agentSession(f.previous.agentSessionId), originalRun = await f.inner.kernel.status(first.run.runId)
  expect(originalRun.lifecycleOperationId).toBeTruthy()
  const original = await f.inner.kernel.inspectRetainedStart(originalRun.lifecycleOperationId)
  expect(original.run.runId).toBe(first.run.runId); expect(JSON.parse(original.prepared.launch).request.env.HOME).toBe(originalHome)
  const originalContext = await Reflect.get(f.client, 'providerNativeContext').call(f.client, first, originalRun)
  expect(await readGrokPromptExecutionEvidence({ ...originalContext, env: decodePreparedRun(original.prepared).request.env })).toMatchObject({ state: 'working' })
  await f.inner.kernel.stop(await f.inner.kernel.prepareStop(first.run.runId))
  await vi.waitFor(async () => expect((await f.inner.kernel.status(first.run.runId)).state.type).not.toBe('running'))
  expect(await f.inner.kernel.readRunEnvironment(first.run.runId, new AbortController().signal)).toBeUndefined()
  if (mode === 'legacy') {
    const current = (await f.store.readMetadata(first.agentSessionId))!, { continuityExecutors: _originalNotRetained, ...withoutEnvironment } = current
    await f.store.compareAndSwapMetadata(current, withoutEnvironment)
  }
  await f.client.dispose()
  vi.stubEnv('GROK_HOME', join(f.root, 'unrelated-observer-root')); vi.stubEnv('HOME', join(f.root, 'unrelated-observer-home'))
  const cold = await f.reader(), nativeInspect = cold.inner.kernel.inspectRetainedStart.bind(cold.inner.kernel), inspect = vi.spyOn(cold.inner.kernel, 'inspectRetainedStart')
  const runtime = createGoalRuntime({ clients: () => [{ hostId: 'local', client: cold.client }], checkIn: async () => ({ known: false, reason: 'Unused' }) })
  let now = Date.now()
  const manager = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(f.root, 'original-schedule.json')), (loop, op, isCurrent, signal) => deliverContinuousProgress(runtime, loop, op, isCurrent, signal), () => now, runtime.observeContinuousProgress, runtime)
  cleanups.push(() => manager.stop()); await manager.start()
  const loop = (await manager.call('schedule.create', { target: { hostId: 'local', agentSessionId: first.agentSessionId, providerId: 'grok', workspacePath: f.root }, operationId: 'original-arrangement', everyMs: 60000, prompt: 'Original saved heartbeat' }, { principal: { kind: 'user', id: 'private-person' } })).schedule
  const recover = () => cold.client.ensureAgentContinuity({ agentSessionId: first.agentSessionId, expectedRun: first.run, operationId: 'cold-source-resume', trigger: 'manual', args: f.request.args!, env: mode === 'business' ? { ...privateEnv, HOME: originalHome, GROK_HOME: '' } : privateEnv, policy: { continuationEnabled: false, reminderMode: 'off' } })
  return { ...f, cold, original, originalRun, first, privateEnv, runtime, manager, loop, inspect, nativeInspect, nativeRoot, mode, recover, async due() { now = loop.nextCheckAt; await manager.check(now, loop.loopId); return manager.inspectLoop(loop.loopId)! } }
}
it.each(['legacy', 'sdk', 'business'] as const)('actual Core-bound retained Start reaches original lifecycle and due with %s environment source', async mode => {
  const f = await retainedStart(mode), resumed = await f.recover()
  expect(resumed.kind, JSON.stringify(resumed)).toBe('resumed')
  const current = f.cold.client.agentSession(f.first.agentSessionId)
  expect(current.nativeHandle).toEqual(f.first.nativeHandle)
  const before = await f.cold.inner.kernel.status(current.run.runId), loop = await f.due(), after = await f.cold.inner.kernel.status(current.run.runId)
  expect(loop.lastOutcome, JSON.stringify(loop)).toBe('sent')
  expect(current.nativePromptPredecessor).toBeDefined()
  expect(current.nativePromptPredecessor?.previousRun).toEqual(f.first.run)
  expect(after.acceptedInputBytes).toBeGreaterThan(before.acceptedInputBytes)
  expect(loop.lastInputRef?.inputKey.expectedRun).toEqual(current.run)
  expect(f.cold.client.agentSession(f.first.agentSessionId).semanticStatus).toBeUndefined()
  expect(f.inspect.mock.calls.some(args => args[0] === f.originalRun.lifecycleOperationId)).toBe(true)
  expect(JSON.stringify(current)).not.toContain(f.nativeRoot)
  if (mode === 'legacy') {
    const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.cold.client }], schedules: f.manager }); cleanups.push(() => service.dispose())
    const probe = new ObjectCliProbe(request => service.call(request.method as any, request.params as any)); await probe.start(); cleanups.push(() => probe.stop())
    const cli = await runSourceObjectCli(['--endpoint', 'unix:' + probe.socketPath, 'schedule', 'inspect', '--data', '-'], probe.environment(), JSON.stringify({ scheduleId: loop.loopId }))
    expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.input.reference).toEqual(loop.lastInputRef)
    expect(cli.stdout).not.toContain(f.nativeRoot)
  }
  if (process.env.RETAINED_START_FACTS) await appendFile(process.env.RETAINED_START_FACTS, JSON.stringify({ mode, root: f.root, originalRun: f.first.run, resumedRun: current.run, lifecycleOperationId: f.originalRun.lifecycleOperationId, originalRuntimeId: f.original.runtime.runtimeId, key: loop.lastInputRef?.inputKey, inputBefore: before.acceptedInputBytes, inputAfter: after.acceptedInputBytes, originalRetainedSource: true }) + '\n')
})
it.each(['absent', 'key', 'run', 'cwd', 'binding', 'runtime', 'source'] as const)('a %s mismatch in the original retained source keeps the due unconfirmed without closing its restored Run', async change => {
  const f = await retainedStart(), oldKey = f.originalRun.lifecycleOperationId
  if (change === 'source') await writeFile(join(f.nativeRoot, 'sessions', encodeCwdDirname(f.root), 'original-native', 'summary.json'), JSON.stringify({ info: { id: 'another-native', cwd: f.root } }))
  let foreign: typeof f.original | undefined
  if (change === 'runtime') {
    const second = await otherRuntime({ ...f, inner: f.cold.inner }), request = decodePreparedRun(f.original.prepared).request
    await second.kernel.startPrepared(request, oldKey)
    foreign = await second.kernel.inspectRetainedStart(oldKey)
  }
  f.inspect.mockImplementation(async (key: unknown) => {
    const original = await f.nativeInspect(key)
    if (key !== oldKey || !original) return original
    if (change === 'absent') return null
    if (change === 'runtime') return foreign
    const value = structuredClone(original)
    if (change === 'run') value.run.runId = 'other-original-run'
    if (change === 'cwd') value.run.workspacePath = join(f.root, 'other-workspace')
    if (change === 'key') value.run.lifecycleOperationId = 'other-original-key'
    if (change === 'binding') {
      const launch = JSON.parse(value.prepared.launch); launch.request.env.AGENTMUX_EXECUTOR_ID = 'other-executor'; value.prepared.launch = JSON.stringify(launch)
    }
    return value
  })
  const recovered = await f.recover(); expect(recovered.kind).toBe('resumed')
  const current = f.cold.client.agentSession(f.first.agentSessionId), before = await f.cold.inner.kernel.status(current.run.runId), loop = await f.due(), after = await f.cold.inner.kernel.status(current.run.runId)
  expect(current.nativePromptPredecessor).toBeUndefined(); expect(loop).toMatchObject({ status: 'active', lastOutcome: 'skipped' })
  expect(after.state.type).toBe('running'); expect(after.acceptedInputBytes).toBe(before.acceptedInputBytes)
  if (change === 'absent') await f.write(current, f.cold)
})
it.each(['absent', 'unavailable'] as const)('an optional Native observation %s preserves the original explicit SDK source and its independent Provider qualification', async outcome => {
  const f = await retainedStart('sdk'), oldKey = f.originalRun.lifecycleOperationId
  f.inspect.mockImplementation(async (key: unknown) => {
    if (key !== oldKey) return await f.nativeInspect(key)
    if (outcome === 'absent') return null
    throw new AgentMuxError('The optional original Native observation is unavailable.', 'CTXMUX_UNAVAILABLE')
  })
  expect((await f.recover()).kind).toBe('resumed')
  expect(await f.due()).toMatchObject({ status: 'active', lastOutcome: 'sent' })
})
it.each(['PREPARED_START_RUNTIME_MISMATCH', 'INVALID_PREPARED_RUN'])('an already rejected Native witness %s cannot fall through to the SDK source', async code => {
  const f = await retainedStart('sdk'), oldKey = f.originalRun.lifecycleOperationId
  f.inspect.mockImplementation(async (key: unknown) => {
    if (key !== oldKey) return await f.nativeInspect(key)
    throw new AgentMuxError('The original returned Native witness failed its typed validation.', code)
  })
  expect((await f.recover()).kind).toBe('resumed')
  const current = f.cold.client.agentSession(f.first.agentSessionId), before = await f.cold.inner.kernel.status(current.run.runId)
  expect(await f.due()).toMatchObject({ status: 'active', lastOutcome: 'skipped' })
  expect(current.nativePromptPredecessor).toBeUndefined()
  expect((await f.cold.inner.kernel.status(current.run.runId)).acceptedInputBytes).toBe(before.acceptedInputBytes)
})
it('newly readable history on an already restored Run without a predecessor does not attribute its old ending to this Run', async () => {
  const f = await retainedStart(), oldKey = f.originalRun.lifecycleOperationId
  f.inspect.mockImplementation(async (key: unknown) => key === oldKey ? null : await f.nativeInspect(key))
  const path = join(f.nativeRoot, 'sessions', encodeCwdDirname(f.root), 'original-native', 'updates.jsonl')
  await appendFile(path, JSON.stringify(grokDone('original-native', 'old-turn')) + '\n')
  expect((await f.recover()).kind).toBe('resumed')
  const before = (await f.cold.store.readMetadata(f.first.agentSessionId))!, { continuityExecutors: _missingOriginalSource, ...withoutEnvironment } = before
  expect(before.nativePromptPredecessor).toBeUndefined()
  await f.cold.store.compareAndSwapMetadata(before, withoutEnvironment)
  f.provider.observeSessionStatus = observeGrokSessionStatus
  await f.cold.client.statusAgent(f.first.agentSessionId)
  await vi.waitFor(() => expect(Reflect.get(f.cold.client, 'nativeStatusWatches').get(f.first.agentSessionId)?.observer).toBeDefined())
  await Reflect.get(f.cold.client, 'nativeStatusWatches').get(f.first.agentSessionId).pending
  const current = f.cold.client.agentSession(f.first.agentSessionId), native = await f.cold.inner.kernel.status(current.run.runId)
  expect(current.semanticStatus?.state).not.toBe('done')
  expect((await f.cold.store.readMetadata(f.first.agentSessionId))?.nativeTurnEnds?.turns['old-turn']).toBeUndefined()
  expect(await f.due()).toMatchObject({ status: 'active', lastOutcome: 'skipped' })
  expect((await f.cold.inner.kernel.status(current.run.runId)).acceptedInputBytes).toBe(native.acceptedInputBytes)
  const user = grokUser('original-native', 'New original input', 'new-turn'), end = grokDone('original-native', 'new-turn')
  user.params._meta.eventId = 'new-user'; end.params._meta.eventId = 'new-end'
  await appendFile(path, JSON.stringify(user) + '\n' + JSON.stringify(end) + '\n')
  await vi.waitFor(() => expect(f.cold.client.agentSession(f.first.agentSessionId).semanticStatus).toMatchObject({ state: 'done', nativeTurnId: 'new-turn' }))
})
