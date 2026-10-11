import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as Source from '../src/index.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { agentLifecycleOperationIdentity } from '../src/agent-session-store.js'
import type { AgentMuxAgentResumeInput } from '../src/client.js'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession } from '../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const core: typeof Source & Record<string, any> = process.env.AGENTMUX_TEST_CONTINUITY_SUPERVISION_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_CONTINUITY_SUPERVISION_ENTRY)
  : { ...Source, ...await import('../src/public-rpc-server.js'), ...await import('../src/hosted-runtime-service.js') }
if (process.env.AGENTMUX_TEST_CONTINUITY_SUPERVISION_MUTANT) expect(Reflect.get(core, 'AGENTMUX_CONTINUITY_SUPERVISION_MUTANT')).toBe(process.env.AGENTMUX_TEST_CONTINUITY_SUPERVISION_MUTANT)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup() } catch (error) { errors.push(error) }
    }
  } finally {
    try { vi.restoreAllMocks() } catch (error) { errors.push(error) }
    try { vi.unstubAllEnvs() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Continuity fixture cleanup failed.')
})
it('validates exact supervision subjects and signal facts without narrowing real Runtime signal forms', () => {
  const operation: any = { operationId: 'root', agentSessionId: 'original-session', trigger: 'startup', policy: core.DEFAULT_AGENT_CONTINUITY_POLICY,
    previousRun: { runId: 'old-run' }, kind: 'resumed', reason: 'original', admittedAt: _historyFixtureEpoch(0, 0, 1), observedAt: _historyFixtureEpoch(0, 0, 1), rechecks: 0,
    evidence: { kind: 'run-ended', observedAt: _historyFixtureEpoch(0, 0, 1) }, nativeTarget: { kind: 'provider', providerId: 'resume-process', sessionId: 'native-session' },
    supervision: { phase: 'observing', activeAttemptOperationId: 'root', attemptCount: 1, attemptLimit: 4, reason: 'original', observedAt: _historyFixtureEpoch(0, 0, 1),
      process: { run: { runId: 'new-run' }, state: 'exited', observedAt: _historyFixtureEpoch(0, 0, 1) } } }
  for (const signal of [null, 15, 'SIGTERM']) expect(core.normalizeAgentContinuityOperation({ ...operation,
    supervision: { ...operation.supervision, process: { ...operation.supervision.process, exitSignal: signal } } }).supervision.process.exitSignal).toBe(signal)
  for (const signal of [{}, [], 1.5]) expect(() => core.normalizeAgentContinuityOperation({ ...operation,
    supervision: { ...operation.supervision, process: { ...operation.supervision.process, exitSignal: signal } } })).toThrow(TypeError)
  expect(() => core.normalizeAgentContinuityOperation({ ...operation, nativeTarget: { ...operation.nativeTarget, sessionId: '' } })).toThrow(TypeError)
  expect(() => core.normalizeAgentContinuityOperation({ ...operation, supervision: { ...operation.supervision,
    process: { ...operation.supervision.process, run: { runId: '' } } } })).toThrow(TypeError)
})
async function fixture(exitMode: 'immediate' | 'deferred' = 'immediate', options: { code?: number; signal?: boolean; alwaysFail?: boolean; delayMs?: number; handshake?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'adr-')))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
  const runtime = join(root, 'r'), state = join(root, 's')
  await mkdir(runtime); await mkdir(state)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const daemon = spawn(resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonError = ''; daemon.stderr!.on('data', bytes => { daemonError += String(bytes) })
  cleanups.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited }
    await rm(root, { recursive: true, force: true })
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(daemonError) })])
  const terminate = options.signal ? "process.kill(process.pid,'SIGTERM')" : exitMode === 'immediate'
    ? 'process.exit(' + (options.code ?? 7) + ')' : 'setImmediate(()=>{process.exitCode=' + (options.code ?? 23) + '})'
  const fail = options.delayMs ? 'setTimeout(()=>{' + terminate + '},' + options.delayMs + ')' : terminate
  const program = "const fs=require('node:fs');console.log('LAUNCH:'+JSON.stringify(process.argv.slice(1)));if(" +
    (options.alwaysFail ? 'true' : "!fs.existsSync('attempted')") + "){fs.writeFileSync('attempted','yes');" + fail +
    "}else{process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d.toString()));setInterval(()=>{},1000)}"
  const provider = core.defineAgentProvider({ catalog: { id: 'resume-process', label: 'Controlled resume process', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
    ...(options.handshake ? { terminalHandshake: { query: '\x1b[?u', response: '\x1b[?0u' } } : {}),
    buildArgs: (_prompt, args) => [...args], buildResumeArgs: (id, _path, prompt, _args) => ['-e', program, id, ...(prompt ? [prompt] : [])], hook: { rules: [] } })
  const storePath = join(root, 'sessions.sqlite'), clients: Array<any> = []
  async function reader() {
    const store = new core.AgentMuxFileAgentSessionStore(storePath), client = new core.AgentMuxClient({ store, providers: [provider] }), inner = client as any
    Object.defineProperty(inner.hookServer, 'port', { value: 0 }); await client.connect()
    const events: any[] = []; client.onEvent((event: any) => { if (event.type === 'agent-error') events.push(event) })
    const value = { store, client, inner, events, nativeStart: inner.kernel.start.bind(inner.kernel), nativeList: inner.kernel.list.bind(inner.kernel),
      start: vi.spyOn(inner.kernel, 'start'), stop: vi.spyOn(inner.kernel, 'stop'), input: vi.spyOn(inner.kernel, 'input') }
    clients.push(value); return value
  }
  const original = await reader()
  cleanups.push(async () => {
    for (const value of clients.slice().reverse()) {
      if (value.inner.kernel.isConnected()) for (const run of await value.nativeList()) if (run.state.type === 'running') {
        try { await value.inner.kernel.stop(await value.inner.kernel.prepareStop(run.runId)) }
        catch (error) { if ((await value.inner.kernel.status(run.runId)).state.type === 'running') throw error }
      }
      await value.client.dispose()
    }
  })
  const ended = await original.nativeStart({ operationKey: 'original-seed', program: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root, env: {} })
  await vi.waitFor(async () => expect((await original.inner.kernel.status(ended.runId)).state.type).toBe('exited'), { timeout: 5000 })
  const activityAt = Date.now()
  const previous: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-session', providerId: provider.id, executorId: 'configured-resume',
    hostId: 'local', workspacePath: root, run: { runId: ended.runId }, retiredRuns: [], createdAt: activityAt, updatedAt: activityAt,
    hookBindingId: 'original-binding', hookToken: 'original-token', semanticStatus: { state: 'working', source: 'native-hook', observedAt: activityAt }, nativeHandle: { kind: 'provider', providerId: provider.id, sessionId: 'original-native' } }
  await original.store.compareAndSwap(null, previous); await original.inner.registry.load('local')
  const request: AgentMuxAgentResumeInput = { agentSessionId: previous.agentSessionId, operationId: 'original-resume', prompt: 'the frozen original task' }
  const resume = (changes: Partial<AgentMuxAgentResumeInput> = {}, owner = original) => owner.client.resumeAgent({ ...request, ...changes })
  const replay = async (session: Pick<AgentMuxAgentSession, 'run'>, owner = original) => (await owner.client.readRunReplay(session.run)).replay.map(chunk => chunk.data).join('')
  const write = async (session: AgentMuxAgentSession, owner = original) => {
    await vi.waitFor(async () => expect(await replay(session, owner)).toContain('LAUNCH:'))
    await owner.client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: 'still-working' })
    await vi.waitFor(async () => expect(await replay(session, owner)).toContain('INPUT:still-working'))
  }
  const noReplacement = (inputs = 0) => {
    expect(clients.reduce((n, value) => n + value.start.mock.calls.length, 0)).toBe(1)
    expect(clients.reduce((n, value) => n + value.input.mock.calls.length, 0)).toBe(inputs)
    for (const value of clients) expect(value.stop).not.toHaveBeenCalled()
  }
  const correlation = async () => (await original.store.loadResumeCorrelation(previous.agentSessionId, agentLifecycleOperationIdentity('resume', previous.agentSessionId, request.operationId))) ?? undefined
  const recover = (policy = {}, owner = original) => owner.client.ensureAgentContinuity({ agentSessionId: previous.agentSessionId, expectedRun: previous.run,
    operationId: 'automatic-root', trigger: 'startup', policy: { retryInitialDelayMs: 40, retryMaxDelayMs: 100, retryMaxAttempts: 3, ...policy } as any })
  return { ...original, root, previous, request, provider, reader, resume, replay, write, noReplacement, correlation, recover, program, storePath, clients }
}

