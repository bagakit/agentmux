import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxError } from '@agentmux/core'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type ToolkitMetricsSnapshot } from '@agentmux/core/control'
import { PerformanceToolkitOwner } from '../src/main/toolkit-owner.js'
import { registerToolkitIpc } from '../src/main/toolkit-ipc.js'
import { TOOLKIT_CHANGED_CHANNEL, TOOLKIT_ENDED_CHANNEL } from '../src/shared/contracts.js'
import { AgentMuxControlServer, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { desktopToolkitPublicPort } from './helpers/desktop-toolkit-public-port.js'
import type { ToolkitRunPort } from '../src/main/toolkit-run-port.js'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getAppPath: () => process.cwd() } }))
const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const request = (operation: 'toolkit.get' | 'toolkit.run') => ({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
  requestId: 'original-reader', operation, toolId: 'performance' })
const nativeFailure = () => new AgentMuxError('Original durable state open failed.', 'CTXMUX_persistence')
const admission = { executionId: 'original-unknown', run: null, reason: 'Original creation unconfirmed.', startedAt: 100 }

function fixture(options: { restored?: boolean; historicalFailure?: boolean; knownRun?: boolean } = {}) {
  let enabled = true
  const port: ToolkitRunPort = { prepare: vi.fn(), createPrepared: vi.fn(), observe: () => () => {},
    create: vi.fn(async () => { throw nativeFailure() }), attach: vi.fn(), replay: vi.fn(), status: vi.fn(),
    stop: vi.fn(), release: vi.fn(), remove: vi.fn() }
  const retained = { ...admission, run: options.knownRun ? { hostId: 'local', runId: 'original-run' } : null }
  const receipts = { read: vi.fn(async () => options.restored ? { schema: 'agentmux.performance.receipt.v1', admission: retained } : null),
    save: vi.fn(async () => {}) }
  const openRunPort = vi.fn(async () => port)
  const owner = new PerformanceToolkitOwner({ openRunPort, launch: () => ({ runner: process.execPath,
    cli: resolve('packages/core/bin/amux'), script: resolve('apps/desktop/resources/toolkit/performance.mjs'),
    cwd: process.cwd(), env: {} }), enabled: () => enabled, receipts,
    ...(options.historicalFailure ? { failures: { read: async () => ({ schema: 'agentmux.performance.failure.v1',
      executionId: 'historical-failure', run: null, recordedAt: 1, details: { stage: 'create',
        error: { code: 'HISTORICAL', message: 'Historical failure.', stack: null, messageTruncated: false, stackTruncated: false }, bytes: null, exit: null } }),
      save: vi.fn() } } : {}) })
  cleanup.push(() => owner.dispose())
  return { owner, port, receipts, openRunPort, disable: () => { enabled = false } }
}
function ipc(owner: PerformanceToolkitOwner) {
  const handlers = new Map<string, (...args: any[]) => any>()
  cleanup.push(registerToolkitIpc(owner, (channel, handler) => handlers.set(channel, handler)))
  const sender = Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false, send: vi.fn() })
  return { handlers, sender, event: { sender } }
}

it('actual IPC observes the original create failure without retrying or ending its state reader', async () => {
  const f = fixture(), ui = ipc(f.owner)
  await expect(ui.handlers.get('toolkit:observe')!(ui.event, 'performance', 'first')).resolves.toEqual({ id: 'first' })
  const original = f.owner.current
  expect(original).toMatchObject({ state: 'unknown', run: null, consumerCount: 1, observation: null,
    reason: 'Original durable state open failed.', diagnostics: { lastFailure: { executionId: original.executionId,
      run: null, details: { stage: 'create', error: { code: 'CTXMUX_persistence', message: null, stack: null } } } } })
  expect(ui.sender.send).toHaveBeenCalledWith(TOOLKIT_CHANGED_CHANNEL, { id: 'first', snapshot: original })
  expect(ui.sender.send.mock.calls.some(([channel]) => channel === TOOLKIT_ENDED_CHANNEL)).toBe(false)
  await ui.handlers.get('toolkit:observe')!(ui.event, 'performance', 'second')
  expect(f.owner.current).toMatchObject({ executionId: original.executionId, state: 'unknown', consumerCount: 2 })
  expect((await ui.handlers.get('toolkit:get')!(ui.event, 'performance')).snapshot).toEqual(f.owner.current)
  await expect(f.owner.execute(request('toolkit.run'), new AbortController().signal)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.port.create).toHaveBeenCalledOnce()
  expect(f.port.attach).not.toHaveBeenCalled(); expect(f.port.stop).not.toHaveBeenCalled()
  expect(f.port.remove).not.toHaveBeenCalled()
  for (const id of ['first', 'second']) ui.handlers.get('toolkit:release')!(ui.event, id)
  expect(f.owner.current).toMatchObject({ executionId: original.executionId, state: 'unknown', run: null, consumerCount: 0 })
  const explicit = await f.owner.execute({ ...request('toolkit.get'), includeFailureEvidence: true }, new AbortController().signal)
  expect(explicit).toMatchObject({ snapshot: { diagnostics: { lastFailure: { details: { error: { message: original.reason } } } } } })
})

it('restored admission is readable without a failure record or acquiring the creation port', async () => {
  const f = fixture({ restored: true }), seen = vi.fn(), end = vi.fn(), signal = new AbortController()
  const lease = await f.owner.subscribe('performance', seen, end, signal.signal)
  expect(seen.mock.calls.at(-1)?.[0]).toMatchObject({ ...admission, state: 'unknown', consumerCount: 1,
    diagnostics: { lastFailure: null } })
  expect(f.openRunPort).not.toHaveBeenCalled(); expect(f.receipts.save).not.toHaveBeenCalled()
  signal.abort(); lease.dispose()
  expect(f.owner.current.consumerCount).toBe(0); expect(end).not.toHaveBeenCalled()
})

