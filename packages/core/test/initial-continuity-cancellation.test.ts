import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import * as Source from '../src/index.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const core: typeof Source & Record<string, any> = process.env.AGENTMUX_TEST_INITIAL_CONTINUITY_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_INITIAL_CONTINUITY_ENTRY)
  : { ...Source, ...await import('../src/public-rpc-server.js'), ...await import('../src/hosted-runtime-service.js') }
if (process.env.AGENTMUX_TEST_INITIAL_CONTINUITY_MUTANT) expect(Reflect.get(core, 'AGENTMUX_INITIAL_CONTINUITY_MUTANT')).toBe(process.env.AGENTMUX_TEST_INITIAL_CONTINUITY_MUTANT)
const rootId = 'original-waiting-intent', cleanups: Array<() => Promise<void>> = []
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
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function consumer(name: string, facts: unknown) {
  const directory = process.env.AGENTMUX_TEST_INITIAL_CONTINUITY_EVIDENCE
  if (directory && !process.env.AGENTMUX_TEST_INITIAL_CONTINUITY_MUTANT) await writeFile(join(directory, name + '.json'),
    JSON.stringify({ schema: 'agentmux.initial-continuity-consumer.v1', name, userRuntimeTouched: false, facts }, null, 2))
}
async function fixture(options: { healthy?: boolean; noTarget?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aic-')))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
  const runtime = join(root, 'runtime'), state = join(root, 'state'); await mkdir(runtime); await mkdir(state)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const daemon = spawn(resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonError = ''; daemon.stderr!.on('data', bytes => { daemonError += String(bytes) })
  cleanups.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) { const ended = once(daemon, 'exit'); daemon.kill('SIGTERM'); await ended }
    await rm(root, { recursive: true, force: true })
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(daemonError) })])
  const program = "console.log('NATIVE:'+JSON.stringify({pid:process.pid,args:process.argv.slice(1)}));process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('RAW:'+d));setInterval(()=>{},1000)"
  const provider = core.defineAgentProvider({ catalog: { id: 'waiting-native', label: 'Private waiting Native', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' }, hookStrategy: { kind: 'none' },
    resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
    buildArgs: (_prompt: string, args: string[]) => args,
    buildResumeArgs: (id: string, _path: string | undefined, prompt: string | undefined) => ['-e', program, id, ...(prompt ? [prompt] : [])], hook: { rules: [] } })
  const storePath = join(root, 'sessions.sqlite'), store = new core.AgentMuxFileAgentSessionStore(storePath)
  const client = new core.AgentMuxClient({ store, providers: [provider] }), inner = client as any
  Object.defineProperty(inner.hookServer, 'port', { value: 0 }); await client.connect()
  const nativeStart = inner.kernel.start.bind(inner.kernel), nativeList = inner.kernel.list.bind(inner.kernel), nativeStatus = inner.kernel.status.bind(inner.kernel)
  const seed = await nativeStart({ operationKey: 'original-native', program: process.execPath, args: ['-e', options.healthy ? program : 'process.exit(0)'], cwd: root, env: {} })
  await vi.waitFor(async () => expect((await nativeStatus(seed.runId)).state.type).toBe(options.healthy ? 'running' : 'exited'))
  const activityAt = Date.now()
  const previous: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-waiting-session', providerId: provider.id, executorId: 'original-executor', hostId: 'local', workspacePath: root,
    run: { runId: seed.runId }, retiredRuns: [], createdAt: activityAt, updatedAt: activityAt, hookBindingId: 'original-binding', hookToken: 'original-token',
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: activityAt }, ...(options.noTarget ? {} : { nativeHandle: { kind: 'provider', providerId: provider.id, sessionId: 'original-native' } as const }) }
  await store.compareAndSwap(null, previous); await client.refreshAgentSession(previous.agentSessionId)
  cleanups.push(async () => {
    vi.restoreAllMocks()
    for (const run of await nativeList()) if (run.state.type === 'running') {
      try { await inner.kernel.stop(await inner.kernel.prepareStop(run.runId)) }
      catch (error) { if ((await nativeStatus(run.runId)).state.type === 'running') throw error }
    }
    await client.dispose()
  })
  const start = vi.spyOn(inner.kernel, 'start'), stop = vi.spyOn(inner.kernel, 'stop'), input = vi.spyOn(inner.kernel, 'input')
  const request = { agentSessionId: previous.agentSessionId, expectedRun: previous.run, operationId: rootId, trigger: 'startup' as const,
    policy: { activeRecoveryDelayMs: 120, retryMaxAttempts: 0, recheckMaxAttempts: 0, retryInitialDelayMs: 10, retryMaxDelayMs: 10 } }
  const saved = async () => (await store.readMetadata(previous.agentSessionId))!
  const rootOf = async () => (await saved()).continuityOperations?.[rootId]
  const packet = async (operationId = 'original-cancel') => ({ agentSessionId: previous.agentSessionId, expectedRun: (await saved()).run, intentOperationId: rootId, operationId, action: 'cancel' as const })
  const barrier = async () => { await inner.recovery.continuitySupervisor.serialize(previous.agentSessionId, async () => {}) }
  const raw = async (run = previous.run) => {
    const replay = async () => (await client.readRunReplay(run)).replay.map(chunk => chunk.data).join('')
    await vi.waitFor(async () => expect(await replay()).toContain('NATIVE:'))
    await expect(client.writeAgent({ agentSessionId: previous.agentSessionId, expectedRun: run, source: 'user', data: 'healthy-raw' })).resolves.toBeDefined()
    await vi.waitFor(async () => expect(await replay()).toContain('RAW:healthy-raw'))
  }
  const noLifecycle = () => { expect(start).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled() }
  return { root, storePath, store, client, inner, nativeStart, nativeList, nativeStatus, seed, previous, request, saved, rootOf, packet, barrier, raw, noLifecycle, start, stop, input }
}
it('cancels the configured initial delay and keeps the same zero-count receipt across Core process Hosted and compiled CLI', async () => {
  const f = await fixture(), pending = f.client.ensureAgentContinuity(f.request)
  await expect(pending).resolves.toMatchObject({ kind: 'pending', reason: 'active-delay', continuity: { supervision: { attemptCount: 0 } } })
  const initial = await f.rootOf(); expect(initial?.supervision).toMatchObject({ attemptCount: 0, attemptLimit: 1 }); expect(initial?.newRun).toBeUndefined()
  const request = await f.packet(), cancel = f.client.controlAgentContinuity(request)
  await expect(cancel).resolves.toMatchObject({ receipt: { request, outcome: 'cancelled', attemptCount: 0 } }); const accepted = await cancel
  await delay(Math.max(0, initial!.nextActionAt! - Date.now()) + 30); await f.barrier()
  f.noLifecycle(); expect(f.input).not.toHaveBeenCalled(); expect((await f.rootOf())?.supervision?.phase).toBe('cancelled')
  const childProgram = `const core=await import(process.env.INITIAL_ENTRY);const config=JSON.parse(process.env.INITIAL_PACKET);const store=new core.AgentMuxFileAgentSessionStore(config.storePath);const client=new core.AgentMuxClient({store});let lifecycleCalls=0;for(const key of ['start','stop','input'])client.kernel[key]=async()=>{lifecycleCalls++;throw new Error('Read-only reconciliation attempted Native mutation')};try{const result=await client.controlAgentContinuity(config.request);process.stdout.write(JSON.stringify({result,lifecycleCalls})+'\\n')}finally{await client.dispose()}`
  const child = spawn(process.execPath, ['--input-type=module', '-e', childProgram], { env: { ...process.env,
    INITIAL_ENTRY: process.env.AGENTMUX_TEST_INITIAL_CONTINUITY_ENTRY ?? pathToFileURL(resolve(import.meta.dirname, '../dist/index.js')).href,
    INITIAL_PACKET: JSON.stringify({ request, storePath: f.storePath }) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout!.on('data', bytes => { stdout += bytes }); child.stderr!.on('data', bytes => { stderr += bytes })
  const [code] = await once(child, 'exit'); expect(code, stderr).toBe(0); const newProcess = JSON.parse(stdout)
  expect(newProcess).toMatchObject({ result: { receipt: accepted.receipt }, lifecycleCalls: 0 })
  const hosted = new core.AgentMuxHostedRuntimeService(f.client, f.storePath, () => ({ runtimeId: 'private-initial-owner', ownerInstanceId: 'private-initial-instance', protocolVersion: 2, processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }))
  cleanups.push(() => hosted.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const reader = await core.connectHostedAgentMux({ rpc }); cleanups.push(() => reader.dispose())
  await expect(reader.controlAgentContinuity(request)).resolves.toMatchObject({ receipt: accepted.receipt })
  const input = join(f.root, 'cancel.json'); await writeFile(input, JSON.stringify(request))
  const cli = await runCompiledObjectCli(['agent', 'continuity', 'control', '--input', input], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.receipt).toEqual(accepted.receipt)
  const inspect = await runCompiledObjectCli(['agent', 'inspect', '--session', f.previous.agentSessionId], objectCliEnvironment(f.root))
  expect(inspect.code, inspect.stderr).toBe(0); expect(inspect.stdout).toContain('cancelled'); f.noLifecycle(); expect(f.input).not.toHaveBeenCalled()
  await consumer('delay-cancel-public-restart', { initial, accepted, newProcess, cli: JSON.parse(cli.stdout), inspect: JSON.parse(inspect.stdout), starts: 0, stops: 0, inputs: 0 })
})
it('cancels an unknown original Runtime observation without Native target while its healthy raw Run survives', async () => {
  const f = await fixture({ healthy: true, noTarget: true }), actual = f.nativeStatus
  const status = vi.spyOn(f.inner.kernel, 'status').mockRejectedValue(new core.AgentMuxError('Exact Runtime read unavailable', 'CONTROL_UNAVAILABLE'))
  await expect(f.client.ensureAgentContinuity(f.request)).resolves.toMatchObject({ kind: 'pending', reason: 'runtime-unverified', continuity: { supervision: { attemptCount: 0 } } })
  expect((await f.rootOf())?.nativeTarget).toBeUndefined()
  await expect(f.client.controlAgentContinuity(await f.packet())).resolves.toMatchObject({ receipt: { outcome: 'cancelled', attemptCount: 0 } })
  status.mockImplementation(actual); expect((await actual(f.previous.run.runId)).pid).toBe(f.seed.pid); await f.raw(); f.noLifecycle()
  expect((await f.rootOf())?.supervision?.phase).toBe('cancelled')
  await consumer('runtime-unknown-healthy-raw', { originalRun: await actual(f.previous.run.runId), root: await f.rootOf(), rawVerified: true })
})
it('cancels initial Provider uncertainty without waiting for its observation to recover', async () => {
  const f = await fixture(); vi.spyOn(f.client as unknown as { probePreparedAgent: typeof f.client.probeAgent }, 'probePreparedAgent').mockRejectedValueOnce(new core.AgentMuxError('Exact Provider read unavailable', 'CONTROL_UNAVAILABLE'))
  await expect(f.client.ensureAgentContinuity({ ...f.request, policy: { ...f.request.policy, activeRecoveryDelayMs: 0 } })).resolves.toMatchObject({ kind: 'pending', reason: 'provider-unverified', continuity: { supervision: { attemptCount: 0 } } })
  await expect(f.client.controlAgentContinuity(await f.packet())).resolves.toMatchObject({ receipt: { outcome: 'cancelled', attemptCount: 0 } })
  f.noLifecycle(); expect(f.input).not.toHaveBeenCalled()
})
it('cancellation wins when the original delay timer is already reading exact Runtime status', async () => {
  const f = await fixture(); await f.client.ensureAgentContinuity(f.request)
  let enter!: () => void, release!: () => void, held = true
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f.inner.kernel, 'status').mockImplementation(async (id: any) => { if (id === f.previous.run.runId && held) { held = false; enter(); await gate }; return await f.nativeStatus(id) })
  await entered
  try { await expect(f.client.controlAgentContinuity(await f.packet())).resolves.toMatchObject({ receipt: { outcome: 'cancelled', attemptCount: 0 } }) }
  finally { release() }
  await f.barrier(); f.noLifecycle(); expect(f.input).not.toHaveBeenCalled(); expect((await f.rootOf())?.supervision?.phase).toBe('cancelled')
})
it('the same Store claim refuses a cancelled initial attempt before any Native Start', async () => {
  const f = await fixture(); await f.client.ensureAgentContinuity(f.request)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve }), prepare = f.store.prepareResume.bind(f.store)
  vi.spyOn(f.store, 'prepareResume').mockImplementation(async (...args) => { enter(); await gate; return await prepare(...args) })
  await entered
  try { await expect(f.client.controlAgentContinuity(await f.packet())).resolves.toMatchObject({ receipt: { outcome: 'cancelled', attemptCount: 1 } }) }
  finally { release() }
  await f.barrier(); f.noLifecycle(); expect(f.input).not.toHaveBeenCalled(); expect((await f.rootOf())?.supervision?.phase).toBe('cancelled')
})
it.each(['paused', 'cancelled'] as const)('a fresh automatic startup joins the original %s intent without resetting its budget or input', async expected => {
  const f = await fixture(); const probe = vi.spyOn(f.client as unknown as { probePreparedAgent: typeof f.client.probeAgent }, 'probePreparedAgent').mockRejectedValueOnce(new core.AgentMuxError('Exact Provider read unavailable', 'CONTROL_UNAVAILABLE'))
  await f.client.ensureAgentContinuity({ ...f.request, policy: { ...f.request.policy, activeRecoveryDelayMs: 0 } })
  if (expected === 'cancelled') await f.client.controlAgentContinuity(await f.packet())
  const original = await f.rootOf(); expect(original?.supervision?.phase).toBe(expected); probe.mockRestore()
  const automatic = f.client.ensureAgentContinuity({ ...f.request, operationId: 'fresh-startup-identity', policy: { activeRecoveryDelayMs: 0, retryMaxAttempts: 20 } })
  await expect(automatic).resolves.toMatchObject({ kind: 'pending', reason: expected === 'cancelled' ? 'intent-cancelled' : 'recovery-supervised', continuity: { operationId: rootId } })
  expect((await f.rootOf())?.supervision).toEqual(original!.supervision); expect((await f.saved()).continuityOperations?.['fresh-startup-identity']).toBeUndefined(); f.noLifecycle(); expect(f.input).not.toHaveBeenCalled()
})
it('explicit continuation rechecks the original zero-count paused observation without replacing its intent', async () => {
  const f = await fixture(); const probe = vi.spyOn(f.client as unknown as { probePreparedAgent: typeof f.client.probeAgent }, 'probePreparedAgent').mockRejectedValueOnce(new core.AgentMuxError('Exact Provider read unavailable', 'CONTROL_UNAVAILABLE'))
  await expect(f.client.ensureAgentContinuity({ ...f.request, policy: { ...f.request.policy, activeRecoveryDelayMs: 0 } })).resolves.toMatchObject({ kind: 'pending', reason: 'provider-unverified' })
  const original = await f.rootOf(); expect(original?.supervision).toMatchObject({ attemptCount: 0, attemptLimit: 1, phase: 'paused' }); probe.mockRestore()
  const packet = { ...await f.packet('explicit-initial-continue'), action: 'continue' as const, additionalAttempts: 1 }
  await expect(f.client.controlAgentContinuity(packet)).resolves.toMatchObject({ receipt: { outcome: 'continued', attemptCount: 0, attemptLimitAfter: 2 } })
  await f.barrier()
  expect(f.start).toHaveBeenCalledTimes(1)
  expect((await f.rootOf())?.supervision).toMatchObject({ attemptCount: 1, attemptLimit: 2 })
  expect((await f.rootOf())?.operationId).toBe(rootId); expect((await f.rootOf())?.policy).toEqual(original!.policy)
  expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})
it('explicit public refresh reobserves the original zero-count Provider wait and admits its first Native attempt', async () => {
  const f = await fixture(); const probe = vi.spyOn(f.client as unknown as { probePreparedAgent: typeof f.client.probeAgent }, 'probePreparedAgent').mockRejectedValueOnce(new core.AgentMuxError('Exact Provider read unavailable', 'CONTROL_UNAVAILABLE'))
  await expect(f.client.ensureAgentContinuity({ ...f.request, policy: { ...f.request.policy, activeRecoveryDelayMs: 0 } })).resolves.toMatchObject({ kind: 'pending', reason: 'provider-unverified' })
  const original = await f.rootOf(); expect(original?.supervision).toMatchObject({ attemptCount: 0, attemptLimit: 1, phase: 'paused' }); probe.mockRestore()
  await expect(f.client.refreshAgentSession(f.previous.agentSessionId)).resolves.toBeDefined()
  await f.barrier()
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
  expect((await f.rootOf())?.supervision).toMatchObject({ attemptCount: 1, attemptLimit: 1 }); expect((await f.rootOf())?.policy).toEqual(original!.policy)
})
it('cancel reconciles an admitted unknown startup without synthesizing or replaying input', async () => {
  const f = await fixture(); f.start.mockImplementationOnce(async (spec: any) => { await f.nativeStart(spec); throw new core.AgentMuxError('Original Start receipt unavailable', 'CONTROL_UNAVAILABLE', undefined, { disposition: 'unknown', confirmedInputBytes: null }) })
  await expect(f.client.ensureAgentContinuity({ ...f.request, policy: { ...f.request.policy, activeRecoveryDelayMs: 0 } })).resolves.toMatchObject({ kind: 'pending', reason: 'operation-unconfirmed', continuity: { supervision: { attemptCount: 1 } } })
  const before = await f.rootOf(), runs = await f.nativeList(), admitted = runs.find((run: any) => run.runId !== f.previous.run.runId && run.state.type === 'running')
  expect(before?.launchInput).toBeUndefined()
  expect(f.start.mock.calls[0]![0].args).toEqual(['-e', expect.any(String), 'original-native'])
  expect(admitted).toBeDefined(); const cancel = f.client.controlAgentContinuity(await f.packet())
  await expect(cancel).resolves.toMatchObject({ receipt: { outcome: 'cancelled', attemptCount: 1 } })
  await expect(f.client.ensureAgentContinuity(f.request)).resolves.toMatchObject({ kind: 'resumed', run: { runId: admitted!.runId } })
  const current = f.client.agentSession(f.previous.agentSessionId)
  expect((await f.rootOf())?.launchInput).toBeUndefined(); expect((await f.rootOf())?.supervision).toMatchObject({ attemptCount: 1, phase: 'cancelled' })
  expect((await f.nativeStatus(admitted!.runId)).pid).toBe(admitted!.pid); expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
  await f.raw(current.run)
  await consumer('unknown-admitted-start', { run: admitted, current, originalInputPresent: before?.launchInput !== undefined, starts: 1, stops: 0, inputReplays: 0, rawVerified: true })
})
it('wrong Run root Host and changed original packet refuse only that control', async () => {
  const f = await fixture(); await f.client.ensureAgentContinuity(f.request); const packet = await f.packet()
  await expect(f.client.controlAgentContinuity({ ...packet, expectedRun: { runId: 'another-run' } })).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  await expect(f.client.controlAgentContinuity({ ...packet, intentOperationId: 'another-root' })).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
  await expect(f.client.controlAgentContinuity(packet, { assertCurrent: async () => { throw new core.AgentMuxError('Original target Host route changed', 'HOST_SCOPE_MISMATCH') } })).rejects.toMatchObject({ code: 'HOST_SCOPE_MISMATCH' })
  await expect(f.client.controlAgentContinuity(packet)).resolves.toMatchObject({ receipt: { outcome: 'cancelled' } })
  await expect(f.client.controlAgentContinuity({ ...packet, action: 'continue', additionalAttempts: 1 })).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_CONTROL_CONFLICT' })
  f.noLifecycle(); expect(f.input).not.toHaveBeenCalled()
})
it('strict codecs accept truthful initial zero counts and reject impossible negative fractional or admitted-zero facts', () => {
  const operation: any = { operationId: rootId, agentSessionId: 'original-session', trigger: 'startup', policy: core.DEFAULT_AGENT_CONTINUITY_POLICY,
    previousRun: { runId: 'original-run' }, kind: 'pending', reason: 'runtime-unverified', admittedAt: _historyFixtureEpoch(0, 0, 1), observedAt: _historyFixtureEpoch(0, 0, 1), rechecks: 0,
    evidence: { kind: 'run-unknown', observedAt: _historyFixtureEpoch(0, 0, 1), message: 'Exact Runtime not yet observed' },
    supervision: { phase: 'paused', activeAttemptOperationId: rootId, attemptCount: 0, attemptLimit: 4, reason: 'runtime-unverified', observedAt: _historyFixtureEpoch(0, 0, 1) } }
  expect(() => core.normalizeAgentContinuityOperation(operation)).not.toThrow()
  for (const attemptCount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => core.normalizeAgentContinuityOperation({ ...operation, supervision: { ...operation.supervision, attemptCount } })).toThrow()
  for (const change of [{ newRun: { runId: 'admitted' } }, { intentOperationId: 'another-root' }, { supervision: { ...operation.supervision, phase: 'retry-wait' } }, { supervision: { ...operation.supervision, activeAttemptOperationId: 'another-operation' } }]) expect(() => core.normalizeAgentContinuityOperation({ ...operation, ...change })).toThrow()
  const receipt = { request: { agentSessionId: 'original-session', intentOperationId: rootId, expectedRun: operation.previousRun, operationId: 'original-cancel', action: 'cancel' },
    outcome: 'cancelled', reason: 'explicit-cancel', phaseAtCommit: 'cancelled', activeAttemptOperationId: rootId, attemptCount: 0, attemptLimitBefore: 4, attemptLimitAfter: 4, observedAt: _historyFixtureEpoch(0, 0, 1) }
  expect(() => core.parseAgentContinuityControlReceipt(receipt)).not.toThrow()
  for (const attemptCount of [-1, 0.5, 5]) expect(() => core.parseAgentContinuityControlReceipt({ ...receipt, attemptCount })).toThrow()
})
