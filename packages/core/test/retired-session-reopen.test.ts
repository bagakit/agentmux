import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AgentMuxError } from '../src/errors.js'
import { AgentHookServer } from '../src/hook-server.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, loadAgentSessions, loadSessionHistorySources, agentLifecycleOperationIdentity } from '../src/agent-session-store.js'
import { retiredReopenFixture } from './fixtures/retired-reopen.js'
const fixtures: Awaited<ReturnType<typeof retiredReopenFixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.close(); vi.restoreAllMocks() })
async function fixture(provider: 'claude' | 'pi' = 'claude') { const f = await retiredReopenFixture(provider); fixtures.push(f); return f }

it.each(['claude', 'pi'] as const)('continues the same retired %s native identity through the actual Provider and durable transaction', async provider => {
  const f = await fixture(provider), before = await f.client.sessionHistoryPage(f.old.agentSessionId)
  const next = await f.client.reopenAgent(f.input)
  expect(next).toMatchObject({ agentSessionId: f.old.agentSessionId, providerId: provider, executorId: provider, hostId: 'local',
    workspacePath: f.old.workspacePath, createdAt: f.old.createdAt, nativeHandle: f.old.nativeHandle, run: { runId: 'new-run-1' },
    retiredRuns: [f.old.run], reopenedFrom: { run: f.old.run, source: 'user', observedAt: f.retired.observedAt } })
  expect(next).not.toHaveProperty('hookToken')
  expect(f.starts).toHaveLength(1); expect(f.starts[0]!.args).toContain(provider === 'pi' ? f.path : 'native-main')
  expect(f.starts[0]!.env.AGENTMUX_AGENT_SESSION_ID).toBe(f.old.agentSessionId)
  expect(f.binds).toEqual(['new-run-1']); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.stops).toEqual([])
  expect(await f.store.loadRetiredAgentSessions()).toEqual([]); expect(await f.store.loadRetiredRuns()).toEqual([])
  expect(await f.store.loadTimeline(f.old.agentSessionId)).toEqual(f.timelineBefore)
  expect(await f.client.sessionHistoryPage(f.old.agentSessionId)).toEqual(before); expect(await readFile(f.path)).toEqual(f.nativeBefore)
  expect((await loadAgentSessions(f.store))[0]!.reopenedFrom).toEqual(next.reopenedFrom)
})

