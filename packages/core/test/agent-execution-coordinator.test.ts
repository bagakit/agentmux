import { mkdtemp, realpath, rm, stat, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { messageJournalIo } from './helpers/message-journal-io.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { AgentExecutionCoordinator, AgentExecutionBindingService, type AgentExecutionHostPort, type AgentExecutionOpenInput } from '../src/agent-execution-coordinator.js'
import type { AgentMuxClientEvent, AgentMuxRunInputOperation, AgentMuxAgentSession } from '../src/types.js'

let io: Awaited<ReturnType<typeof messageJournalIo>>
beforeAll(async () => { io = await messageJournalIo() }, 30_000)
afterAll(async () => { await io.close() })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
function host(role: 'frontend' | 'executor') {
  const runId = role + '-original-run', listeners = new Set<(event: AgentMuxClientEvent) => void>()
  let runtime = role + '-original-instance', output = '', cursor = 0, lostStart = false, missing = false, state = 'running'
  const claimed = new Map<string, { startByte: number; endByte: number }>()
  const run = () => ({ runId, state })
  let started = false
  const slice = (after: number) => { const dataBytes = Buffer.from(output).subarray(after); return dataBytes.length ? [{ startByte: after, endByte: Buffer.byteLength(output), dataBytes }] : [] }
  const api = {
    runtimeIdentity: vi.fn(() => ({ instanceId: runtime })),
    prepareAgentExecutionHelper: vi.fn(async (input: { createOperationId: string; workspacePath: string }) => ({ prepared: { ...input, launch: 'fixture' } })),
    inspectPreparedTerminal: vi.fn(async () => started && !missing ? run() : null),
    createPreparedTerminal: vi.fn(async () => { started = true; if (lostStart) { lostStart = false; throw new Error('Start acknowledgement lost') }; return run() }),
    listHostExecutors: vi.fn(async () => ({ executors: [{ executorId: 'configured-executor', providerId: 'fixture-provider', configRevision: 'original-revision' }] })),
    readAgentSession: vi.fn(async (): Promise<AgentMuxAgentSession | null> => null),
    createHostAgentWithDelivery: vi.fn(async () => ({ session: { agentSessionId: 'original-agent', run: { runId: 'original-agent-run' } } })),
    onRunEvent: vi.fn((_runId: string, listener: (event: AgentMuxClientEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }),
    attachTerminal: vi.fn(async (_runId: string, after: number) => ({ run: run(), gap: null, replay: slice(after) })),
    readRunReplay: vi.fn(async (_target: unknown, after: number) => ({ run: run(), gap: null, replay: slice(after) })),
    releaseRunAttachment: vi.fn(async () => {}),
    writeTerminal: vi.fn(async (_target: unknown, input: AgentMuxRunInputOperation) => {
      let range = claimed.get(input.operationId)
      if (!range) { expect(input.expectedByte).toBe(cursor); const bytes = typeof input.data === 'string' ? Buffer.byteLength(input.data) : input.data.byteLength;
        range = { startByte: cursor, endByte: cursor + bytes }; claimed.set(input.operationId, range); cursor += bytes }
      return { runId, appliedByteRange: range, acceptedThroughByte: cursor }
    }),
  }
  return { api, port: api as unknown as AgentExecutionHostPort, runId, claimed,
    listeners, forgetCreation: () => { missing = true }, loseStart: () => { lostStart = true }, replaceRuntime: () => { runtime += '-replacement'; missing = true },
    setState: (value: string) => { state = value },
    addOutput: (frame: unknown) => {
      const data = JSON.stringify(frame) + '\n', startByte = Buffer.byteLength(output); output += data
      for (const listener of listeners) listener({ type: 'terminal-output', run: { runId }, data, dataBytes: Buffer.from(data),
        evidence: { source: 'terminal-output', observedAt: 0, run: { runId }, outputByteRange: { startByte, endByte: Buffer.byteLength(output) } } } as AgentMuxClientEvent)
      return Buffer.byteLength(output)
    },
  }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-execution-coordinator-'))); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const frontend = host('frontend'), executor = host('executor'), observations: unknown[] = []
  const input: AgentExecutionOpenInput = { bindingId: 'original-binding', agentHostId: 'agent-host', agentRuntimeId: 'agent-core',
    resourceHostId: 'resource-host', resourceRuntimeId: 'resource-core', resourceWorkspacePath: '/original/resource/project',
    resourceGrant: { scope: 'host-user', bindingId: 'original-binding' }, agent: { agentSessionId: 'original-agent', createOperationId: 'original-agent-creation',
      executorId: 'configured-executor', executorRevision: 'original-revision', workspacePath: '/agent/launch' } }
  const resolveHost = vi.fn(async (id: string) => {
    if (id === input.agentHostId) return { runtimeId: input.agentRuntimeId, client: frontend.port }
    if (id === input.resourceHostId) return { runtimeId: input.resourceRuntimeId, client: executor.port }
    throw new Error('Unrelated host lookup')
  })
  const open = async (onObservation?: () => void) => {
    const coordinator = await AgentExecutionCoordinator.open(root, { resolveHost, onObservation: value => { observations.push(value); onObservation?.() } })
    let disposed = false
    const close = async () => { if (!disposed) { disposed = true; await coordinator.dispose() } }
    cleanups.push(close)
    return { coordinator, close }
  }
  const read = () => { const db = new DatabaseSync(join(root, 'bindings.sqlite'), { readOnly: true }); try {
    const row = db.prepare('SELECT binding_intents.input,bindings.record FROM bindings JOIN binding_intents USING(id) WHERE id=?').get(input.bindingId)
    return row ? { input: JSON.parse(String(row.input)), ...JSON.parse(String(row.record)) } : null
  } finally { db.close() } }
  return { root, input, frontend, executor, resolveHost, observations, open, read }
}

describe('execution coordinator retained original pair', () => {
  it('reopens the exact SQLite pair and restores readers without creating a helper or Agent', async () => {
    const f = await fixture(), first = await f.open()
    const created = await first.coordinator.create(f.input)
    expect(created.session.agentSessionId).toBe(f.input.agent.agentSessionId)
    expect(created.execution.state).toBe('connected')
    expect((await stat(join(f.root, 'bindings.sqlite'))).mode & 0o777).toBe(0o600)
    expect(f.read()).toMatchObject({ input: f.input, bridge: { bindingId: f.input.bindingId,
      frontend: { runId: f.frontend.runId }, executor: { runId: f.executor.runId } } })
    await first.close()
    expect(f.frontend.listeners.size).toBe(0); expect(f.executor.listeners.size).toBe(0)
    const second = await f.open()
    await second.coordinator.restoreReaders()
    expect(second.coordinator.inspect(f.input.bindingId)?.state).toBe('connected')
    expect(f.frontend.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledTimes(1)
    expect(f.frontend.api.prepareAgentExecutionHelper).toHaveBeenCalledTimes(1)
    expect(f.executor.api.prepareAgentExecutionHelper).toHaveBeenCalledTimes(1)
  })

  it('recovers a lost Start reply by observing the original prepared creation, without resubmitting Start', async () => {
    const f = await fixture(), first = await f.open(); f.executor.loseStart()
    await expect(first.coordinator.create(f.input)).rejects.toThrow('Start acknowledgement lost')
    await first.close()
    const second = await f.open(); await second.coordinator.create(f.input)
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    expect(f.read().executor.runId).toBe(f.executor.runId)
  })

  it('keeps an applied but unacknowledged helper Start unknown after the original Runtime changes', async () => {
    const f = await fixture(), first = await f.open(); f.executor.loseStart()
    await expect(first.coordinator.create(f.input)).rejects.toThrow('Start acknowledgement lost')
    await first.close(); f.executor.replaceRuntime()
    const second = await f.open()
    await expect(second.coordinator.create(f.input)).rejects.toThrow()
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    expect(f.frontend.api.createPreparedTerminal).not.toHaveBeenCalled()
  })

  it('keeps a missing original Start receipt unknown even on the unchanged Runtime', async () => {
    const f = await fixture(), first = await f.open(); f.executor.loseStart()
    await expect(first.coordinator.create(f.input)).rejects.toThrow('Start acknowledgement lost')
    f.executor.forgetCreation()
    await expect(first.coordinator.create(f.input)).rejects.toThrow()
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    expect(f.frontend.api.createPreparedTerminal).not.toHaveBeenCalled()
  })

  it('does not treat a confirmed ended helper from a lost Start reply as a healthy pair', async () => {
    const f = await fixture(), first = await f.open(); f.executor.loseStart()
    await expect(first.coordinator.create(f.input)).rejects.toThrow('Start acknowledgement lost')
    f.executor.setState('exited')
    await expect(first.coordinator.create(f.input)).rejects.toThrow()
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    expect(f.frontend.api.createHostAgentWithDelivery).not.toHaveBeenCalled()
  })

  it('does not classify an acknowledged frontend detach as an execution failure', async () => {
    const f = await fixture(), first = await f.open()
    f.executor.addOutput({ type: 'generation', generation: 'old-generation', state: 'detached' })
    await first.coordinator.create(f.input)
    expect(first.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'connected' })
    await first.close()
    const second = await f.open(); await second.coordinator.restoreReaders()
    expect(second.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'connected' })
  })

  it('does not clear a native diagnostic merely because the original reader attached successfully', async () => {
    const f = await fixture(), first = await f.open()
    f.executor.addOutput({ type: 'diagnostic', generation: 'original-generation', code: 'EXECUTION_OPERATION_UNKNOWN' })
    await first.coordinator.create(f.input)
    expect(first.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'connected', diagnostics: [{ scope: 'unclassified', code: 'EXECUTION_OPERATION_UNKNOWN' }] })
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledTimes(1)
  })

  it('retains an unresolved native diagnostic after its Replay cursor was committed and the reader reopened', async () => {
    const f = await fixture(), first = await f.open()
    f.executor.addOutput({ type: 'diagnostic', generation: 'original-generation', code: 'EXECUTION_OPERATION_UNKNOWN' })
    await first.coordinator.create(f.input); await first.close()
    expect(f.read().bridge.executor.outputByte).toBeGreaterThan(0)
    const second = await f.open(); await second.coordinator.restoreReaders()
    expect(second.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'connected', diagnostics: [{ scope: 'unclassified', code: 'EXECUTION_OPERATION_UNKNOWN' }] })
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledTimes(1)
  })

  it('does not report a connected tool service when reattaching retained but ended helpers', async () => {
    const f = await fixture(), first = await f.open(); await first.coordinator.create(f.input); await first.close()
    f.executor.setState('exited')
    const second = await f.open(); await second.coordinator.restoreReaders()
    expect(second.coordinator.inspect(f.input.bindingId)?.state).toBe('unavailable')
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledTimes(1)
  })

  it('keeps live bridge progress when a concurrent create retry is awaiting helper observations', async () => {
    const f = await fixture(), first = await f.open(); await first.coordinator.create(f.input)
    const entered = gate(), held = gate(), original = f.frontend.api.listHostExecutors.getMockImplementation()!
    f.frontend.api.listHostExecutors.mockImplementationOnce(async () => { entered.release(); await held.promise; return await original() })
    const retry = first.coordinator.create(f.input); await entered.promise
    const through = f.frontend.addOutput({ type: 'request', generation: 'original-generation', payload: { id: 1, method: 'fixture/write' } })
    await vi.waitFor(() => expect(f.read().bridge.frontend.outputByte).toBe(through))
    held.release(); await retry
    expect(f.frontend.api.attachTerminal.mock.calls.map(call => call[1])).toEqual([0, through])
    expect(f.executor.api.writeTerminal).toHaveBeenCalledTimes(1)
    expect(f.read().bridge.frontend.outputByte).toBe(through)
  })

  it('rejects a competing process writer and releases ownership when its reader is disposed', async () => {
    const f = await fixture(), first = await f.open(); await first.coordinator.create(f.input)
    const modulePath = fileURLToPath(new URL(`../.tmp/execution-coordinator-owner-${process.pid}.mjs`, import.meta.url))
    cleanups.push(() => rm(modulePath, { force: true }))
    await build({ entryPoints: [fileURLToPath(new URL('../src/agent-execution-coordinator.ts', import.meta.url))], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm' })
    const source = `const {AgentExecutionCoordinator}=await import(process.argv[1]);
      try { const owner=await AgentExecutionCoordinator.open(process.argv[2],{resolveHost:async()=>{throw Error('unexpected host operation')}});
        await owner.dispose(); process.stdout.write(JSON.stringify({opened:true})); }
      catch(error) { process.stdout.write(JSON.stringify({opened:false,code:error.code})); }`
    const compete = async () => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source, modulePath, f.root])).stdout)
    expect(await compete()).toMatchObject({ opened: false })
    expect(f.read().input).toEqual(f.input)
    await first.close()
    expect(await compete()).toEqual({ opened: true })
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledTimes(1)
  })

  it('isolates observer exceptions from successful creation and later native diagnostic processing', async () => {
    const f = await fixture(), first = await f.open(() => { throw new Error('presentation observer failed') })
    const result = await first.coordinator.create(f.input)
    expect(result.session.agentSessionId).toBe(f.input.agent.agentSessionId)
    const through = f.executor.addOutput({ type: 'diagnostic', generation: 'original-generation', code: 'EXECUTION_OPERATION_UNKNOWN' })
    await vi.waitFor(() => expect(f.read().bridge.executor.outputByte).toBe(through))
    expect(first.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'connected', diagnostics: [{ scope: 'unclassified', code: 'EXECUTION_OPERATION_UNKNOWN' }] })
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
  })

  it('keeps small-frame durable write cost independent of the original large creation prompt', async () => {
    const costs: { promptBytes: number; writeBytes: number; writes: number; syncs: number }[] = []
    for (const promptBytes of [32, 2 * 1024 * 1024]) {
      const f = await fixture(); f.input.agent.prompt = 'p'.repeat(promptBytes)
      io.target(join(f.root, 'bindings.sqlite'))
      const first = await f.open(); await first.coordinator.create(f.input)
      io.reset()
      const through = f.frontend.addOutput({ type: 'request', generation: 'original-generation', payload: { id: 1, method: 'fixture/write' } })
      await vi.waitFor(() => expect(f.read().bridge.frontend.outputByte).toBe(through))
      const observed = io.stats()
      expect(observed.failures).toBe(0); expect(observed.writes).toBeGreaterThan(0); expect(observed.syncs).toBeGreaterThan(0)
      costs.push({ promptBytes, writeBytes: observed.writeBytes, writes: observed.writes, syncs: observed.syncs })
      expect(f.read().input.agent.prompt.length).toBe(promptBytes)
      await first.close()
    }
    console.info('execution coordinator small-frame SQLite IO', costs)
    // Allow page/layout variation, but never an extra megabyte-sized prompt rewrite per frame.
    expect(costs[1]!.writeBytes).toBeLessThanOrEqual(costs[0]!.writeBytes * 2 + 64 * 1024)
  })

  it('returns the original completed Agent creation after the current Executor configuration changes', async () => {
    const f = await fixture(), first = await f.open(), original = await first.coordinator.create(f.input)
    f.frontend.api.readAgentSession.mockResolvedValue({ ...original.session, executorId: f.input.agent.executorId,
      workspacePath: f.input.agent.workspacePath, creation: { createOperationId: f.input.agent.createOperationId },
      toolExecution: { bindingId: f.input.bindingId, resourceHostId: f.input.resourceHostId,
        resourceRuntimeId: f.input.resourceRuntimeId, workspacePath: f.input.resourceWorkspacePath } } as unknown as AgentMuxAgentSession)
    f.frontend.api.listHostExecutors.mockResolvedValue({ executors: [{ executorId: 'configured-executor', providerId: 'fixture-provider', configRevision: 'new-revision' }] })
    const retried = await first.coordinator.create(f.input)
    expect(retried.session).toEqual(original.session)
    expect(f.frontend.api.listHostExecutors).toHaveBeenCalledTimes(1)
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledTimes(2)
    expect(f.frontend.api.createHostAgentWithDelivery.mock.calls[1]).toEqual(f.frontend.api.createHostAgentWithDelivery.mock.calls[0])
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    expect(f.frontend.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
  })

  it('rejects changed binding intent and Core identity without replacing the pair', async () => {
    const f = await fixture(), first = await f.open(); await first.coordinator.create(f.input)
    await expect(first.coordinator.create({ ...f.input, agent: { ...f.input.agent, agentSessionId: 'another-agent' } })).rejects.toMatchObject({ code: 'EXECUTION_BINDING_CONFLICT' })
    f.resolveHost.mockResolvedValueOnce({ runtimeId: 'replacement-core', client: f.frontend.port })
    await expect(first.coordinator.rejoin(f.input.bindingId)).rejects.toMatchObject({ code: 'EXECUTION_HOST_CHANGED' })
    expect(first.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'unavailable', diagnostic: { code: 'EXECUTION_HOST_CHANGED' } })
    expect(f.read().input).toEqual(f.input)
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
  })
})


