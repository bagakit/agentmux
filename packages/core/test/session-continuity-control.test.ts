import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as Source from '../src/index.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { agentLifecycleOperationIdentity } from '../src/agent-session-store.js'
import type { AgentMuxAgentResumeInput } from '../src/agent-session-recovery.js'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession } from '../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const core: typeof Source & Record<string, any> = process.env.AGENTMUX_TEST_CONTINUITY_CONTROL_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_CONTINUITY_CONTROL_ENTRY)
  : { ...Source, ...await import('../src/public-rpc-server.js'), ...await import('../src/hosted-runtime-service.js') }
if (process.env.AGENTMUX_TEST_CONTINUITY_CONTROL_MUTANT) expect(Reflect.get(core, 'AGENTMUX_CONTINUITY_CONTROL_MUTANT')).toBe(process.env.AGENTMUX_TEST_CONTINUITY_CONTROL_MUTANT)
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
  const previous: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-session', providerId: provider.id, executorId: 'configured-resume',
    hostId: 'local', workspacePath: root, run: { runId: ended.runId }, retiredRuns: [], createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1),
    hookBindingId: 'original-binding', hookToken: 'original-token', semanticStatus: { state: 'working', source: 'native-hook', observedAt: _historyFixtureEpoch(0, 0, 1) }, nativeHandle: { kind: 'provider', providerId: provider.id, sessionId: 'original-native' } }
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


const saved = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.store.readMetadata(f.previous.agentSessionId))!
const rootOf = (session: AgentMuxAgentSession) => session.continuityOperations!['automatic-root']!
async function paused(f: Awaited<ReturnType<typeof fixture>>) {
  await vi.waitFor(async () => expect(rootOf(await saved(f)).supervision?.phase).toBe('paused'))
  return await saved(f)
}
async function runningAfter(f: Awaited<ReturnType<typeof fixture>>, previousRun: { runId: string }) {
  await vi.waitFor(async () => {
    const current = await saved(f)
    expect(current.run.runId).not.toBe(previousRun.runId)
    expect(f.client.agentSession(current.agentSessionId).run).toEqual(current.run)
    expect((await f.inner.kernel.status(current.run.runId)).state.type).toBe('running')
  })
}
async function packet(f: Awaited<ReturnType<typeof fixture>>, operationId: string, action: 'continue' | 'cancel' = 'cancel', additionalAttempts = 1) {
  return { agentSessionId: f.previous.agentSessionId, intentOperationId: 'automatic-root', expectedRun: (await saved(f)).run,
    operationId, action, ...(action === 'continue' ? { additionalAttempts } : {}) } as any
}

it('requires an explicit positive continuation budget and a strict immutable packet', () => {
  const base = { agentSessionId: 'session', intentOperationId: 'root', expectedRun: { runId: 'run' }, operationId: 'control' }
  expect(core.parseAgentContinuityControlInput({ ...base, action: 'continue', additionalAttempts: 1 })).toMatchObject({ additionalAttempts: 1 })
  expect(core.parseAgentContinuityControlInput({ ...base, action: 'cancel' })).toMatchObject({ action: 'cancel' })
  for (const additionalAttempts of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() =>
    core.parseAgentContinuityControlInput({ ...base, action: 'continue', additionalAttempts })).toThrow()
  for (const bad of [{ action: 'cancel', additionalAttempts: 1 }, { action: 'cancel', caller: {} }, { action: 'continue', additionalAttempts: 1, expectedRun: { runId: 'run', hostId: 'foreign' } }]) {
    expect(() => core.parseAgentContinuityControlInput({ ...base, ...bad })).toThrow()
  }
})

it('rejects a control receipt with coerced enums or contradictory admission facts', () => {
  const request = { agentSessionId: 'session', intentOperationId: 'root', expectedRun: { runId: 'run' }, operationId: 'control', action: 'cancel' }
  const receipt = { request, outcome: 'unchanged', reason: 'already-settled', activeAttemptOperationId: 'attempt',
    attemptCount: 1, attemptLimitBefore: 1, attemptLimitAfter: 1, phaseAtCommit: 'settled', observedAt: _historyFixtureEpoch(0, 0, 1) }
  expect(core.parseAgentContinuityControlReceipt(receipt)).toEqual(receipt)
  for (const change of [{ outcome: ['unchanged'] }, { reason: ['already-settled'] }, { phaseAtCommit: ['settled'] },
    { attemptCount: 2 }, { reason: 'already-active' }, { reason: 'already-cancelled' },
    { request: { ...request, action: 'continue', additionalAttempts: 1 } }]) {
    expect(() => core.parseAgentContinuityControlReceipt({ ...receipt, ...change })).toThrow()
  }
})