it.each(['immediate', 'deferred'] as const)('supervises the original automatic intent with %s exit after a confirmed nonzero recovery exit without replaying its input', async mode => {
  const f = await fixture(mode), first = await f.recover()
  expect(first.kind).toBe('resumed')
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2), { timeout: 5000 })
  await vi.waitFor(async () => {
    const status = await f.client.statusAgent(f.previous.agentSessionId)
    expect(status.session.run).not.toEqual(first.kind === 'resumed' ? first.session.run : f.previous.run)
    expect(status.run.state).toBe('running')
  })
  const current = f.client.agentSession(f.previous.agentSessionId), root = current.continuityOperations!['automatic-root']!
  expect(current.agentSessionId).toBe(f.previous.agentSessionId); expect(current.nativeHandle).toEqual(f.previous.nativeHandle)
  expect(root.supervision).toMatchObject({ attemptCount: 2, attemptLimit: 4, phase: 'observing' })
  expect(f.start.mock.calls[0]![0].args.length).toBe(3); expect(f.start.mock.calls[1]![0].args.length).toBe(3)
  expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  await f.write(current)
})

const rootOf = (session: AgentMuxAgentSession) => session.continuityOperations!['automatic-root']!
async function phase(f: Awaited<ReturnType<typeof fixture>>, expected: string) {
  await vi.waitFor(async () => {
    const saved = await f.store.readMetadata(f.previous.agentSessionId)
    expect(saved?.continuityOperations?.['automatic-root']?.supervision?.phase,
      JSON.stringify({ supervision: saved?.continuityOperations?.['automatic-root']?.supervision, errors: f.events.map(event => event.code) })).toBe(expected)
  })
  return rootOf((await f.store.readMetadata(f.previous.agentSessionId))!)
}
async function rootUpdate(f: Awaited<ReturnType<typeof fixture>>, change: (root: any, session: any) => any) {
  const old = (await f.store.readMetadata(f.previous.agentSessionId))!
  return await f.inner.registry.update(old.agentSessionId, old.run, (session: any) => {
    const root = session.continuityOperations['automatic-root'], updated = change(root, session)
    return { ...session, continuityOperations: { ...session.continuityOperations, 'automatic-root': updated },
      ...(session.continuity?.operationId === 'automatic-root' ? { continuity: updated } : {}) }
  }).then((updated: any) => { f.inner.publishSession(updated); return updated })
}