it('keeps ordinary continuity retired, rejects stale retirement and running old Run without a second launch', async () => {
  const f = await fixture()
  await expect(f.client.ensureAgentContinuity({ agentSessionId: f.old.agentSessionId, expectedRun: f.old.run, operationId: 'observe-only' })).resolves.toMatchObject({ kind: 'retired' })
  await expect(f.client.reopenAgent({ ...f.input, expectedRetiredAt: f.retired.observedAt + 1 })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  f.inner.kernel.status.mockImplementation(async (id: string) => f.run(id, true))
  await expect(f.client.reopenAgent(f.input)).rejects.toMatchObject({ code: 'AGENT_SESSION_STILL_RUNNING' })
  expect(f.starts).toEqual([]); expect(f.stops).toEqual([]); expect(await f.store.loadRetiredAgentSessions()).toEqual([f.retired])
})

it('admits one winner across independent Clients sharing the same durable retired identity', async () => {
  const f = await fixture(), { AgentMuxClient } = await import('../src/client.js')
  const second = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(f.storePath) })
  const inner = second as any; inner.connected = true
  inner.kernel = f.inner.kernel
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = () => ({ bindingId: 'second-fresh-binding', endpoint: { url: 'http://127.0.0.1:0', token: 'second-fresh-token' },
    bindRun: async (id: string) => { second.agentSession(f.old.agentSessionId); f.binds.push(id) }, close: async () => {} })
  vi.spyOn(second, 'probeAgent').mockResolvedValue({ providerId: 'claude', executable: 'claude', installed: true, capabilities: second.providers.get('claude').catalog.capabilities })
  vi.spyOn(second as any, 'ensureManagedHooks').mockResolvedValue(undefined)
  inner.ensureTerminalHandshakeOrDegrade = async (session: unknown) => session
  await inner.registry.load('local')
  try {
    const results = await Promise.allSettled([f.client.reopenAgent(f.input), second.reopenAgent({ ...f.input, operationId: 'competing-intent' })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(f.starts).toHaveLength(1); expect((await loadAgentSessions(f.store)).map(value => value.run)).toEqual([{ runId: 'new-run-1' }])
  } finally { await second.dispose() }
})

it('cleans only its uncommitted Run after confirmed persistence failure and retains original retired history', async () => {
  const f = await fixture(); vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('private persist rejected'))
  await expect(f.client.reopenAgent(f.input)).rejects.toThrow('private persist rejected')
  expect(await f.store.loadRetiredAgentSessions()).toEqual([f.retired]); expect(await loadAgentSessions(f.store)).toEqual([])
  expect(await f.store.loadTimeline(f.old.agentSessionId)).toEqual(f.timelineBefore)
  expect(f.stops).toEqual(['new-run-1']); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('reads canonical applied identity after a lost commit ACK and never stops or launches it again', async () => {
  const f = await fixture(), commit = f.store.commitLifecycle.bind(f.store)
  vi.spyOn(f.store, 'commitLifecycle').mockImplementationOnce(async (...args) => { await commit(...args); throw new Error('private lost ACK') })
  const next = await f.client.reopenAgent(f.input)
  expect(next.run).toEqual({ runId: 'new-run-1' }); expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([])
  expect(f.binds).toEqual(['new-run-1'])
  await expect(f.client.reopenAgent(f.input)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(f.starts).toHaveLength(1)
})

it('preserves canonical healthy capability when postcommit Hook observation fails', async () => {
  const f = await fixture(); f.inner.hookServer.createBinding.mockImplementation(() => ({ bindingId: 'fresh-binding',
    endpoint: { url: 'http://127.0.0.1:0', token: 'fresh-token' }, bindRun: async () => { throw new Error('private observation unavailable') }, close: vi.fn() }))
  const next = await f.client.reopenAgent(f.input)
  expect(next.run).toEqual({ runId: 'new-run-1' }); expect(f.stops).toEqual([]); expect(f.starts).toHaveLength(1)
  expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error', agentSessionId: f.old.agentSessionId, code: 'AGENT_REOPEN_OBSERVATION_UNCONFIRMED' }))
  expect(await f.store.loadTimeline(f.old.agentSessionId)).toEqual(f.timelineBefore)
})

it('rejects hidden prompt/native overrides before any lifecycle side effect', async () => {
  const f = await fixture()
  await expect(f.client.reopenAgent({ ...f.input, prompt: 'must not send' } as any)).rejects.toMatchObject({ code: 'INVALID_AGENT_REOPEN' })
  expect(f.starts).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('preserves an uncertain start reservation and never repeats or blindly stops the new Run', async () => {
  const f = await fixture()
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => {
    f.starts.push(input); throw new AgentMuxError('private start ACK lost', 'CTXMUX_io', undefined, { disposition: 'unknown', confirmedInputBytes: null })
  })
  await expect(f.client.reopenAgent(f.input)).rejects.toMatchObject({ controlFailure: { disposition: 'unknown' } })
  expect(JSON.parse(await readFile(f.storePath, 'utf8')).reservations).toHaveLength(1)
  await expect(f.client.reopenAgent(f.input)).rejects.toMatchObject({ code: 'AGENT_SESSION_BUSY' })
  expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([])
  expect(await f.store.loadRetiredAgentSessions()).toEqual([f.retired])
})

it('keeps the Run and reservation when the commit and canonical read are both unknown', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('private unknown commit'))
  vi.spyOn(f.store, 'load').mockRejectedValueOnce(new Error('private canonical read unavailable'))
  await expect(f.client.reopenAgent(f.input)).rejects.toThrow('Continue result is unconfirmed')
  expect(f.stops).toEqual([]); expect(f.starts).toHaveLength(1)
  expect(JSON.parse(await readFile(f.storePath, 'utf8')).reservations).toHaveLength(1)
  expect(await f.store.loadRetiredAgentSessions()).toEqual([f.retired])
})

it('serializes the exact retired identity across two real FileStore owner processes', async () => {
  const f = await fixture(), workerPath = fileURLToPath(new URL('./fixtures/retired-reopen-worker.mjs', import.meta.url))
  const workers = ['worker-run-a', 'worker-run-b'].map(operationId => fork(workerPath,
    [JSON.stringify({ storePath: f.storePath, old: f.old, operationId })], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }))
  const wait = (worker: typeof workers[number]) => new Promise<any>((resolve, reject) => {
    worker.once('message', resolve); worker.once('error', reject)
  })
  try {
    const ready = await Promise.all(workers.map(wait))
    expect(ready.map(value => value.kind)).toEqual(['ready', 'ready']); expect(new Set(ready.map(value => value.pid)).size).toBe(2)
    const replies = workers.map(wait); workers.forEach(worker => worker.send({ continue: true }))
    const results = await Promise.all(replies)
    expect(results.map(value => value.kind).sort()).toEqual(['rejected', 'reserved'])
    expect(results.find(value => value.kind === 'rejected').code).toBe('AGENT_SESSION_BUSY')
    const winner = workers[results.findIndex(value => value.kind === 'reserved')]!, committed = wait(winner)
    winner.send({ commit: true }); expect(await committed).toMatchObject({ kind: 'committed' })
    const active = await loadAgentSessions(f.store)
    expect(active).toHaveLength(1); expect(active[0]!.agentSessionId).toBe(f.old.agentSessionId)
    expect(active[0]!.reopenedFrom).toEqual({ run: f.old.run, source: 'user', observedAt: f.retired.observedAt })
    expect(await f.store.loadRetiredAgentSessions()).toEqual([])
    expect(await f.store.loadTimeline(f.old.agentSessionId)).toEqual(f.timelineBefore)
  } finally { for (const worker of workers) if (worker.connected) worker.disconnect() }
}, 10_000)

it('fences every retirement fact at the durable reservation, including a same-epoch native identity change', async () => {
  const f = await fixture(), reserve = f.store.reserveLifecycle.bind(f.store)
  vi.spyOn(f.store, 'reserveLifecycle').mockImplementationOnce(async reservation => {
    const raw = JSON.parse(await readFile(f.storePath, 'utf8'))
    raw.retiredAgentSessions[0].history.nativeHandle.sessionId = 'another-native'
    await writeFile(f.storePath, JSON.stringify(raw, null, 2))
    return await reserve(reservation)
  })
  await expect(f.client.reopenAgent(f.input)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION', controlFailure: { disposition: 'not_applied' } })
  expect(f.starts).toEqual([]); expect(f.stops).toEqual([])
  expect((await f.store.loadRetiredAgentSessions())[0]!.history!.nativeHandle).toMatchObject({ sessionId: 'another-native' })
})

it('retains every item and revision even when the original activity window is full', async () => {
  const f = await retiredReopenFixture('claude', 200); fixtures.push(f)
  expect(f.timelineBefore.items).toHaveLength(200)
  await f.client.reopenAgent(f.input)
  expect(await f.store.loadTimeline(f.old.agentSessionId)).toEqual(f.timelineBefore)
})

it('keeps an unprepared dead reopen attempt unknown without stopping its possibly healthy Run', async () => {
  const f = await fixture()
  const reservation = { kind: 'reopen' as const, reservationId: 'dead-reservation', ownerId: 'dead-owner', ownerPid: 2147483647,
    agentSessionId: f.old.agentSessionId, operationId: 'orphan-operation', expiresAt: 1, expectedRetirement: f.retired }
  await f.store.reserveLifecycle(reservation)
  f.inner.kernel.list = vi.fn(async () => [{ ...f.run('orphaned-run'), lifecycleOperationId: 'orphan-operation' }])
  await (f.client as any).recoverStaleLifecycles()
  expect(f.stops).toEqual([]); expect(f.starts).toEqual([])
  expect(await f.store.loadRetiredAgentSessions()).toEqual([f.retired])
  expect(JSON.parse(await readFile(f.storePath, 'utf8')).reservations).toHaveLength(1)
  expect(await f.store.loadTimeline(f.old.agentSessionId)).toEqual(f.timelineBefore)
})

it('buffers a real early HTTP Hook until the same identity is canonical, then retains its native ready fact', async () => {
  const f = await fixture(), deliveries: string[] = []
  const hook = new AgentHookServer(async (event, signal) => {
    expect(f.client.agentSession(f.old.agentSessionId).run.runId).toBe(event.runId)
    await (f.client as any).acceptHookEvent(event, signal); deliveries.push(event.receiptId)
  }, 0)
  await hook.start(); f.inner.hookServer = hook
  const start = f.inner.kernel.start.getMockImplementation()!
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => {
    const run = await start(input)
    const response = await fetch(input.env.AGENTMUX_HOOK_URL, { method: 'POST',
      headers: { authorization: `Bearer ${input.env.AGENTMUX_HOOK_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: 'early-native-ready', payload: { hook_event_name: 'SessionStart',
        session_id: 'native-main', transcript_path: f.path } }) })
    expect(response.ok).toBe(true); expect(deliveries).toEqual([])
    return run
  })
  const next = await f.client.reopenAgent(f.input)
  expect(deliveries).toEqual(['early-native-ready'])
  expect(next.hookReceipt).toMatchObject({ id: 'early-native-ready', run: { runId: 'new-run-1' } })
  expect(next.nativeHandle).toEqual(f.old.nativeHandle); expect(f.stops).toEqual([])
})

it('keeps original native identity and a service window when the continued CLI reports another conversation', async () => {
  const f = await fixture(), hook = new AgentHookServer(async (event, signal) => await (f.client as any).acceptHookEvent(event, signal), 0)
  await hook.start(); f.inner.hookServer = hook
  const start = f.inner.kernel.start.getMockImplementation()!
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => {
    const run = await start(input)
    await fetch(input.env.AGENTMUX_HOOK_URL, { method: 'POST', headers: { authorization: `Bearer ${input.env.AGENTMUX_HOOK_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: 'foreign-native-ready', payload: { hook_event_name: 'SessionStart', session_id: 'foreign-native', transcript_path: f.path } }) })
    return run
  })
  const next = await f.client.reopenAgent(f.input)
  expect(next.nativeHandle).toEqual(f.old.nativeHandle); expect(f.client.agentSession(f.old.agentSessionId).nativeHandle).toEqual(f.old.nativeHandle)
  expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_REOPEN_OBSERVATION_UNCONFIRMED' }))
  expect(f.stops).toEqual([]); expect(f.starts).toHaveLength(1)
})


it('durably prepares original identity and fresh credentials before starting, then explicitly confirms a lost start ACK', async () => {
  const f = await fixture()
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => {
    const raw = JSON.parse(await readFile(f.storePath, 'utf8')), prepared = raw.reservations[0].preparedSession
    expect(raw.sessions).toEqual([]); expect(raw.retiredAgentSessions).toEqual([f.retired])
    expect(raw.reservations[0].callerOperationId).toBe(f.input.operationId)
    expect(raw.reservations[0].operationId).toBe(input.operationKey)
    expect(prepared).toMatchObject({ agentSessionId: f.old.agentSessionId, nativeHandle: f.old.nativeHandle,
      hookBindingId: 'fresh-binding', hookToken: input.env.AGENTMUX_HOOK_TOKEN, capabilityHash: expect.any(String) })
    f.starts.push(input)
    throw new AgentMuxError('private lost start ACK', 'CTXMUX_io', undefined, { disposition: 'unknown', confirmedInputBytes: null })
  })
  await expect(f.client.reopenAgent(f.input)).rejects.toMatchObject({ code: 'AGENT_REOPEN_UNCONFIRMED' })
  const before = await readFile(f.storePath)
  expect(await f.client.readAgentSessions()).toEqual([]); expect(await readFile(f.storePath)).toEqual(before)
  expect(await f.store.loadReopenCorrelations()).toEqual([{ expectedRetirement: f.retired, operationId: f.input.operationId }])
  expect(await f.client.sessionHistorySources()).toEqual([{ agentSessionId: f.old.agentSessionId, hostId: f.old.hostId,
    state: 'retired', retiredAt: f.retired.observedAt, history: f.retired.history, pendingReopen: { operationId: f.input.operationId } }])
  expect(await readFile(f.storePath)).toEqual(before)
  const reservation = JSON.parse(before.toString()).reservations[0]
  await expect(f.store.prepareReopen({ ...reservation, callerOperationId: 'changed-original-intent' }, reservation.preparedSession))
    .rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(await readFile(f.storePath)).toEqual(before)
  const confirmed = await f.client.reconcileAgentReopen(f.input)
  expect(confirmed.run).toEqual({ runId: 'new-run-1' }); expect(confirmed.nativeHandle).toEqual(f.old.nativeHandle)
  expect(confirmed.reopenedFrom).toEqual({ run: f.old.run, source: 'user', observedAt: f.retired.observedAt })
  expect(f.starts).toHaveLength(1); expect(f.binds).toEqual(['new-run-1']); expect(f.stops).toEqual([])
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(JSON.parse(await readFile(f.storePath, 'utf8')).reservations).toEqual([])
  await expect(f.client.reconcileAgentReopen(f.input)).resolves.toMatchObject({ run: confirmed.run })
  expect(f.starts).toHaveLength(1); expect(f.binds).toEqual(['new-run-1'])
})

