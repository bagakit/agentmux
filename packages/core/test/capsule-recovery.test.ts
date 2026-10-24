import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { capsuleRecoveryFixture } from './helpers/capsule-recovery-fixture.js'
import { CapsuleRunManager } from '../src/capsule-run-manager.js'
import { AgentMuxError } from '../src/errors.js'
import * as durable from '../src/durable-write.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { CtxmuxProtocolError, createOperationKey } from '@ctxmux/sdk'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { decodePreparedTerminal } from '../src/terminal-preparation.js'
import { parseCapsuleRuntimeParams, parseCapsuleRuntimeResult } from '../src/capsule-runtime.js'
import { spawn } from 'node:child_process'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
async function fixture() { const value = await capsuleRecoveryFixture(); cleanup.push(value.close); return value }
const inspect = (f: Awaited<ReturnType<typeof fixture>>, operationId?: string) => f.manager.runtime.call('capsule.runtime.inspect', operationId ? { operationId } : {})

it('retains exact Start nonapplication and storage first failure across replacement and a new explicit generation', async () => {
  const f = await fixture(); f.failStart(f.notApplied)
  const first = await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start-one', expectedRevision: 0 })
  expect(first.operation).toMatchObject({ phase: 'not_applied', failure: { creationFailure: { operationId: 'native-create-1', disposition: 'not_applied' }, storageFailure: { systemErrno: 28 } } })
  const before = await readFile(join(f.state, 'capsule-service.json'))
  expect((await inspect(f, 'start-one')).operation).toEqual(first.operation)
  expect(await readFile(join(f.state, 'capsule-service.json'))).toEqual(before)
  await f.manager.dispose()
  const restored = new CapsuleRunManager(f.client, f.state); cleanup.push(() => restored.dispose())
  expect((await restored.runtime.call('capsule.runtime.inspect', { operationId: 'start-one' })).operation).toEqual(first.operation)
  f.failStart(undefined)
  const next = await restored.runtime.call('capsule.runtime.start', { operationId: 'start-two', expectedRevision: 1 })
  expect(next).toMatchObject({ phase: 'running', operation: { operationId: 'start-two', phase: 'confirmed' } })
  expect(f.calls.creates).toHaveLength(2)
  expect(f.calls.creates[1]!.createOperationId).not.toBe(f.calls.creates[0]!.createOperationId)
  expect((await restored.runtime.call('capsule.runtime.inspect', { operationId: 'start-one' })).operation).toEqual(first.operation)
})

it('does not convert wrong-key or absent Native creation receipts into permission to retry', async () => {
  for (const error of [new AgentMuxError('No receipt', 'CTXMUX_io'), new AgentMuxError('Other dispatch', 'CTXMUX_storage_error', undefined, undefined, undefined, { operationId: 'foreign', disposition: 'not_applied' })]) {
    const f = await fixture(); f.failStart(() => error)
    const first = await f.manager.runtime.call('capsule.runtime.start', { operationId: 'unknown-start', expectedRevision: 0 })
    expect(first.operation?.phase, 'Wrong or absent Native receipt must stay unknown').toBe('unknown')
    f.manager.start()
    await inspect(f); await inspect(f, 'unknown-start')
    expect(f.calls.creates).toHaveLength(1)
    expect((await inspect(f, 'unknown-start')).operation?.firstFailure?.message).toBe(error.message)
  }
})

it('settles a late original refusal after observation timeout without resending Start', async () => {
  const f = await fixture(); f.pause(); f.failStart(f.notApplied)
  const started = f.manager.runtime.call('capsule.runtime.start', { operationId: 'late-start', expectedRevision: 0 })
  await vi.waitFor(() => expect(f.calls.creates).toHaveLength(1))
  expect((await started).operation?.phase).toBe('unknown')
  f.release()
  await vi.waitFor(async () => expect(JSON.parse(await readFile(join(f.state, 'capsule-service-operations/late-start.json'), 'utf8')).receipt.phase, 'Late refusal must be durable without another management mutation').toBe('not_applied'))
  const result = await inspect(f, 'late-start')
  expect(result.operation?.failure?.creationFailure?.disposition).toBe('not_applied')
  expect(result.operation?.firstFailure?.code).toBe('CAPSULE_RUNTIME_OBSERVATION_UNKNOWN')
  expect(f.calls.creates).toHaveLength(1)
}, 15000)