it('settles normal zero exit without another native Start', async () => {
  const f = await fixture('immediate', { code: 0 }); await f.recover()
  expect((await phase(f, 'settled')).supervision!.reason).toBe('normal-exit')
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})
it('observes a later exact Native exit even when no terminal consumer is attached', async () => {
  const f = await fixture('immediate', { delayMs: 150 }); await f.recover()
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2))
  expect(rootOf((await f.store.readMetadata(f.previous.agentSessionId))!).supervision!.attemptCount).toBe(2)
  expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})
it.each(['unavailable Runtime', 'foreign Run'] as const)('explicit refresh reobserves %s without changing its frozen budget', async cause => {
  const f = await fixture(); await f.recover({ recheckIntervalMs: 10, recheckMaxAttempts: 2 })
  await vi.waitFor(async () => expect(rootOf((await f.store.readMetadata(f.previous.agentSessionId))!).supervision).toMatchObject({ attemptCount: 2, process: { state: 'running' } }))
  const current = (await f.store.readMetadata(f.previous.agentSessionId))!, actualStatus = f.inner.kernel.status.bind(f.inner.kernel)
  const status = vi.spyOn(f.inner.kernel, 'status').mockImplementation(async (id: string) => {
    if (id === current.run.runId) {
      if (cause === 'foreign Run') return await actualStatus(f.previous.run.runId)
      throw new core.AgentMuxError('Original runtime observation cause', 'CONTROL_UNAVAILABLE')
    }
    return await actualStatus(id)
  })
  await f.client.refreshAgentSession(current.agentSessionId)
  const uncertain = await phase(f, 'paused')
  expect(uncertain.supervision, JSON.stringify(uncertain.supervision)).toMatchObject({ reason: 'runtime-unverified', attemptCount: 2, attemptLimit: 4,
    observationError: { code: cause === 'foreign Run' ? 'AGENT_SESSION_RUN_MISMATCH' : 'CONTROL_UNAVAILABLE' } })
  if (cause === 'unavailable Runtime') expect(uncertain.supervision!.observationError!.message).toBe('Original runtime observation cause')
  status.mockRestore()
  await f.client.refreshAgentSession(current.agentSessionId)
  await phase(f, 'observing')
  expect(f.start).toHaveBeenCalledTimes(2); await f.write(f.client.agentSession(current.agentSessionId))
})
it('keeps the exact observer failure cause and healthy Native capability after its bounded observation budget', async () => {
  const f = await fixture(), actualWatch = f.inner.kernel.observeLifecycle.bind(f.inner.kernel)
  let fail: ((error: any) => void) | undefined
  vi.spyOn(f.inner.kernel, 'observeLifecycle').mockImplementation(async (run: any, changed: any) => {
    fail = changed; return await actualWatch(run, changed)
  })
  await f.recover({ recheckMaxAttempts: 1 })
  await vi.waitFor(async () => expect(rootOf((await f.store.readMetadata(f.previous.agentSessionId))!).supervision).toMatchObject({ attemptCount: 2, process: { state: 'running' } }))
  const current = (await f.store.readMetadata(f.previous.agentSessionId))!
  fail!(new core.AgentMuxError('Original exact observer cause', 'CONTROL_UNAVAILABLE'))
  const root = await phase(f, 'paused')
  expect(root.supervision).toMatchObject({ reason: 'runtime-unverified', observationError: { code: 'CONTROL_UNAVAILABLE', message: 'Original exact observer cause' } })
  expect(f.events.some(event => event.evidence?.run?.runId === current.run.runId && event.message.includes('Original exact observer cause'))).toBe(true)
  expect((await f.inner.kernel.status(current.run.runId)).state.type).toBe('running')
  await f.write(f.client.agentSession(current.agentSessionId)); expect(f.start).toHaveBeenCalledTimes(2); expect(f.stop).not.toHaveBeenCalled()
})
it('dispose cancels a never-replying status observation and ignores its late result without changing the original Run', async () => {
  const f = await fixture(); await f.recover()
  await vi.waitFor(async () => expect(rootOf((await f.store.readMetadata(f.previous.agentSessionId))!).supervision).toMatchObject({ attemptCount: 2, process: { state: 'running' } }))
  const current = (await f.store.readMetadata(f.previous.agentSessionId))!, actual = await f.inner.kernel.status(current.run.runId)
  let entered!: () => void, release!: (run: any) => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), status = new Promise(resolve => { release = resolve })
  vi.spyOn(f.inner.kernel, 'status').mockImplementation(() => { entered(); return status })
  await f.client.refreshAgentSession(current.agentSessionId); await waiting
  const before = await f.store.readMetadata(current.agentSessionId), writes = vi.spyOn(f.store, 'compareAndSwapMetadata')
  let disposed = false
  void f.client.dispose().then(() => { disposed = true })
  let completedWrites = 0
  try { await vi.waitFor(() => expect(disposed).toBe(true)); completedWrites = writes.mock.calls.length }
  finally { release(actual) }
  await Promise.resolve(); await Promise.resolve()
  expect(await f.store.readMetadata(current.agentSessionId)).toEqual(before)
  expect(writes).toHaveBeenCalledTimes(completedWrites); expect(f.start).toHaveBeenCalledTimes(2); expect(f.stop).not.toHaveBeenCalled()
  const reader = await f.reader(); await f.write(current, reader)
})
it('keeps signal-only termination unknown rather than inferring a nonzero crash', async () => {
  const f = await fixture('immediate', { signal: true, delayMs: 50 }), first = await f.recover()
  expect(first.kind).toBe('resumed')
  await vi.waitFor(async () => expect((await f.inner.kernel.status(first.kind === 'resumed' ? first.session.run.runId : '')).state.type).toBe('exited'))
  const root = await phase(f, 'paused')
  expect(root.supervision!.reason).toBe('exit-outcome-unverified'); expect(f.start).toHaveBeenCalledTimes(1)
  const run = await f.inner.kernel.status(f.client.agentSession(f.previous.agentSessionId).run.runId)
  expect(run.state.type).toBe('exited'); expect(run.state.signal).not.toBeNull()
})
it('pauses at the frozen total attempt limit without resetting input or policy', async () => {
  const f = await fixture('immediate', { alwaysFail: true }); await f.recover({ retryInitialDelayMs: 10, retryMaxDelayMs: 40, retryMaxAttempts: 2 })
  const root = await phase(f, 'paused')
  expect(root.supervision).toMatchObject({ attemptCount: 3, attemptLimit: 3, reason: 'retry-budget-exhausted' })
  expect(root.policy.retryMaxAttempts).toBe(2); expect(f.start).toHaveBeenCalledTimes(3)
  expect(root.launchInput).toBeUndefined(); expect(root.recoveryInputs).toEqual({ reminder: '', continuation: '' }); expect(f.start.mock.calls.slice(1).every((call: any[]) => call[0].args.length === 3)).toBe(true)
  expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})
