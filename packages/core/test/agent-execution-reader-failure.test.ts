import { expect, test, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentExecutionBridge, type AgentExecutionBridgePort, type AgentExecutionBridgeState } from '../src/agent-execution-bridge.js'
import { AgentExecutionCoordinator, type AgentExecutionHostPort, type AgentExecutionInspection } from '../src/agent-execution-coordinator.js'
import { AgentMuxError } from '../src/errors.js'

const state = (): AgentExecutionBridgeState => ({ bindingId: 'original-binding', frontend: { runId: 'front', ownerInstanceId: 'original-native', inputByte: 0, outputByte: 0 }, executor: { runId: 'exec', ownerInstanceId: 'original-native', inputByte: 0, outputByte: 0 } })
function port(runId: string, initial: 'gap' | 'callback' | 'registration-error' | 'healthy', options: { cleanupThrows?: boolean; attach?(): Promise<void> } = {}) {
  let onError: ((error: { code: string; message: string }) => void) | undefined, mode = initial
  let active = 0, attached = 0, writes = 0
  const released: string[] = []
  const issue = { code: 'ORIGINAL_ATTACHMENT_DISCONNECTED', message: 'The exact original reader transport disconnected' }
  const api = {
    runtimeIdentity: () => ({ instanceId: 'original-native' }),
    onRunEvent: (_run: string, _listener: unknown, settings: { onError: typeof onError }) => {
      active++; onError = settings.onError
      if (mode === 'registration-error') onError?.(issue)
      return () => { active--; if (options.cleanupThrows) throw Error('Cleanup observer failed') }
    },
    attachTerminal: async () => {
      attached++; await options.attach?.()
      if (mode === 'callback') onError?.(issue)
      return { run: { runId, state: 'running' }, gap: null, replay: mode === 'gap' ? [{ startByte: 1, endByte: 2, dataBytes: Buffer.from('\n') }] : [] }
    },
    releaseRunAttachment: async (run: { runId: string }) => { released.push(run.runId) },
    readRunReplay: async () => { throw Error('No pending replay was requested') },
    writeTerminal: async () => { writes++; throw Error('Observer recovery cannot authorize a new input action') },
  } as unknown as AgentExecutionBridgePort
  return { api, issue, healthy: () => { mode = 'healthy' }, facts: () => ({ active, attached, writes, released: [...released] }) }
}
async function observe(mode: 'gap' | 'callback' | 'registration-error', options: { cleanupThrows?: boolean } = {}) {
  const f = port('front', mode, options), e = port('exec', 'healthy'), observed: Error[] = []
  const bridge = new AgentExecutionBridge({ state: state(), ports: { frontend: f.api, executor: e.api }, persist: async () => {}, onFrame: async () => {}, onError: issue => observed.push(issue) })
  let thrown: unknown
  try { await bridge.start() } catch (error) { thrown = error }
  const afterStart = { frontend: f.facts(), executor: e.facts() }
  await bridge.close()
  return { observed, thrown, afterStart, original: f.issue }
}

test('a typed original output gap survives start rejection as the same error object', async () => {
  const result = await observe('gap')
  expect(result.observed[0]).toMatchObject({ code: 'EXECUTION_PROTOCOL_GAP' })
  expect(result.thrown).toBe(result.observed[0])
  expect(result.afterStart.frontend.active + result.afterStart.executor.active).toBe(0)
})

test('the SDK callback keeps its machine code and local cause through start rejection', async () => {
  const result = await observe('callback')
  expect(result.observed[0]).toMatchObject({ code: 'ORIGINAL_ATTACHMENT_DISCONNECTED' })
  expect(result.observed[0]?.cause).toBe(result.original)
  expect(result.thrown).toBe(result.observed[0])
})

test('known startup failure never acquires the next helper reader and releases the exact attachments', async () => {
  const result = await observe('callback')
  expect(result.afterStart.executor.active).toBe(0)
  expect(result.afterStart.executor.attached).toBe(0)
  expect(result.afterStart.frontend.released).toEqual(['front'])
  expect(result.afterStart.executor.released).toEqual(['exec'])
  expect(result.afterStart.frontend.writes + result.afterStart.executor.writes).toBe(0)
})

