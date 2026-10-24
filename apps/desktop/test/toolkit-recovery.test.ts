import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { AgentMuxError, DurableWriteError } from '@agentmux/core'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { PerformanceToolkitOwner } from '../src/main/toolkit-owner.js'
import { ToolkitReceiptStore } from '../src/main/toolkit-receipt-store.js'
import { registerToolkitIpc } from '../src/main/toolkit-ipc.js'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { desktopToolkitPublicPort } from './helpers/desktop-toolkit-public-port.js'
import { parseToolkitCommand } from '../../../packages/core/src/toolkit-cli.js'
import type { ToolkitRunPort } from '../src/main/toolkit-run-port.js'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getAppPath: () => process.cwd() } }))
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const old = { executionId: 'original-unknown', run: null, startedAt: 100, reason: 'Original storage creation unconfirmed.' }
const input = { invocationId: 'new-observation', expectedExecutionId: old.executionId }
const req = (operation: 'toolkit.run' | 'toolkit.get', fields: object = {}) => ({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
  requestId: 'original-request', operation, toolId: 'performance', ...fields })
const error = () => new AgentMuxError('Original creation unconfirmed.', 'CTXMUX_persistence')

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'amx-pr-')), path = join(dir, 'receipts.json')
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const receipts = new ToolkitReceiptStore(path, () => ['performance'])
  await receipts.save('performance', { schema: 'agentmux.performance.receipt.v1', admission: old })
  const originalFailure = { schema: 'agentmux.performance.failure.v1' as const, executionId: old.executionId, run: null, recordedAt: 101,
    details: { stage: 'create' as const, error: { message: old.reason, code: 'CTXMUX_persistence', stack: 'Original private stack.',
      messageTruncated: false, stackTruncated: false }, bytes: null, exit: null } }
  let create: ToolkitRunPort['create'] = async () => ({ runId: 'new-run', pid: 77, kind: 'terminal' } as any)
  const port: ToolkitRunPort = { prepare: vi.fn(), createPrepared: vi.fn(), observe: () => () => {},
    create: vi.fn(async (request, onEvent, output) => await create(request, onEvent, output)), attach: vi.fn(async () => ({ replay: [], gap: null }) as any),
    replay: vi.fn(), status: vi.fn(async () => ({ state: 'exited' }) as any), stop: vi.fn(), release: vi.fn(), remove: vi.fn() }
  const make = (store = receipts) => {
    const owner = new PerformanceToolkitOwner({ openRunPort: async () => port, receipts: store,
      failures: { read: async () => originalFailure, save: vi.fn() }, enabled: () => true, launch: () => ({ runner: process.execPath,
        script: resolve('apps/desktop/resources/toolkit/performance.mjs'), cli: resolve('packages/core/bin/amux'), cwd: dir, env: {} }) })
    cleanup.push(() => owner.dispose()); return owner
  }
  const owner = make()
  return { dir, path, receipts, owner, port, make, originalFailure, setCreate: (fn: ToolkitRunPort['create']) => { create = fn } }
}