it('freezes deterministic backoff before dispatch and keeps its original schedule on read-only refresh', async () => {
  const f = await fixture(); await f.recover({ retryInitialDelayMs: 1200, retryMaxDelayMs: 1200 })
  const root = await phase(f, 'retry-wait'), next = root.supervision!.nextAttemptAt!
  expect(root.supervision!.attemptCount).toBe(1); expect(next - root.supervision!.observedAt).toBeGreaterThanOrEqual(1200)
  expect(next - root.supervision!.observedAt).toBeLessThanOrEqual(1500)
  await f.client.refreshAgentSession(f.previous.agentSessionId)
  expect(rootOf((await f.store.readMetadata(f.previous.agentSessionId))!).supervision!.nextAttemptAt).toBe(next)
  expect(f.start).toHaveBeenCalledTimes(1)
})
it('reconciles the unknown original Start before allocating any later attempt', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new core.AgentMuxError('Original Start unknown', 'CONTROL_UNAVAILABLE', undefined, { disposition: 'unknown', confirmedInputBytes: null }))
  const first = await f.recover({ recheckIntervalMs: 10, recheckMaxAttempts: 2 })
  expect(first.kind).toBe('pending')
  const root = await phase(f, 'paused')
  expect(root.supervision).toMatchObject({ attemptCount: 1, reason: 'original-operation-unconfirmed' })
  expect(f.start).toHaveBeenCalledTimes(1); expect(await f.correlation()).toBeUndefined()
  expect(await f.store.readLifecycleReservation(f.previous.agentSessionId)).toMatchObject({ kind: 'resume', preparedSession: { continuity: { operationId: 'automatic-root' } } })
  expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})