it('continues a zero-budget paused intent with one new context-only attempt and one immutable receipt', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); const original = await paused(f)
  const request = await packet(f, 'continue-once', 'continue'), before = rootOf(original)
  const operation = f.client.controlAgentContinuity(request)
  await expect(operation).resolves.toMatchObject({ state: 'active', receipt: { outcome: 'continued', attemptCount: 1,
    attemptLimitBefore: 1, attemptLimitAfter: 2, request } })
  const receipt = (await operation).receipt
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2))
  await runningAfter(f, original.run)
  const current = await saved(f), root = rootOf(current)
  expect(root.supervision).toMatchObject({ attemptCount: 2, attemptLimit: 2, controlOperations: { 'continue-once': receipt } })
  expect(root.policy).toEqual(before.policy); expect(root.launchInput).toEqual(before.launchInput)
  expect(root.previousInput).toEqual(before.previousInput); expect(current.nativeHandle).toEqual(original.nativeHandle)
  expect(f.start.mock.calls[1]![0]).toHaveProperty('args.length', 3); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  await expect(f.client.controlAgentContinuity(request)).resolves.toMatchObject({ receipt })
  expect(rootOf(await saved(f)).supervision!.attemptLimit).toBe(2)
  await f.write(f.client.agentSession(current.agentSessionId))
})

it('rejects changed action budget root and Run for an accepted operation while preserving its original result', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); await paused(f)
  const request = await packet(f, 'immutable'), result = await f.client.controlAgentContinuity(request)
  for (const change of [{ action: 'continue', additionalAttempts: 1 }, { intentOperationId: 'another-root' }, { expectedRun: f.previous.run }]) {
    await expect(f.client.controlAgentContinuity({ ...request, ...change } as any)).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_CONTROL_CONFLICT' })
  }
  await expect(f.client.controlAgentContinuity(request)).resolves.toMatchObject({ receipt: result.receipt })
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})

it('accepts retained canonical locator enrichment while rejecting changed or lost known native targets', async () => {
  const f = await fixture('immediate', { alwaysFail: true }); await f.recover({ retryMaxAttempts: 1 }); const original = await paused(f)
  const nativeHandle = { kind: 'provider' as const, providerId: f.provider.id, sessionId: 'original-native', transcriptPath: join(f.root, 'canonical-native.json') }
  await f.store.compareAndSwapMetadata(original, { ...original, nativeHandle })
  const request = await packet(f, 'enriched-control'), operation = f.client.controlAgentContinuity(request)
  await expect(operation).resolves.toMatchObject({ receipt: { outcome: 'cancelled' } })
  const receipt = (await operation).receipt, canonical = await saved(f), root = rootOf(canonical)
  const active = canonical.continuityOperations![root.supervision!.activeAttemptOperationId]!
  await f.store.compareAndSwapMetadata(canonical, { ...canonical, continuityOperations: {
    ...canonical.continuityOperations, [active.operationId]: { ...active, nativeTarget: nativeHandle } } })
  for (const changed of [{ ...nativeHandle, transcriptPath: join(f.root, 'another-native.json') },
    { kind: 'provider' as const, providerId: f.provider.id, sessionId: nativeHandle.sessionId },
    { ...nativeHandle, sessionId: 'another-native' }]) {
    const current = await saved(f)
    await f.store.compareAndSwapMetadata(current, { ...current, nativeHandle: changed })
    await expect(f.client.controlAgentContinuity({ ...request, operationId: 'new-target-control' })).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
  }
  const latest = await saved(f)
  await expect(f.store.compareAndSwapMetadata(latest, { ...latest, nativeHandle: { ...nativeHandle, providerId: 'another-provider' } })).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
  await expect(f.client.controlAgentContinuity(request)).resolves.toMatchObject({ receipt })
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})