it('recovers through the production IPC while preserving original unknown facts and failure privacy', async () => {
  const f = await fixture(), handlers = new Map<string, (...args: any[]) => any>()
  cleanup.push(registerToolkitIpc(f.owner, (channel, handler) => handlers.set(channel, handler)))
  const sender = Object.assign(new EventEmitter(), { id: 12, send: vi.fn(), isDestroyed: () => false }), event = { sender }
  await handlers.get('toolkit:observe')!(event, 'performance', 'reader')
  expect(f.port.create).not.toHaveBeenCalled()
  await expect(f.owner.execute(req('toolkit.run'), new AbortController().signal)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  f.setCreate(async request => {
    const stored = JSON.parse(await readFile(f.path, 'utf8')).tools.performance
    expect(stored.admission.executionId).toBe(input.invocationId)
    expect(stored.recoveries).toEqual([{ invocationId: input.invocationId, admission: old, failure: f.originalFailure }])
    expect(request.createOperationId).toBe(input.invocationId)
    return { runId: 'new-run', pid: 77, kind: 'terminal' } as any
  })
  const current = (await handlers.get('toolkit:run')!(event, 'performance', input)).snapshot
  expect(current).toMatchObject({ state: 'observing', executionId: input.invocationId, run: { runId: 'new-run' },
    previousUnknownExecutionId: old.executionId, reason: null })
  const historical = (await handlers.get('toolkit:get')!(event, 'performance', old.executionId)).snapshot
  expect(historical).toMatchObject({ ...old, state: 'unknown', consumerCount: 0, manual: false, observation: null,
    diagnostics: { lastFailure: { executionId: old.executionId, details: { error: { message: null, stack: null } } } } })
  const explicit = await f.owner.execute(req('toolkit.get', { executionId: old.executionId, includeFailureEvidence: true }), new AbortController().signal)
  expect(explicit).toMatchObject({ snapshot: { diagnostics: { lastFailure: f.originalFailure } } })
  expect(f.port.create).toHaveBeenCalledOnce(); expect(f.port.stop).not.toHaveBeenCalled(); expect(f.port.remove).not.toHaveBeenCalled()
})

it('the same recovery invocation never creates again after reply loss, reconstruction or later observations', async () => {
  const f = await fixture(), signal = new AbortController().signal
  await f.owner.execute(req('toolkit.run', { input }), signal)
  await f.owner.execute(req('toolkit.run', { input }), signal)
  vi.mocked(f.port.status).mockResolvedValue({ state: 'running' } as any)
  const restored = f.make(new ToolkitReceiptStore(f.path, () => ['performance']))
  await restored.execute(req('toolkit.run', { input }), signal)
  expect(restored.current).toMatchObject({ executionId: input.invocationId, state: 'unknown', previousUnknownExecutionId: old.executionId })
  expect(f.port.create).toHaveBeenCalledOnce()
  await expect(restored.execute(req('toolkit.run', { input: { ...input, invocationId: 'stale-independent' } }), signal)).rejects.toMatchObject({ code: 'TOOLKIT_RECOVERY_CONFLICT' })
  expect(restored.current.manual).toBe(false)
  vi.mocked(f.port.status).mockResolvedValue({ state: 'exited' } as any)
  await restored.execute({ ...req('toolkit.run'), operation: 'toolkit.stop' } as any, signal)
  const lease = await restored.subscribe('performance', vi.fn(), vi.fn(), signal)
  await expect(restored.execute(req('toolkit.run', { input }), signal)).rejects.toMatchObject({ code: 'TOOLKIT_RECOVERY_CONFLICT' })
  expect(f.port.create).toHaveBeenCalledTimes(2)
  const historical = await restored.execute(req('toolkit.get', { executionId: old.executionId }), signal)
  expect(historical).toMatchObject({ snapshot: { ...old, state: 'unknown' } }); lease.dispose()
})

it.each(['before-replace', 'after-replace'] as const)('uncertain %s handoff never dispatches a Native creation', async phase => {
  const f = await fixture(), original = f.receipts.save.bind(f.receipts)
  vi.spyOn(f.receipts, 'save').mockImplementationOnce(async (...args) => {
    if (phase === 'after-replace') await original(...args)
    throw new DurableWriteError(f.path, phase, new Error('Controlled handoff failure.'))
  })
  await expect(f.owner.execute(req('toolkit.run', { input }), new AbortController().signal)).rejects.toThrow('Controlled handoff failure.')
  expect(f.port.create).not.toHaveBeenCalled()
  expect(f.owner.current).toMatchObject({ executionId: input.invocationId, state: 'unknown', run: null })
  const disk = JSON.parse(await readFile(f.path, 'utf8')).tools.performance
  if (phase === 'after-replace') expect(disk.recoveries[0]).toMatchObject({ invocationId: input.invocationId, admission: old })
  else expect(disk.admission).toEqual(old)
  const oldResult = await f.owner.execute(req('toolkit.get', { executionId: old.executionId }), new AbortController().signal)
  expect(oldResult).toMatchObject({ snapshot: { ...old, state: 'unknown' } })
  await f.owner.execute(req('toolkit.run', { input }), new AbortController().signal)
  expect(f.port.create).not.toHaveBeenCalled()
})

it('concurrent independent recoveries cannot adopt each other’s invocation result', async () => {
  const f = await fixture(), signal = new AbortController().signal
  let resume!: () => void
  const waiting = new Promise<void>(resolve => { resume = resolve })
  f.setCreate(async () => { await waiting; return { runId: 'new-run', pid: 77, kind: 'terminal' } as any })
  const first = f.owner.execute(req('toolkit.run', { input }), signal)
  const competing = f.owner.execute(req('toolkit.run', { input: { ...input, invocationId: 'competing-observation' } }), signal)
  const rejected = expect(competing).rejects.toMatchObject({ code: 'TOOLKIT_RECOVERY_CONFLICT' })
  await vi.waitFor(() => expect(f.port.create).toHaveBeenCalledOnce())
  resume()
  expect(await first).toMatchObject({ snapshot: { executionId: input.invocationId, state: 'observing' } })
  await rejected
  expect(f.port.create).toHaveBeenCalledOnce()
})

it('cancellation during durable handoff retains the original and never dispatches a creation', async () => {
  const f = await fixture(), controller = new AbortController(), save = f.receipts.save.bind(f.receipts)
  vi.spyOn(f.receipts, 'save').mockImplementationOnce(async (...args) => { await save(...args); controller.abort() })
  await expect(f.owner.execute(req('toolkit.run', { input }), controller.signal)).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  expect(f.port.create).not.toHaveBeenCalled()
  const original = await f.owner.execute(req('toolkit.get', { executionId: old.executionId }), new AbortController().signal)
  expect(original).toMatchObject({ snapshot: { ...old, state: 'unknown', observation: null } })
  await f.owner.execute(req('toolkit.run', { input }), new AbortController().signal)
  expect(f.port.create).not.toHaveBeenCalled()
})

it('public Unix recovery and exact CLI selector consume the original owner', async () => {
  const f = await fixture(), server = new AgentMuxControlServer({ socketPath: join(f.dir, 'control.sock'), coreClients: () => [],
    execute: vi.fn(), toolkit: desktopToolkitPublicPort(f.owner) })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.dir, 'control.sock') } })
  cleanup.push(() => rpc.dispose())
  const result = await rpc.call('toolkit.run', { toolId: 'performance', input })
  expect(result).toMatchObject({ snapshot: { executionId: input.invocationId, state: 'observing' } })
  const cli = await parseToolkitCommand(['inspect', 'performance', '--execution-id', old.executionId, '--failure-evidence'])
  const original = await rpc.call(cli.method as 'toolkit.inspect', cli.params as any)
  expect(original).toMatchObject({ snapshot: { ...old, state: 'unknown', diagnostics: { lastFailure: f.originalFailure } } })
  await expect(rpc.call('toolkit.inspect', { toolId: 'performance', executionId: 'missing-original' })).rejects.toMatchObject({ code: 'CONTROL_TARGET_UNAVAILABLE' })
  expect(f.port.create).toHaveBeenCalledOnce()
})