it('two Core observers and timers converge on one deterministic later attempt', async () => {
  const f = await fixture()
  await f.recover({ retryInitialDelayMs: 300, retryMaxDelayMs: 300 })
  await phase(f, 'retry-wait')
  const second = await f.reader()
  await vi.waitFor(async () => {
    const canonical = (await f.store.readMetadata(f.previous.agentSessionId))!
    expect(rootOf(canonical).supervision!.attemptCount, JSON.stringify({ canonical, events: f.clients.map(client => client.events) })).toBe(2)
    expect((await f.inner.kernel.status(canonical.run.runId)).state.type).toBe('running')
  })
  expect(f.clients.reduce((count: number, client: any) => count + client.start.mock.calls.length, 0)).toBe(2)
  expect(f.clients.reduce((count: number, client: any) => count + client.input.mock.calls.length, 0)).toBe(0)
})
it('a canonical Store binding protects a healthy Native Run from an earlier Core observer cache', async () => {
  const f = await fixture(), stale = await f.reader()
  await f.recover()
  await vi.waitFor(async () => expect(rootOf((await f.store.readMetadata(f.previous.agentSessionId))!).supervision).toMatchObject({ attemptCount: 2, process: { state: 'running' } }))
  const canonical = (await f.store.readMetadata(f.previous.agentSessionId))!
  expect(stale.client.agentSession(canonical.agentSessionId).run).toEqual(f.previous.run)
  stale.inner.continuitySupervisor.observe(canonical)
  await stale.inner.continuitySupervisor.tails.get(canonical.agentSessionId)
  const observed = rootOf((await f.store.readMetadata(canonical.agentSessionId))!).supervision!
  expect(observed.process?.state).toBe('running')
  expect(observed).toMatchObject({ phase: 'observing', process: { run: canonical.run } })
  expect((await stale.inner.kernel.status(canonical.run.runId)).state.type).toBe('running')
  expect(stale.start).not.toHaveBeenCalled(); expect(stale.stop).not.toHaveBeenCalled(); expect(stale.input).not.toHaveBeenCalled()
})
it('verified exact cancellation wins before the same recovery Run later exits nonzero', async () => {
  const f = await fixture('immediate', { delayMs: 200 }); await f.recover()
  await rootUpdate(f, (root, session) => ({ ...root, supervision: { ...root.supervision,
    cancellation: { source: 'native-hook', operationId: 'verified-cancellation', run: session.run, nativeTarget: session.nativeHandle, observedAt: Date.now() } } }))
  expect((await phase(f, 'cancelled')).supervision!.reason).toBe('explicit-cancellation')
  await vi.waitFor(async () => expect((await f.inner.kernel.status(f.client.agentSession(f.previous.agentSessionId).run.runId)).state).toMatchObject({ type: 'exited', code: 7 }))
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})
it('a stale cancellation does not authorize cancelling the current recovery intent', async () => {
  const f = await fixture('immediate', { delayMs: 150 }); await f.recover()
  await rootUpdate(f, root => ({ ...root, supervision: { ...root.supervision,
    cancellation: { source: 'native-hook', operationId: 'old-cancellation', run: f.previous.run, nativeTarget: f.previous.nativeHandle, observedAt: Date.now() } } }))
  await vi.waitFor(async () => expect(f.start).toHaveBeenCalledTimes(2))
  expect(rootOf((await f.store.readMetadata(f.previous.agentSessionId))!).supervision!.phase).not.toBe('cancelled')
})
it('pending durable Stop prevents retry after a later nonzero exit', async () => {
  const f = await fixture('immediate', { delayMs: 250 }); await f.recover()
  const session = f.client.agentSession(f.previous.agentSessionId)
  f.stop.mockRejectedValueOnce(new core.AgentMuxError('Original Stop unavailable', 'CONTROL_UNAVAILABLE'))
  await expect(f.client.stopAgent(session.agentSessionId, session.run)).rejects.toThrow()
  expect(await f.store.readLifecycleReservation(session.agentSessionId)).toMatchObject({ kind: 'stop' })
  expect((await phase(f, 'cancelled')).supervision!.reason).toBe('user-stop')
  expect(f.start).toHaveBeenCalledTimes(1)
})
it('a Stop for another Run does not cancel the current recovery intent', async () => {
  const f = await fixture('immediate', { delayMs: 150 })
  vi.spyOn(f.store, 'readLifecycleReservation').mockResolvedValue({ kind: 'stop', expectedRun: f.previous.run,
    reservationId: 'old-stop', ownerId: 'old-owner', ownerPid: process.pid, agentSessionId: f.previous.agentSessionId,
    operationId: 'old-stop', expiresAt: Number.MAX_SAFE_INTEGER, stopOperation: { daemonInstance: 'old-runtime', operationKey: 'old-stop', runId: f.previous.run.runId } } as any)
  await f.recover()
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2))
  expect(rootOf((await f.store.readMetadata(f.previous.agentSessionId))!).supervision!.phase).not.toBe('cancelled')
})
it.each(['Host', 'native target'] as const)('retains a superseded %s without authorizing another Start', async changed => {
  const f = await fixture(); await f.recover({ retryInitialDelayMs: 1200, retryMaxDelayMs: 1200 })
  await phase(f, 'retry-wait')
  const session = (await f.store.readMetadata(f.previous.agentSessionId))!
  const foreign = { ...session, ...(changed === 'Host' ? { hostId: 'another-host' } : { nativeHandle: { ...session.nativeHandle!, sessionId: 'another-native' } }), updatedAt: session.updatedAt + 1 }
  await f.store.compareAndSwapMetadata(session, foreign)
  f.inner.continuitySupervisor.wake(session.agentSessionId)
  if (changed === 'Host') await vi.waitFor(() => expect(f.events.some(event => event.code === 'AGENT_CONTINUITY_OBSERVATION_UNCONFIRMED')).toBe(true))
  else expect((await phase(f, 'paused')).supervision!.reason).toBe('original-target-changed')
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})
it('verified context completion releases its exact observer and timers while preserving the healthy Run', async () => {
  const f = await fixture(); await f.recover()
  await vi.waitFor(async () => expect(rootOf((await f.store.readMetadata(f.previous.agentSessionId))!).supervision).toMatchObject({ attemptCount: 2, process: { state: 'running' } }))
  await rootUpdate(f, (root, session) => ({ ...root, supervision: { ...root.supervision, contextEvidence: {
    source: 'native-hook', hookReceiptId: 'context-complete', run: session.run, nativeTarget: session.nativeHandle, observedAt: Date.now() } } }))
  expect((await phase(f, 'settled')).supervision!.reason).toBe('context-observed')
  await vi.waitFor(() => {
    expect(f.inner.continuitySupervisor.watches.size).toBe(0); expect(f.inner.continuitySupervisor.timers.size).toBe(0)
    expect(f.inner.continuitySupervisor.facts.size).toBe(0)
  })
  await f.write(f.client.agentSession(f.previous.agentSessionId)); expect(f.start).toHaveBeenCalledTimes(2); expect(f.stop).not.toHaveBeenCalled()
})
it('confirmed retirement preserves its original identity history and releases recovery scheduling', async () => {
  const f = await fixture(); await f.recover()
  await vi.waitFor(async () => expect(rootOf((await f.store.readMetadata(f.previous.agentSessionId))!).supervision).toMatchObject({ attemptCount: 2, process: { state: 'running' } }))
  const current = f.client.agentSession(f.previous.agentSessionId)
  await f.client.stopAgent(current.agentSessionId, current.run)
  expect(await f.store.readMetadata(current.agentSessionId)).toBeNull()
  expect(await f.store.loadRetiredAgentSessions()).toContainEqual(expect.objectContaining({ agentSessionId: current.agentSessionId, run: current.run }))
  await vi.waitFor(() => { expect(f.inner.continuitySupervisor.roots.size).toBe(0); expect(f.inner.continuitySupervisor.watches.size).toBe(0) })
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.stop).toHaveBeenCalledTimes(1)
})
it('cancellation before the atomic prepare claim prevents Start even after controller admission', async () => {
  const f = await fixture(), prepare = f.store.prepareResume.bind(f.store)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f.store, 'prepareResume').mockImplementation(async (reservation: any, session: any) => {
    if (session.continuity?.intentOperationId) { enter(); await held }
    return await prepare(reservation, session)
  })
  await f.recover(); await entered
  await rootUpdate(f, root => ({ ...root, supervision: { ...root.supervision, phase: 'cancelled', reason: 'explicit-control', observedAt: Date.now() } }))
  release(); await phase(f, 'cancelled')
  await vi.waitFor(() => expect(f.inner.pendingLifecycleBindings.size).toBe(0))
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()
})
it('cancellation after the atomic claim preserves the admitted Start and forbids another one', async () => {
  const f = await fixture(), prepare = f.store.prepareResume.bind(f.store)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f.store, 'prepareResume').mockImplementation(async (reservation: any, session: any) => {
    const result = await prepare(reservation, session)
    if (session.continuity?.intentOperationId) { enter(); await held }
    return result
  })
  await f.recover(); await entered
  await rootUpdate(f, root => ({ ...root, supervision: { ...root.supervision, phase: 'cancelled', reason: 'explicit-control', observedAt: Date.now() } }))
  release()
  await vi.waitFor(async () => expect((await f.store.readLifecycleReservation(f.previous.agentSessionId))).toBeNull())
  await phase(f, 'cancelled'); expect(f.start).toHaveBeenCalledTimes(2)
  const current = (await f.store.readMetadata(f.previous.agentSessionId))!
  expect((await f.inner.kernel.status(current.run.runId)).state.type).toBe('running'); expect(f.stop).not.toHaveBeenCalled()
})
it('a supervised fast fatal keeps its exact failed new Run while direct resume retains its rollback contract', async () => {
  const f = await fixture('immediate', { handshake: true, alwaysFail: true }), result = await f.recover({ retryMaxAttempts: 0 })
  expect(result.kind).toBe('resumed')
  const root = await phase(f, 'paused'), session = (await f.store.readMetadata(f.previous.agentSessionId))!
  expect(session.run).not.toEqual(f.previous.run); expect(root.newRun).toEqual(session.run)
  expect(root.errorCode).toBe('AGENT_TERMINAL_HANDSHAKE_FAILED'); expect(f.stop).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledTimes(1)
})

