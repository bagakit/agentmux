import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as durable from '../src/durable-write.js'
import type { AgentMuxClient } from '../src/client.js'
import { CapsuleRunManager } from '../src/capsule-run-manager.js'
import { AgentMuxError } from '../src/errors.js'
import { parseCapsuleRuntimeParams, parseCapsuleRuntimeResult } from '../src/capsule-runtime.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amxc-run-'))
  const state = join(directory, 'state'); await mkdir(state)
  let creates = 0, stops = 0, inspections = 0, unknownCreation = false, unknownStop = false
  let creationGate: Promise<void> | undefined, releaseCreation: (() => void) | undefined
  let inspectionGate: Promise<void> | undefined, stopGate: Promise<void> | undefined
  let run = { runId: 'original-run', kind: 'terminal', pid: 1, state: 'running' }
  const frozen = { createOperationId: 'original-create', workspacePath: join(state, 'capsules'), launch: '' }
  frozen.launch = JSON.stringify({ createOperationId: frozen.createOperationId, request: {
    program: process.execPath, args: [], cwd: frozen.workspacePath, env: { AGENTMUX_LIFECYCLE_OPERATION_ID: frozen.createOperationId },
    initial_size: { cols: 80, rows: 24 }, declared_inputs: [] } })
  const client = {
    connectRuntime: async () => {}, prepareTerminal: () => structuredClone(frozen),
    terminalCreationRuntimeIdentity: () => ({ runtimeId: 'fixture-lineage', instanceId: 'fixture-owner', buildIdentity: 'fixture-build', protocolVersion: 1 }),
    createPreparedTerminal: async () => { creates++; await creationGate; if (unknownCreation) throw new AgentMuxError('Original Start ACK lost', 'CAPSULE_RUNTIME_CREATION_UNKNOWN')
      if (creates > 1) run = { ...run, runId: 'next-run', state: 'running' }; return { ...run } },
    inspectPreparedTerminal: async (prepared: unknown, ref?: { runId: string }) => { inspections++; await inspectionGate; expect(prepared).toEqual(frozen)
      if (ref && ref.runId !== run.runId) throw new AgentMuxError('Exact Run mismatches its frozen launch', 'TERMINAL_PREPARATION_RUN_MISMATCH')
      return unknownCreation ? null : { ...run } },
    runtimeSubject: async ({ runId }: { runId: string }) => { expect(runId).toBe(run.runId); return { run: { ...run } } },
    prepareTerminalStop: async (ref: unknown) => ({ run: ref, ownerInstanceId: 'original-native-owner', operationId: 'original-stop' }),
    stopPreparedTerminal: async (token: unknown) => { stops++; expect(token).toEqual({ run: { runId: run.runId }, ownerInstanceId: 'original-native-owner', operationId: 'original-stop' })
      const binding = JSON.parse(await readFile(join(state, 'capsule-service.json'), 'utf8'))
      expect(binding.desired).toBe('stopped'); expect(binding.stopPhase).toBe('dispatched'); expect(binding.stop).toEqual(token)
      await stopGate
      if (unknownStop) throw new AgentMuxError('Original Stop ACK lost', 'CAPSULE_RUNTIME_STOP_UNKNOWN'); run.state = 'exited' },
  } as unknown as AgentMuxClient
  const manager = new CapsuleRunManager(client, state)
  cleanup.push(() => rm(directory, { recursive: true, force: true }), () => manager.dispose())
  return { manager, state, count: () => ({ creates, stops, inspections }), unknownCreate: () => { unknownCreation = true }, confirmCreate: () => { unknownCreation = false },
    unknownStop: () => { unknownStop = true }, terminal: () => { run.state = 'exited' }, interrupted: () => { run.state = 'interrupted' },
    pauseCreation: () => { creationGate = new Promise<void>(yes => { releaseCreation = yes }) }, releaseCreation: () => releaseCreation?.(),
    pauseInspection: () => { inspectionGate = new Promise(() => {}) }, pauseStop: () => { stopGate = new Promise(() => {}) },
    binding: async () => JSON.parse(await readFile(join(state, 'capsule-service.json'), 'utf8')), client }
}