it('keeps late Start success behind a later Stop intent and retains the original creation receipt', async () => {
  const f = await fixture(); f.pause()
  const started = f.manager.runtime.call('capsule.runtime.start', { operationId: 'old-start', expectedRevision: 0 })
  await vi.waitFor(() => expect(f.calls.creates).toHaveLength(1)); await started
  const stopped = await f.manager.runtime.call('capsule.runtime.stop', { operationId: 'later-stop', expectedRevision: 1, expectedRun: null })
  expect(stopped.desired).toBe('stopped')
  f.release()
  await vi.waitFor(async () => expect(JSON.parse(await readFile(join(f.state, 'capsule-service.json'), 'utf8')).run?.runId).toBe('run-1'))
  expect((await inspect(f, 'old-start')).operation?.phase).toBe('pending')
  const binding = JSON.parse(await readFile(join(f.state, 'capsule-service.json'), 'utf8'))
  expect(binding).toMatchObject({ revision: 2, desired: 'stopped', command: { params: { operationId: 'later-stop' } }, run: { runId: 'run-1' } })
  const record = JSON.parse(await readFile(join(f.state, 'capsule-service-operations/old-start.json'), 'utf8'))
  expect(record.native).toMatchObject({ operationId: 'native-create-1', runId: 'run-1', outcome: { disposition: 'applied' } })
  f.manager.start()
  await vi.waitFor(async () => expect((await inspect(f)).phase).toBe('stopped'))
  expect(f.calls.creates).toHaveLength(1); expect(f.calls.stops).toHaveLength(1)
}, 15000)

it('keeps Native creation separate from service readiness and later converges the same original management command', async () => {
  const f = await fixture(); f.noEndpoint()
  const first = await f.manager.runtime.call('capsule.runtime.start', { operationId: 'not-ready', expectedRevision: 0 })
  expect(first.operation?.phase, 'Native creation does not prove service readiness').not.toBe('confirmed')
  expect(first.run?.runId).toBe('run-1')
  await f.openEndpoint(); f.manager.start()
  await vi.waitFor(async () => expect((await inspect(f, 'not-ready')).operation?.phase).toBe('confirmed'))
  expect(f.calls.creates).toHaveLength(1)
})

it('retains a live uncalled fact when dispatched replacement is visible but durability fails', async () => {
  const f = await fixture(), original = durable.durableWriteFile
  let failing = true
  vi.spyOn(durable, 'durableWriteFile').mockImplementation(async (path, data, options) => {
    await original(path, data, options)
    if (failing && path.endsWith('capsule-service.json') && String(data).includes('"launchPhase":"dispatched"'))
      throw new durable.DurableWriteError(path, 'after-replace', new Error('Directory receipt unavailable'))
    if (failing && path.endsWith('capsule-service.json') && String(data).includes('"launchPhase":"not_applied"'))
      throw new durable.DurableWriteError(path, 'after-replace', new Error('Outcome directory receipt unavailable'))
  })
  const failed = await f.manager.runtime.call('capsule.runtime.start', { operationId: 'uncalled', expectedRevision: 0 })
  expect(failed.operation?.phase, 'Live owner retains exact uncalled Native fact').toBe('not_applied')
  expect(f.calls.creates).toHaveLength(0)
  const before = await readFile(join(f.state, 'capsule-service.json'))
  expect((await inspect(f, 'uncalled')).operation?.phase).toBe('not_applied')
  expect(await readFile(join(f.state, 'capsule-service.json'))).toEqual(before)
  failing = false
  const next = await f.manager.runtime.call('capsule.runtime.start', { operationId: 'explicit-retry', expectedRevision: 1 })
  expect(next.phase).toBe('running'); expect(f.calls.creates).toHaveLength(1)
})

it('retains an exact Stop rejection and allows only a new explicit Stop operation', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  const failure = new AgentMuxError('Original Stop was not applied', 'CTXMUX_io', undefined, { disposition: 'not_applied', confirmedInputBytes: null })
  f.failStop(failure)
  const stop = await f.manager.runtime.call('capsule.runtime.stop', { operationId: 'stop-one', expectedRevision: 1, expectedRun: { runId: 'run-1' } })
  expect(stop.operation).toMatchObject({ phase: 'not_applied', failure: { message: failure.message } })
  expect((await inspect(f, 'stop-one')).operation).toEqual(stop.operation)
  expect(f.calls.stops).toHaveLength(1)
  f.failStop(undefined)
  const next = await f.manager.runtime.call('capsule.runtime.stop', { operationId: 'stop-two', expectedRevision: 2, expectedRun: { runId: 'run-1' } })
  expect(next.operation?.phase).toBe('confirmed'); expect(f.calls.stops).toHaveLength(2)
  expect((await inspect(f, 'stop-one')).operation).toEqual(stop.operation)
  expect((await inspect(f, 'start')).operation?.phase).toBe('confirmed')
})