it('a new Core process resumes the durable original schedule and counter with context-only input', async () => {
  if (!process.env.AGENTMUX_TEST_CONTINUITY_SUPERVISION_ENTRY) throw new Error('This process proof requires the source-bound compiled Core gate entry.')
  const f = await fixture(); await f.recover({ retryInitialDelayMs: 1200, retryMaxDelayMs: 1200 })
  const saved = await phase(f, 'retry-wait'), nextAttemptAt = saved.supervision!.nextAttemptAt
  await f.client.dispose()
  const config = join(f.root, 'reader-config.json')
  await writeFile(config, JSON.stringify({ program: f.program, storePath: f.storePath, agentSessionId: f.previous.agentSessionId }))
  const child = spawn(process.execPath, [resolve(import.meta.dirname, 'helpers/continuity-supervision-process.mjs'), config],
    { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let errors = ''; child.stderr!.on('data', data => { errors += String(data) })
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed }
  })
  const records: any[] = []; child.on('message', message => { records.push(message) })
  await vi.waitFor(() => { expect(child.exitCode, errors).toBeNull(); expect(records.find(row => row.kind === 'connected')).toBeDefined() })
  expect(rootOf(records.find(row => row.kind === 'connected').initial).supervision).toMatchObject({ attemptCount: 1, nextAttemptAt })
  await vi.waitFor(() => { expect(child.exitCode, errors).toBeNull(); expect(records.find(row => row.kind === 'restored')).toBeDefined() }, { timeout: 6000 })
  const restored = records.find(row => row.kind === 'restored')
  expect(restored).toMatchObject({ starts: 1, inputs: 0, session: { agentSessionId: f.previous.agentSessionId, nativeHandle: f.previous.nativeHandle } })
  const reader = await f.reader(); await f.write(restored.session, reader)
  const closed = once(child, 'exit'); child.send({ kind: 'dispose' }); await closed
  expect(child.exitCode, errors).toBe(0)
})
it('existing Hosted ensure and actual inspect/refresh CLI expose original process and attempt facts', async () => {
  if (!process.env.AGENTMUX_TEST_OBJECT_CLI) throw new Error('This public proof requires the source-bound compiled CLI gate entry.')
  const f = await fixture(), hosted = new core.AgentMuxHostedRuntimeService(f.client, f.store.path, () => ({ runtimeId: 'supervision-runtime', ownerInstanceId: 'supervision-owner', protocolVersion: 2,
    processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }))
  cleanups.push(() => hosted.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const reader = await core.connectHostedAgentMux({ rpc }); cleanups.push(() => reader.dispose())
  const first = await reader.ensureAgentContinuity({ agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run,
    operationId: 'automatic-root', trigger: 'startup', policy: { retryInitialDelayMs: 40, retryMaxDelayMs: 100, retryMaxAttempts: 3 } })
  expect(first.kind).toBe('resumed')
  await vi.waitFor(async () => {
    const current = (await f.store.readMetadata(f.previous.agentSessionId))!
    expect(rootOf(current).supervision!.attemptCount).toBe(2); expect((await f.inner.kernel.status(current.run.runId)).state.type).toBe('running')
  })
  const inspected = await runCompiledObjectCli(['agent', 'inspect', '--session', f.previous.agentSessionId], objectCliEnvironment(f.root))
  expect(inspected.code, inspected.stderr).toBe(0)
  const facts = JSON.parse(inspected.stdout).result.session, root = rootOf(facts)
  expect(root.supervision, JSON.stringify(root.supervision)).toMatchObject({ attemptCount: 2, attemptLimit: 4, phase: 'observing', process: { state: 'running' } })
  expect(root.supervision!.contextEvidence).toBeUndefined(); expect(root.launchInput).toBeUndefined(); expect(root.recoveryInputs).toEqual({ reminder: '', continuation: '' })
  expect(facts.continuity.intentOperationId).toBe('automatic-root'); expect(facts.continuity.launchInput).toBeUndefined()
  const refreshed = await runCompiledObjectCli(['agent', 'refresh', '--session', f.previous.agentSessionId], objectCliEnvironment(f.root))
  expect(refreshed.code, refreshed.stderr).toBe(0); expect(rootOf(JSON.parse(refreshed.stdout).result.session).supervision!.attemptCount).toBe(2)
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})