it('keeps empty inspection lazy and rejects malformed management targets', async () => {
  const f = await fixture(), observed = await f.manager.runtime.call('capsule.runtime.inspect', {})
  expect(observed).toMatchObject({ revision: 0, desired: 'unconfigured', phase: 'unconfigured', run: null })
  expect(f.count().creates).toBe(0)
  expect(parseCapsuleRuntimeResult(observed)).toEqual(observed)
  for (const value of [{}, { operationId: 'bad/path', expectedRevision: 0 }, { operationId: 'start', expectedRevision: -1 }])
    expect(() => parseCapsuleRuntimeParams('capsule.runtime.start', value)).toThrow()
  expect(() => parseCapsuleRuntimeParams('capsule.runtime.stop', { operationId: 'stop', expectedRevision: 0 })).toThrow()
  expect(() => parseCapsuleRuntimeResult({ ...observed, arbitrary: true })).toThrow()
})
it('keeps unconfigured page reads lazy and admits only an explicit create', async () => {
  const f = await fixture(); f.unknownCreate()
  const empty = await f.manager.runtime.call('capsule.runtime.inspect', {})
  const requests = [
    ['capsule.ls', {}], ['capsule.config.inspect', {}],
    ['capsule.inspect', { capsuleId: '111111111111' }], ['capsule.resolve', { capsuleId: '111111111111' }],
    ['capsule.operation.inspect', { operationId: 'unconfigured-operation' }],
    ['capsule.open', { capsuleId: '111111111111', operationId: 'unconfigured-open' }],
  ] as const
  for (const [method, params] of requests) {
    await expect(f.manager.call(method, params)).rejects.toMatchObject({ code: 'CAPSULE_RUNTIME_UNCONFIGURED' })
    expect(await f.manager.runtime.call('capsule.runtime.inspect', {})).toEqual(empty)
    expect(f.count()).toEqual({ creates: 0, stops: 0, inspections: 0 })
    expect(await readdir(f.state)).toEqual([])
  }
  const create = f.client.createPreparedTerminal.bind(f.client)
  const started = vi.spyOn(f.client, 'createPreparedTerminal').mockImplementation(async prepared => {
    expect(await f.binding()).toMatchObject({ revision: 1, desired: 'running', launchPhase: 'dispatched', launch: prepared })
    return await create(prepared)
  })
  await expect(f.manager.call('capsule.create', { operationId: 'explicit-page-create', sourcePath: f.state })).rejects.toMatchObject({ code: 'CAPSULE_RUNTIME_CREATION_UNKNOWN' })
  expect(started).toHaveBeenCalledOnce()
  expect(f.count()).toEqual({ creates: 1, stops: 0, inspections: 0 })
  const retained = await f.binding()
  expect(retained.launch.createOperationId).toBe('original-create')
  expect(JSON.parse(retained.launch.launch).createOperationId).toBe('original-create')
  expect(await f.manager.runtime.call('capsule.runtime.inspect', {})).toMatchObject({ revision: 1, desired: 'running', phase: 'unknown' })
  expect((await f.binding()).launch).toEqual(retained.launch)
  expect(f.count().creates).toBe(1)
})
it('observes an unknown original Start without resubmitting or changing the frozen launch', async () => {
  const f = await fixture(); f.unknownCreate()
  const first = await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  const frozen = (await f.binding()).launch
  expect(first).toMatchObject({ desired: 'running', phase: 'unknown', operation: { operationId: 'start', phase: 'unknown' } })
  await f.manager.runtime.call('capsule.runtime.inspect', {})
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  expect(f.count()).toEqual({ creates: 1, stops: 0, inspections: 2 })
  f.manager.start()
  await vi.waitFor(() => expect(f.count().creates + f.count().inspections).toBeGreaterThan(3))
  await f.manager.runtime.call('capsule.runtime.inspect', {})
  expect(f.count().creates).toBe(1)
  expect((await f.binding()).launch).toEqual(frozen)
})
it('persists stopped intent and the original Stop fence before effect and never retries an unknown Stop', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  f.unknownStop()
  const stopped = await f.manager.runtime.call('capsule.runtime.stop', { operationId: 'stop', expectedRevision: 1, expectedRun: { runId: 'original-run' } })
  expect(stopped).toMatchObject({ revision: 2, desired: 'stopped', phase: 'unknown' })
  const before = await f.binding()
  expect(before).toMatchObject({ desired: 'stopped', stopPhase: 'dispatched', stop: { run: { runId: 'original-run' }, ownerInstanceId: 'original-native-owner', operationId: 'original-stop' } })
  await f.manager.runtime.call('capsule.runtime.inspect', {})
  await f.manager.runtime.call('capsule.runtime.stop', { operationId: 'stop', expectedRevision: 1, expectedRun: { runId: 'original-run' } })
  const inspections = f.count().inspections
  f.manager.start()
  await vi.waitFor(() => expect(f.count().inspections).toBeGreaterThan(inspections))
  await f.manager.runtime.call('capsule.runtime.inspect', {})
  expect(f.count().stops).toBe(1)
  expect((await f.binding()).stop).toEqual(before.stop)
  await expect(f.manager.runtime.call('capsule.runtime.start', { operationId: 'new-start', expectedRevision: 2 })).rejects.toMatchObject({ code: 'CAPSULE_RUNTIME_STOP_UNKNOWN' })
  await expect(f.manager.call('capsule.ls', {})).rejects.toMatchObject({ code: 'CAPSULE_RUNTIME_STOPPED' })
  expect(f.count().creates).toBe(1)
}, 15000)