it('exposes the same retained original result through actual public Unix RPC and CLI', async () => {
  const f = await fixture(); f.failStart(f.notApplied)
  const server = new AgentMuxControlServer({ coreClients: () => [], capsules: f.manager, capsuleRuntime: f.manager.runtime }, join(f.directory, 'c.sock'))
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const first = await rpc.call('capsule.runtime.start', { operationId: 'public-start', expectedRevision: 0 })
  expect(first.operation?.phase).toBe('not_applied')
  const result = await rpc.call('capsule.runtime.inspect', { operationId: 'public-start' })
  expect(result.operation).toEqual(first.operation)
  const cli = process.env.CAPSULE_RECOVERY_CLI
  expect(cli, 'Actual source-compiled CLI must be provided by the verifier').toBeTruthy()
  const output = await new Promise<string>((yes, no) => {
    const child = spawn(process.execPath, [cli!, '--endpoint', 'unix:' + server.path, 'capsule', 'runtime', 'inspect', '--input', '-'],
      { env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_'))), stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.end(JSON.stringify({operationId:'public-start'}))
    let text = '', errors = ''; child.stdout.on('data', x => { text += x }); child.stderr.on('data', x => { errors += x })
    child.on('error', no); child.on('close', code => code === 0 ? yes(text) : no(new Error(errors || text)))
  })
  expect(JSON.parse(output).result.operation).toEqual(first.operation)
  await expect(rpc.call('capsule.config.update', { operationId: '23456789ABCD', expectedRevision: 1, changes: { defaultTheme: 'none' } }), 'Unsent domain request has exact nonapplication').rejects.toMatchObject({
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
  expect(f.calls.creates).toHaveLength(1)
})


it('settles a late original Stop refusal after observation timeout and never repeats its token', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  f.pause(); f.failStop(new AgentMuxError('Late original Stop refusal', 'CTXMUX_io', undefined, { disposition: 'not_applied', confirmedInputBytes: null }))
  const stopped = f.manager.runtime.call('capsule.runtime.stop', { operationId: 'late-stop', expectedRevision: 1, expectedRun: { runId: 'run-1' } })
  await vi.waitFor(() => expect(f.calls.stops).toHaveLength(1))
  expect((await stopped).operation?.phase).toBe('unknown')
  f.release()
  await vi.waitFor(async () => expect(JSON.parse(await readFile(join(f.state, 'capsule-service-operations/late-stop.json'), 'utf8')).receipt.phase, 'Late Stop refusal must be durable without another management mutation').toBe('not_applied'))
  expect((await inspect(f, 'late-stop')).operation?.firstFailure?.code).toBe('CAPSULE_RUNTIME_OBSERVATION_UNKNOWN')
  expect(f.calls.stops).toHaveLength(1)
}, 15000)


it('keeps confirmed management history when an automatic later generation has a known refusal', async () => {
  const f = await fixture()
  const original = await f.manager.runtime.call('capsule.runtime.start', { operationId: 'confirmed-start', expectedRevision: 0 })
  expect(original.operation?.phase).toBe('confirmed')
  const nativeReceipt = JSON.parse(await readFile(join(f.state, 'capsule-service-operations/confirmed-start.json'), 'utf8')).native
  await f.terminal(); f.failStart(f.notApplied); f.manager.start()
  await vi.waitFor(async () => expect((await inspect(f)).issue?.retry).toBe('start'))
  expect((await inspect(f, 'confirmed-start')).operation, 'Confirmed original management result must stay immutable').toEqual(original.operation)
  expect(JSON.parse(await readFile(join(f.state, 'capsule-service-operations/confirmed-start.json'), 'utf8')).native).toEqual(nativeReceipt)
  const next = await inspect(f)
  expect(next).toMatchObject({ phase: 'unavailable', operation: { phase: 'confirmed' }, issue: { retry: 'start' } })
  expect(f.calls.creates).toHaveLength(2)
  await inspect(f)
  expect(f.calls.creates).toHaveLength(2)
})


it('consumes exact SDK23 creation and storage facts through the original adapter rather than error text', async () => {
  const f = await fixture(), adapter = new CtxmuxRunAdapter()
  const sdk = { start: vi.fn(async (_request, operationKey: string) => {
    throw new CtxmuxProtocolError('io', 'Different display text', {
      creation_failure: { operation_key: createOperationKey(operationKey), disposition: 'not_applied' },
      storage_failure: { stage: 'start', sqlite_primary_code: 13, sqlite_extended_code: 13, system_errno: 28, transaction_outcome: 'not_started' }
    })
  }) }
  Object.assign(adapter, { client: sdk })
  vi.spyOn(f.client, 'createPreparedTerminal').mockImplementation(async prepared => {
    const decoded = decodePreparedTerminal(prepared)
    return await adapter.startPrepared(decoded.request, decoded.prepared.createOperationId) as never
  })
  const result = await f.manager.runtime.call('capsule.runtime.start', { operationId: 'sdk-refusal', expectedRevision: 0 })
  expect(result.operation).toMatchObject({ phase: 'not_applied', firstFailure: {
    code: 'CTXMUX_io', message: 'Different display text', creationFailure: { operationId: 'native-create-1', disposition: 'not_applied' }, storageFailure: { systemErrno: 28, transactionOutcome: 'not_started' }
  } })
  expect(sdk.start).toHaveBeenCalledOnce()
  await inspect(f, 'sdk-refusal')
  expect(sdk.start).toHaveBeenCalledOnce()
})

it('retains late original success and first timeout while the original ready owner confirms its command', async () => {
  const f = await fixture(); f.pause()
  const pending = f.manager.runtime.call('capsule.runtime.start', { operationId: 'late-success', expectedRevision: 0 })
  await vi.waitFor(() => expect(f.calls.creates).toHaveLength(1))
  expect((await pending).operation?.phase).toBe('unknown')
  f.release(); f.manager.start()
  await vi.waitFor(async () => expect((await inspect(f, 'late-success')).operation?.phase).toBe('confirmed'))
  const record = JSON.parse(await readFile(join(f.state, 'capsule-service-operations/late-success.json'), 'utf8'))
  await vi.waitFor(async () => expect(JSON.parse(await readFile(join(f.state, 'capsule-service-operations/late-success.json'), 'utf8')).native).toMatchObject({ operationId: 'native-create-1', outcome: { disposition: 'applied' } }))
  expect((await inspect(f, 'late-success')).operation?.firstFailure?.code).toBe('CAPSULE_RUNTIME_OBSERVATION_UNKNOWN')
  expect(f.calls.creates).toHaveLength(1)
}, 15000)

it('strictly validates history identity and typed failure/recovery fields', async () => {
  const f = await fixture(); f.failStart(f.notApplied)
  const value = await f.manager.runtime.call('capsule.runtime.start', { operationId: 'strict-original', expectedRevision: 0 })
  expect(parseCapsuleRuntimeParams('capsule.runtime.inspect', { operationId: 'strict-original' })).toEqual({ operationId: 'strict-original' })
  expect(() => parseCapsuleRuntimeParams('capsule.runtime.inspect', { operationId: '../foreign' })).toThrow()
  expect(() => parseCapsuleRuntimeParams('capsule.runtime.inspect', { author: 'human' })).toThrow()
  expect(parseCapsuleRuntimeResult(value)).toEqual(value)
  expect(() => parseCapsuleRuntimeResult({ ...value, operation: { ...value.operation, failure: { code: 'X', message: 'x', creationFailure: { operationId: 'x', disposition: 'guessed' } } } })).toThrow()
  expect(() => parseCapsuleRuntimeResult({ ...value, operation: { operationId: 'strict-original', kind: 'start', phase: 'not_applied' } })).toThrow()
  expect(() => parseCapsuleRuntimeResult({ ...value, issue: { ...value.issue, retry: 'guess' } })).toThrow()
})


it('preserves a postdispatch domain failure after its actual effect without falsely certifying nonapplication', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  const actual = f.manager as unknown as { connect: (...args: any[]) => Promise<any> }
  const connect = actual.connect.bind(actual)
  vi.spyOn(actual, 'connect').mockImplementation(async (...args) => {
    const connected = await connect(...args), call = connected.connection.call.bind(connected.connection)
    connected.connection.call = async (method, params, context) => {
      const result = await call(method, params, context)
      if (method === 'capsule.config.update') throw new AgentMuxError('Lost acknowledgment after original domain commit', 'CAPSULE_RUNTIME_UNAVAILABLE')
      return result
    }
    return connected
  })
  const config = await f.manager.call('capsule.config.inspect', {})
  const error = await f.manager.call('capsule.config.update', { operationId: '23456789ABCD', expectedRevision: config.config.revision, changes: { defaultTheme: 'none' } }).then(() => null, e => e)
  expect(error).toMatchObject({ code: 'CAPSULE_RUNTIME_UNAVAILABLE' })
  expect(error.controlFailure, 'An invoked domain call cannot inherit manager predispatch nonapplication').toBeUndefined()
  expect((await f.manager.call('capsule.operation.inspect', { operationId: '23456789ABCD' })).operation?.status).toBe('committed')
  expect((await f.manager.call('capsule.config.inspect', {})).config.defaultTheme).toBe('none')
})


async function failBindingOutcome(f: Awaited<ReturnType<typeof fixture>>, kind: 'start' | 'stop') {
  const original = durable.durableWriteFile
  let enabled = true
  const spy = vi.spyOn(durable, 'durableWriteFile').mockImplementation(async (path, data, options) => {
    if (enabled && path.endsWith('capsule-service.json')) {
      const b = JSON.parse(String(data))
      if (kind === 'start' ? b.launchOutcome : b.stopOutcome) throw new Error('Binding outcome unavailable after original command settlement')
    }
    await original(path, data, options)
  })
  return () => { enabled = false; spy.mockRestore() }
}

it('recovers a refused Start from durable settlement after binding write failure and manager replacement', async () => {
  const f = await fixture(); f.failStart(f.notApplied)
  const restore = await failBindingOutcome(f, 'start')
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'durable-start', expectedRevision: 0 })
  await f.manager.dispose(); restore()
  const before = await readFile(join(f.state, 'capsule-service.json'))
  expect(JSON.parse(before.toString())).toMatchObject({ launchPhase: 'dispatched', run: null })
  const next = new CapsuleRunManager(f.client, f.state); cleanup.push(() => next.dispose())
  const known = await next.runtime.call('capsule.runtime.inspect', { operationId: 'durable-start' })
  expect(known, 'Durable original Start refusal must restore reachable recovery').toMatchObject({ operation: { phase: 'not_applied' }, issue: { retry: 'start' } })
  expect(await readFile(join(f.state, 'capsule-service.json'))).toEqual(before)
  f.failStart(undefined)
  expect((await next.runtime.call('capsule.runtime.start', { operationId: 'new-explicit-start', expectedRevision: 1 })).phase).toBe('running')
  expect(f.calls.creates).toHaveLength(2)
})

