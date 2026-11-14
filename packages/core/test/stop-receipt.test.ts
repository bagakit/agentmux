import { fixtureEpoch } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js';
import { agentLifecycleOperationIdentity } from "../src/agent-session-identity.js";
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseAgentMuxControlReceipt } from '../src/control-codec.js'
import { assertControlResultTarget } from '../src/rpc-business-codec.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { AgentMuxError } from '../src/errors.js'
import { parseAgentStopInspection } from '../src/agent-stop-receipt.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../src/control.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

type Plan = { state: 'running' | 'exited' | 'interrupted' | 'missing'; disposition?: 'graceful' | 'forced'; stopError?: Error | undefined }

async function fixture(kind: 'memory' | 'file', plan: Plan = { state: 'running', disposition: 'graceful' }) {
  const root = await mkdtemp(join(tmpdir(), 'amux-stop-receipt-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const store: AgentMuxAgentSessionStore = kind === 'file' ? new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) : new AgentMuxMemoryAgentSessionStore()
  const original: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'receipt-agent', hostId: 'local',
    providerId: 'claude', executorId: 'claude', workspacePath: root, run: { runId: 'receipt-run' }, retiredRuns: [],
    hookBindingId: 'receipt-hook', hookToken: 'private-token', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'receipt-native' } }
  await store.compareAndSwap(null, original)
  const client = new AgentMuxClient({ store })
  const internal = client as any
  await internal.registry.load('local')
  const state = () => plan.state === 'running' ? { type: 'running' } : plan.state === 'exited' ? { type: 'exited', code: 0, signal: null } : { type: 'interrupted', reason: 'runtime restart' }
  internal.connected = true
  internal.kernel.isConnected = () => true
  internal.kernel.identity = () => ({ daemonInstanceId: 'receipt-daemon', protocolVersion: 1, buildIdentity: 'private' })
  internal.kernel.status = vi.fn(async (runId: string) => {
    if (plan.state === 'missing') throw new AgentMuxError('absent', 'CTXMUX_run_not_found')
    return { runId, lifecycleOperationId: null, program: 'private-agent', args: [], workspacePath: root, pid: plan.state === 'running' ? 42 : null,
      state: state(), cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null }
  })
  internal.kernel.detach = vi.fn(async () => {})
  internal.kernel.disconnect = vi.fn(async () => {})
  internal.releaseRunAttachment = vi.fn(async () => {})
  internal.kernel.prepareStop = vi.fn(async (runId: string, operationKey: string) => ({ daemonInstance: 'receipt-daemon', operationKey, runId }))
  internal.kernel.stop = vi.fn(async () => {
    if (plan.stopError) throw plan.stopError
    plan.state = 'exited'
    return { disposition: plan.disposition ?? 'graceful' }
  })
  cleanup.push(() => client.dispose())
  return { root, client, internal, store, original, plan }
}