it('a historical failure stays separate from the restored unknown admission', async () => {
  const f = fixture({ restored: true, historicalFailure: true }), seen = vi.fn()
  await f.owner.execute(request('toolkit.get'), new AbortController().signal)
  const lease = await f.owner.subscribe('performance', seen, vi.fn(), new AbortController().signal)
  expect(seen.mock.calls.at(-1)?.[0]).toMatchObject({ ...admission, state: 'unknown', diagnostics: {
    lastFailure: { executionId: 'historical-failure', details: { error: { code: 'HISTORICAL', message: null } } } } })
  expect(f.openRunPort).not.toHaveBeenCalled(); expect(f.receipts.save).not.toHaveBeenCalled()
  lease.dispose()
})

it('unknown state does not swallow a consumer callback error or disabled permission', async () => {
  const f = fixture({ restored: true }), callbackError = new Error('Original reader failed.')
  await expect(f.owner.subscribe('performance', () => { throw callbackError }, vi.fn(), new AbortController().signal)).rejects.toBe(callbackError)
  expect(f.owner.current.consumerCount).toBe(0)
  f.disable()
  await expect(f.owner.subscribe('performance', vi.fn(), vi.fn(), new AbortController().signal)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.owner.current).toMatchObject({ ...admission, state: 'unknown', consumerCount: 0 })
  expect(f.openRunPort).not.toHaveBeenCalled()
})

it('a reader retired by its failure callback cannot report successful observation', async () => {
  const f = fixture()
  await expect(f.owner.subscribe('performance', value => {
    if (value.kind === 'metrics' && value.state === 'unknown') throw new Error('Original reader delivery failed.')
  }, vi.fn(), new AbortController().signal)).rejects.toMatchObject({ code: 'CTXMUX_persistence' })
  expect(f.owner.current).toMatchObject({ state: 'unknown', run: null, consumerCount: 0 })
  expect(f.port.create).toHaveBeenCalledOnce(); expect(f.port.stop).not.toHaveBeenCalled()
})

it('a reader retired during original Run reconciliation cannot report successful observation', async () => {
  const f = fixture({ restored: true, knownRun: true })
  vi.mocked(f.port.status).mockRejectedValue(new Error('Original status read failed.'))
  await expect(f.owner.subscribe('performance', value => {
    if (value.kind === 'metrics' && value.state === 'unknown') throw new Error('Original reader delivery failed.')
  }, vi.fn(), new AbortController().signal)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.owner.current).toMatchObject({ executionId: admission.executionId, state: 'unknown',
    run: { hostId: 'local', runId: 'original-run' }, consumerCount: 0 })
  expect(f.owner.current.reason).toContain('Original status read failed.')
  expect(f.port.create).not.toHaveBeenCalled(); expect(f.port.stop).not.toHaveBeenCalled()
})

it.each(['abort', 'disable'] as const)('rechecks %s after a recorded creation rejection', async action => {
  const f = fixture(), signal = new AbortController(), seen = vi.fn()
  vi.mocked(f.port.create).mockImplementation(async () => {
    if (action === 'abort') signal.abort(); else f.disable()
    throw nativeFailure()
  })
  await expect(f.owner.subscribe('performance', seen, vi.fn(), signal.signal)).rejects.toMatchObject({
    code: action === 'abort' ? 'CTXMUX_persistence' : 'CONTROL_UNAVAILABLE' })
  expect(f.owner.current).toMatchObject({ state: 'unknown', run: null, consumerCount: 0 })
  if (action === 'abort') expect(seen.mock.calls.some(([value]) => value.state === 'unknown')).toBe(false)
  expect(f.port.create).toHaveBeenCalledOnce()
})

it('public Unix watch and actual CLI inspect read the same retained unknown admission', async () => {
  const f = fixture(), dir = await mkdtemp(join(tmpdir(), 'amx-po-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const server = new AgentMuxControlServer({ socketPath: join(dir, 'control.sock'), coreClients: () => [],
    execute: vi.fn(), toolkit: desktopToolkitPublicPort(f.owner) })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(dir, 'control.sock') } })
  cleanup.push(() => rpc.dispose())
  const frames: any[] = [], end = vi.fn()
  const lease = await rpc.subscribe('toolkit.watch', { toolId: 'performance', includeFailureEvidence: true }, {
    onInitial: () => {}, onEvent: event => frames.push(event), onEnd: end })
  cleanup.push(() => lease.dispose())
  await vi.waitFor(() => expect(frames.some(frame => frame.type === 'snapshot' && frame.data.state === 'unknown')).toBe(true))
  const snapshot = f.owner.current, event = frames.filter(frame => frame.type === 'snapshot').at(-1)!.data as ToolkitMetricsSnapshot
  expect(event).toMatchObject({ executionId: snapshot.executionId, state: 'unknown', run: null,
    diagnostics: { lastFailure: { details: { stage: 'create', error: { code: 'CTXMUX_persistence', message: snapshot.reason } } } } })
  const cli = await runCompiledObjectCli(['toolkit', 'inspect', 'performance'], objectCliEnvironment(dir))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.snapshot).toEqual(snapshot)
  expect(end).not.toHaveBeenCalled(); expect(f.port.create).toHaveBeenCalledOnce()
})
