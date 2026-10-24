import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalRecoveryOwner } from '../src/terminal-recovery-owner.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { parseTerminalRecoveryInput, parseTerminalRecoveryResult } from '../src/terminal-recovery.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { encodeHostedValue, decodeHostedValue } from '../src/hosted-value.js'
import type { AgentMuxRun } from '../src/types.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const input = { expectedRun: { runId: 'old-run' }, runtimeId: 'original-runtime', workspacePath: '/private/original-cwd', operationId: 'original-operation' }
const runtime = { runtimeId: input.runtimeId, instanceId: 'native-instance', buildIdentity: 'native-build', protocolVersion: 23 }
function barrier() {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  return { waiting, release }
}
export const run = (runId = 'replacement-run', state: AgentMuxRun['state'] = 'running'): AgentMuxRun => ({ runId, state, kind: 'terminal', providerId: null, executorId: null, agentSessionId: null,
  workspacePath: input.workspacePath, pid: 123, cols: 80, rows: 24, observedAt: 1, latestOutputBytes: 0, acceptedInputBytes: 0, nativeService: null })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amxtr-')); roots.push(root)
  let retained: AgentMuxRun | null = null, started = 0, retired = false
  const port = {
    runtime: () => runtime, original: vi.fn(async () => run('old-run', 'interrupted')),
    prepare: vi.fn(async (op: string, cwd: string) => ({ createOperationId: op, workspacePath: cwd,
      launch: JSON.stringify({ createOperationId: op, request: { program: '/bin/cat', args: [], cwd, env: { AGENTMUX_LIFECYCLE_OPERATION_ID: op, PRIVATE_SENTINEL: 'frozen-secret' }, initial_size: { cols: 80, rows: 24 }, declared_inputs: [] } }) })),
    start: vi.fn(async (_prepared: import('../src/terminal-preparation.js').AgentMuxPreparedTerminal) => { started++; return retained = run() }),
    inspect: vi.fn(async () => retained), retire: vi.fn(async () => retained ? { outcome: 'retained' as const, runtime, run: retained } : (retired = true, { outcome: 'retired' as const, runtime })),
    observeRetirement: vi.fn(async () => ({ runtime, outcome: retired ? 'retired' as const : 'not_retired' as const }))
  }
  return { root, port, owner: () => new TerminalRecoveryOwner(root, port), setRetained: (value: AgentMuxRun | null) => { retained = value }, count: () => started }
}
it('[terminal recovery] shared DTO validates Host path structure without interpreting the client OS', () => {
  for (const workspacePath of ['relative/cwd', 'C:\\original\\cwd']) {
    expect(parseTerminalRecoveryInput({ ...input, workspacePath })).toEqual({ ...input, workspacePath })
  }
  for (const workspacePath of ['', 'bad\0path', 'bad\npath']) {
    expect(() => parseTerminalRecoveryInput({ ...input, workspacePath })).toThrow()
  }
})
it.each(['recover', 'inspect', 'continue'] as const)('[terminal recovery] relative recovery %s is rejected before every port and intent write', async action => {
  const f = await fixture(), runtime = vi.spyOn(f.port, 'runtime')
  await expect(f.owner().recover({ ...input, workspacePath: 'relative/cwd', action }))
    .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  for (const port of [runtime, f.port.original, f.port.prepare, f.port.start, f.port.inspect, f.port.retire, f.port.observeRetirement]) {
    expect(port).not.toHaveBeenCalled()
  }
  expect(await readdir(f.root)).toEqual([])
})
it('[terminal recovery] relative recovery persisted intent cannot prepare or dispatch and does not revoke a healthy original Run', async () => {
  const f = await fixture()
  await f.owner().recover(input)
  const path = join(f.root, (await readdir(f.root)).find(path => path.endsWith('.json'))!)
  const intent = JSON.parse(await readFile(path, 'utf8'))
  intent.workspacePath = intent.prepared.workspacePath = 'relative/cwd'
  const launch = JSON.parse(intent.prepared.launch)
  launch.request.cwd = 'relative/cwd'; intent.prepared.launch = JSON.stringify(launch)
  const damaged = JSON.stringify(intent)
  await writeFile(path, damaged)
  for (const port of [f.port.prepare, f.port.start, f.port.inspect, f.port.retire, f.port.observeRetirement]) port.mockClear()
  await expect(f.owner().recover(input)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  f.port.original.mockResolvedValueOnce(run('old-run'))
  expect(await f.owner().recover(input)).toMatchObject({ kind: 'reattachable', run: { runId: 'old-run' } })
  for (const port of [f.port.prepare, f.port.start, f.port.inspect, f.port.retire, f.port.observeRetirement]) expect(port).not.toHaveBeenCalled()
  expect(await readFile(path, 'utf8')).toBe(damaged)
})
it('[terminal recovery] lost Start reentry keeps one durable frozen launch across owner reconstruction and a new caller operation', async () => {
  const f = await fixture(), start = f.port.start.getMockImplementation()!
  f.port.start.mockImplementationOnce(async () => { await start(); throw Error('reply lost') })
  expect(await f.owner().recover(input)).toMatchObject({ kind: 'pending', phase: 'dispatched', operationId: input.operationId })
  const result = await f.owner().recover({ ...input, operationId: 'remounted-new-caller' })
  expect(result).toMatchObject({ kind: 'recovered', operationId: input.operationId, run: { runId: 'replacement-run' } })
  expect(f.count()).toBe(1); expect(f.port.prepare).toHaveBeenCalledOnce()
  expect(JSON.stringify(result)).not.toContain('frozen-secret')
  const record = JSON.parse(await readFile(join(f.root, (await readdir(f.root)).find(path => path.endsWith('.json'))!), 'utf8'))
  expect(record.prepared.launch).toContain('frozen-secret')
})
it('[terminal recovery] NOT_RETAINED stays unknown and never replays Start with the same or new operation', async () => {
  const f = await fixture()
  f.port.start.mockRejectedValue(Error('unknown before ACK'))
  expect(await f.owner().recover(input)).toMatchObject({ kind: 'pending', phase: 'dispatched' })
  for (const operationId of [input.operationId, 'another-op']) expect(await f.owner().recover({ ...input, operationId })).toMatchObject({ kind: 'pending', phase: 'dispatched' })
  expect(f.port.start).toHaveBeenCalledOnce(); expect(f.port.retire).not.toHaveBeenCalled()
})
it('[terminal recovery] explicit continue fences the unknown original before one successor, repeated authorization only observes', async () => {
  const f = await fixture()
  f.port.start.mockRejectedValue(Error('unknown Start'))
  await f.owner().recover(input)
  const continuation = { ...input, operationId: 'manual-continue', action: 'continue' as const }
  expect(await f.owner().recover(continuation)).toMatchObject({ kind: 'pending', phase: 'dispatched', operationId: input.operationId })
  expect(f.port.retire).toHaveBeenCalledOnce(); expect(f.port.start).toHaveBeenCalledTimes(2)
  const old = f.port.start.mock.calls[0]![0], next = f.port.start.mock.calls[1]![0]
  expect(next.createOperationId).not.toBe(old.createOperationId)
  await f.owner().recover(continuation)
  expect(f.port.start).toHaveBeenCalledTimes(2); expect(f.port.retire).toHaveBeenCalledOnce()
})
it('[terminal recovery] concurrent Core admissions dispatch once without a file lock across Native wait', async () => {
  const f = await fixture(); let release!: () => void
  f.port.start.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r }); return run() })
  const first = f.owner().recover(input)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const other = await f.owner().recover({ ...input, operationId: 'other-Core' })
  expect(other).toMatchObject({ kind: 'pending', phase: 'dispatched' })
  release(); expect(await first).toMatchObject({ kind: 'recovered' }); expect(f.port.start).toHaveBeenCalledOnce()
})
it('[terminal recovery] concurrent same continuation only observes its one successor and never retires it', async () => {
  const f = await fixture(), inspected = barrier(), inspectReply = barrier(), started = barrier(), startReply = barrier()
  f.port.start.mockRejectedValueOnce(Error('unknown original Start'))
  await f.owner().recover(input)
  f.port.inspect.mockImplementationOnce(async () => { inspected.release(); await inspectReply.waiting; return null })
  f.port.start.mockImplementationOnce(async () => { started.release(); await startReply.waiting; return run() })
  const continuation = { ...input, operationId: 'same-manual-continue', action: 'continue' as const }
  const late = f.owner().recover(continuation)
  await inspected.waiting
  const first = f.owner().recover(continuation)
  try {
    await started.waiting
    inspectReply.release()
    expect(await late).toMatchObject({ kind: 'pending', phase: 'dispatched', operationId: input.operationId })
    expect(f.port.retire).toHaveBeenCalledOnce()
    expect(f.port.retire).toHaveBeenCalledWith(f.port.start.mock.calls[0]![0], runtime)
    expect(f.port.start).toHaveBeenCalledTimes(2)
    const record = JSON.parse(await readFile(join(f.root, (await readdir(f.root)).find(path => path.endsWith('.json'))!), 'utf8'))
    expect(record.continuedBy).toEqual([continuation.operationId]); expect(record.retiredAttempts).toHaveLength(1)
    expect(record.prepared).toEqual(f.port.start.mock.calls[1]![0]); expect(record.retirement).toBeNull()
  } finally { inspectReply.release(); startReply.release(); await first }
  expect(await first).toMatchObject({ kind: 'recovered', run: { runId: 'replacement-run' } })
})
it.each(['inspect', 'retire', 'observeRetirement', 'start'] as const)('[terminal recovery] late %s authority reply cannot confirm or rewrite a newer attempt', async boundary => {
  const f = await fixture(), entered = barrier(), reply = barrier(), started = barrier(), startReply = barrier()
  const continuation = { ...input, operationId: 'one-continuation', action: 'continue' as const }
  let late: ReturnType<TerminalRecoveryOwner['recover']>
  if (boundary === 'start') {
    f.port.start.mockImplementationOnce(async () => { entered.release(); await reply.waiting; return run('previous-attempt-run') })
    late = f.owner().recover(input)
  } else {
    f.port.start.mockRejectedValueOnce(Error('unknown original Start')); await f.owner().recover(input)
    if (boundary === 'inspect') f.port.inspect.mockImplementationOnce(async () => { entered.release(); await reply.waiting; return run('previous-attempt-run') })
    if (boundary === 'retire') f.port.retire.mockImplementationOnce(async () => { entered.release(); await reply.waiting; return { outcome: 'retained', runtime, run: run('previous-attempt-run') } })
    if (boundary === 'observeRetirement') {
      f.port.retire.mockRejectedValueOnce(Error('fence reply lost'))
      await expect(f.owner().recover(continuation)).rejects.toThrow('fence reply lost')
      f.port.observeRetirement.mockImplementationOnce(async () => { entered.release(); await reply.waiting; return { outcome: 'retired', runtime } })
    }
    late = f.owner().recover(continuation)
  }
  await entered.waiting
  f.port.start.mockImplementationOnce(async () => { started.release(); await startReply.waiting; return run() })
  const current = f.owner().recover(continuation)
  try {
    await started.waiting; reply.release()
    expect(await late).toMatchObject({ kind: 'pending', phase: 'dispatched', operationId: input.operationId })
    const record = JSON.parse(await readFile(join(f.root, (await readdir(f.root)).find(path => path.endsWith('.json'))!), 'utf8'))
    expect(record.phase).toBe('dispatched'); expect(record.run).toBeNull(); expect(record.retirement).toBeNull()
    expect(record.prepared).toEqual(f.port.start.mock.calls[1]![0]); expect(record.continuedBy).toEqual([continuation.operationId])
    expect(record.retiredAttempts).toHaveLength(1); expect(f.port.start).toHaveBeenCalledTimes(2)
  } finally { reply.release(); startReply.release(); await current }
  expect(await current).toMatchObject({ kind: 'recovered', run: { runId: 'replacement-run' } })
})
it.each(['inspect', 'retire', 'start'] as const)('[terminal recovery] late %s retained reply cannot undo a confirmed fence before a successor is prepared', async boundary => {
  const f = await fixture(), entered = barrier(), reply = barrier(), preparing = barrier(), prepareReply = barrier()
  const prepare = f.port.prepare.getMockImplementation()!
  const continuation = { ...input, operationId: 'one-continuation', action: 'continue' as const }
  let late: ReturnType<TerminalRecoveryOwner['recover']>
  if (boundary === 'start') {
    f.port.start.mockImplementationOnce(async () => { entered.release(); await reply.waiting; return run('previous-attempt-run') })
    late = f.owner().recover(input)
  } else {
    f.port.start.mockRejectedValueOnce(Error('unknown original Start')); await f.owner().recover(input)
    if (boundary === 'inspect') f.port.inspect.mockImplementationOnce(async () => { entered.release(); await reply.waiting; return run('previous-attempt-run') })
    if (boundary === 'retire') f.port.retire.mockImplementationOnce(async () => { entered.release(); await reply.waiting; return { outcome: 'retained', runtime, run: run('previous-attempt-run') } })
    late = f.owner().recover(continuation)
  }
  await entered.waiting
  f.port.prepare.mockImplementationOnce(async (...args) => { preparing.release(); await prepareReply.waiting; return prepare(...args) })
  const current = f.owner().recover(continuation)
  try {
    await preparing.waiting; reply.release()
    expect(await late).toMatchObject({ kind: 'pending', phase: 'not_applied', operationId: input.operationId })
    const record = JSON.parse(await readFile(join(f.root, (await readdir(f.root)).find(path => path.endsWith('.json'))!), 'utf8'))
    expect(record.phase).toBe('not_applied'); expect(record.run).toBeNull(); expect(record.retirement).toEqual(runtime)
    expect(record.prepared).toEqual(f.port.start.mock.calls[0]![0]); expect(record.retiredAttempts).toHaveLength(0)
  } finally { reply.release(); prepareReply.release(); await current }
  expect(await current).toMatchObject({ kind: 'recovered', run: { runId: 'replacement-run' } })
  expect(f.port.start).toHaveBeenCalledTimes(2)
})
it('[terminal recovery] the same caller operation on different original Runs cannot alias one Native creation key', async () => {
  const f = await fixture()
  await f.owner().recover(input)
  await f.owner().recover({ ...input, expectedRun: { runId: 'another-original-run' } })
  expect(f.port.prepare).toHaveBeenCalledTimes(2)
  expect(f.port.prepare.mock.calls[0]![0]).not.toBe(f.port.prepare.mock.calls[1]![0])
})
it('[terminal recovery] an ended retained replacement remains addressable in its original canonical pending receipt', async () => {
  const f = await fixture()
  await f.owner().recover(input)
  f.setRetained(run('replacement-run', 'exited'))
  const result = await f.owner().recover({ ...input, operationId: 'another-reader' })
  expect(result).toMatchObject({ kind: 'pending', phase: 'retained', operationId: input.operationId, replacementRun: { runId: 'replacement-run' } })
  expect(parseTerminalRecoveryResult(result, input)).toEqual(result)
  expect(f.port.start).toHaveBeenCalledOnce()
})
it('[terminal recovery] healthy original attaches directly and mismatched runtime or cwd cannot replace it', async () => {
  const f = await fixture(); f.port.original.mockResolvedValue(run('old-run'))
  expect(await f.owner().recover(input)).toMatchObject({ kind: 'reattachable', run: { runId: 'old-run' } })
  await expect(f.owner().recover({ ...input, runtimeId: 'different-runtime' })).rejects.toMatchObject({ code: 'TERMINAL_RECOVERY_UNCONFIRMED' })
  expect(f.port.start).not.toHaveBeenCalled(); expect(f.port.prepare).not.toHaveBeenCalled()
})
it('[terminal recovery] Core rejects wrong cwd and Agent ownership before any preparation', async () => {
  const store = new AgentMuxMemoryAgentSessionStore(), core = new AgentMuxClient({ store }), f = await fixture()
  const actual = core as any
  actual.connected = true
  actual.kernel = { stateDirectory: f.root, isConnected: () => true, creationRuntimeIdentity: () => runtime,
    status: vi.fn(async () => ({ ...run('old-run'), workspacePath: '/wrong-cwd', state: { type: 'interrupted', reason: 'daemon_restart' } })),
    prepareStart: (value: any) => ({ ...value, initial_size: { cols: 80, rows: 24 }, declared_inputs: [] }),
    startPrepared: async () => ({ ...run(), state: { type: 'running' } }) }
  const prepare = vi.spyOn(core, 'prepareTerminal')
  await expect(core.recoverTerminal(input)).rejects.toMatchObject({ code: 'TERMINAL_RECOVERY_TARGET_MISMATCH' })
  vi.spyOn(store, 'loadRetiredAgentSessions').mockResolvedValue([{ agentSessionId: 'original-agent', hostId: 'local', run: input.expectedRun, source: 'user', observedAt: 1 }])
  await expect(core.recoverTerminal(input)).rejects.toMatchObject({ code: 'RUN_KIND_MISMATCH' })
  expect(prepare).not.toHaveBeenCalled()
})
it('[terminal recovery] CLI and strict public service reach the same exact Core owner and preserve canonical receipt', async () => {
  const cli = await parseAgentMuxCliInvocation(['terminal', 'recover', '--host-id', 'local', '--runtime-id', input.runtimeId, '--run', input.expectedRun.runId, '--workspace-path', input.workspacePath, '--operation-id', 'new-CLI'])
  const f = await fixture(), recoverTerminal = vi.fn(value => f.owner().recover(value))
  const service = new AgentMuxRpcService({ coreClients: async () => [{ hostId: 'local', client: { recoverTerminal } as any }] })
  const result = await service.call('terminal.recover', cli.params as any, { transport: 'unix', principal: { kind: 'user', id: 'private-test' } })
  expect(result).toMatchObject({ kind: 'recovered', operationId: 'new-CLI' }); expect(recoverTerminal).toHaveBeenCalledWith({ ...input, operationId: 'new-CLI' })
  expect(() => parseTerminalRecoveryInput({ ...input, env: {} })).toThrow()
  expect(() => parseTerminalRecoveryResult({ ...result, expectedRun: { runId: 'wrong' } }, input)).toThrow()
  await service.dispose()
})
it('[terminal recovery] Hosted rejects extra authority arguments and verifies the returned original target', async () => {
  const identity = { runtimeId: 'core-runtime', ownerInstanceId: 'core-instance', processId: process.pid, protocolVersion: 2 as const, ctxmux: null, availability: 'connected' as const }
  const result = { kind: 'recovered' as const, expectedRun: input.expectedRun, runtimeId: input.runtimeId, operationId: input.operationId, run: run() }
  const recoverTerminal = vi.fn(async () => result)
  const core = { onEvent: () => () => {}, recoverTerminal, connectRuntime: async () => {} }
  const owner = new AgentMuxHostedRuntimeService(core as any, null, () => identity)
  const params = (args: unknown[]) => ({ consumerId: 'a'.repeat(64), fence: { runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId }, invocation: encodeHostedValue({ method: 'recoverTerminal', args }) })
  const context = { principal: { kind: 'user' as const, id: 'private-test' } }
  await expect(owner.call('runtime.invoke', params([input, { env: {} }]), context)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(owner.call('runtime.invoke', params([{ ...input, env: {} }]), context)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  const response = await owner.call('runtime.invoke', params([input]), context)
  expect(decodeHostedValue((response as any).value)).toEqual(result); expect(recoverTerminal).toHaveBeenCalledOnce()
  const client = await connectHostedAgentMux({ waitForReady: false, rpc: {
    call: vi.fn(async method => method === 'runtime.owner.identity' ? { owner: identity } : method === 'runtime.invoke'
      ? { value: encodeHostedValue({ ...result, expectedRun: { runId: 'wrong-original' } }) } : { released: true }) as any,
    subscribe: vi.fn(async () => { throw Error('Independent observation unavailable') }) as any
  } })
  await expect(client.recoverTerminal(input)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  await client.dispose(); await owner.dispose()
})