it.each(['matching', 'foreign', 'unknown', 'untyped', 'control-only'] as const)('only exact proven-not-applied creation converges (%s)', async kind => {
  const f = await fixture()
  await f.receipts.save('performance', { schema: 'agentmux.performance.receipt.v1', admission: null })
  const owner = f.make()
  f.setCreate(async request => {
    if (kind === 'untyped') throw error()
    throw new AgentMuxError('Controlled creation rejection.', 'CTXMUX_persistence', undefined,
      kind === 'control-only' ? { disposition: 'not_applied', confirmedInputBytes: null } : undefined, undefined,
      kind === 'control-only' ? undefined : { operationId: kind === 'foreign' ? 'foreign-operation' : request.createOperationId!,
        disposition: kind === 'unknown' ? 'unknown' : 'not_applied' })
  })
  const lease = await owner.subscribe('performance', vi.fn(), vi.fn(), new AbortController().signal).catch(() => null)
  await vi.waitFor(() => expect(owner.current.state).toBe(kind === 'matching' ? 'failed' : 'unknown'))
  expect(owner.current.diagnostics.lastFailure?.details.error.code).toBe('CTXMUX_persistence')
  expect(f.port.create).toHaveBeenCalledOnce()
  lease?.dispose()
  if (kind === 'matching') {
    const rejectedId = owner.current.executionId
    f.setCreate(async () => ({ runId: 'later-normal-run', pid: 78, kind: 'terminal' } as any))
    expect(await owner.execute(req('toolkit.run'), new AbortController().signal)).toMatchObject({ snapshot: { state: 'observing', run: { runId: 'later-normal-run' } } })
    expect(owner.current.executionId).not.toBe(rejectedId)
    expect(f.port.create).toHaveBeenCalledTimes(2)
  }
})