test('a synchronous registration failure releases the listener returned after the failure', async () => {
  const result = await observe('registration-error')
  expect(result.thrown).toMatchObject({ code: 'ORIGINAL_ATTACHMENT_DISCONNECTED' })
  expect(result.afterStart.frontend.active).toBe(0)
  expect(result.afterStart.frontend.attached + result.afterStart.executor.attached).toBe(0)
})

test('cleanup failure cannot replace the original typed reader failure', async () => {
  const result = await observe('callback', { cleanupThrows: true })
  expect(result.thrown).toBe(result.observed[0])
  expect(result.thrown).toMatchObject({ code: 'ORIGINAL_ATTACHMENT_DISCONNECTED' })
  expect(result.afterStart.frontend.active + result.afterStart.executor.active).toBe(0)
})

test('a late successful attach after explicit close cannot revive the reader', async () => {
  let entered!: () => void, complete!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), attached = new Promise<void>(resolve => { complete = resolve })
  const f = port('front', 'healthy', { attach: async () => { entered(); await attached } }), e = port('exec', 'healthy'), connections: string[] = []
  const bridge = new AgentExecutionBridge({ state: state(), ports: { frontend: f.api, executor: e.api }, persist: async () => {}, onFrame: async () => {}, onError: () => {}, onConnection: (_side, fact) => connections.push(fact.reader) })
  const starting = bridge.start().catch(error => error)
  await waiting; await bridge.close(); complete()
  await expect(starting).resolves.toMatchObject({ code: 'EXECUTION_READER_UNAVAILABLE' })
  expect(connections).not.toContain('attached')
  expect(e.facts().attached).toBe(0)
  expect(f.facts().active).toBe(0)
  expect(f.facts().released.at(-1)).toBe('front')
})