describe('optional execution service lifetime', () => {
  it('does not create a store or resolve Hosts for unused service observation', async () => {
    const f = await fixture(), path = join(f.root, 'unused')
    const service = new AgentExecutionBindingService(path, { resolveHost: f.resolveHost })
    await service.restoreReaders()
    expect(await service.inspect('uncreated-binding')).toBeNull()
    expect(f.resolveHost).not.toHaveBeenCalled()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await service.dispose()
  })
  it('preserves missing retained storage as unknown and leaves other capabilities available', async () => {
    const f = await fixture(), path = join(f.root, 'retained')
    await mkdir(path)
    const service = new AgentExecutionBindingService(path, { resolveHost: f.resolveHost })
    await expect(service.inspect(f.input.bindingId)).rejects.toMatchObject({ code: 'EXECUTION_STORAGE_UNCONFIRMED' })
    await expect(service.restoreReaders()).rejects.toMatchObject({ code: 'EXECUTION_STORAGE_UNCONFIRMED' })
    expect(f.resolveHost).not.toHaveBeenCalled()
    await expect(stat(join(path, 'bindings.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
    await service.dispose()
  })
  it('retains the original pair through lazy service disposal and reopen', async () => {
    const f = await fixture(), path = join(f.root, 'bindings')
    const service = new AgentExecutionBindingService(path, { resolveHost: f.resolveHost })
    await service.create(f.input)
    await service.dispose()
    const restored = new AgentExecutionBindingService(path, { resolveHost: f.resolveHost })
    await restored.restoreReaders()
    expect(await restored.inspect(f.input.bindingId)).toMatchObject({ state: 'connected', agentSessionId: f.input.agent.agentSessionId })
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledTimes(1)
    expect(f.frontend.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    await restored.dispose()
  })
})


it('persists both helper qualification notices without taking away a connected service, including after reader restart', async () => {
  const f = await fixture(), first = await f.open()
  const notices = (['executor', 'frontend'] as const).map(role => ({ providerId: 'fixture-provider', role, capability: role === 'executor' ? 'agent-control' as const : 'hooks' as const,
    state: role === 'executor' ? 'unconfigured' as const : 'unqualified' as const, code: role + '_QUALIFICATION', message: 'connected unavailable healthy are display text', action: 'Qualify original capability' }))
  for (const [index, h] of [f.executor, f.frontend].entries()) {
    h.api.prepareAgentExecutionHelper.mockImplementation(async input => ({ prepared: { ...input, launch: 'fixture' }, notices: [notices[index]!] }))
  }
  const created = await first.coordinator.create(f.input)
  expect(created.execution).toMatchObject({ state: 'connected', notices })
  expect(created.execution.diagnostic).toBeUndefined()
  expect(f.read().notices).toEqual(notices)
  await first.close()
  const next = await f.open()
  expect(next.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'unavailable', notices })
  expect(await next.coordinator.rejoin(f.input.bindingId)).toMatchObject({ state: 'connected', notices })
  expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledTimes(1)
  expect(f.frontend.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
  expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
})

it('qualifies Agent control only from the current frontend generation without hiding other notices or stopping native tools', async () => {
  const f = await fixture(), owner = await f.open()
  const agentNotice = { providerId: 'fixture-provider', role: 'executor' as const, capability: 'agent-control' as const,
    state: 'unconfigured' as const, code: 'AGENT_TOOL_CONTEXT_UNAVAILABLE', message: 'Route absent', action: 'Configure original route' }
  const hooks = { ...agentNotice, role: 'frontend' as const, capability: 'hooks' as const, state: 'unqualified' as const }
  f.executor.api.prepareAgentExecutionHelper.mockImplementation(async input => ({ prepared: { ...input, launch: 'fixture' }, notices: [agentNotice] }))
  f.frontend.api.prepareAgentExecutionHelper.mockImplementation(async input => ({ prepared: { ...input, launch: 'fixture' }, notices: [hooks] }))
  await owner.coordinator.create(f.input)
  const notice = () => owner.coordinator.inspect(f.input.bindingId)!.notices!.find(value => value.capability === 'agent-control')
  f.frontend.addOutput({ type: 'agent-control-state', generation: 'first', state: 'unverified', stage: 'invocation-registration', code: 'RUNTIME_OWNER_MISMATCH' })
  await vi.waitFor(() => expect(notice()).toMatchObject({ state: 'unverified', code: 'RUNTIME_OWNER_MISMATCH' }))
  expect(notice()?.message).toContain('invocation registration')
  f.executor.addOutput({ type: 'agent-control-state', generation: 'first', state: 'available' })
  await vi.waitFor(() => expect(f.read().bridge.executor.outputByte).toBeGreaterThan(0))
  expect(notice()?.state).toBe('unverified')
  f.frontend.addOutput({ type: 'agent-control-state', generation: 'first', state: 'available' })
  await vi.waitFor(() => expect(notice()).toBeUndefined())
  expect(owner.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'connected', notices: [hooks] })
  f.frontend.addOutput({ type: 'agent-control-state', generation: 'second', state: 'unverified' })
  await vi.waitFor(() => expect(notice()?.state).toBe('unverified'))
  const late = f.frontend.addOutput({ type: 'agent-control-state', generation: 'first', state: 'available' })
  await vi.waitFor(() => expect(f.read().bridge.frontend.outputByte).toBe(late))
  expect(notice()?.state).toBe('unverified')
  f.frontend.addOutput({ type: 'agent-control-state', generation: 'second', state: 'unavailable' })
  await vi.waitFor(() => expect(notice()?.message).toContain('transport is unconfirmed'))
  expect(owner.coordinator.inspect(f.input.bindingId)?.state).toBe('connected')
  expect(f.read().notices).toEqual([agentNotice, hooks])
  await owner.close()
  const restored = await f.open(); await restored.coordinator.rejoin(f.input.bindingId)
  expect(restored.coordinator.inspect(f.input.bindingId)?.notices?.find(value => value.capability === 'agent-control')?.state).toBe('unverified')
  expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledTimes(1)
  expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
})


describe('exact helper connection and local diagnostic truth', () => {
  const emit = (h: ReturnType<typeof host>, event: Record<string, unknown>) => {
    for (const listener of h.listeners) listener({ run: { runId: h.runId }, evidence: { source: 'run-process', observedAt: 0 }, ...event } as AgentMuxClientEvent)
  }
  it.each(['exited', 'interrupted', 'removed'] as const)('observes original helper %s without new output and never revives it from reader restoration', async state => {
    const f = await fixture(), first = await f.open(); await first.coordinator.create(f.input)
    emit(f.executor, state === 'removed' ? { type: 'run-removed' } : { type: 'process-state', state, pid: null })
    expect(first.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'unavailable', diagnostic: { code: 'EXECUTION_HELPER_UNAVAILABLE' } })
    emit(f.executor, { type: 'attachment-state', state: 'restored', afterByte: 0 })
    emit(f.executor, { type: 'process-state', state: 'running', pid: 1 })
    expect(first.coordinator.inspect(f.input.bindingId)?.state).toBe('unavailable')
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledTimes(1)
    expect(f.executor.api.releaseRunAttachment).not.toHaveBeenCalled()
  })
  it('separates the exact reader restoration from other Run and other helper failures', async () => {
    const f = await fixture(), first = await f.open(); await first.coordinator.create(f.input)
    emit(f.executor, { type: 'process-state', run: { runId: 'unrelated' }, state: 'exited', pid: null })
    expect(first.coordinator.inspect(f.input.bindingId)?.state).toBe('connected')
    const unavailable = { type: 'attachment-state', state: 'unavailable', afterByte: 0, diagnostic: { code: 'EXACT_READER', message: 'Its observation is unavailable' } }
    emit(f.executor, unavailable)
    expect(first.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'unavailable', diagnostic: { code: 'EXACT_READER' } })
    emit(f.frontend, { type: 'attachment-state', state: 'restored', afterByte: 0 })
    expect(first.coordinator.inspect(f.input.bindingId)?.state).toBe('unavailable')
    emit(f.executor, { type: 'attachment-state', state: 'restored', afterByte: 0, run: { runId: 'wrong' } })
    expect(first.coordinator.inspect(f.input.bindingId)?.state).toBe('unavailable')
    emit(f.executor, { type: 'attachment-state', state: 'restored', afterByte: 0 })
    expect(first.coordinator.inspect(f.input.bindingId)?.state).toBe('connected')
    expect(f.executor.api.attachTerminal).toHaveBeenCalledTimes(1)
  })
  it('uses native service revisions independently from running process and reader availability', async () => {
    const f = await fixture(), first = await f.open(); await first.coordinator.create(f.input)
    const nativeService = { revision: 5, owner: { type: 'serving' }, output: { type: 'serving' }, input: { phase: { type: 'unavailable', reason: 'write_failed' } } }
    emit(f.executor, { type: 'run-service', nativeService })
    expect(first.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'unavailable', diagnostic: { code: 'EXECUTION_HELPER_SERVICE_UNAVAILABLE' } })
    emit(f.executor, { type: 'process-state', state: 'running', pid: 1 })
    emit(f.executor, { type: 'attachment-state', state: 'restored', afterByte: 0 })
    const restored = { ...nativeService, input: { phase: { type: 'open' } } }
    emit(f.executor, { type: 'run-service', nativeService: { ...restored, revision: 4 } })
    expect(first.coordinator.inspect(f.input.bindingId)?.state).toBe('unavailable')
    emit(f.executor, { type: 'run-service', nativeService: { ...restored, revision: 6 } })
    expect(first.coordinator.inspect(f.input.bindingId)?.state).toBe('connected')
  })
  it('retains distinct operation issues across unrelated success, rejoin and Core reopen; only exact executor completion settles one', async () => {
    const f = await fixture(), first = await f.open(); await first.coordinator.create(f.input)
    const operation = { bindingId: f.input.bindingId, streamGeneration: 'original', nativeRequestId: 1 as string | number }
    const send = async (h: ReturnType<typeof host>, value: unknown) => {
      const through = h.addOutput(value)
      await vi.waitFor(() => expect(f.read().bridge[h === f.executor ? 'executor' : 'frontend'].outputByte).toBe(through))
    }
    const problem = { type: 'diagnostic', scope: 'operation', generation: 'original', code: 'RESPONSE_STORAGE_UNCONFIRMED', operation }
    await send(f.executor, problem)
    await send(f.executor, { ...problem, operation: { ...operation, nativeRequestId: '1' } })
    await send(f.executor, { type: 'diagnostic', scope: 'request', generation: 'original', code: 'INVALID_NATIVE_MESSAGE' })
    await send(f.executor, { type: 'response', generation: 'original', payload: { id: 1, result: {} } })
    await first.coordinator.rejoin(f.input.bindingId)
    expect(first.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'connected', diagnostics: [{ scope: 'operation', operation }, { scope: 'operation', operation: { ...operation, nativeRequestId: '1' } }, { scope: 'request' }] })
    await first.close(); const next = await f.open(); await next.coordinator.rejoin(f.input.bindingId)
    await send(f.frontend, { type: 'operation-completed', generation: 'original', operation })
    await send(f.executor, { type: 'operation-completed', generation: 'wrong', operation })
    await send(f.executor, { type: 'operation-completed', generation: 'original', operation: { ...operation, bindingId: 'other' } })
    expect(next.coordinator.inspect(f.input.bindingId)?.diagnostics).toHaveLength(3)
    await send(f.executor, { type: 'operation-completed', generation: 'original', operation })
    expect(next.coordinator.inspect(f.input.bindingId)?.diagnostics).toEqual([expect.objectContaining({ scope: 'operation', operation: { ...operation, nativeRequestId: '1' } }), expect.objectContaining({ scope: 'request' })])
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
  })
  it('preserves an old durable unscoped diagnostic without inventing its helper subject', async () => {
    const f = await fixture(), first = await f.open(); await first.coordinator.create(f.input); await first.close()
    const original = { code: 'OLD_UNSCOPED', message: 'Original retained message', generation: 'original' }
    const db = new DatabaseSync(join(f.root, 'bindings.sqlite'))
    const row = db.prepare('SELECT record FROM bindings WHERE id=?').get(f.input.bindingId)!
    db.prepare('UPDATE bindings SET record=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(String(row.record)), diagnostic: original }), f.input.bindingId); db.close()
    const next = await f.open(); await next.coordinator.rejoin(f.input.bindingId)
    expect(next.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'connected', diagnostics: [{ ...original, scope: 'unclassified' }] })
    expect(next.coordinator.inspect(f.input.bindingId)?.diagnostics?.[0]).not.toHaveProperty('runId')
    expect(f.read().diagnostic).toEqual(original)
  })
})