it.each(['missing', 'wrong-cwd', 'ambiguous'] as const)('keeps %s actual prepared result unknown without releasing or retrying the operation', async shape => {
  const f = await fixture()
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => { f.starts.push(input); throw new Error('private start ACK missing') })
  await expect(f.client.reopenAgent(f.input)).rejects.toMatchObject({ controlFailure: { disposition: 'unknown' } })
  const matching = { ...f.run('new-run-1'), lifecycleOperationId: f.starts[0]!.operationKey }
  f.inner.kernel.list.mockResolvedValue(shape === 'missing' ? [] : shape === 'wrong-cwd' ? [{ ...matching, workspacePath: 'another-workspace' }] : [matching, { ...matching, runId: 'another-run' }])
  await expect(f.client.reconcileAgentReopen(f.input)).rejects.toMatchObject({ controlFailure: { disposition: 'unknown' } })
  expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(await f.store.loadRetiredAgentSessions()).toEqual([f.retired]); expect(await loadAgentSessions(f.store)).toEqual([])
  expect(JSON.parse(await readFile(f.storePath, 'utf8')).reservations).toHaveLength(1)
})

it('does not claim a still-executing original operation even while its Run already exists', async () => {
  const f = await fixture(), start = f.inner.kernel.start.getMockImplementation()!
  let finish!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), barrier = new Promise<void>(resolve => { finish = resolve })
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => { const run = await start(input); entered(); await barrier; return run })
  const operation = f.client.reopenAgent(f.input)
  await started
  try {
    await expect(f.client.reconcileAgentReopen(f.input)).rejects.toMatchObject({ controlFailure: { disposition: 'unknown' } })
    await expect(f.client.reopenAgent(f.input)).rejects.toMatchObject({ controlFailure: { disposition: 'unknown' } })
    expect(await loadAgentSessions(f.store)).toEqual([]); expect(f.binds).toEqual([]); expect(f.stops).toEqual([])
  } finally { finish() }
  await expect(operation).resolves.toMatchObject({ run: { runId: 'new-run-1' } }); expect(f.starts).toHaveLength(1)
})