describe('a Stop returns and keeps its own receipt', () => {
  it.each(['memory', 'file'] as const)('a running Run reports the Runtime disposition and every stage in %s', async kind => {
    const f = await fixture(kind, { state: 'running', disposition: 'forced' })
    const receipt = await f.client.stopAgent(f.original.agentSessionId, f.original.run, { operationId: 'caller-stop' })
    expect(receipt).toMatchObject({ agentSessionId: f.original.agentSessionId, expectedRun: f.original.run, operationId: 'caller-stop',
      lifecycleOperationId: agentLifecycleOperationIdentity('stop', f.original.agentSessionId, 'caller-stop'),
      admission: 'new', runtime: { observed: 'running', stop: 'forced' } })
    expect(receipt.stages.map(stage => [stage.stage, stage.outcome])).toEqual([
      ['admission', 'ok'], ['runtime-observe', 'ok'], ['runtime-stop', 'ok'], ['retire-commit', 'ok']])
    for (const stage of receipt.stages) expect(stage.endedAt).toBeGreaterThanOrEqual(stage.startedAt)
    // The Runtime operation carries the same lifecycle identity the receipt names.
    expect(f.internal.kernel.prepareStop).toHaveBeenCalledWith(f.original.run.runId, receipt.lifecycleOperationId)
    const retired = await f.store.readRetiredAgentSession(f.original.agentSessionId)
    expect(retired?.stop).toEqual({ operationId: 'caller-stop', lifecycleOperationId: receipt.lifecycleOperationId, runtime: receipt.runtime, stages: receipt.stages })
    expect(receipt.retiredAt).toBe(retired?.observedAt)
    expect(await f.store.readLifecycleReservation(f.original.agentSessionId)).toBeNull()
  })

  it.each([['interrupted', 'interrupted'], ['exited', 'exited'], ['missing', 'not-found']] as const)(
    'a %s Run retires without a Runtime stop and says so', async (state, observed) => {
      const f = await fixture('file', { state })
      const receipt = await f.client.stopAgent(f.original.agentSessionId, f.original.run)
      expect(f.internal.kernel.stop).not.toHaveBeenCalled()
      expect(receipt.runtime).toEqual({ observed, stop: 'not-required' })
      expect(receipt.stages.find(stage => stage.stage === 'runtime-stop')?.outcome).toBe('skipped')
      expect(receipt.stages.find(stage => stage.stage === 'runtime-observe')?.outcome).toBe(state === 'missing' ? 'not-found' : 'ok')
      // Without a caller identity the minted one is returned and is the lifecycle seed.
      expect(receipt.lifecycleOperationId).toBe(agentLifecycleOperationIdentity('stop', f.original.agentSessionId, receipt.operationId))
    })

  it('a Run that vanished during the Runtime stop is recorded as not-found, not as stopped', async () => {
    const f = await fixture('memory', { state: 'running', stopError: new AgentMuxError('gone', 'CTXMUX_run_not_found') })
    const receipt = await f.client.stopAgent(f.original.agentSessionId, f.original.run)
    expect(receipt.runtime).toEqual({ observed: 'running', stop: 'not-found' })
    expect(receipt.stages.find(stage => stage.stage === 'runtime-stop')?.outcome).toBe('not-found')
  })
})

describe('a failed Stop keeps its progress on its own reservation', () => {
  it.each(['memory', 'file'] as const)('the failed stage, code and caller identity survive in %s, and a retry continues them', async kind => {
    const f = await fixture(kind, { state: 'running', stopError: new Error('receipt lost') })
    await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run, { operationId: 'first-stop' })).rejects.toThrow('receipt lost')
    const open = await f.store.readLifecycleReservation(f.original.agentSessionId)
    expect(open).toMatchObject({ kind: 'stop', operationId: agentLifecycleOperationIdentity('stop', f.original.agentSessionId, 'first-stop'),
      progress: { operationId: 'first-stop', failure: { stage: 'runtime-stop', code: 'AGENT_STOP_FAILED', message: 'receipt lost' } } })
    expect(open?.kind === 'stop' && open.progress?.stages.map(stage => [stage.stage, stage.outcome])).toEqual([
      ['admission', 'ok'], ['runtime-observe', 'ok'], ['runtime-stop', 'failed']])
    const inspected = await f.client.inspectAgentStop({ agentSessionId: f.original.agentSessionId, expectedRun: f.original.run, operationId: 'first-stop' })
    expect(inspected).toMatchObject({ phase: 'stopping', canRetry: true, operationIdMatched: true, lifecycleOperationId: open!.operationId,
      failure: { stage: 'runtime-stop', code: 'AGENT_STOP_FAILED' } })

    f.plan.stopError = undefined
    // A retry under another caller identity still continues the original Stop and reports its identity.
    const receipt = await f.client.stopAgent(f.original.agentSessionId, f.original.run, { operationId: 'second-stop' })
    expect(receipt).toMatchObject({ operationId: 'first-stop', lifecycleOperationId: open!.operationId, admission: 'retained', runtime: { observed: 'running', stop: 'graceful' } })
    expect(f.internal.kernel.prepareStop).toHaveBeenCalledTimes(1)
    expect(new Set(f.internal.kernel.stop.mock.calls.map((call: any[]) => JSON.stringify(call[0]))).size).toBe(1)
    expect((await f.store.readRetiredAgentSession(f.original.agentSessionId))?.stop?.operationId).toBe('first-stop')
  })

  it('progress is written before the Runtime stop that may hang', async () => {
    const f = await fixture('file')
    let release!: () => void
    const barrier = new Promise<void>(done => { release = done })
    f.internal.kernel.stop.mockImplementation(async () => { await barrier; return { disposition: 'graceful' } })
    const stopping = f.client.stopAgent(f.original.agentSessionId, f.original.run, { operationId: 'hanging-stop' })
    await vi.waitFor(() => expect(f.internal.kernel.stop).toHaveBeenCalledTimes(1))
    try {
      expect(await f.client.inspectAgentStop({ agentSessionId: f.original.agentSessionId, expectedRun: f.original.run })).toMatchObject({
        phase: 'stopping', canRetry: true, stages: [{ stage: 'admission', outcome: 'ok' }, { stage: 'runtime-observe', outcome: 'ok' }] })
      // A second reader joins the same Stop and gets the same receipt marked joined.
      const joined = f.client.stopAgent(f.original.agentSessionId, f.original.run)
      release()
      const [first, second] = await Promise.all([stopping, joined])
      expect(first.admission).toBe('new')
      expect(second).toEqual({ ...first, admission: 'joined' })
    } finally { release() }
  })
})