it.each(['prepared', 'dispatched'] as const)('keeps inspection of a %s original Start free of lifecycle and binding writes', async phase => {
  const f = await fixture(); f.unknownCreate()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  const binding = await f.binding(); binding.launchPhase = phase
  const path = join(f.state, 'capsule-service.json')
  await writeFile(path, JSON.stringify(binding))
  const before = await readFile(path, 'utf8'), calls = f.count()
  await f.manager.runtime.call('capsule.runtime.inspect', {})
  expect(f.count().creates).toBe(calls.creates)
  expect(f.count().stops).toBe(calls.stops)
  expect(await readFile(path, 'utf8')).toBe(before)
  await expect(f.manager.call('capsule.operation.inspect', { operationId: 'original-page-operation' })).rejects.toBeInstanceOf(AgentMuxError)
  expect(f.count().creates).toBe(calls.creates)
  expect(f.count().stops).toBe(calls.stops)
  expect(await readFile(path, 'utf8')).toBe(before)
})
it('allows an explicit Stop of the exact Run observed after an unknown Start without requiring inspection to save it', async () => {
  const f = await fixture(); f.unknownCreate()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  f.confirmCreate()
  const path = join(f.state, 'capsule-service.json'), before = await readFile(path, 'utf8')
  const observed = await f.manager.runtime.call('capsule.runtime.inspect', {})
  expect(observed.run).toEqual({ hostId: 'local', runId: 'original-run' })
  expect(await readFile(path, 'utf8')).toBe(before)
  expect((await f.binding()).run).toBeNull()
  await expect(f.manager.runtime.call('capsule.runtime.stop', { operationId: 'wrong-stop', expectedRevision: observed.revision,
    expectedRun: { runId: 'unrelated-run' } })).rejects.toMatchObject({ code: 'CAPSULE_RUNTIME_RUN_CONFLICT' })
  await expect(f.manager.runtime.call('capsule.runtime.stop', { operationId: 'original-stop', expectedRevision: observed.revision,
    expectedRun: { runId: observed.run!.runId } })).resolves.toMatchObject({ phase: 'stopped', run: observed.run })
  expect(f.count()).toMatchObject({ creates: 1, stops: 1 })
})
it('allows explicit Start after Native confirms the stopped original dispatched creation is terminal', async () => {
  const f = await fixture(); f.unknownCreate()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'original-start', expectedRevision: 0 })
  await f.manager.runtime.call('capsule.runtime.stop', { operationId: 'original-stop', expectedRevision: 1, expectedRun: null })
  f.confirmCreate(); f.terminal()
  const path = join(f.state, 'capsule-service.json'), before = await readFile(path, 'utf8')
  const observed = await f.manager.runtime.call('capsule.runtime.inspect', {})
  expect(observed).toMatchObject({ desired: 'stopped', phase: 'stopped', run: { runId: 'original-run' } })
  expect(await readFile(path, 'utf8')).toBe(before)
  await expect(f.manager.runtime.call('capsule.runtime.start', { operationId: 'explicit-resume', expectedRevision: observed.revision }))
    .resolves.toMatchObject({ desired: 'running', run: { runId: 'next-run' } })
  expect(f.count()).toMatchObject({ creates: 2, stops: 0 })
})
it('keeps inspection of a prepared Stop free of lifecycle and binding writes', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  const binding = await f.binding(); binding.desired = 'stopped'; binding.stopPhase = 'prepared'
  binding.stop = await f.client.prepareTerminalStop(binding.run)
  const path = join(f.state, 'capsule-service.json')
  await writeFile(path, JSON.stringify(binding))
  const before = await readFile(path, 'utf8'), calls = f.count()
  const observed = await f.manager.runtime.call('capsule.runtime.inspect', {})
  expect(f.count().stops).toBe(calls.stops)
  expect(observed).toMatchObject({ desired: 'stopped', phase: 'stopping', run: { runId: 'original-run' } })
  expect(await readFile(path, 'utf8')).toBe(before)
})
it('requires original revision and Run and rejects operation ID reinterpretation', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  await expect(f.manager.runtime.call('capsule.runtime.stop', { operationId: 'stop-stale', expectedRevision: 0, expectedRun: { runId: 'original-run' } })).rejects.toMatchObject({ code: 'CAPSULE_RUNTIME_REVISION_CONFLICT' })
  await expect(f.manager.runtime.call('capsule.runtime.stop', { operationId: 'stop-wrong', expectedRevision: 1, expectedRun: { runId: 'different-run' } })).rejects.toMatchObject({ code: 'CAPSULE_RUNTIME_RUN_CONFLICT' })
  await expect(f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 1 })).rejects.toMatchObject({ code: 'CAPSULE_RUNTIME_OPERATION_CONFLICT' })
  expect(f.count().stops).toBe(0)
})
it('detaches the manager without stopping its service and preserves stopped intent across manager replacement', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  await f.manager.dispose()
  expect(f.count().stops).toBe(0)
  const second = new CapsuleRunManager(f.client, f.state); cleanup.push(() => second.dispose())
  expect((await second.runtime.call('capsule.runtime.inspect', {})).run?.runId).toBe('original-run')
  await second.runtime.call('capsule.runtime.stop', { operationId: 'stop', expectedRevision: 1, expectedRun: { runId: 'original-run' } })
  await second.dispose()
  const third = new CapsuleRunManager(f.client, f.state); cleanup.push(() => third.dispose())
  expect(await third.runtime.call('capsule.runtime.inspect', {})).toMatchObject({ revision: 2, desired: 'stopped', phase: 'stopped' })
  expect(f.count()).toMatchObject({ creates: 1, stops: 1 })
})
it('retains a command reserved before a failed intent write as unknown rather than successful or superseded', async () => {
  const f = await fixture(), write = durable.durableWriteFile
  vi.spyOn(durable, 'durableWriteFile').mockImplementation(async (path, content, options) => {
    if (path.endsWith('capsule-service.json')) throw new Error('Controlled failure before intent replacement')
    return await write(path, content, options)
  })
  await expect(f.manager.runtime.call('capsule.runtime.start', { operationId: 'reserved', expectedRevision: 0 })).rejects.toThrow('Controlled failure')
  vi.restoreAllMocks()
  const inspected = await f.manager.runtime.call('capsule.runtime.start', { operationId: 'reserved', expectedRevision: 0 })
  expect(inspected).toMatchObject({ revision: 0, desired: 'unconfigured', operation: { operationId: 'reserved', phase: 'unknown' }, issue: { code: 'CAPSULE_RUNTIME_INTENT_UNKNOWN' } })
  expect(f.count().creates).toBe(0)
})
it('rejects a restored Stop token belonging to another Run before any Native effect', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  const binding = await f.binding()
  binding.desired = 'stopped'; binding.stopPhase = 'prepared'
  binding.stop = { run: { runId: 'other-run' }, ownerInstanceId: 'original-native-owner', operationId: 'original-stop' }
  await writeFile(join(f.state, 'capsule-service.json'), JSON.stringify(binding))
  await expect(f.manager.runtime.call('capsule.runtime.inspect', {})).rejects.toMatchObject({ code: 'CAPSULE_RUNTIME_BINDING_INVALID' })
  expect(f.count().stops).toBe(0)
})
it('preserves a later explicit Stop when an earlier page connection resumes with an old binding', async () => {
  const f = await fixture(); f.pauseCreation()
  const pendingPage = f.manager.call('capsule.create', { operationId: 'page-before-stop', sourcePath: f.state })
  const expectedFailure = expect(pendingPage).rejects.toMatchObject({ code: 'CAPSULE_RUNTIME_INTENT_CHANGED' })
  await vi.waitFor(() => expect(f.count().creates).toBe(1))
  const stop = f.manager.runtime.call('capsule.runtime.stop', { operationId: 'stop-after-create', expectedRevision: 1, expectedRun: { runId: 'original-run' } })
  f.releaseCreation()
  expect(await stop).toMatchObject({ desired: 'stopped', revision: 2 })
  await expectedFailure
  expect(await f.binding()).toMatchObject({ desired: 'stopped', revision: 2 })
}, 15000)
it('can stop an already terminal original Run and explicitly start a new generation without inventing a Stop token', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  f.terminal()
  expect(await f.manager.runtime.call('capsule.runtime.stop', { operationId: 'stop-terminal', expectedRevision: 1, expectedRun: { runId: 'original-run' } })).toMatchObject({ phase: 'stopped' })
  expect(await f.manager.runtime.call('capsule.runtime.inspect', {})).toMatchObject({ phase: 'stopped' })
  expect((await f.binding()).stop).toBeNull()
  const resumed = await f.manager.runtime.call('capsule.runtime.start', { operationId: 'resume', expectedRevision: 2 })
  expect(resumed).toMatchObject({ revision: 3, desired: 'running', run: { runId: 'next-run' } })
  expect(f.count()).toMatchObject({ creates: 2, stops: 0 })
})
it('does not stop an unrelated healthy Run from a semantically mismatched restored binding', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  const binding = await f.binding(); binding.run = { runId: 'unrelated-run' }
  await writeFile(join(f.state, 'capsule-service.json'), JSON.stringify(binding))
  const observed = await f.manager.runtime.call('capsule.runtime.stop', { operationId: 'stop', expectedRevision: 1, expectedRun: { runId: 'unrelated-run' } })
  expect(observed).toMatchObject({ desired: 'stopped', phase: 'unavailable', issue: { code: 'TERMINAL_PREPARATION_RUN_MISMATCH' } })
  expect(f.count().stops).toBe(0)
})
it('recovers a Native-authoritative interrupted historical Run while preserving its durable running intent', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  f.interrupted()
  const path = join(f.state, 'capsule-service.json'), before = await readFile(path, 'utf8')
  const observed = await f.manager.runtime.call('capsule.runtime.inspect', {})
  expect(observed).toMatchObject({ revision: 1, desired: 'running', phase: 'unavailable', run: { runId: 'original-run' } })
  await expect(f.manager.call('capsule.operation.inspect', { operationId: 'prior-page-create' })).rejects.toMatchObject({ code: 'CAPSULE_RUNTIME_UNAVAILABLE' })
  expect(f.count().creates).toBe(1)
  expect(await readFile(path, 'utf8')).toBe(before)
  f.manager.start()
  await vi.waitFor(() => expect(f.count().creates).toBe(2))
  expect(await f.manager.runtime.call('capsule.runtime.inspect', {})).toMatchObject({ revision: 1, desired: 'running', run: { runId: 'next-run' } })
})
it('requires original file and directory durability confirmation before any restored lifecycle effect', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  const binding = await f.binding(); binding.desired = 'stopped'
  await writeFile(join(f.state, 'capsule-service.json'), JSON.stringify(binding))
  const durableManager = f.manager as unknown as { confirmDurable(path: string): Promise<void> }
  const confirm = vi.spyOn(durableManager, 'confirmDurable').mockRejectedValue(new Error('Original directory sync unconfirmed'))
  expect(await f.manager.runtime.call('capsule.runtime.inspect', {})).toMatchObject({ desired: 'stopped', phase: 'stopping' })
  expect(confirm).not.toHaveBeenCalled()
  const stopped = await f.manager.runtime.call('capsule.runtime.stop', { operationId: 'explicit-stop', expectedRevision: 1, expectedRun: binding.run })
  expect(stopped.issue?.message).toBe('Original directory sync unconfirmed')
  expect(f.count().stops).toBe(0)
})
it.each(['inspection', 'stop'] as const)('detaches a manager waiting for an unacknowledged Native %s without replaying its operation', async kind => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  const before = f.count()
  if (kind === 'inspection') f.pauseInspection(); else f.pauseStop()
  const pending = kind === 'inspection' ? f.manager.runtime.call('capsule.runtime.inspect', {}) :
    f.manager.runtime.call('capsule.runtime.stop', { operationId: 'stop', expectedRevision: 1, expectedRun: { runId: 'original-run' } })
  await vi.waitFor(() => expect(kind === 'inspection' ? f.count().inspections : f.count().stops).toBe((kind === 'inspection' ? before.inspections : before.stops) + 1))
  await f.manager.dispose()
  expect(await pending).toMatchObject({ phase: 'unknown', issue: { code: 'CAPSULE_RUNTIME_OBSERVATION_UNKNOWN' } })
  expect(f.count().creates).toBe(1)
  expect(f.count().stops).toBe(kind === 'stop' ? 1 : 0)
  if (kind === 'stop') expect(await f.binding()).toMatchObject({ desired: 'stopped', stopPhase: 'dispatched', stop: { run: { runId: 'original-run' }, operationId: 'original-stop' } })
})