it('cold stale owner completes the exact durable prepared healthy attempt without a launch or stop', async () => {
  const f = await fixture()
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => { f.starts.push(input); throw new Error('private ACK lost before owner death') })
  await expect(f.client.reopenAgent(f.input)).rejects.toThrow()
  const raw = JSON.parse(await readFile(f.storePath, 'utf8')); raw.reservations[0].ownerPid = 2147483647; raw.reservations[0].ownerId = 'dead-owner'
  await writeFile(f.storePath, JSON.stringify(raw))
  const { AgentMuxClient } = await import('../src/client.js'), cold = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(f.storePath) }), inner = cold as any
  inner.kernel = f.inner.kernel
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = (sid: string, provider: string, bindingId: string, token: string) => ({ bindingId, endpoint: { url: 'private-restored', token },
    bindRun: async (id: string) => { expect(cold.agentSession(sid).run.runId).toBe(id); f.binds.push(id) }, close: async () => {} })
  try {
    await inner.recoverStaleLifecycles()
    expect(cold.agentSession(f.old.agentSessionId)).toMatchObject({ nativeHandle: f.old.nativeHandle, run: { runId: 'new-run-1' } })
    expect(f.binds).toEqual(['new-run-1']); expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
    expect(await f.store.loadRetiredAgentSessions()).toEqual([]); expect(await f.store.loadTimeline(f.old.agentSessionId)).toEqual(f.timelineBefore)
    expect(JSON.parse(await readFile(f.storePath, 'utf8')).reservations).toEqual([])
  } finally { await cold.dispose() }
})