it('recovers a refused Stop from durable settlement after binding write failure and manager replacement', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  f.failStop(new AgentMuxError('Exact Stop refusal', 'CTXMUX_io', undefined, { disposition: 'not_applied', confirmedInputBytes: null }))
  const restore = await failBindingOutcome(f, 'stop')
  await f.manager.runtime.call('capsule.runtime.stop', { operationId: 'durable-stop', expectedRevision: 1, expectedRun: { runId: 'run-1' } })
  await f.manager.dispose(); restore()
  const before = await readFile(join(f.state, 'capsule-service.json'))
  expect(JSON.parse(before.toString()).stopPhase).toBe('dispatched')
  const next = new CapsuleRunManager(f.client, f.state); cleanup.push(() => next.dispose())
  expect(await next.runtime.call('capsule.runtime.inspect', { operationId: 'durable-stop' })).toMatchObject({ operation: { phase: 'not_applied' }, issue: { retry: 'stop' } })
  expect(await readFile(join(f.state, 'capsule-service.json'))).toEqual(before)
  f.failStop(undefined)
  expect((await next.runtime.call('capsule.runtime.stop', { operationId: 'new-explicit-stop', expectedRevision: 2, expectedRun: { runId: 'run-1' } })).operation?.phase).toBe('confirmed')
  expect(f.calls.stops).toHaveLength(2)
})