describe('a Stop is identified and finished by one rule', () => {
  it('a caller operation id is checked at entry by the same rule inspect uses', async () => {
    const f = await fixture('memory')
    for (const operationId of ['', 'stop.1', 'stop 1']) {
      await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run, { operationId })).rejects.toMatchObject({ code: 'INVALID_SESSION_ID' })
    }
    expect(f.internal.kernel.prepareStop).not.toHaveBeenCalled()
    expect(await f.store.readLifecycleReservation(f.original.agentSessionId)).toBeNull()
  })

  it.each(['memory', 'file'] as const)('a retirement that does not commit is recorded as that stage in %s', async kind => {
    const f = await fixture(kind)
    vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new AgentMuxError('commit refused', 'AGENT_SESSION_STORE_UNAVAILABLE'))
    await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run, { operationId: 'uncommitted' })).rejects.toThrow()
    expect(await f.client.inspectAgentStop({ agentSessionId: f.original.agentSessionId, expectedRun: f.original.run })).toMatchObject({
      phase: 'stopping', canRetry: true, failure: { stage: 'retire-commit', code: 'AGENT_SESSION_STORE_UNAVAILABLE' },
      stages: [{ stage: 'admission' }, { stage: 'runtime-observe' }, { stage: 'runtime-stop', outcome: 'ok' }, { stage: 'retire-commit', outcome: 'failed' }] })
    // The retry finishes the same Stop and keeps the admission it was first given.
    const admitted = (await f.store.readLifecycleReservation(f.original.agentSessionId) as any).progress.stages[0]
    const receipt = await f.client.stopAgent(f.original.agentSessionId, f.original.run)
    expect(receipt).toMatchObject({ operationId: 'uncommitted', admission: 'retained' })
    expect(receipt.stages[0]).toEqual(admitted)
  })

  it('an inspection crossing a boundary is read strictly against the asked Stop', () => {
    const asked = { agentSessionId: 'receipt-agent', expectedRun: { runId: 'receipt-run' } }
    const valid = { ...asked, phase: 'stopping', canRetry: true, observedAt: 1,
      failure: { stage: 'runtime-stop', code: 'CONTROL_UNAVAILABLE', message: 'lost', observedAt: 1 } }
    expect(parseAgentStopInspection(valid, asked)).toEqual(valid)
    for (const bad of [
      { ...valid, failure: { ...valid.failure, stage: 'bogus' } },
      { ...valid, agentSessionId: 'other-agent' },
      { ...valid, phase: 'not-requested' },
      { ...valid, holder: { kind: 'resume', operationId: 'r' } },
      { ...valid, operationIdMatched: true },
      { ...valid, extra: true }
    ]) expect(() => parseAgentStopInspection(bad, asked)).toThrow()
  })
})

describe('progress is evidence, never a precondition of the Stop', () => {
  it('a Store that cannot record progress still stops and retires the Run with its full record', async () => {
    const f = await fixture('file', { state: 'running', disposition: 'graceful' })
    vi.spyOn(f.store, 'recordStopProgress').mockRejectedValue(new Error('progress write failed'))
    const receipt = await f.client.stopAgent(f.original.agentSessionId, f.original.run, { operationId: 'unrecorded-stop' })
    expect(f.internal.kernel.stop).toHaveBeenCalledTimes(1)
    expect(receipt.runtime).toEqual({ observed: 'running', stop: 'graceful' })
    expect((await f.store.readRetiredAgentSession(f.original.agentSessionId))?.stop?.operationId).toBe('unrecorded-stop')
  })

  it('a failed Stop answers with its own failure even when the failure cannot be recorded', async () => {
    const f = await fixture('memory', { state: 'running', stopError: new AgentMuxError('owner refused', 'CTXMUX_owner_refused') })
    vi.spyOn(f.store, 'recordStopProgress').mockRejectedValue(new Error('progress write failed'))
    await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run)).rejects.toMatchObject({ code: 'CTXMUX_owner_refused' })
    expect(await f.client.inspectAgentStop({ agentSessionId: f.original.agentSessionId, expectedRun: f.original.run })).toMatchObject({ phase: 'stopping', canRetry: true })
  })
})