it('does not publish a binding change for an ordinary completed operation without a retained issue', async () => {
  const f = await fixture(), first = await f.open(); await first.coordinator.create(f.input)
  const count = f.observations.length
  const through = f.executor.addOutput({ type: 'operation-completed', generation: 'original', operation: { bindingId: f.input.bindingId, streamGeneration: 'original', nativeRequestId: 1 } })
  await vi.waitFor(() => expect(f.read().bridge.executor.outputByte).toBe(through))
  expect(f.observations).toHaveLength(count)
  expect(f.read()).not.toHaveProperty('diagnostics')
})


it('retains 10k native counter revisions without durable intent reads or unchanged public observations', async () => {
  const f = await fixture(), first = await f.open(); await first.coordinator.create(f.input)
  const reads = vi.spyOn(first.coordinator as unknown as { read(id: string): unknown }, 'read')
  const count = f.observations.length
  for (let revision = 1; revision <= 10_000; revision++) {
    for (const listener of f.executor.listeners) listener({ type: 'run-service', run: { runId: f.executor.runId },
      nativeService: { revision, owner: { type: 'serving' }, output: { type: 'serving' }, input: { phase: { type: 'open' }, completedInputBytes: revision } },
      evidence: { source: 'run-process', observedAt: revision } } as AgentMuxClientEvent)
  }
  expect(reads).not.toHaveBeenCalled()
  expect(f.observations).toHaveLength(count)
  for (const listener of f.executor.listeners) listener({ type: 'run-service', run: { runId: f.executor.runId },
    nativeService: { revision: 9_999, owner: { type: 'stopped', reason: 'owner_stopped' }, output: { type: 'closed' }, input: { phase: { type: 'closed' } } },
    evidence: { source: 'run-process', observedAt: 10_001 } } as AgentMuxClientEvent)
  expect(reads).not.toHaveBeenCalled()
  expect(f.observations).toHaveLength(count)
  expect(first.coordinator.inspect(f.input.bindingId)?.state).toBe('connected')
})