it('cancels before the original prepare claim without waiting behind its Start reader', async () => {
  const f = await fixture(), prepare = f.store.prepareResume.bind(f.store)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f.store, 'prepareResume').mockImplementation(async (reservation: any, session: any) => { enter(); await held; return await prepare(reservation, session) })
  const recovery = f.recover(); await entered
  try {
    await expect(f.client.controlAgentContinuity(await packet(f, 'cancel-before-claim'))).resolves.toMatchObject({ receipt: { outcome: 'cancelled' } })
  } finally { release() }
  await recovery
  await vi.waitFor(async () => expect(await f.store.readLifecycleReservation(f.previous.agentSessionId)).toBeNull())
  expect(rootOf(await saved(f)).supervision?.phase).toBe('cancelled'); expect(f.start).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})

it('cancel after claim preserves the healthy admitted Run and its receipt through late original commit', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'attempted'), 'yes')
  const prepare = f.store.prepareResume.bind(f.store); let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f.store, 'prepareResume').mockImplementation(async (reservation: any, session: any) => { const result = await prepare(reservation, session); enter(); await held; return result })
  const recovery = f.recover(); await entered
  const request = await packet(f, 'cancel-after-claim')
  let accepted: any
  try { accepted = await f.client.controlAgentContinuity(request); expect(accepted.receipt.outcome).toBe('cancelled') } finally { release() }
  await recovery
  await expect(f.client.controlAgentContinuity(request)).resolves.toMatchObject({ receipt: accepted.receipt })
  const session = await saved(f)
  expect(rootOf(session).supervision).toMatchObject({ phase: 'cancelled', controlOperations: { 'cancel-after-claim': accepted.receipt } })
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled(); await f.write(f.client.agentSession(session.agentSessionId))
})

it('reconciles only the original unknown Start after cancellation without replaying its launch-carried input', async () => {
  const f = await fixture(); await writeFile(join(f.root, 'attempted'), 'yes')
  f.start.mockImplementationOnce(async (...args: any[]) => { await f.nativeStart(...args); throw new core.AgentMuxError('Controlled original Start ACK loss', 'AGENT_RESUME_UNCONFIRMED', undefined, { disposition: 'unknown', confirmedInputBytes: null }) })
  const first = await f.recover(); expect(first.kind).toBe('pending')
  const request = await packet(f, 'cancel-unknown'), result = await f.client.controlAgentContinuity(request)
  const reconcile = f.recover()
  await expect(reconcile).resolves.toMatchObject({ kind: 'resumed' })
  await expect(f.client.controlAgentContinuity(request)).resolves.toMatchObject({ receipt: result.receipt })
  expect(rootOf(await saved(f)).supervision?.phase).toBe('cancelled'); expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('recovers an applied control CAS acknowledgement without changing its original budget again', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); await paused(f)
  const request = await packet(f, 'lost-control-ack', 'continue'), commit = f.store.compareAndSwapMetadata.bind(f.store)
  vi.spyOn(f.store, 'compareAndSwapMetadata').mockImplementationOnce(async (...args: Parameters<typeof commit>) => { await commit(...args); throw new Error('Controlled applied control ACK loss') })
  const result = await f.client.controlAgentContinuity(request)
  expect(result.receipt).toMatchObject({ outcome: 'continued', attemptLimitAfter: 2 })
  await expect(f.client.controlAgentContinuity(request)).resolves.toMatchObject({ receipt: result.receipt })
  expect(rootOf(await saved(f)).supervision?.attemptLimit).toBe(2)
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2))
})

it('admits one explicit budget across independent FileStore Core readers', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); await paused(f)
  const other = await f.reader(), request = await packet(f, 'two-readers', 'continue')
  const results = await Promise.all([f.client.controlAgentContinuity(request), other.client.controlAgentContinuity(request)])
  expect(results[0].receipt).toEqual(results[1].receipt)
  expect(rootOf(await saved(f)).supervision?.attemptLimit).toBe(2)
  await vi.waitFor(() => expect(f.clients.reduce((sum, reader) => sum + reader.start.mock.calls.length, 0)).toBe(2))
  expect(f.clients.reduce((sum, reader) => sum + reader.input.mock.calls.length, 0)).toBe(0)
})