describe('inspect reads only the exact rows and never guesses stopped', () => {
  it.each(['memory', 'file'] as const)('reports each phase from the owner in %s', async kind => {
    const f = await fixture(kind, { state: 'running' })
    const identity = { agentSessionId: f.original.agentSessionId, expectedRun: f.original.run }
    expect(await f.client.inspectAgentStop(identity)).toMatchObject({ phase: 'not-requested', canRetry: true })
    expect(await f.client.inspectAgentStop({ ...identity, expectedRun: { runId: 'other-run' } })).toMatchObject({ phase: 'unconfirmed', canRetry: false })
    const resume = await f.internal.registry.reserveExisting('resume', f.original.agentSessionId, f.original.run, 'resume-holder')
    expect(await f.client.inspectAgentStop(identity)).toMatchObject({ phase: 'unconfirmed', canRetry: false, holder: { kind: 'resume', operationId: 'resume-holder' } })
    await f.internal.registry.releaseLifecycle(resume)
    const receipt = await f.client.stopAgent(f.original.agentSessionId, f.original.run, { operationId: 'inspected-stop' })
    expect(await f.client.inspectAgentStop({ ...identity, operationId: 'inspected-stop' })).toEqual({ ...identity, phase: 'retired', canRetry: false,
      retiredAt: receipt.retiredAt, lifecycleOperationId: receipt.lifecycleOperationId, stages: receipt.stages, runtime: receipt.runtime,
      operationIdMatched: true, observedAt: expect.any(Number) })
    expect(await f.client.inspectAgentStop({ ...identity, operationId: 'another-stop' })).toMatchObject({ phase: 'retired', operationIdMatched: false })
    expect(f.internal.kernel.status).toHaveBeenCalledTimes(1)
  })

  it('inspect never claims, starts or stops anything and a broken row read is an error', async () => {
    const f = await fixture('memory')
    const claim = vi.spyOn(f.store, 'claimStaleLifecycles'), catalog = vi.spyOn(f.store, 'loadRetiredAgentSessions')
    await f.client.inspectAgentStop({ agentSessionId: f.original.agentSessionId, expectedRun: f.original.run })
    expect(claim).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled()
    expect(f.internal.kernel.status).not.toHaveBeenCalled(); expect(f.internal.kernel.stop).not.toHaveBeenCalled()
    vi.spyOn(f.store, 'readLifecycleReservation').mockRejectedValueOnce(new Error('row read failed'))
    await expect(f.client.inspectAgentStop({ agentSessionId: f.original.agentSessionId, expectedRun: f.original.run })).rejects.toThrow('row read failed')
    await expect(f.client.inspectAgentStop({ agentSessionId: 'self', expectedRun: f.original.run } as any)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  })
})

describe('the Runtime receipt reaches Core', () => {
  it('kernel.stop returns the ctxmux StopReceipt disposition', async () => {
    const adapter = new CtxmuxRunAdapter() as any
    const close = vi.fn()
    adapter.client = { attachRecoverableStop: vi.fn(async () => ({ attachment: { close }, stop: { run: {}, receipt: { type: 'stop', disposition: 'forced' } } })) }
    await expect(adapter.stop({ daemonInstance: 'd', operationKey: 'k', runId: 'r' })).resolves.toEqual({ disposition: 'forced' })
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('the public Stop surface carries the same receipt', () => {
  it('control stop results accept a strict receipt and bind it to the request', () => {
    const receipt = { agentSessionId: 'receipt-agent', expectedRun: { runId: 'receipt-run' }, operationId: 'control-stop', lifecycleOperationId: 'lifecycle',
      admission: 'new', runtime: { observed: 'running', stop: 'graceful' }, retiredAt: 1,
      stages: [{ stage: 'admission', startedAt: 1, endedAt: 1, outcome: 'ok' }] }
    const reply = (value: unknown) => parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'control-stop', ok: true, operation: 'stop', result: value })
    expect(reply({ agentSessionId: 'receipt-agent' })).toMatchObject({ result: { agentSessionId: 'receipt-agent' } })
    const parsed = reply({ agentSessionId: 'receipt-agent', receipt })
    expect(parsed).toMatchObject({ result: { receipt } })
    expect(() => reply({ agentSessionId: 'receipt-agent', receipt: { ...receipt, runtime: { observed: 'running', stop: 'maybe' } } })).toThrow()
    expect(() => reply({ agentSessionId: 'receipt-agent', receipt: { ...receipt, agentSessionId: 'other-agent' } })).toThrow()
    const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'control-stop', operation: 'stop', target: { kind: 'agent-session', agentSessionId: 'receipt-agent' } } as any
    expect(() => assertControlResultTarget(request, { operation: 'stop', agentSessionId: 'receipt-agent', receipt } as any)).not.toThrow()
    expect(() => assertControlResultTarget(request, { operation: 'stop', agentSessionId: 'receipt-agent', receipt: { ...receipt, operationId: 'other' } } as any)).toThrow()
    expect(() => assertControlResultTarget(request, { operation: 'stop', agentSessionId: 'receipt-agent', receipt: { ...receipt, operationId: 'other', admission: 'retained' } } as any)).not.toThrow()
  })

  it('the CLI spells inspect under agent stop and passes the exact identity', async () => {
    const parsed = await parseAgentMuxCliInvocation(['agent', 'stop', 'inspect', '--session', 'receipt-agent', '--run', 'receipt-run', '--operation-id', 'cli-stop'])
    expect(parsed.command.method).toBe('agent.stop.inspect')
    expect(parsed.params).toEqual({ agentSessionId: 'receipt-agent', expectedRun: { runId: 'receipt-run' }, operationId: 'cli-stop' })
    expect((await parseAgentMuxCliInvocation(['agent', 'stop', '--session', 'receipt-agent'])).command.method).toBe('agent.stop')
    await expect(parseAgentMuxCliInvocation(['agent', 'stop', 'inspect', '--session', 'receipt-agent'])).rejects.toThrow()
  })

  it('public RPC and the compiled CLI read the retained Stop from the original owner', async () => {
    const f = await fixture('file', { state: 'running', stopError: new Error('receipt lost') })
    await expect(f.client.stopAgent(f.original.agentSessionId, f.original.run, { operationId: 'rpc-stop' })).rejects.toThrow('receipt lost')
    const server = new AgentMuxControlServer({ socketPath: join(f.root, 'stop.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
    await server.start(); cleanup.push(() => server.stop())
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(async () => rpc.dispose())
    const identity = { agentSessionId: f.original.agentSessionId, expectedRun: f.original.run, operationId: 'rpc-stop' }
    const catalogs = [vi.spyOn(f.store, 'loadMetadata'), vi.spyOn(f.store, 'loadRetiredAgentSessions')]
    expect(await rpc.call('agent.stop.inspect', identity)).toMatchObject({ phase: 'stopping', canRetry: true, operationIdMatched: true,
      failure: { stage: 'runtime-stop' } })
    // The public route finds the owner by the exact Session, never by reading every Session's history.
    for (const catalog of catalogs) { expect(catalog).not.toHaveBeenCalled(); catalog.mockRestore() }
    await expect((server as any).service.call('agent.stop.inspect', identity, { caller: { agentSessionId: f.original.agentSessionId, capability: 'private-test' },
      principal: { kind: 'user', id: 'private-local-user' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    const env = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path })
    const cli = await runCompiledObjectCli(['agent', 'stop', 'inspect', '--session', f.original.agentSessionId, '--run', f.original.run.runId, '--operation-id', 'rpc-stop'], env)
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, result: { phase: 'stopping', operationIdMatched: true } })
    f.plan.stopError = undefined
    await f.client.stopAgent(f.original.agentSessionId, f.original.run)
    expect(await rpc.call('agent.stop.inspect', identity)).toMatchObject({ phase: 'retired', canRetry: false, operationIdMatched: true })
  })
})