test('the actual Coordinator retains the first cause and rejoins the original readers without another Start/input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-reader-coordinator-')), f = port('front', 'gap'), e = port('exec', 'healthy')
  let mockStarts = 0, agentCalls = 0
  for (const target of [f, e]) Object.assign(target.api, {
    listHostExecutors: async () => ({ executors: [{ executorId: 'fixture-executor', providerId: 'fixture', configRevision: 'original-revision' }] }),
    readAgentSession: async () => null,
    prepareAgentExecutionHelper: async () => ({ prepared: { fixture: true } }),
    inspectPreparedTerminal: async () => null,
    createPreparedTerminal: async () => { mockStarts++; return { runId: target === f ? 'front' : 'exec', state: 'running' } },
    createHostAgentWithDelivery: async () => { agentCalls++; throw Error('Reader recovery must not create an Agent') },
  })
  const observations: AgentExecutionInspection[] = []
  const owner = await AgentExecutionCoordinator.open(directory, { resolveHost: async id => ({ runtimeId: id === 'agent' ? 'agent-core' : 'resource-core', client: (id === 'agent' ? f.api : e.api) as AgentExecutionHostPort }), onObservation: value => observations.push(value) })
  try {
    await expect(owner.create({ bindingId: 'original-binding', agentHostId: 'agent', agentRuntimeId: 'agent-core', resourceHostId: 'resource', resourceRuntimeId: 'resource-core', resourceWorkspacePath: '/original/resource', resourceGrant: { scope: 'host-user', bindingId: 'original-binding' }, agent: { agentSessionId: 'original-SID', createOperationId: 'original-CID', executorId: 'fixture-executor', executorRevision: 'original-revision', workspacePath: '/original/agent' } })).rejects.toMatchObject({ code: 'EXECUTION_PROTOCOL_GAP', executionFailure: { stage: 'attach' } })
    const original = owner.inspect('original-binding')!
    expect(original).toMatchObject({ diagnostic: { code: 'EXECUTION_PROTOCOL_GAP' }, continuation: { bindingId: 'original-binding', agentSessionId: 'original-SID', createOperationId: 'original-CID' } })
    expect(observations.at(-1)?.diagnostic?.code).toBe('EXECUTION_PROTOCOL_GAP')
    f.healthy(); const restored = await owner.rejoin('original-binding')
    expect(restored.state).toBe('connected')
    expect(restored.continuation).toEqual(original.continuation)
    expect(restored.helperStarts).toEqual(original.helperStarts)
    expect(mockStarts).toBe(2); expect(agentCalls).toBe(0)
    expect(f.facts().writes + e.facts().writes).toBe(0)
  } finally { await owner.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test.each(['gap', 'callback'] as const)('the actual Coordinator attributes an executor-side %s to the original resource Host', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-reader-side-')), f = port('front', 'healthy'), e = port('exec', mode)
  for (const target of [f, e]) Object.assign(target.api, {
    listHostExecutors: async () => ({ executors: [{ executorId: 'fixture-executor', providerId: 'fixture', configRevision: 'original-revision' }] }),
    readAgentSession: async () => null,
    prepareAgentExecutionHelper: async () => ({ prepared: { fixture: true } }),
    inspectPreparedTerminal: async () => null,
    createPreparedTerminal: async () => ({ runId: target === f ? 'front' : 'exec', state: 'running' }),
    createHostAgentWithDelivery: async () => { throw Error('A failed reader cannot create an Agent') },
  })
  const owner = await AgentExecutionCoordinator.open(directory, { resolveHost: async hostId => ({ runtimeId: hostId === 'agent' ? 'agent-core' : 'resource-core', client: (hostId === 'agent' ? f.api : e.api) as AgentExecutionHostPort }) })
  try {
    await expect(owner.create({ bindingId: 'original-binding', agentHostId: 'agent', agentRuntimeId: 'agent-core', resourceHostId: 'resource', resourceRuntimeId: 'resource-core', resourceWorkspacePath: '/original/resource', resourceGrant: { scope: 'host-user', bindingId: 'original-binding' }, agent: { agentSessionId: 'original-SID', createOperationId: 'original-CID', executorId: 'fixture-executor', executorRevision: 'original-revision', workspacePath: '/original/agent' } })).rejects.toMatchObject({
      code: mode === 'gap' ? 'EXECUTION_PROTOCOL_GAP' : 'ORIGINAL_ATTACHMENT_DISCONNECTED',
      executionFailure: { hostId: 'resource', role: 'executor', stage: 'attach', reference: { bindingId: 'original-binding', agentSessionId: 'original-SID', createOperationId: 'original-CID' } },
    })
    expect(f.facts().writes + e.facts().writes).toBe(0)
  } finally { await owner.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('the actual Coordinator attributes a forwarded executor response write failure to the original frontend target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-reader-write-')), f = port('front', 'healthy'), e = port('exec', 'healthy')
  const response = Buffer.from(JSON.stringify({ type: 'response', generation: 'original-generation', payload: { jsonrpc: '2.0', id: 'original-request', result: {} } }) + '\n')
  const attach = e.api.attachTerminal.bind(e.api)
  e.api.attachTerminal = async (...args) => ({ ...await attach(...args), replay: [{ startByte: 0, endByte: response.length, dataBytes: response, data: response.toString(), type: 'data', runId: 'exec' }] })
  const originalFailure = new AgentMuxError('The original frontend Input channel is unavailable.', 'CTXMUX_DISCONNECTED')
  let writes = 0
  f.api.writeTerminal = async (target, operation) => { writes++; expect(target).toEqual({ runId: 'front' }); expect(Buffer.from(operation.data).equals(response)).toBe(true); throw originalFailure }
  for (const target of [f, e]) Object.assign(target.api, {
    listHostExecutors: async () => ({ executors: [{ executorId: 'fixture-executor', providerId: 'fixture', configRevision: 'original-revision' }] }),
    readAgentSession: async () => null,
    prepareAgentExecutionHelper: async () => ({ prepared: { fixture: true } }),
    inspectPreparedTerminal: async () => null,
    createPreparedTerminal: async () => ({ runId: target === f ? 'front' : 'exec', state: 'running' }),
    createHostAgentWithDelivery: async () => { throw Error('A failed original Input cannot create an Agent') },
  })
  const owner = await AgentExecutionCoordinator.open(directory, { resolveHost: async hostId => ({ runtimeId: hostId === 'agent' ? 'agent-core' : 'resource-core', client: (hostId === 'agent' ? f.api : e.api) as AgentExecutionHostPort }) })
  try {
    const failure: unknown = await owner.create({ bindingId: 'original-binding', agentHostId: 'agent', agentRuntimeId: 'agent-core', resourceHostId: 'resource', resourceRuntimeId: 'resource-core', resourceWorkspacePath: '/original/resource', resourceGrant: { scope: 'host-user', bindingId: 'original-binding' }, agent: { agentSessionId: 'original-SID', createOperationId: 'original-CID', executorId: 'fixture-executor', executorRevision: 'original-revision', workspacePath: '/original/agent' } }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'CTXMUX_DISCONNECTED', executionFailure: { hostId: 'agent', role: 'frontend', stage: 'attach' } })
    if (!(failure instanceof AgentMuxError)) throw failure
    expect(failure.cause).toBe(originalFailure)
    expect(writes).toBe(1)
    expect(owner.inspect('original-binding')?.continuation).toEqual({ bindingId: 'original-binding', agentSessionId: 'original-SID', createOperationId: 'original-CID' })
  } finally { await owner.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('the actual Coordinator keeps a local persistence failure unscoped in its public error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-reader-unscoped-')), f = port('front', 'healthy'), e = port('exec', 'healthy'), attach = e.api.attachTerminal.bind(e.api)
  const response = Buffer.from(JSON.stringify({ type: 'response', generation: 'original-generation', payload: { jsonrpc: '2.0', id: 'original-request', result: {} } }) + '\n')
  e.api.attachTerminal = async (...args) => ({ ...await attach(...args), replay: [{ startByte: 0, endByte: response.length, dataBytes: response, data: response.toString(), type: 'data', runId: 'exec' }] })
  const original = new AgentMuxError('The original Coordinator persistence is unavailable.', 'EXECUTION_STORAGE_UNAVAILABLE')
  const probe = new DatabaseSync(':memory:')
  type Statement = ReturnType<DatabaseSync['prepare']>
  const prototype: Pick<Statement, 'run'> = Object.getPrototypeOf(probe.prepare('SELECT 1'))
  const run = prototype.run
  probe.close()
  const write = vi.spyOn(prototype, 'run').mockImplementation(function(this: Statement, ...args: Parameters<Statement['run']>) {
    if (args[1] === 'original-binding' && typeof args[0] === 'string' && JSON.parse(args[0]).bridge?.pending) throw original
    return run.apply(this, args)
  })
  for (const target of [f, e]) Object.assign(target.api, {
    listHostExecutors: async () => ({ executors: [{ executorId: 'fixture-executor', providerId: 'fixture', configRevision: 'original-revision' }] }),
    readAgentSession: async () => null,
    prepareAgentExecutionHelper: async () => ({ prepared: { fixture: true } }),
    inspectPreparedTerminal: async () => null,
    createPreparedTerminal: async () => ({ runId: target === f ? 'front' : 'exec', state: 'running' }),
    createHostAgentWithDelivery: async () => { throw Error('A failed reader observation cannot create an Agent') },
  })
  const owner = await AgentExecutionCoordinator.open(directory, { resolveHost: async hostId => ({ runtimeId: hostId === 'agent' ? 'agent-core' : 'resource-core', client: (hostId === 'agent' ? f.api : e.api) as AgentExecutionHostPort }) })
  try {
    const failure: unknown = await owner.create({ bindingId: 'original-binding', agentHostId: 'agent', agentRuntimeId: 'agent-core', resourceHostId: 'resource', resourceRuntimeId: 'resource-core', resourceWorkspacePath: '/original/resource', resourceGrant: { scope: 'host-user', bindingId: 'original-binding' }, agent: { agentSessionId: 'original-SID', createOperationId: 'original-CID', executorId: 'fixture-executor', executorRevision: 'original-revision', workspacePath: '/original/agent' } }).catch((error: unknown) => error)
    expect(failure).toBe(original)
    expect(original.executionFailure).toBeUndefined()
    expect(f.facts().writes + e.facts().writes).toBe(0)
  } finally { write.mockRestore(); await owner.dispose(); await rm(directory, { recursive: true, force: true }) }
})