it('keeps cancelled and normally settled intents closed to new continuation controls', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); await paused(f)
  await f.client.controlAgentContinuity(await packet(f, 'cancel-close'))
  await expect(f.client.controlAgentContinuity(await packet(f, 'late-continue', 'continue'))).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
  expect(rootOf(await saved(f)).supervision?.phase).toBe('cancelled'); expect(f.start).toHaveBeenCalledTimes(1)
})

it('preserves a control receipt after authoritative Stop and through a fresh FileStore reader', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); await paused(f)
  const request = await packet(f, 'retained-control'), result = await f.client.controlAgentContinuity(request)
  await f.client.stopAgent(f.previous.agentSessionId, request.expectedRun)
  expect(await f.store.readMetadata(f.previous.agentSessionId)).toBeNull()
  const other = await f.reader()
  await expect(other.client.controlAgentContinuity(request)).resolves.toMatchObject({ state: 'retired', receipt: result.receipt,
    retirement: { agentSessionId: f.previous.agentSessionId, source: 'user' } })
  await expect(other.client.controlAgentContinuity({ ...request, operationId: 'new-after-retirement' })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  expect(other.start).not.toHaveBeenCalled(); expect(other.input).not.toHaveBeenCalled()
})

it('retains an original control receipt across an explicitly authorized native reopen without reviving its intent', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); await paused(f)
  const request = await packet(f, 'control-before-reopen'), accepted = await f.client.controlAgentContinuity(request)
  await f.client.stopAgent(f.previous.agentSessionId, request.expectedRun)
  const retired = await f.store.readContinuityControlReceipt(request.agentSessionId, request.operationId)
  const reopened = f.client.reopenAgent({ agentSessionId: request.agentSessionId,
    expectedRetiredAt: retired!.retirement!.observedAt, operationId: 'separate-explicit-reopen' })
  await expect(reopened).resolves.toMatchObject({ agentSessionId: request.agentSessionId,
    nativeHandle: f.previous.nativeHandle, continuityControlReceipts: { [request.operationId]: accepted.receipt } })
  const current = await reopened
  expect(current.continuityOperations?.[request.intentOperationId]).toBeUndefined()
  const other = await f.reader()
  await expect(other.client.controlAgentContinuity(request)).resolves.toMatchObject({ state: 'active', receipt: accepted.receipt })
  expect(other.start).not.toHaveBeenCalled(); expect(other.input).not.toHaveBeenCalled()
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.input).not.toHaveBeenCalled()
  await f.write(current)
})

it('rejects a pending exact Stop and an overflowing continuation budget without starting a Run', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); await paused(f)
  const request = await packet(f, 'pending-stop', 'continue'), lifecycle = await f.inner.registry.reserveExisting('stop', f.previous.agentSessionId, request.expectedRun, 'pending-exact-stop', await f.inner.kernel.prepareStop(request.expectedRun.runId))
  try { await expect(f.client.controlAgentContinuity(request)).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' }) }
  finally { await f.inner.registry.releaseLifecycle(lifecycle) }
  await expect(f.client.controlAgentContinuity({ ...request, operationId: 'overflow', additionalAttempts: Number.MAX_SAFE_INTEGER })).rejects.toMatchObject({ code: 'INVALID_AGENT_CONTINUITY_CONTROL' })
  expect(rootOf(await saved(f)).supervision?.attemptLimit).toBe(1); expect(f.start).toHaveBeenCalledTimes(1)
})

it('keeps a normally completed intent settled after explicit continuation', async () => {
  const f = await fixture('immediate', { code: 0 }); await f.recover()
  await vi.waitFor(async () => expect(rootOf(await saved(f)).supervision?.phase).toBe('settled'))
  await expect(f.client.controlAgentContinuity(await packet(f, 'zero-continue', 'continue'))).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled()
})