it('explicit confirmation flushes the original buffered real HTTP Hook after unknown commit and read', async () => {
  const f = await fixture(), delivered: string[] = []
  const hook = new AgentHookServer(async (event, signal) => {
    expect(f.client.agentSession(f.old.agentSessionId).run.runId).toBe(event.runId)
    await (f.client as any).acceptHookEvent(event, signal); delivered.push(event.receiptId)
  }, 0)
  await hook.start(); f.inner.hookServer = hook
  const start = f.inner.kernel.start.getMockImplementation()!
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => {
    const run = await start(input)
    const response = await fetch(input.env.AGENTMUX_HOOK_URL, { method: 'POST', headers: {
      authorization: `Bearer ${input.env.AGENTMUX_HOOK_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: 'uncertain-early-native-ready', payload: { hook_event_name: 'SessionStart', session_id: 'native-main',
        transcript_path: f.path, cwd: f.root } }) })
    expect(response.status).toBe(204); expect(delivered).toEqual([]); return run
  })
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('private unknown commit'))
  vi.spyOn(f.store, 'load').mockRejectedValueOnce(new Error('private canonical read unknown'))
  try {
    await expect(f.client.reopenAgent(f.input)).rejects.toThrow('Continue result is unconfirmed')
    expect(delivered).toEqual([])
    const confirmed = await f.client.reconcileAgentReopen(f.input)
    expect(confirmed.run).toEqual({ runId: 'new-run-1' }); expect(confirmed.nativeHandle).toEqual(f.old.nativeHandle)
    expect(delivered).toEqual(['uncertain-early-native-ready']); expect(confirmed.hookReceipt?.id).toBe('uncertain-early-native-ready')
    expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await hook.stop() }
})


it('explicit disposal releases only its settled reopen ownership for a new Client in the same OS process', async () => {
  const f = await fixture()
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => { f.starts.push(input); throw new Error('private native start ACK lost') })
  await expect(f.client.reopenAgent(f.input)).rejects.toThrow()
  const { AgentMuxClient } = await import('../src/client.js'), replacement = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(f.storePath) }), inner = replacement as any
  inner.connected = true; inner.kernel = f.inner.kernel
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = (_sid: string, _provider: string, bindingId: string, token: string) => ({ bindingId, endpoint: { url: 'private-restored', token },
    bindRun: async (id: string) => { expect(replacement.agentSession(f.old.agentSessionId).run.runId).toBe(id); f.binds.push(id) }, close: async () => {} })
  try {
    await expect(replacement.reconcileAgentReopen(f.input)).rejects.toMatchObject({ controlFailure: { disposition: 'unknown' } })
    expect(await loadAgentSessions(f.store)).toEqual([])
    await f.client.dispose()
    const released = JSON.parse(await readFile(f.storePath, 'utf8')).reservations[0]
    expect(released).toMatchObject({ ownerPid: process.pid, ownerReleased: true, preparedSession: { nativeHandle: f.old.nativeHandle } })
    const next = await replacement.reconcileAgentReopen(f.input)
    expect(next.run).toEqual({ runId: 'new-run-1' }); expect(next.nativeHandle).toEqual(f.old.nativeHandle)
    expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await replacement.dispose() }
})

it('disposal waits for an executing explicit confirmation before releasing its owner', async () => {
  const f = await fixture()
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => { f.starts.push(input); throw new Error('private native start ACK lost') })
  await expect(f.client.reopenAgent(f.input)).rejects.toThrow()
  const list = f.inner.kernel.list.getMockImplementation()!
  let finish!: () => void, entered!: () => void
  const barrier = new Promise<void>(resolve => { finish = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  f.inner.kernel.list.mockImplementationOnce(async () => { entered(); await barrier; return await list() })
  const confirmation = f.client.reconcileAgentReopen(f.input)
  await started
  const stopObserving = vi.spyOn(f.inner.hookServer, 'stop')
  let disposed = false
  const disposal = f.client.dispose().then(() => { disposed = true })
  try {
    expect(stopObserving).not.toHaveBeenCalled()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)
    expect(JSON.parse(await readFile(f.storePath, 'utf8')).reservations[0]).not.toHaveProperty('ownerReleased')
    await expect(f.client.reconcileAgentReopen(f.input)).rejects.toMatchObject({ controlFailure: { disposition: 'unknown' } })
  } finally { finish() }
  await expect(confirmation).resolves.toMatchObject({ run: { runId: 'new-run-1' }, nativeHandle: f.old.nativeHandle })
  await disposal
  expect(disposed).toBe(true); expect(f.binds).toEqual(['new-run-1']); expect(f.starts).toHaveLength(1)
  expect(f.stops).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it.each(['missing', 'drifted'] as const)('keeps a %s caller correlation observable as pending unknown without changing durable facts', async shape => {
  const f = await fixture()
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => { f.starts.push(input); throw new Error('private lost start ACK') })
  await expect(f.client.reopenAgent(f.input)).rejects.toThrow()
  const raw = JSON.parse(await readFile(f.storePath, 'utf8'))
  if (shape === 'missing') delete raw.reservations[0].callerOperationId
  else raw.reservations[0].callerOperationId = 'another-original-intent'
  await writeFile(f.storePath, JSON.stringify(raw))
  const before = await readFile(f.storePath)
  expect(await f.client.sessionHistorySources()).toEqual([{ agentSessionId: f.old.agentSessionId, hostId: f.old.hostId,
    state: 'retired', retiredAt: f.retired.observedAt, history: f.retired.history, pendingReopen: {} }])
  expect(await f.store.loadRetiredAgentSessions()).toEqual([f.retired])
  expect(await readFile(f.storePath)).toEqual(before)
  expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it.each(['host', 'epoch', 'native'] as const)('does not project another %s retirement reservation as this history correlation', async shape => {
  const f = await fixture()
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => { f.starts.push(input); throw new Error('private lost start ACK') })
  await expect(f.client.reopenAgent(f.input)).rejects.toThrow()
  const raw = JSON.parse(await readFile(f.storePath, 'utf8')), reservation = raw.reservations[0]
  delete reservation.preparedSession
  if (shape === 'host') reservation.expectedRetirement.hostId = 'another-host'
  if (shape === 'epoch') reservation.expectedRetirement.observedAt++
  if (shape === 'native') reservation.expectedRetirement.history.nativeHandle.sessionId = 'another-native'
  await writeFile(f.storePath, JSON.stringify(raw))
  const before = await readFile(f.storePath)
  expect(await f.client.sessionHistorySources()).toEqual([{ agentSessionId: f.old.agentSessionId, hostId: f.old.hostId,
    state: 'retired', retiredAt: f.retired.observedAt, history: f.retired.history }])
  expect(await readFile(f.storePath)).toEqual(before)
  expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('Memory Store preserves the same original caller correlation across pure discovery and ownership claim', async () => {
  const f = await fixture(), memory = new AgentMuxMemoryAgentSessionStore()
  await memory.compareAndSwap(null, f.old)
  const stop = { kind: 'stop' as const, reservationId: 'memory-stop', ownerId: 'memory-owner', ownerPid: process.pid,
    agentSessionId: f.old.agentSessionId, operationId: 'memory-stop', expiresAt: 1, expectedRun: f.old.run,
    stopOperation: { daemonInstance: 'memory-daemon', operationKey: 'memory-stop', runId: f.old.run.runId } }
  await memory.reserveLifecycle(stop); await memory.commitLifecycle(stop, null)
  const retirement = (await memory.loadRetiredAgentSessions())[0]!
  const reservation = { kind: 'reopen' as const, reservationId: 'memory-reopen', ownerId: 'memory-owner', ownerPid: process.pid,
    agentSessionId: f.old.agentSessionId, operationId: agentLifecycleOperationIdentity('reopen', f.old.agentSessionId, f.input.operationId),
    callerOperationId: f.input.operationId, expiresAt: 1, expectedRetirement: retirement }
  await memory.reserveLifecycle(reservation)
  expect(await loadSessionHistorySources(memory)).toContainEqual({ agentSessionId: f.old.agentSessionId, hostId: f.old.hostId,
    state: 'retired', retiredAt: retirement.observedAt, history: retirement.history, pendingReopen: { operationId: f.input.operationId } })
  expect(await memory.claimReopen(f.old.agentSessionId, reservation.operationId, retirement.observedAt,
    { ownerId: 'memory-owner', ownerPid: process.pid, now: 2, expiresAt: 3 })).toMatchObject({ callerOperationId: f.input.operationId })
  const correlations = await memory.loadReopenCorrelations()
  correlations[0]!.expectedRetirement.hostId = 'changed-reader-copy'
  expect(await memory.loadReopenCorrelations()).toEqual([{ expectedRetirement: retirement, operationId: f.input.operationId }])
  expect(f.starts).toEqual([]); expect(f.stops).toEqual([])
})

it('preserves accepted unflushed activity across retirement preparation and canonical continuation', async () => {
  const f = await fixture()
  const activityCommit = {
    latest: { id: 'accepted-latest', source: 'agentmux' as const, createdAt: 3, activityState: { run: f.old.run, state: 'done' as const } },
    latestCommitted: false,
    pending: { id: 'accepted-earlier', source: 'agentmux' as const, createdAt: 2, activityState: { run: f.old.run, state: 'working' as const } }
  }
  const raw = JSON.parse(await readFile(f.storePath, 'utf8'))
  raw.retiredAgentSessions[0].activityCommit = activityCommit
  await writeFile(f.storePath, JSON.stringify(raw))
  f.inner.kernel.start.mockImplementationOnce(async (input: Record<string, any>) => {
    const prepared = JSON.parse(await readFile(f.storePath, 'utf8')).reservations[0]
    expect(prepared.expectedRetirement.activityCommit).toEqual(activityCommit)
    expect(prepared.preparedSession.activityCommit).toEqual(activityCommit)
    f.starts.push(input); throw new Error('private start ACK unavailable')
  })
  await expect(f.client.reopenAgent(f.input)).rejects.toMatchObject({ controlFailure: { disposition: 'unknown' } })
  await expect(f.client.reconcileAgentReopen(f.input)).resolves.toMatchObject({ run: { runId: 'new-run-1' } })
  expect((await loadAgentSessions(f.store))[0]!.activityCommit).toEqual(activityCommit)
  expect(await f.store.loadRetiredAgentSessions()).toEqual([])
  expect(await f.store.loadTimeline(f.old.agentSessionId)).toEqual(f.timelineBefore)
  expect(f.starts).toHaveLength(1); expect(f.stops).toEqual([]); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