it('restores an applied original Start from durable settlement without creating a replacement Run', async () => {
  const f = await fixture(); f.noEndpoint()
  const restore = await failBindingOutcome(f, 'start')
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'applied-start', expectedRevision: 0 })
  await f.manager.dispose(); restore()
  const before = await readFile(join(f.state, 'capsule-service.json'))
  const next = new CapsuleRunManager(f.client, f.state); cleanup.push(() => next.dispose())
  const unready = await next.runtime.call('capsule.runtime.inspect', { operationId: 'applied-start' })
  expect(unready.run?.runId).toBe('run-1'); expect(unready.operation?.phase).not.toBe('confirmed')
  expect(await readFile(join(f.state, 'capsule-service.json'))).toEqual(before)
  await f.openEndpoint()
  expect((await next.runtime.call('capsule.runtime.start', { operationId: 'explicit-reconnect', expectedRevision: 1 })).phase).toBe('running')
  expect(f.calls.creates).toHaveLength(1)
})

it('restores an applied original Stop from durable settlement without sending its token again', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'start', expectedRevision: 0 })
  const restore = await failBindingOutcome(f, 'stop')
  await f.manager.runtime.call('capsule.runtime.stop', { operationId: 'applied-stop', expectedRevision: 1, expectedRun: { runId: 'run-1' } })
  await f.manager.dispose(); restore()
  const next = new CapsuleRunManager(f.client, f.state); cleanup.push(() => next.dispose())
  expect((await next.runtime.call('capsule.runtime.inspect', { operationId: 'applied-stop' })).phase).toBe('stopped')
  expect((await next.runtime.call('capsule.runtime.stop', { operationId: 'explicit-confirm-stop', expectedRevision: 2, expectedRun: { runId: 'run-1' } })).phase).toBe('stopped')
  expect(f.calls.stops).toHaveLength(1)
})