it('keeps healthy raw capability while Hosted and the actual public CLI consume the same control owner', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); await paused(f)
  const hosted = new core.AgentMuxHostedRuntimeService(f.client, f.storePath, () => ({ runtimeId: 'private-control-owner', ownerInstanceId: 'private-control-instance',
    protocolVersion: 2, processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }))
  cleanups.push(() => hosted.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const reader = await core.connectHostedAgentMux({ rpc }); cleanups.push(() => reader.dispose())
  const request = await packet(f, 'public-continue', 'continue'), control = vi.spyOn(f.client, 'controlAgentContinuity')
  await expect(reader.controlAgentContinuity(request)).resolves.toMatchObject({ receipt: { request, outcome: 'continued' } })
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2))
  await runningAfter(f, request.expectedRun)
  const input = join(f.root, 'control.json'); await writeFile(input, JSON.stringify(request))
  const cli = await runCompiledObjectCli(['agent', 'continuity', 'control', '--input', input], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, operation: 'agent.continuity.control', result: { receipt: { request, outcome: 'continued' } } })
  expect(control).toHaveBeenCalledTimes(2)
  const activeControl = await packet(f, 'already-running', 'continue', 5)
  await expect(reader.controlAgentContinuity(activeControl)).resolves.toMatchObject({ receipt: { outcome: 'unchanged', attemptLimitAfter: 2 } })
  const cancel = await packet(f, 'public-cancel'); await writeFile(input, JSON.stringify(cancel))
  const cancelled = await runCompiledObjectCli(['agent', 'continuity', 'control', '--input', input], objectCliEnvironment(f.root))
  expect(cancelled.code, cancelled.stderr).toBe(0); expect(JSON.parse(cancelled.stdout).result.receipt).toMatchObject({ outcome: 'cancelled' })
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.stop).not.toHaveBeenCalled(); await f.write(f.client.agentSession(f.previous.agentSessionId))
  for (const args of [['--help'], ['agent', '--help'], ['agent', 'continuity', '--help'], ['agent', 'continuity', 'control', '--help'], ['agent', '--skill']]) {
    const help = await runCompiledObjectCli(args, objectCliEnvironment(f.root)); expect(help.code, help.stderr).toBe(0)
    expect(help.stdout).toContain(args.includes('--skill') ? 'additionalAttempts' : 'continuity')
  }
  await f.client.stopAgent(f.previous.agentSessionId, cancel.expectedRun)
  const retired = await runCompiledObjectCli(['agent', 'continuity', 'control', '--input', input], objectCliEnvironment(f.root))
  expect(retired.code, retired.stderr).toBe(0); expect(JSON.parse(retired.stdout).result).toMatchObject({ state: 'retired', receipt: { request: cancel } })
})

it('rejects a wire reply for another immutable control packet', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); await paused(f)
  const request = await packet(f, 'codec'), accepted = await f.client.controlAgentContinuity(request)
  const { ObjectCliProbe } = await import('./helpers/object-cli-rpc.js')
  const probe = new ObjectCliProbe(() => ({ ...accepted, receipt: { ...accepted.receipt, request: { ...request, operationId: 'foreign-control' } } }))
  await probe.start(); cleanups.push(() => probe.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: probe.socketPath } }); cleanups.push(() => rpc.dispose())
  await expect(rpc.call('agent.continuity.control', request)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled()
})

it('Hosted cancellation works without Native readiness and reader disposal does not cancel the durable intent', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); await paused(f)
  const hosted = new core.AgentMuxHostedRuntimeService(f.client, f.storePath, () => ({ runtimeId: 'private-offline-owner', ownerInstanceId: 'private-offline-instance',
    protocolVersion: 2, processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }))
  cleanups.push(() => hosted.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const reader = await core.connectHostedAgentMux({ rpc });
  vi.spyOn(f.client, 'connect').mockRejectedValue(new Error('Controlled Native readiness unavailable'))
  await expect(reader.controlAgentContinuity(await packet(f, 'offline-cancel'))).resolves.toMatchObject({ receipt: { outcome: 'cancelled' } })
  await reader.dispose(); expect(rootOf(await saved(f)).supervision?.phase).toBe('cancelled')
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled()
})

it('does not infer absent Stop from a failed lifecycle observation', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); await paused(f)
  const request = await packet(f, 'unreadable-stop', 'continue')
  vi.spyOn(f.store, 'readLifecycleReservation').mockRejectedValueOnce(new Error('Exact lifecycle observation failed'))
  await expect(f.client.controlAgentContinuity(request)).rejects.toThrow('Exact lifecycle observation failed')
  expect(rootOf(await saved(f)).supervision?.controlOperations?.[request.operationId]).toBeUndefined()
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled()
})

