import { createHash } from 'node:crypto'
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
import { AgentExecutionCoordinator, AgentExecutionBindingService, type AgentExecutionCoordinatorOptions, type AgentExecutionHostPort, type AgentExecutionOpenInput, type AgentExecutionInspection } from '../src/agent-execution-coordinator.js'
import type { AgentMuxClientEvent, AgentMuxRunInputOperation, AgentMuxAgentSession } from '../src/types.js'
import { AgentMuxError } from '../src/errors.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'

let io: Awaited<ReturnType<typeof messageJournalIo>>
beforeAll(async () => { io = await messageJournalIo() }, 30_000)
afterAll(async () => { await io.close() })
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
function host(role: 'frontend' | 'executor') {
  let runId = role + '-original-run'
  const listeners = new Set<(event: AgentMuxClientEvent) => void>()
  let runtime = role + '-original-instance', output = '', cursor = 0, lostStart = false, missing = false, state = 'running'
  const claimed = new Map<string, { startByte: number; endByte: number }>()
  const run = () => ({ runId, state })
  let started = false
  const slice = (after: number) => { const dataBytes = Buffer.from(output).subarray(after); return dataBytes.length ? [{ startByte: after, endByte: Buffer.byteLength(output), dataBytes }] : [] }
  const api = {
    runtimeIdentity: vi.fn(() => ({ instanceId: runtime })),
    prepareAgentExecutionHelper: vi.fn(async (input: { createOperationId: string; workspacePath: string }) => ({ prepared: { ...input, launch: 'fixture' } })),
    inspectPreparedTerminal: vi.fn(async (_prepared?: unknown, exact?: { runId: string }) =>
      started && !missing && (!exact || exact.runId === runId) ? run() : null),
    createPreparedTerminal: vi.fn(async () => { started = true; if (lostStart) { lostStart = false; throw new Error('Start acknowledgement lost') }; return run() }),
    listHostExecutors: vi.fn(async () => ({ executors: [{ executorId: 'configured-executor', providerId: 'fixture-provider', configRevision: 'original-revision' }] })),
    readAgentSession: vi.fn(async (): Promise<AgentMuxAgentSession | null> => null),
    createHostAgentWithDelivery: vi.fn(async () => ({ session: { agentSessionId: 'original-agent', run: { runId: 'original-agent-run' } } })),
    cancelAgentCreation: vi.fn(async () => ({ outcome: 'created' })),
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
  const addBytes = (data: string) => {
      const startByte = Buffer.byteLength(output); output += data
      for (const listener of listeners) listener({ type: 'terminal-output', run: { runId }, data, dataBytes: Buffer.from(data),
        evidence: { source: 'terminal-output', observedAt: 0, run: { runId }, outputByteRange: { startByte, endByte: Buffer.byteLength(output) } } } as AgentMuxClientEvent)
      return Buffer.byteLength(output)
  }
  return { api, port: api as unknown as AgentExecutionHostPort, runId, claimed,
    listeners, forgetCreation: () => { missing = true }, loseStart: () => { lostStart = true }, replaceRuntime: () => { runtime += '-replacement'; missing = true },
    installSuccessor: () => { runId = role + '-successor-run'; output = ''; cursor = 0; claimed.clear(); missing = false; return run() },
    readInputByte: () => cursor,
    setState: (value: string) => { state = value },
    addBytes, addOutput: (frame: unknown) => addBytes(JSON.stringify(frame) + '\n'),
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
  const open = async (onObservation?: () => void, options: Partial<AgentExecutionCoordinatorOptions> = {}) => {
    const coordinator = await AgentExecutionCoordinator.open(root, { resolveHost, onObservation: value => { observations.push(value); onObservation?.() }, ...options })
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
  it.each(['running', 'exited', 'second Native replacement'] as const)('automatically replaces only a project helper with the original Agent %s', async scenario => {
    const f = await fixture(), originalOwner = await f.open()
    f.input.resourceHostId = 'local'
    const workspacePath = f.input.resourceWorkspacePath, createOperationId = 'original-executor-start'
    const localProjectExecutor = vi.fn(async () => ({
      bindingId: f.input.bindingId, role: 'executor' as const, providerId: 'fixture-provider', journalIdentity: 'original-project-journal',
      prepared: { createOperationId, workspacePath, launch: JSON.stringify({ createOperationId, request: {
        program: '/original/helper', args: [], cwd: workspacePath, env: { AGENTMUX_LIFECYCLE_OPERATION_ID: createOperationId },
        initial_size: { cols: 80, rows: 24 }, declared_inputs: [],
      } }) },
    }))
    await originalOwner.coordinator.create(f.input)
    await originalOwner.close()
    f.executor.replaceRuntime()
    const previousInstance = f.executor.api.runtimeIdentity().instanceId
    if (scenario === 'second Native replacement') f.executor.api.createPreparedTerminal.mockImplementationOnce(async () => {
      f.executor.replaceRuntime()
      throw new AgentMuxError('The project changed before this exact Start', 'TERMINAL_INITIAL_RUNTIME_CHANGED')
    })
    f.executor.api.createPreparedTerminal.mockImplementationOnce(async () => f.executor.installSuccessor())
    const oldReplay = f.frontend.api.readRunReplay.getMockImplementation()!
    f.frontend.api.readRunReplay.mockImplementation(async (...args) => {
      const result = await oldReplay(...args)
      return { ...result, run: { ...result.run, acceptedInputBytes: 0, latestOutputBytes: 0,
        nativeService: { owner: { type: 'serving' }, input: { phase: { type: 'open' }, completedInputBytes: 0,
          activeConfirmedBytes: 0, unsettledCommands: 0, unsettledRequestBytes: 0 } } } }
    })
    const observed = vi.fn(async () => ({
      kind: 'agent', run: { runId: 'original-agent-run', state: scenario === 'exited' ? 'exited' : 'running' },
      agentSession: { agentSessionId: f.input.agent.agentSessionId, run: { runId: 'original-agent-run' },
        toolExecution: { bindingId: f.input.bindingId, resourceRuntimeId: f.input.resourceRuntimeId, workspacePath } },
    }))
    f.frontend.port.runtimeSubject = observed as unknown as AgentExecutionHostPort['runtimeSubject']
    const startLocalProjectExecutor = vi.fn(async (_prepared, instance: string) => {
      expect(instance).toBe(f.executor.api.runtimeIdentity().instanceId)
      return await f.executor.api.createPreparedTerminal() as never
    })
    const reconcileLocalProjectExecutor = vi.fn(async () => 'not-admitted' as const)
    const active = await f.open(undefined, { localProjectExecutor, startLocalProjectExecutor, reconcileLocalProjectExecutor })
    await active.coordinator.restoreReaders()
    await vi.waitFor(() => expect(observed).toHaveBeenCalledWith({ kind: 'agent-session', agentSessionId: f.input.agent.agentSessionId }))
    if (scenario !== 'exited') {
      await vi.waitFor(() => expect(f.read().bridge.executor.runId).toBe('executor-successor-run'))
      expect(f.read().bridge.frontend.runId).toBe(f.frontend.runId)
    } else {
      expect(localProjectExecutor).not.toHaveBeenCalled()
      expect(active.coordinator.inspect(f.input.bindingId)?.diagnostic?.nextAction).toBe('recover-project')
    }
    if (scenario === 'second Native replacement') {
      const [abandoned, successor] = f.read().projectRecoveries
      expect(abandoned).toMatchObject({ ownerInstanceId: previousInstance, previousAttemptSettled: 'not-admitted' })
      expect(successor.operationId).not.toBe(abandoned.operationId)
      expect(reconcileLocalProjectExecutor).toHaveBeenCalledWith(expect.objectContaining({ createOperationId: abandoned.operationId }), previousInstance)
    } else expect(reconcileLocalProjectExecutor).not.toHaveBeenCalled()
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(scenario === 'exited' ? 1 : scenario === 'running' ? 2 : 3)
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledTimes(1)
  })

  it('recovers a lost project helper on the original binding without forwarding an old Input again', async () => {
    const f = await fixture()
    f.input.resourceHostId = 'local'
    const workspacePath = f.input.resourceWorkspacePath, createOperationId = 'original-executor-start'
    const prepared = { createOperationId, workspacePath, launch: JSON.stringify({ createOperationId, request: {
      program: '/original/helper', args: ['executor'], cwd: workspacePath, env: { AGENTMUX_LIFECYCLE_OPERATION_ID: createOperationId },
      initial_size: { cols: 80, rows: 24 }, declared_inputs: [],
    } }) }
    const owner = await f.open(undefined, { startLocalProjectExecutor: async (_prepared, instance) => {
      expect(instance).toBe(f.executor.api.runtimeIdentity().instanceId)
      return await f.executor.api.createPreparedTerminal() as never
    }, localProjectExecutor: async () => ({
      bindingId: f.input.bindingId, role: 'executor', providerId: 'fixture-provider', prepared, journalIdentity: 'original-project-journal',
    }) })
    await owner.coordinator.create(f.input)
    const original = f.read().bridge
    const write = f.executor.api.writeTerminal.getMockImplementation()!
    f.executor.api.writeTerminal.mockImplementationOnce(async (...args) => {
      await write(...args)
      f.executor.replaceRuntime()
      throw new AgentMuxError('The original write acknowledgement was lost', 'EXECUTION_RUNTIME_CHANGED')
    })
    const oldEndByte = f.frontend.addOutput({ type: 'request', generation: 'old-native', payload: { id: 1, method: 'tools/call' } })
    await vi.waitFor(() => expect(f.read().bridge.pending?.sourceEndByte).toBe(oldEndByte))
    await expect(owner.coordinator.rejoin(f.input.bindingId)).rejects.toMatchObject({ code: 'EXECUTION_RUNTIME_CHANGED' })
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    const inspect = f.executor.api.inspectPreparedTerminal.getMockImplementation()!
    f.executor.api.inspectPreparedTerminal.mockImplementation((launch, exact) => exact?.runId === original.executor.runId
      ? Promise.resolve({ runId: exact.runId, state: 'interrupted' }) : inspect(launch, exact))

    const replay = f.frontend.api.readRunReplay.getMockImplementation()!
    f.frontend.api.readRunReplay.mockImplementation(async (...args) => {
      const result = await replay(...args)
      const acceptedInputBytes = f.frontend.readInputByte()
      return { ...result, run: { ...result.run, latestOutputBytes: result.replay.at(-1)?.endByte ?? args[1], acceptedInputBytes,
        nativeService: { owner: { type: 'serving' }, input: { phase: { type: 'open' }, completedInputBytes: acceptedInputBytes,
          activeConfirmedBytes: 0, unsettledCommands: 0, unsettledRequestBytes: 0 } } } }
    })
    const healthyCut = f.frontend.api.readRunReplay.getMockImplementation()!
    f.frontend.api.readRunReplay.mockImplementationOnce(async (...args) => {
      const result = await healthyCut(...args)
      const run = result.run as typeof result.run & { nativeService: { input: { unsettledCommands: number } } }
      run.nativeService.input.unsettledCommands = 1
      return { ...result, run }
    })
    await expect(owner.coordinator.rejoin(f.input.bindingId, undefined, true)).rejects.toMatchObject({ code: 'EXECUTION_PROJECT_RECOVERY_UNCONFIRMED' })
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    expect(f.read().projectRecoveries).toBeUndefined()

    f.executor.api.createPreparedTerminal.mockImplementationOnce(async () => {
      f.executor.installSuccessor()
      throw new AgentMuxError('The successor Start acknowledgement was lost', 'CONTROL_CONNECTION_FAILED')
    })
    await expect(owner.coordinator.rejoin(f.input.bindingId, undefined, true)).rejects.toMatchObject({ code: 'CONTROL_CONNECTION_FAILED' })
    const recoveryId = f.read().projectRecoveries[0].operationId
    const restored = await owner.coordinator.rejoin(f.input.bindingId, undefined, true)
    expect(restored).toMatchObject({ state: 'unavailable', diagnostic: { code: 'EXECUTION_PROJECT_INITIALIZATION_PENDING' }, helperStarts: {
      frontend: { runId: f.frontend.runId }, executor: { runId: 'executor-successor-run' },
    } })
    expect(f.read().projectRecoveries[0]).toMatchObject({ original: { executor: original.executor, pending: { sourceEndByte: oldEndByte } } })
    expect(f.read().bridge.projectRecoveryId).toBe(recoveryId)
    expect(f.executor.api.writeTerminal).toHaveBeenCalledTimes(1)
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledTimes(1)
    const journalReady = { type: 'ready', bindingId: f.input.bindingId, journalIdentity: 'original-project-journal' }
    f.executor.addOutput(journalReady)
    f.frontend.addOutput({ type: 'request', generation: 'new-native', payload: { id: 1, method: 'initialize' } })
    await vi.waitFor(() => expect(f.executor.api.writeTerminal).toHaveBeenCalledTimes(2))
    f.executor.addOutput({ type: 'response', generation: 'new-native', payload: { id: 1, result: {} } })
    f.executor.addOutput({ type: 'native-connection-ready', generation: 'new-native' })
    await vi.waitFor(() => expect(owner.coordinator.inspect(f.input.bindingId)?.state).toBe('connected'))
    expect(f.frontend.api.writeTerminal).toHaveBeenCalledTimes(1)
    f.frontend.addOutput({ type: 'request', generation: 'new-native', payload: { id: 2, method: 'tools/call' } })
    await vi.waitFor(() => expect(f.executor.api.writeTerminal).toHaveBeenCalledTimes(3))
    f.executor.addOutput({ type: 'response', generation: 'new-native', payload: { id: 2, result: { project: 'original-resource' } } })
    await vi.waitFor(() => expect(f.frontend.api.writeTerminal).toHaveBeenCalledTimes(2))
    expect(JSON.parse(Buffer.from(f.frontend.api.writeTerminal.mock.calls[1]![1].data).toString()).payload.result.project).toBe('original-resource')
    expect((await owner.coordinator.rejoin(f.input.bindingId, undefined, true)).state).toBe('connected')
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(2)
  })

  it('automatically rejoins the original bridge after carrier loss and reconciles the lost Input acknowledgement', async () => {
    const f = await fixture(), owner = await f.open()
    const original = (await owner.coordinator.create(f.input)).execution
    const disconnected = () => new AgentMuxError('Original carrier disconnected', 'CONTROL_CONNECTION_FAILED')
    const resolveHost = f.resolveHost.getMockImplementation()!
    let failedRejoins = 0
    f.resolveHost.mockImplementation(async id => {
      if (id === f.input.resourceHostId && failedRejoins < 2) { failedRejoins++; throw disconnected() }
      return await resolveHost(id)
    })
    const write = f.executor.api.writeTerminal.getMockImplementation()!
    f.executor.api.writeTerminal.mockImplementationOnce(async (...args) => {
      await write(...args)
      throw disconnected()
    })
    const end = f.frontend.addOutput({ type: 'request', generation: 'original', payload: { id: 1, method: 'tools/call' } })
    const inspect = () => owner.coordinator.inspect(f.input.bindingId)
    await vi.waitFor(() => expect(inspect()).toMatchObject({ state: 'unavailable', diagnostic: { code: 'CONTROL_CONNECTION_FAILED' } }))
    expect(f.read().bridge.pending.operation.operationId).toBe(f.executor.api.writeTerminal.mock.calls[0]![1].operationId)
    await vi.waitFor(() => expect(inspect()).toMatchObject({ state: 'connected', helperStarts: original.helperStarts,
      continuation: original.continuation }), { timeout: 3000 })
    expect(failedRejoins).toBe(2)
    expect(f.executor.api.writeTerminal.mock.calls).toHaveLength(2)
    expect(f.executor.api.writeTerminal.mock.calls[1]).toEqual(f.executor.api.writeTerminal.mock.calls[0])
    expect(f.executor.claimed.size).toBe(1)
    expect(f.read().bridge.frontend.outputByte).toBe(end)
    expect(f.read().bridge.pending).toBeUndefined()
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledOnce()
    for (const helper of [f.frontend, f.executor]) expect(helper.api.createPreparedTerminal).toHaveBeenCalledOnce()
  })

  it('keeps the original claim and stops background rejoin when the carrier answers for another Runtime', async () => {
    const f = await fixture(), owner = await f.open()
    const original = (await owner.coordinator.create(f.input)).execution
    f.resolveHost.mockImplementationOnce(async () => ({ runtimeId: 'wrong-runtime', client: f.frontend.port }))
    f.executor.api.writeTerminal.mockRejectedValueOnce(new AgentMuxError('Original carrier disconnected', 'CONTROL_CONNECTION_FAILED'))
    f.frontend.addOutput({ type: 'request', generation: 'original', payload: { id: 1, method: 'tools/call' } })
    await vi.waitFor(() => expect(f.resolveHost).toHaveBeenCalledTimes(4))
    expect(owner.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'unavailable',
      diagnostic: { code: 'CONTROL_CONNECTION_FAILED' }, helperStarts: original.helperStarts, continuation: original.continuation })
    await new Promise(resolve => setTimeout(resolve, 550))
    expect(f.resolveHost).toHaveBeenCalledTimes(4)
    expect(f.executor.api.writeTerminal).toHaveBeenCalledOnce()
    expect(f.read().bridge.pending.operation.operationId).toBe(f.executor.api.writeTerminal.mock.calls[0]![1].operationId)
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledOnce()
  })

  it('retains both independently pending Inputs across coordinator reopen', async () => {
    const f = await fixture(), first = await f.open(), ack = gate()
    await first.coordinator.create(f.input)
    for (const helper of [f.frontend, f.executor]) {
      const write = helper.api.writeTerminal.getMockImplementation()!
      helper.api.writeTerminal.mockImplementationOnce(async (...args) => {
        const receipt = await write(...args)
        await ack.promise
        return receipt
      })
    }
    f.frontend.addOutput({ type: 'request', generation: 'original', payload: { id: 1, method: 'tools/call' } })
    f.executor.addOutput({ type: 'response', generation: 'original', payload: { id: 0, result: 'original reply' } })
    try {
      await vi.waitFor(() => {
        expect(f.frontend.api.writeTerminal).toHaveBeenCalledOnce()
        expect(f.executor.api.writeTerminal).toHaveBeenCalledOnce()
      })
      const saved = f.read().bridge
      expect([saved.pending.source, saved.concurrentPending.source].sort()).toEqual(['executor', 'frontend'])
      const db = new DatabaseSync(join(f.root, 'bindings.sqlite'), { readOnly: true })
      try { expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2) } finally { db.close() }
      await first.close()
      const second = await f.open()
      await second.coordinator.restoreReaders()
      expect(second.coordinator.inspect(f.input.bindingId)?.state).toBe('connected')
      for (const helper of [f.frontend, f.executor]) {
        expect(helper.api.writeTerminal).toHaveBeenCalledTimes(2)
        expect(helper.api.writeTerminal.mock.calls[1]).toEqual(helper.api.writeTerminal.mock.calls[0])
        expect(helper.claimed.size).toBe(1)
        expect(helper.api.createPreparedTerminal).toHaveBeenCalledOnce()
      }
      expect(f.read().bridge).not.toHaveProperty('pending')
      expect(f.read().bridge).not.toHaveProperty('concurrentPending')
    } finally { ack.release() }
  })

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

  it('continues the original Agent creation on a healthy bridge without repeating helper preparation or attachment', async () => {
    const f = await fixture(), first = await f.open(); await first.coordinator.create(f.input)
    const entered = gate(), held = gate(), original = f.frontend.api.createHostAgentWithDelivery.getMockImplementation()!
    f.frontend.api.createHostAgentWithDelivery.mockImplementationOnce(async () => { entered.release(); await held.promise; return await original() })
    const retry = first.coordinator.create(f.input); await entered.promise
    try {
      const through = f.frontend.addOutput({ type: 'request', generation: 'original-generation', payload: { id: 1, method: 'fixture/write' } })
      await vi.waitFor(() => expect(f.read().bridge.frontend.outputByte).toBe(through))
      held.release(); await retry
      for (const helper of [f.frontend, f.executor]) {
        expect(helper.api.prepareAgentExecutionHelper).toHaveBeenCalledOnce()
        expect(helper.api.attachTerminal).toHaveBeenCalledOnce()
        expect(helper.api.releaseRunAttachment).not.toHaveBeenCalled()
      }
      expect(f.executor.api.writeTerminal).toHaveBeenCalledOnce()
      expect(f.read().bridge.frontend.outputByte).toBe(through)
    } finally { held.release() }
  })

  it.each(['[1234/PRIVATE_STDERR]\n', '{"type":"response","private":"PRIVATE_PAYLOAD"\n'])('records safe exact bad-frame provenance without returning raw bytes or changing helpers: %s', async bad => {
    const f = await fixture(), first = await f.open(); await first.coordinator.create(f.input)
    f.frontend.api.createPreparedTerminal.mockClear(); f.executor.api.createPreparedTerminal.mockClear()
    f.frontend.api.createHostAgentWithDelivery.mockClear()
    f.executor.addBytes(bad.slice(0, 5)); f.executor.addBytes(bad.slice(5))
    const ref = { bindingId: f.input.bindingId, agentSessionId: f.input.agent.agentSessionId, createOperationId: f.input.agent.createOperationId }
    await vi.waitFor(() => expect(first.coordinator.diagnostics(ref)?.failure).toMatchObject({
      hostId: f.input.resourceHostId, role: 'executor', stage: 'attach', code: 'EXECUTION_PROTOCOL_INVALID_FRAME',
      frame: { startByte: 0, endByte: Buffer.byteLength(bad), bytes: Buffer.byteLength(bad) - 1, syntax: 'invalid-json' }
    }))
    const diagnostic = first.coordinator.diagnostics(ref)!
    expect(diagnostic.failure!.frame!.sha256).toBe(createHash('sha256').update(bad.slice(0, -1)).digest('hex'))
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_')
    f.resolveHost.mockRejectedValueOnce(new AgentMuxError('Rejoin lookup failed', 'CONTROL_TIMEOUT'))
    await expect(first.coordinator.rejoin(f.input.bindingId)).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT' })
    expect(first.coordinator.diagnostics(ref)?.failure).toEqual(diagnostic.failure)
    expect(first.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'unavailable', diagnostic: { code: 'EXECUTION_PROTOCOL_INVALID_FRAME' } })
    expect(first.coordinator.inspect(f.input.bindingId)!.diagnostic).not.toHaveProperty('protocolFrame')
    expect(first.coordinator.diagnostics({ ...ref, createOperationId: 'another-operation' })).toBeNull()
    expect(f.frontend.api.createPreparedTerminal).not.toHaveBeenCalled(); expect(f.executor.api.createPreparedTerminal).not.toHaveBeenCalled()
    expect(f.frontend.api.createHostAgentWithDelivery).not.toHaveBeenCalled()
    expect(f.executor.api.writeTerminal).not.toHaveBeenCalled(); expect(f.frontend.api.writeTerminal).not.toHaveBeenCalled()
    await first.close(); const reopened = await f.open()
    expect(reopened.coordinator.diagnostics(ref)).not.toHaveProperty('failure') // Current observation is not manufactured history.
  })

  it('rejects a competing process writer and releases ownership when its reader is disposed', async () => {
    const f = await fixture(), first = await f.open(); await first.coordinator.create(f.input)
    const modulePath = fileURLToPath(new URL(`../.tmp/execution-coordinator-owner-${process.pid}.mjs`, import.meta.url))
    cleanups.push(() => rm(modulePath, { force: true }))
    await build({ entryPoints: [fileURLToPath(new URL('../src/agent-execution-coordinator.ts', import.meta.url))], outfile: modulePath,
      bundle: true, packages: 'external', platform: 'node', format: 'esm' })
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

  it('keeps small-frame durable reads and writes independent of the original large creation prompt', async () => {
    const costs: { promptBytes: number; writeBytes: number; writes: number; syncs: number }[] = []
    for (const promptBytes of [32, 2 * 1024 * 1024]) {
      const f = await fixture(); f.input.agent.prompt = 'p'.repeat(promptBytes)
      io.target(join(f.root, 'bindings.sqlite'))
      const first = await f.open(); await first.coordinator.create(f.input)
      const readIntent = vi.spyOn(first.coordinator as unknown as { read(id: string): unknown }, 'read')
      io.reset()
      const through = f.frontend.addOutput({ type: 'request', generation: 'original-generation', payload: { id: 1, method: 'fixture/write' } })
      await vi.waitFor(() => expect(f.read().bridge.frontend.outputByte).toBe(through))
      const observed = io.stats()
      expect(observed.failures).toBe(0); expect(observed.writes).toBeGreaterThan(0); expect(observed.syncs).toBeGreaterThan(0)
      expect(readIntent).not.toHaveBeenCalled()
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
    await first.close()
    const reopened = await f.open()
    f.resolveHost.mockResolvedValueOnce({ runtimeId: 'replacement-core', client: f.frontend.port })
    await expect(reopened.coordinator.rejoin(f.input.bindingId)).rejects.toMatchObject({ code: 'EXECUTION_HOST_CHANGED' })
    expect(reopened.coordinator.inspect(f.input.bindingId)).toMatchObject({ state: 'unavailable', diagnostic: { code: 'EXECUTION_HOST_CHANGED' } })
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

  it('restores the original reader of a legacy journal without preparing the Source diagnostic index', async () => {
    const f = await fixture(), path = join(f.root, 'bindings')
    const original = new AgentExecutionBindingService(path, { resolveHost: f.resolveHost })
    await original.create(f.input)
    await original.dispose()
    const legacy = new DatabaseSync(join(path, 'bindings.sqlite'))
    try { legacy.exec('DROP INDEX IF EXISTS binding_intents_source_creation; VACUUM') } finally { legacy.close() }

    const restored = new AgentExecutionBindingService(path, { resolveHost: f.resolveHost })
    cleanups.push(() => restored.dispose())
    const exec = DatabaseSync.prototype.exec
    const index = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql.includes('CREATE INDEX IF NOT EXISTS binding_intents_source_creation')) {
        const pageLimit = this.prepare('PRAGMA max_page_count').get()!.max_page_count
        const pages = this.prepare('PRAGMA page_count').get()!.page_count
        exec.call(this, `PRAGMA max_page_count=${pages}`)
        try { return exec.call(this, sql) } finally { exec.call(this, `PRAGMA max_page_count=${pageLimit}`) }
      }
      return exec.call(this, sql)
    })
    try {
      await restored.restoreReaders()
      expect(index.mock.calls.some(([sql]) => sql.includes('binding_intents_source_creation'))).toBe(false)
      expect(await restored.inspect(f.input.bindingId)).toMatchObject({ state: 'connected', agentSessionId: f.input.agent.agentSessionId })
      f.frontend.addOutput({ type: 'request', generation: 'original', payload: { id: 1, method: 'tools/call' } })
      await vi.waitFor(() => expect(f.executor.api.writeTerminal).toHaveBeenCalledOnce())
      expect(f.frontend.api.createPreparedTerminal).toHaveBeenCalledOnce()
      expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledOnce()
    } finally { index.mockRestore() }
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
  expect(first.coordinator.diagnostics(created.execution.continuation!)).toMatchObject({ connection: { state: 'connected' },
    notices: notices.map(({ role, capability, state }) => ({ role, capability, state })) })
  expect(JSON.stringify(first.coordinator.diagnostics(created.execution.continuation!))).not.toContain('connected unavailable healthy are display text')
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
  it('the original Unix RPC rejoin preserves healthy readers and isolates a per-attempt authorization failure', async () => {
    const f = await fixture(), key = { bindingId: f.input.bindingId }
    const authorize = vi.fn(async () => undefined)
    const bindings = new AgentExecutionBindingService(f.root, { resolveHost: f.resolveHost, authorize })
    f.input.agent.executorRevision = 'a'.repeat(64)
    f.frontend.api.listHostExecutors.mockResolvedValueOnce({ executors: [
      { executorId: f.input.agent.executorId, providerId: 'fixture-provider', configRevision: f.input.agent.executorRevision },
    ] })
    f.frontend.api.createHostAgentWithDelivery.mockImplementationOnce(async () => ({ session: {
      kind: 'agent', agentSessionId: f.input.agent.agentSessionId, run: { runId: 'original-agent-run' }, retiredRuns: [],
      providerId: 'fixture-provider', executorId: f.input.agent.executorId, hostId: 'local', workspacePath: f.input.agent.workspacePath,
      createdAt: 1, updatedAt: 1,
      creation: { createOperationId: f.input.agent.createOperationId, initialPrompt: 'not-requested', executorRevision: f.input.agent.executorRevision },
      toolExecution: { bindingId: key.bindingId, resourceHostId: f.input.resourceHostId, resourceRuntimeId: f.input.resourceRuntimeId, workspacePath: f.input.resourceWorkspacePath },
    } }))
    cleanups.push(() => bindings.dispose())
    const server = new AgentMuxControlServer({ socketPath: join(f.root, 'rpc.sock'), executionBindings: bindings })
    await server.start(); cleanups.push(() => server.stop())
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
    const original = (await rpc.call('agent.execution.create', f.input)).execution
    f.resolveHost.mockRejectedValueOnce(new AgentMuxError('Replacement route is unavailable', 'CONTROL_TIMEOUT'))
    const cli = await runSourceObjectCli(['--endpoint', 'unix:' + server.path, 'agent', 'execution', 'rejoin', '--input', '-'],
      objectCliEnvironment(f.root), JSON.stringify(key))
    expect(cli.code, cli.stdout + cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, result: original })
    authorize.mockRejectedValueOnce(new AgentMuxError('The original viewer grant changed', 'CONTROL_PERMISSION_DENIED'))
    await expect(rpc.call('agent.execution.rejoin', key)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    const through = f.frontend.addOutput({ type: 'request', generation: 'original', payload: { id: 1, method: 'tools/call' } })
    await vi.waitFor(() => expect(f.read().bridge.frontend.outputByte).toBe(through))
    expect(f.executor.claimed.size).toBe(1)
    await expect(rpc.call('agent.execution.binding', key)).resolves.toEqual(original)
    expect(f.resolveHost).toHaveBeenCalledTimes(2)
    for (const helper of [f.frontend, f.executor]) {
      expect(helper.api.attachTerminal).toHaveBeenCalledOnce()
      expect(helper.api.releaseRunAttachment).not.toHaveBeenCalled()
      expect(helper.api.createPreparedTerminal).toHaveBeenCalledOnce()
    }
  })

  it.each([false, true])('keeps a Hosted reader recovered during the rejoin route lookup (alternate route fails: %s)', async failLookup => {
    const f = await fixture(), owner = await f.open(), resolving = gate(), resolved = gate()
    const original = (await owner.coordinator.create(f.input)).execution
    const resolve = f.resolveHost.getMockImplementation()!
    f.resolveHost.mockImplementationOnce(async id => {
      resolving.release()
      await resolved.promise
      if (failLookup) throw new AgentMuxError('Alternate reader lookup timed out', 'CONTROL_TIMEOUT')
      return await resolve(id)
    })
    emit(f.executor, { type: 'attachment-state', state: 'unavailable', afterByte: 0,
      diagnostic: { code: 'EXECUTION_READER_UNAVAILABLE', message: 'Original attachment is being restored by its Host' } })
    const retry = owner.coordinator.rejoin(f.input.bindingId)
    const outcome = retry.then(value => ({ value }), error => ({ error }))
    await resolving.promise
    emit(f.executor, { type: 'attachment-state', state: 'restored', afterByte: 0 })
    resolved.release()
    expect(await outcome).toMatchObject(failLookup ? { error: { code: 'CONTROL_TIMEOUT' } } : { value: original })
    expect(owner.coordinator.inspect(f.input.bindingId)).toEqual(original)
    for (const helper of [f.frontend, f.executor]) {
      expect(helper.api.attachTerminal).toHaveBeenCalledOnce()
      expect(helper.api.releaseRunAttachment).not.toHaveBeenCalled()
    }
  })

  it('does not let a continuation failure rewrite an attached connection', async () => {
    const f = await fixture(), owner = await f.open()
    const original = (await owner.coordinator.create(f.input)).execution
    f.frontend.api.createHostAgentWithDelivery.mockRejectedValueOnce(new AgentMuxError('Original Agent receipt timed out', 'CONTROL_TIMEOUT'))
    await expect(owner.coordinator.continueOriginal(original.continuation!)).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT' })
    expect(owner.coordinator.inspect(f.input.bindingId)).toEqual(original)
    expect(f.frontend.api.attachTerminal).toHaveBeenCalledOnce()
  })

  it('continues the original creation with a retained pair while fresh helper preparation is unavailable', async () => {
    const f = await fixture(), owner = await f.open()
    f.frontend.api.createHostAgentWithDelivery.mockRejectedValueOnce(new AgentMuxError('Original creation reply timed out', 'CONTROL_TIMEOUT'))
    await expect(owner.coordinator.create(f.input)).rejects.toMatchObject({ code: 'CONTROL_TIMEOUT' })
    const original = owner.coordinator.inspect(f.input.bindingId)!.continuation!
    emit(f.executor, { type: 'attachment-state', state: 'unavailable', afterByte: 0,
      diagnostic: { code: 'EXECUTION_READER_UNAVAILABLE', message: 'Original reader temporarily unavailable' } })
    f.executor.api.prepareAgentExecutionHelper.mockRejectedValueOnce(new AgentMuxError('Fresh preparation unavailable', 'CONTROL_TIMEOUT'))
    expect((await owner.coordinator.continueOriginal(original)).execution).toMatchObject({ state: 'connected', continuation: original })
    expect(f.frontend.api.listHostExecutors).toHaveBeenCalledOnce()
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledTimes(2)
    for (const helper of [f.frontend, f.executor]) {
      expect(helper.api.prepareAgentExecutionHelper).toHaveBeenCalledOnce()
      expect(helper.api.createPreparedTerminal).toHaveBeenCalledOnce()
      expect(helper.api.attachTerminal).toHaveBeenCalledTimes(2)
    }
  })

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
  it.each([false, true])('recovers an idle reader after carrier loss and keeps an already restored attachment (%s)', async restoredFirst => {
    const f = await fixture(), owner = await f.open()
    await owner.coordinator.create(f.input)
    emit(f.executor, { type: 'attachment-state', state: 'unavailable', afterByte: 0,
      diagnostic: { code: 'CONTROL_CONNECTION_FAILED', message: 'Original attachment carrier disconnected' } })
    expect(owner.coordinator.inspect(f.input.bindingId)?.state).toBe('unavailable')
    if (restoredFirst) {
      emit(f.executor, { type: 'attachment-state', state: 'restored', afterByte: 0 })
      // The first binding retry window ends within this interval.
      await new Promise(resolve => setTimeout(resolve, 300))
    } else await vi.waitFor(() => expect(f.executor.api.attachTerminal).toHaveBeenCalledTimes(2))
    expect(f.executor.api.attachTerminal).toHaveBeenCalledTimes(restoredFirst ? 1 : 2)
    expect(owner.coordinator.inspect(f.input.bindingId)?.state).toBe('connected')
    expect(f.frontend.api.writeTerminal).not.toHaveBeenCalled()
    expect(f.executor.api.writeTerminal).not.toHaveBeenCalled()
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledOnce()
  })
  it('coalesces a manual rejoin queued behind automatic recovery on the same binding', async () => {
    const f = await fixture(), owner = await f.open(), attaching = gate()
    const original = (await owner.coordinator.create(f.input)).execution
    const attach = f.executor.api.attachTerminal.getMockImplementation()!
    f.executor.api.attachTerminal.mockImplementationOnce(async (...args) => {
      await attaching.promise
      return await attach(...args)
    })
    try {
      emit(f.executor, { type: 'attachment-state', state: 'unavailable', afterByte: 0,
        diagnostic: { code: 'CONTROL_CONNECTION_FAILED', message: 'Original attachment carrier disconnected' } })
      await vi.waitFor(() => expect(f.executor.api.attachTerminal).toHaveBeenCalledTimes(2))
      const manual = owner.coordinator.rejoin(f.input.bindingId)
      attaching.release()
      await expect(manual).resolves.toMatchObject({ state: 'connected', continuation: original.continuation,
        helperStarts: original.helperStarts })
      expect(f.executor.api.attachTerminal).toHaveBeenCalledTimes(2)
      expect(f.executor.api.releaseRunAttachment).toHaveBeenCalledOnce()
      expect(f.resolveHost).toHaveBeenCalledTimes(4)
      expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledOnce()
    } finally { attaching.release() }
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


describe('original execution preparation and explicit continuation', () => {
  it('prepares both exact endpoints before any Start and retains the precise failing frontend step', async () => {
    const f = await fixture(), { coordinator } = await f.open(), ready = gate()
    f.frontend.api.prepareAgentExecutionHelper.mockImplementationOnce(async () => { await ready.promise; throw new Error('Original frontend preparation unavailable') })
    const pending = coordinator.create(f.input)
    const observed = expect(pending).rejects.toMatchObject({ executionFailure: { reference: { bindingId: f.input.bindingId, agentSessionId: f.input.agent.agentSessionId,
      createOperationId: f.input.agent.createOperationId }, hostId: f.input.agentHostId, role: 'frontend', stage: 'prepare' } })
    try {
      await vi.waitFor(() => expect(f.frontend.api.prepareAgentExecutionHelper).toHaveBeenCalledTimes(1))
      expect(f.executor.api.createPreparedTerminal).not.toHaveBeenCalled()
      expect(f.frontend.api.createPreparedTerminal).not.toHaveBeenCalled()
    } finally { ready.release(); await observed }
    expect(coordinator.inspect(f.input.bindingId)).toMatchObject({ helperStarts: { executor: { outcome: 'not-submitted', runId: null }, frontend: { outcome: 'not-submitted', runId: null } } })
  })
  it('continues only the retained immutable input after Coordinator restart in the same lane', async () => {
    const f = await fixture(), first = await f.open()
    f.frontend.api.prepareAgentExecutionHelper.mockRejectedValueOnce(new Error('Original frontend not ready'))
    await expect(first.coordinator.create({ ...f.input, agent: { ...f.input.agent, prompt: '原始任务\n  exact bytes' } })).rejects.toThrow('Original frontend not ready')
    const frozen = f.read().input
    await first.close()
    const second = await f.open(), original = { bindingId: frozen.bindingId, agentSessionId: frozen.agent.agentSessionId, createOperationId: frozen.agent.createOperationId }
    const result = await second.coordinator.continueOriginal(original)
    expect(result.session.agentSessionId).toBe(original.agentSessionId)
    expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledWith(expect.objectContaining({ ...frozen.agent }))
    expect(f.read().input).toEqual(frozen)
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    expect(f.frontend.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    await second.coordinator.continueOriginal(original)
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    expect(f.frontend.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    for (const wrong of [{ ...original, agentSessionId: 'another' }, { ...original, createOperationId: 'another' }])
      await expect(second.coordinator.continueOriginal(wrong)).rejects.toMatchObject({ code: 'EXECUTION_BINDING_CONFLICT' })
  })
  it('does not clear an unacknowledged Native Start attempt across Core restart or submit it again', async () => {
    const f = await fixture(), first = await f.open()
    f.executor.loseStart()
    await expect(first.coordinator.create(f.input)).rejects.toThrow('Start acknowledgement lost')
    f.executor.forgetCreation()
    const attempts = f.read().attempts
    await first.close()
    const second = await f.open(), original = { bindingId: f.input.bindingId, agentSessionId: f.input.agent.agentSessionId, createOperationId: f.input.agent.createOperationId }
    await expect(second.coordinator.continueOriginal(original)).rejects.toThrow('no confirmed receipt')
    expect(f.read().attempts).toEqual(attempts)
    expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledTimes(1)
    expect(second.coordinator.inspect(f.input.bindingId)).toMatchObject({ helperStarts: { executor: { outcome: 'unknown', runId: null } } })
  })
  it('does not create or resolve any Host when the original binding intent is missing', async () => {
    const f = await fixture(), { coordinator } = await f.open()
    await expect(coordinator.continueOriginal({ bindingId: 'missing', agentSessionId: 'original', createOperationId: 'original' })).rejects.toMatchObject({ code: 'EXECUTION_INTENT_UNCONFIRMED' })
    expect(f.resolveHost).not.toHaveBeenCalled()
    expect(f.frontend.api.createHostAgentWithDelivery).not.toHaveBeenCalled()
  })
})


it('does not send the original initial input again when explicit continuation adopts an existing Agent receipt', async () => {
  const f = await fixture(), { coordinator } = await f.open(), input = { ...f.input, agent: { ...f.input.agent, prompt: 'original initial input' } }
  const first = await coordinator.create(input)
  f.frontend.api.readAgentSession.mockResolvedValueOnce(first.session)
  const continued = await coordinator.continueOriginal({ bindingId: input.bindingId, agentSessionId: input.agent.agentSessionId, createOperationId: input.agent.createOperationId })
  expect(continued.session.run).toEqual(first.session.run)
  expect(f.frontend.api.writeTerminal.mock.calls.filter(([target]) => (target as { runId: string }).runId === first.session.run.runId)).toHaveLength(0)
  expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenLastCalledWith(expect.objectContaining({ ...input.agent }))
})

it('Core binding readers coalesce only related facts and cancellation preserves helpers and frozen intent', async () => {
  const f = await fixture(), service = new AgentExecutionBindingService(f.root, { resolveHost: f.resolveHost })
  cleanups.push(() => service.dispose())
  await service.create(f.input)
  const entered = gate(), held = gate(), values: AgentExecutionInspection[] = []
  const reader = await service.watch(f.input.bindingId, async value => { values.push(value!); if (values.length === 1) { entered.release(); await held.promise } })
  expect(reader.initial).toMatchObject({ bindingId: f.input.bindingId, inspection: { continuation: { createOperationId: f.input.agent.createOperationId } } })
  const unrelated = vi.fn(), other = await service.watch('unrelated-binding', unrelated); other.start(); reader.start()
  f.executor.addOutput({ type: 'diagnostic', generation: 'original-generation', code: 'ORIGINAL_UNKNOWN_0' }); await entered.promise
  for (let i = 1; i <= 12; i++) {
    f.executor.addOutput({ type: 'diagnostic', generation: 'original-generation', code: `ORIGINAL_UNKNOWN_${i}` })
    await vi.waitFor(async () => expect((await service.inspect(f.input.bindingId))?.diagnostics?.at(-1)?.code).toBe(`ORIGINAL_UNKNOWN_${i}`))
  }
  expect(values).toHaveLength(1); expect(unrelated).not.toHaveBeenCalled()
  held.release(); await vi.waitFor(() => expect(values).toHaveLength(2))
  expect(values[1]!.diagnostics?.at(-1)?.code).toBe('ORIGINAL_UNKNOWN_12')
  await reader.dispose(); await other.dispose()
  expect(f.frontend.listeners.size).toBe(1); expect(f.executor.listeners.size).toBe(1)
  expect(f.read().input).toEqual(f.input)
  expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledOnce()
  expect(f.frontend.api.createPreparedTerminal).toHaveBeenCalledOnce(); expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledOnce()
})

it('retains the live tool cursor when original cancellation authorization takes time', async () => {
  const f = await fixture(), entered = gate(), ready = gate()
  const authorize = vi.fn(async () => undefined)
  const service = new AgentExecutionBindingService(f.root, { resolveHost: f.resolveHost, authorize })
  cleanups.push(() => service.dispose())
  const created = await service.create(f.input), original = created.execution.continuation!
  const input = { agentSessionId: original.agentSessionId, createOperationId: original.createOperationId, operationId: 'cancel-original' }
  authorize.mockImplementationOnce(async () => { entered.release(); await ready.promise; return undefined })
  const cancellation = service.cancelOriginal(original, input)
  try {
    await entered.promise
    const through = f.frontend.addOutput({ type: 'request', generation: 'original', payload: { id: 1, method: 'tools/call' } })
    await vi.waitFor(() => expect(f.read().bridge.frontend.outputByte).toBe(through))
    ready.release()
    await expect(cancellation).resolves.toMatchObject({ outcome: 'created' })
    expect(f.read()).toMatchObject({ cancellation: input, bridge: { frontend: { outputByte: through } } })
    expect(f.executor.api.writeTerminal).toHaveBeenCalledOnce()
    expect(f.frontend.api.cancelAgentCreation).toHaveBeenCalledOnce()
    expect((await service.inspect(f.input.bindingId))?.state).toBe('connected')
  } finally { ready.release(); await cancellation.catch(() => {}) }
})

it('one rejecting binding consumer cannot close Core or interrupt a different reader', async () => {
  const f = await fixture(), service = new AgentExecutionBindingService(f.root, { resolveHost: f.resolveHost }); cleanups.push(() => service.dispose())
  await service.create(f.input)
  const failed = vi.fn(), good = vi.fn()
  const broken = await service.watch(f.input.bindingId, () => { throw Error('private reader gone') }, { onError: failed })
  const healthy = await service.watch(f.input.bindingId, good); broken.start(); healthy.start()
  f.executor.addOutput({ type: 'diagnostic', generation: 'original-generation', code: 'ORIGINAL_UNKNOWN' })
  await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce(); expect(good).toHaveBeenCalledOnce() })
  f.executor.addOutput({ type: 'diagnostic', generation: 'original-generation', code: 'SECOND_UNKNOWN' })
  await vi.waitFor(() => expect(good).toHaveBeenCalledTimes(2))
  expect(f.frontend.listeners.size).toBe(1); expect(f.read().input).toEqual(f.input)
  await healthy.dispose()
})
it('aborting a binding watch releases only that reader while other readers and helper input remain available', async () => {
  const f = await fixture(), service = new AgentExecutionBindingService(f.root, { resolveHost: f.resolveHost }); cleanups.push(() => service.dispose())
  await service.create(f.input)
  const abort = new AbortController(), closed = vi.fn(), healthy = vi.fn()
  const cancelled = await service.watch(f.input.bindingId, closed, { signal: abort.signal }), retained = await service.watch(f.input.bindingId, healthy)
  cancelled.start(); retained.start(); abort.abort()
  f.executor.addOutput({ type: 'diagnostic', generation: 'original-generation', code: 'AFTER_READER_CANCEL' })
  await vi.waitFor(() => expect(healthy).toHaveBeenCalledOnce())
  expect(closed).not.toHaveBeenCalled(); expect(f.frontend.listeners.size).toBe(1); expect(f.executor.listeners.size).toBe(1)
  expect((await service.inspect(f.input.bindingId))?.continuation?.createOperationId).toBe(f.input.agent.createOperationId)
  await retained.dispose()
})

it('admission durably freezes the complete original intent with no endpoint effects, and explicit continuation survives reopen', async () => {
  const f = await fixture(); f.input.sourceRequestDigest = 'd'.repeat(64); f.input.agent.sourceAgentMuxNote = 'Frozen original Source context'
  const inventory = f.frontend.api.listHostExecutors.getMockImplementation()!
  f.frontend.api.listHostExecutors.mockImplementation(async () => { const value = await inventory(); return { ...value, runtimeId: f.input.agentRuntimeId, executors: value.executors.map(executor => ({ ...executor, creationContract: { ordinaryLaunch: 1 } })) } })
  let service = new AgentExecutionBindingService(f.root, { resolveHost: f.resolveHost }); cleanups.push(() => service.dispose())
  const key = { bindingId: f.input.bindingId, agentSessionId: f.input.agent.agentSessionId, createOperationId: f.input.agent.createOperationId }
  expect(await service.admit(f.input)).toEqual(key); expect(f.resolveHost).not.toHaveBeenCalled(); expect(f.read().input).toEqual(f.input)
  await service.dispose(); service = new AgentExecutionBindingService(f.root, { resolveHost: f.resolveHost })
  expect(await service.inspect(f.input.bindingId, 'association')).toMatchObject({ continuation: key, association: { sourceRequestDigest: f.input.sourceRequestDigest,
    agent: { executorId: f.input.agent.executorId, executorRevision: f.input.agent.executorRevision, workspacePath: f.input.agent.workspacePath } } })
  await expect(service.admit({ ...f.input, agent: { ...f.input.agent, sourceAgentMuxNote: 'Changed Source context' } })).rejects.toMatchObject({ code: 'EXECUTION_BINDING_CONFLICT' })
  expect(f.resolveHost).not.toHaveBeenCalled(); expect(await service.admit(f.input)).toEqual(key)
  await service.continueOriginal(key)
  expect(f.read().input).toEqual(f.input); expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledOnce()
  expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledOnce(); expect(f.frontend.api.createPreparedTerminal).toHaveBeenCalledOnce()
})
it('admit and create serialize coherently in one lane without nested public calls or duplicate effects', async () => {
  const f = await fixture(), entered = gate(), held = gate(), authorize = vi.fn(async () => { entered.release(); await held.promise; return undefined })
  const service = new AgentExecutionBindingService(f.root, { resolveHost: f.resolveHost, authorize }); cleanups.push(() => service.dispose())
  const admitted = service.admit(f.input); await entered.promise
  const created = service.create(f.input)
  expect(f.resolveHost).not.toHaveBeenCalled(); held.release()
  const [key, result] = await Promise.all([admitted, created])
  expect(key.agentSessionId).toBe(result.session.agentSessionId); expect(authorize).toHaveBeenCalledTimes(2)
  expect(f.frontend.api.createHostAgentWithDelivery).toHaveBeenCalledOnce(); expect(f.frontend.api.createPreparedTerminal).toHaveBeenCalledOnce(); expect(f.executor.api.createPreparedTerminal).toHaveBeenCalledOnce()
})
it('direct admission refuses coerced Source identities and storage failure never produces a durable ACK or endpoint effect', async () => {
  const f = await fixture(), service = new AgentExecutionBindingService(f.root, { resolveHost: f.resolveHost }); cleanups.push(() => service.dispose())
  await expect(service.admit({ ...f.input, sourceRequestDigest: ['a'.repeat(64)] } as never)).rejects.toMatchObject({ code: 'EXECUTION_BINDING_CONFLICT' })
  expect(await service.inspect(f.input.bindingId)).toBeNull()
  io.target(join(f.root, 'bindings.sqlite')); io.fault('sync')
  try { await expect(service.admit(f.input)).rejects.toThrow() } finally { io.reset() }
  expect(f.resolveHost).not.toHaveBeenCalled(); expect(f.frontend.api.createHostAgentWithDelivery).not.toHaveBeenCalled()
})