it('refuses missing or foreign durable Native identity instead of granting a fresh generation', async () => {
  const f = await fixture(); f.failStart(f.notApplied)
  const restore = await failBindingOutcome(f, 'start')
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'foreign-native', expectedRevision: 0 })
  await f.manager.dispose(); restore()
  const path = join(f.state, 'capsule-service-operations/foreign-native.json')
  const retained = JSON.parse(await readFile(path, 'utf8'))
  const next = new CapsuleRunManager(f.client, f.state); cleanup.push(() => next.dispose())
  for (const native of [{ ...retained.native, launchKey: undefined }, { ...retained.native, launchKey: 'foreign-frozen-launch' }, { ...retained.native, operationId: 'another-native-operation' }]) {
    await writeFile(path, JSON.stringify({ ...retained, native }))
    expect((await next.runtime.call('capsule.runtime.inspect', { operationId: 'foreign-native' })).issue?.retry, 'Foreign Native identity cannot authorize recovery').toBeUndefined()
  }
  await next.runtime.call('capsule.runtime.start', { operationId: 'cannot-retry-unknown', expectedRevision: 1 })
  expect(f.calls.creates).toHaveLength(1)
})


it('keeps a reserved latest generation separate from an older late Native reply', async () => {
  const f = await fixture()
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'original-management', expectedRevision: 0 })
  const path = join(f.state, 'capsule-service-operations/original-management.json')
  const first = JSON.parse(await readFile(path, 'utf8')).native
  f.holdNextAck(); await f.terminal(); f.manager.start()
  await vi.waitFor(() => expect(f.calls.creates).toHaveLength(2))
  const second = await f.manager.call('capsule.config.update', { operationId: '23456789ABCD', expectedRevision: 1, changes: { defaultTheme: 'none' } })
  await f.terminal()
  await f.manager.call('capsule.config.update', { operationId: '3456789ABCDE', expectedRevision: second.config.revision, changes: { defaultTheme: 'follow' } })
  expect(f.calls.creates).toHaveLength(3)
  const before = JSON.parse(await readFile(path, 'utf8'))
  expect(before.latestNative).toMatchObject({ operationId: 'native-create-3', outcome: { disposition: 'applied' } })
  f.releaseAck()
  // This explicit command owns no new generation; it serializes after the late receipt writer.
  await f.manager.runtime.call('capsule.runtime.start', { operationId: 'read-current-generation', expectedRevision: 1 })
  const after = JSON.parse(await readFile(path, 'utf8'))
  expect(after.latestNative, 'A late old generation must preserve the latest reserved Native receipt').toEqual(before.latestNative)
  expect(after.native).toEqual(first)
  expect((await inspect(f)).run?.runId).toBe('run-3')
  expect(f.calls.creates).toHaveLength(3)
}, 20000)