it('transport reader cancellation retains the accepted original control for exact public reconciliation', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); await paused(f)
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const request = await packet(f, 'unknown-public-receipt'), original = f.client.controlAgentContinuity.bind(f.client)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f.client, 'controlAgentContinuity').mockImplementationOnce(async (input: any, context: any) => { const result = await original(input, context); enter(); await held; return result })
  const reader = new AbortController(), pending = rpc.call('agent.continuity.control', request, { signal: reader.signal })
  await entered; reader.abort()
  await expect(pending).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' }); release()
  const accepted = rootOf(await saved(f)).supervision!.controlOperations![request.operationId]
  await expect(rpc.call('agent.continuity.control', request)).resolves.toMatchObject({ receipt: accepted })
  expect(rootOf(await saved(f)).supervision?.phase).toBe('cancelled'); expect(f.start).toHaveBeenCalledTimes(1)
})

it('a new Core process reads the exact retired control without connecting to or resuming Native', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); await paused(f)
  const request = await packet(f, 'cross-process-retired'), accepted = await f.client.controlAgentContinuity(request)
  await f.client.stopAgent(f.previous.agentSessionId, request.expectedRun)
  const config = join(f.root, 'retired-control.json'), { pathToFileURL } = await import('node:url')
  await writeFile(config, JSON.stringify({ request, storePath: f.storePath,
    entry: process.env.AGENTMUX_TEST_CONTINUITY_CONTROL_ENTRY ?? pathToFileURL(resolve(import.meta.dirname, '../dist/index.js')).href }))
  const child = spawn(process.execPath, [resolve(import.meta.dirname, 'helpers/continuity-control-process.mjs'), config], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout!.on('data', data => { stdout += data }); child.stderr!.on('data', data => { stderr += data })
  const [code] = await once(child, 'exit'); expect(code, stderr).toBe(0)
  expect(JSON.parse(stdout)).toMatchObject({ state: 'retired', receipt: accepted.receipt })
  expect(f.start).toHaveBeenCalledTimes(1)
})

it('extends the original total limit without resetting attempts after multiple confirmed failures', async () => {
  const f = await fixture('immediate', { alwaysFail: true }); await f.recover({ retryMaxAttempts: 1 }); await paused(f)
  expect(rootOf(await saved(f)).supervision).toMatchObject({ attemptCount: 2, attemptLimit: 2 })
  const request = await packet(f, 'extend-total', 'continue'), operation = f.client.controlAgentContinuity(request)
  await expect(operation).resolves.toMatchObject({ receipt: { attemptCount: 2, attemptLimitBefore: 2, attemptLimitAfter: 3 } })
  const result = await operation
  expect(result.state === 'active' && rootOf(result.session).supervision?.attemptCount).toBe(2)
  await paused(f)
  expect(rootOf(await saved(f)).supervision).toMatchObject({ attemptCount: 3, attemptLimit: 3 })
  expect(f.start).toHaveBeenCalledTimes(3); expect(f.input).not.toHaveBeenCalled()
})

it('managed business control does not grant full Runtime SDK or foreign Host authority', async () => {
  const f = await fixture(); await f.recover({ retryMaxAttempts: 0 }); const original = await paused(f)
  const { createHash } = await import('node:crypto'), capability = 'private-controlled-author-capability'
  await f.store.compareAndSwapMetadata(original, { ...original, capabilityHash: createHash('sha256').update(capability).digest('base64url') })
  await f.inner.registry.refresh(f.previous.agentSessionId)
  const foreign = Object.assign(Object.create(f.client), { agentSessions: () => [{ ...f.client.agentSession(f.previous.agentSessionId), agentSessionId: 'foreign-session', hostId: 'foreign' }],
    readAgentSessions: async () => [{ ...f.client.agentSession(f.previous.agentSessionId), agentSessionId: 'foreign-session', hostId: 'foreign' }], controlAgentContinuity: vi.fn() })
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }, { hostId: 'foreign', client: foreign }] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') }, credentials: { agentSessionId: f.previous.agentSessionId, capability } })
  cleanups.push(() => rpc.dispose())
  await expect(rpc.call('agent.continuity.control', await packet(f, 'managed-cancel'))).resolves.toMatchObject({ receipt: { outcome: 'cancelled' } })
  await expect(rpc.call('runtime.owner.identity', {})).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  await expect(rpc.call('agent.continuity.control', { ...await packet(f, 'foreign-control'), agentSessionId: 'foreign-session' })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  expect(foreign.controlAgentContinuity).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledTimes(1)
})
