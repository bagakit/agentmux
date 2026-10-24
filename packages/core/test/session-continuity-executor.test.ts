import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import * as Source from '../src/index.js'
import { continuityExecutorProvider } from './helpers/continuity-executor-process.mjs'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const core: typeof Source & Record<string, any> = process.env.AGENTMUX_TEST_CONTINUITY_EXECUTOR_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_CONTINUITY_EXECUTOR_ENTRY)
  : { ...Source, ...await import('../src/public-rpc-server.js'), ...await import('../src/hosted-runtime-service.js') }
if (process.env.AGENTMUX_TEST_CONTINUITY_EXECUTOR_MUTANT) expect(Reflect.get(core, 'AGENTMUX_CONTINUITY_EXECUTOR_MUTANT')).toBe(process.env.AGENTMUX_TEST_CONTINUITY_EXECUTOR_MUTANT)
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
  if (errors.length) {
    if (process.env.SESSION_EXECUTOR_FACTS) appendFileSync(process.env.SESSION_EXECUTOR_FACTS, JSON.stringify({ cleanup: 'unknown', errors: errors.map(error => error instanceof Error ? { message: error.message, stack: error.stack, cause: error.cause } : String(error)) }) + '\n')
    throw new AggregateError(errors, 'Continuity fixture cleanup failed.')
  }
  if (process.env.SESSION_EXECUTOR_FACTS) appendFileSync(process.env.SESSION_EXECUTOR_FACTS, JSON.stringify({ cleanup: 'confirmed', surface: 'core' }) + '\n')
})
const rootId = 'original-intent', sentinel = 'sdk-private-value'
async function recordConsumer(name: string, facts: unknown) {
  const directory = process.env.AGENTMUX_TEST_CONTINUITY_EXECUTOR_EVIDENCE
  if (directory && !process.env.AGENTMUX_TEST_CONTINUITY_EXECUTOR_MUTANT) await writeFile(join(directory, name + '.json'),
    JSON.stringify({ schema: 'agentmux.continuity-executor-consumer.v1', name, userRuntimeTouched: false, facts }, null, 2))
}
async function fixture(options: { owner?: boolean; configuration?: boolean; healthy?: boolean; args?: string[]; env?: Record<string, string> } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aex-')))
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
  const scripts: Record<string, string> = {}
  for (const kind of ['catalog', 'sdk', 'owner']) {
    const file = join(root, kind + '.mjs'); scripts[kind] = file
    const program = '#!' + process.execPath + '\n' + "import fs from 'node:fs';const args=process.argv.slice(2),kind=" + JSON.stringify(kind) + ";" +
      "if(!args.includes('original-native'))throw new Error('Wrong original native target');const witness={kind,pid:process.pid,program:fs.realpathSync(process.argv[1]),args,sentinel:process.env.SDK_RECOVERY_SENTINEL??null,sessionId:process.env.AGENTMUX_AGENT_SESSION_ID};" +
      "fs.writeFileSync(kind+'-'+process.pid+'.json',JSON.stringify(witness));process.stdout.write('NATIVE:'+JSON.stringify(witness)+'\\n');" +
      (kind === 'sdk' && !options.healthy ? "if(!fs.existsSync('failed-once')){fs.writeFileSync('failed-once','yes');setImmediate(()=>process.exit(7))}else " : '') +
      "{process.stdin.setRawMode(true);process.stdin.on('data',bytes=>{if(String(bytes)==='fixture-exit7')process.exit(7);process.stdout.write('RAW:'+bytes)});setInterval(()=>{},1000)}"
    await writeFile(file, program, { mode: 0o700 })
  }
  const provider = continuityExecutorProvider(core, scripts.catalog), storePath = join(root, 'sessions.sqlite'), readers: any[] = []
  const hostOwner = options.owner ? new core.AgentMuxHostExecutorOwner({ path: join(root, 'executors.json'), runtimeId: 'private-source-owner', catalog: () => [provider.catalog] }) : undefined
  let currentRevision: string | undefined
  const configure = async (command = scripts.catalog!, value = 'owner-initial') => { const configured = await hostOwner!.configure({ executorId: 'original-executor', ...(currentRevision ? { expectedRevision: currentRevision } : {}), config: {
    label: 'Private configured source', providerId: provider.id, command, args: ['owner-argument'], env: { SDK_RECOVERY_SENTINEL: value }, injectAgentMuxGuide: false } }); currentRevision = configured.executor.configRevision; return configured }
  if (hostOwner) await configure()
  let configuration: import('../src/types.js').AgentExecutorConfig = { label: 'Original Session configuration', providerId: provider.id, command: scripts.owner!,
    args: ['configuration-argument'], env: { SDK_RECOVERY_SENTINEL: 'configuration-current' }, injectAgentMuxGuide: false }
  const configurationReader = vi.fn(async (_executorId: string) => structuredClone(configuration))
  async function reader() {
    const store = new core.AgentMuxFileAgentSessionStore(storePath), client = new core.AgentMuxClient({ store, providers: [provider],
      ...(options.configuration ? { sessionExecutorConfiguration: configurationReader } : {}), ...(hostOwner ? { hostExecutorOwner: hostOwner } : {}) }), inner = client as any
    Object.defineProperty(inner.hookServer, 'port', { value: 0 }); await client.connect()
    const nativeList = inner.kernel.list.bind(inner.kernel), nativeStart = inner.kernel.start.bind(inner.kernel)
    const value = { store, client, inner, nativeList, nativeStart, start: vi.spyOn(inner.kernel, 'start'), stop: vi.spyOn(inner.kernel, 'stop'), input: vi.spyOn(inner.kernel, 'input') }
    readers.push(value); return value
  }
  const original = await reader()
  cleanups.push(async () => {
    const final = await reader()
    for (const run of await final.nativeList()) if (run.state.type === 'running') {
      try { await final.inner.kernel.stop(await final.inner.kernel.prepareStop(run.runId)) }
      catch (error) { if ((await final.inner.kernel.status(run.runId)).state.type === 'running') throw error }
    }
    for (const value of readers.slice().reverse()) await value.client.dispose()
  })
  const seed = await original.nativeStart({ operationKey: 'original-seed', program: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root, env: {} })
  await vi.waitFor(async () => expect((await original.inner.kernel.status(seed.runId)).state.type).toBe('exited'))
  const activityAt = options.configuration ? Date.now() : _historyFixtureEpoch(0, 0, 1)
  const previous: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-session', providerId: provider.id, executorId: 'original-executor',
    hostId: 'local', workspacePath: root, run: { runId: seed.runId }, retiredRuns: [], createdAt: activityAt, updatedAt: activityAt, hookBindingId: 'original-binding', hookToken: 'original-token',
    nativeHandle: { kind: 'provider', providerId: provider.id, sessionId: 'original-native' }, semanticStatus: { state: 'working', source: 'native-hook', observedAt: activityAt } }
  await original.store.compareAndSwap(null, previous); await original.client.refreshAgentSession(previous.agentSessionId)
  const overrides = { commandOverride: scripts.sdk!, args: options.args ?? ['sdk-argument'], env: options.env ?? { SDK_RECOVERY_SENTINEL: sentinel } }
  const request = { agentSessionId: previous.agentSessionId, expectedRun: previous.run, operationId: rootId, trigger: 'startup' as const,
    policy: { retryMaxAttempts: 1, retryInitialDelayMs: 30, retryMaxDelayMs: 30 }, ...overrides }
  const saved = async () => (await original.store.readMetadata(previous.agentSessionId))!
  const phase = async (expected: string) => {
    await vi.waitFor(async () => expect((await saved()).continuityOperations?.[rootId]?.supervision?.phase).toBe(expected), { timeout: 5000 })
    return (await saved()).continuityOperations![rootId]!
  }
  const next = async (oldRun: { runId: string }, owner = original) => {
    let observed: any
    await expect((async () => {
      await vi.waitFor(async () => {
        const current = (await owner.store.readMetadata(previous.agentSessionId))!, run = (await owner.client.listRuns()).find((value: any) => value.runId === current.run.runId)
        expect(current.run.runId).not.toBe(oldRun.runId); expect(run?.state).toBe('running')
        for (const kind of Object.keys(scripts)) { try { const witness = JSON.parse(await readFile(join(root, kind + '-' + run!.pid + '.json'), 'utf8')); if (witness.pid === run!.pid) observed = { current, witness, run } } catch {} }
        expect(observed).toBeDefined()
      }, { timeout: 5000 })
    })()).resolves.toBeUndefined()
    return observed
  }
  const raw = async (session: any, owner = original) => {
    const replay = async () => (await owner.client.readRunReplay(session.run)).replay.map((chunk: any) => chunk.data).join('')
    await vi.waitFor(async () => expect(await replay()).toContain('NATIVE:'))
    await expect(owner.client.writeAgent({ agentSessionId: previous.agentSessionId, expectedRun: session.run, source: 'user', data: 'healthy-input' })).resolves.toBeDefined()
    await vi.waitFor(async () => expect(await replay()).toContain('RAW:healthy-input'))
  }
  const mutate = async (change: (value: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession) => {
    const old = await saved(); await original.store.compareAndSwapMetadata(old, change(old)); await original.client.refreshAgentSession(previous.agentSessionId)
  }
  const control = async () => ({ agentSessionId: previous.agentSessionId, expectedRun: (await saved()).run, intentOperationId: rootId, operationId: 'explicit-budget', action: 'continue' as const, additionalAttempts: 1 })
  const child = async (action: 'continue' | 'ensure', packet: unknown) => {
    const config = join(root, 'child.json')
    await writeFile(config, JSON.stringify({ root, action, request: packet, storePath, defaultProgram: scripts.catalog,
      entry: process.env.AGENTMUX_TEST_CONTINUITY_EXECUTOR_ENTRY ?? pathToFileURL(resolve(import.meta.dirname, '../dist/index.js')).href }))
    const child = spawn(process.execPath, [resolve(import.meta.dirname, 'helpers/continuity-executor-process.mjs'), config], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout!.on('data', value => { stdout += value }); child.stderr!.on('data', value => { stderr += value })
    const [code] = await once(child, 'exit'); expect(code, stderr).toBe(0)
    return JSON.parse(stdout)
  }
  return { ...original, root, scripts, readers, provider, previous, request, overrides, saved, phase, next, raw, mutate, reader, child, control, configure,
    configurationReader, setConfiguration(value: Partial<typeof configuration>) { configuration = { ...configuration, ...value } } }
}
function originalSdk(f: any, observed: any, args = ['sdk-argument'], env: string | null = sentinel, first = false) {
  expect(observed.witness.program).toBe(f.scripts.sdk)
  expect(observed.witness.kind).toBe('sdk')
  if (first) { expect(observed.witness.args.slice(0, -1)).toEqual([...args, 'resume', 'original-native']); expect(observed.witness.args.at(-1)).toContain('Continue the task') }
  else expect(observed.witness.args).toEqual([...args, 'resume', 'original-native'])
  expect(observed.witness.sentinel).toBe(env)
  expect(observed.witness.sessionId).toBe(f.previous.agentSessionId)
  expect(observed.current?.nativeHandle ?? observed.session.nativeHandle).toEqual(f.previous.nativeHandle)
}
it.each([false, true])('retains the exact SDK invocation for the context-only retry with Host owner %s', async owner => {
  const f = await fixture({ owner }), first = f.client.ensureAgentContinuity(f.request)
  await expect(first).resolves.toMatchObject({ kind: 'resumed' }); const accepted = await first
  const observed = await f.next(accepted.kind === 'resumed' ? accepted.run : f.previous.run)
  originalSdk(f, observed); expect(f.start).toHaveBeenCalledTimes(2)
  expect((f.start.mock.calls[0]![0] as any).args).toHaveLength(4); expect((f.start.mock.calls[1]![0] as any).args).toHaveLength(3)
  expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); await f.raw(observed.current)
  await recordConsumer(owner ? 'sdk-unrelated-owner' : 'sdk-no-owner', { witness: observed.witness, run: observed.run, original: f.previous.run, nativeTarget: observed.current.nativeHandle, rawEchoVerified: true })
})
it('a separate Core process retains the original private SDK options without receiving them again', async () => {
  const f = await fixture(); await f.client.ensureAgentContinuity({ ...f.request, policy: { retryMaxAttempts: 0, retryInitialDelayMs: 10, retryMaxDelayMs: 10 } }); await f.phase('paused')
  const request = await f.control(); await f.client.dispose()
  const observed = await f.child('continue', request); originalSdk(f, observed)
  expect(observed.starts).toHaveLength(1); expect(JSON.stringify(observed)).not.toContain('continuityExecutors')
  const fresh = await f.reader(); await f.raw(observed.session, fresh)
  await recordConsumer('independent-core', { observed, rawEchoVerified: true, configContainsSdkOverrides: false })
})
it('captures the SDK source before initial Runtime uncertainty and rechecks the same original operation', async () => {
  const f = await fixture({ healthy: true }), actual = f.inner.kernel.status.bind(f.inner.kernel)
  const status = vi.spyOn(f.inner.kernel, 'status').mockRejectedValue(new core.AgentMuxError('Original read unavailable', 'CONTROL_UNAVAILABLE'))
  await expect(f.client.ensureAgentContinuity({ ...f.request, policy: { retryMaxAttempts: 0, recheckMaxAttempts: 0 } })).resolves.toMatchObject({ kind: 'pending', reason: 'runtime-unverified' })
  expect((await f.saved()).continuityExecutors).toMatchObject({ [rootId]: { source: 'sdk', options: f.overrides } }); expect(f.start).not.toHaveBeenCalled()
  status.mockImplementation(actual)
  const { commandOverride: _command, args: _args, env: _env, ...same } = f.request
  await expect(f.client.ensureAgentContinuity(same)).resolves.toMatchObject({ kind: 'resumed' })
  const observed = await f.next(f.previous.run); originalSdk(f, observed, undefined, undefined, true); expect(f.start).toHaveBeenCalledTimes(1)
  await recordConsumer('initial-runtime-unknown', { witness: observed.witness, operation: observed.current.continuity, runtimeObservationRecovered: true })
})
it('retains pending delay and its SDK source through an actual independent Core restart', async () => {
  const f = await fixture({ healthy: true }), policy = { retryMaxAttempts: 0, activeRecoveryDelayMs: 150, recheckMaxAttempts: 0 }
  await expect(f.client.ensureAgentContinuity({ ...f.request, policy })).resolves.toMatchObject({ kind: 'pending', reason: 'active-delay' })
  const original = await f.saved(); expect(original.continuity!.nextActionAt).toBeGreaterThan(Date.now()); expect(f.start).not.toHaveBeenCalled()
  await f.client.dispose()
  const { commandOverride: _command, args: _args, env: _env, ...packet } = f.request
  const observed = await f.child('ensure', { ...packet, policy }); originalSdk(f, observed, undefined, undefined, true)
  expect(observed.starts).toHaveLength(1); expect(observed.session.continuityOperations[rootId].admittedAt).toBe(original.continuity!.admittedAt)
  await recordConsumer('delay-restart', { original: original.continuity, observed, configContainsSdkOverrides: false })
})
it.each(['missing', 'malformed'] as const)('keeps current target-owned Host authority with a %s private record', async broken => {
  const f = await fixture({ owner: true }); await f.client.ensureAgentContinuity({ ...f.request, policy: { retryMaxAttempts: 0, retryInitialDelayMs: 10, retryMaxDelayMs: 10 } }); await f.phase('paused')
  const configured = await f.configure(f.scripts.owner, 'owner-current')
  await f.mutate(value => ({ ...value, creation: { createOperationId: 'owner-authority', initialPrompt: 'not-requested', intentDigest: 'c'.repeat(64), executorRevision: configured.executor.configRevision }, continuityExecutors: broken === 'missing' ? undefined : { [rootId]: { damaged: 'opaque-private-original' } } } as any))
  const packet = await f.control()
  await expect(f.client.controlAgentContinuity(packet)).resolves.toMatchObject({ receipt: { outcome: 'continued' } })
  const observed = await f.next(packet.expectedRun)
  expect(observed.witness.program).toBe(f.scripts.owner); expect(observed.witness.sentinel).toBe('owner-current')
  expect(observed.witness.args).toEqual(['owner-argument', 'resume', 'original-native'])
  if (broken === 'malformed') expect((await f.saved()).continuityExecutors).toEqual({ [rootId]: { damaged: 'opaque-private-original' } })
  await recordConsumer('host-current-' + broken, { witness: observed.witness, ownerReceipt: configured, retainedPrivateRecord: (await f.saved()).continuityExecutors })
  expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); await f.raw(observed.current)
})
it.each(['missing', 'malformed'] as const)('keeps an unconfirmed %s SDK source scoped to its exact recovery', async broken => {
  const f = await fixture(); await f.client.ensureAgentContinuity({ ...f.request, policy: { retryMaxAttempts: 0, retryInitialDelayMs: 10, retryMaxDelayMs: 10 } }); await f.phase('paused')
  const original = broken === 'missing' ? undefined : { [rootId]: { source: 'sdk', options: { env: [sentinel] } }, unrelated: { damaged: true } }
  await f.mutate(value => ({ ...value, continuityExecutors: original }))
  await expect(f.client.controlAgentContinuity(await f.control())).resolves.toMatchObject({ receipt: { outcome: 'continued' } })
  await vi.waitFor(async () => { const current = (await f.saved()).continuity; expect(current?.intentOperationId).toBe(rootId); expect(current?.kind === 'resumed' || current?.errorCode !== undefined).toBe(true) })
  expect((await f.saved()).continuity).toMatchObject({ kind: 'pending', errorCode: 'AGENT_CONTINUITY_EXECUTOR_UNCONFIRMED' })
  expect(f.start).toHaveBeenCalledTimes(1); expect((await f.saved()).continuityExecutors).toEqual(original)
  expect(f.client.agentSession(f.previous.agentSessionId).nativeHandle).toEqual(f.previous.nativeHandle); expect(f.stop).not.toHaveBeenCalled()
  await recordConsumer('unknown-sdk-' + broken, { operation: (await f.saved()).continuity, starts: f.start.mock.calls.length, privateRetained: (await f.saved()).continuityExecutors })
})
it('a damaged private root retains healthy Native inspection raw input and another new recovery root', async () => {
  const f = await fixture({ healthy: true }); await f.client.ensureAgentContinuity(f.request); const observed = await f.next(f.previous.run)
  const damaged = { [rootId]: { source: 'sdk', options: { env: [sentinel] } } }
  await expect(f.mutate(value => ({ ...value, continuityExecutors: damaged }))).resolves.toBeUndefined()
  const fresh = await f.reader()
  await expect(fresh.client.statusAgent(f.previous.agentSessionId)).resolves.toMatchObject({ session: { run: observed.current.run }, run: { state: 'running' } })
  await f.raw(observed.current, fresh)
  expect(Object.hasOwn(fresh.client.agentSession(f.previous.agentSessionId), 'continuityExecutors')).toBe(false)
  await fresh.client.writeAgent({ agentSessionId: f.previous.agentSessionId, expectedRun: observed.current.run, source: 'user', data: 'fixture-exit7' })
  await vi.waitFor(async () => expect((await fresh.inner.kernel.status(observed.current.run.runId)).state).toMatchObject({ type: 'exited', code: 7 }))
  await vi.waitFor(async () => expect((await f.saved()).continuity).toMatchObject({ kind: 'pending', errorCode: 'AGENT_CONTINUITY_EXECUTOR_UNCONFIRMED' }))
  expect(f.start).toHaveBeenCalledTimes(1); expect(fresh.start).not.toHaveBeenCalled()
  await expect(fresh.client.ensureAgentContinuity({ ...f.request, expectedRun: observed.current.run, operationId: 'new-explicit-root', trigger: 'manual' })).resolves.toMatchObject({ kind: 'resumed' })
  const next = await f.next(observed.current.run, fresh); originalSdk(f, next)
  expect((await fresh.store.readMetadata(f.previous.agentSessionId))!.continuityExecutors).toMatchObject(damaged)
  await recordConsumer('damaged-private-healthy-native', { healthyRun: observed.run, rawEchoVerified: true, damagedRetained: damaged, nextExplicitWitness: next.witness })
})
it.each(['commandOverride', 'args', 'env'] as const)('rejects an altered %s on the frozen original request before its success shortcut', async field => {
  const f = await fixture({ healthy: true }); await f.client.ensureAgentContinuity(f.request); const observed = await f.next(f.previous.run)
  const changed = { commandOverride: f.scripts.catalog, args: [], env: {} }
  await expect(f.client.ensureAgentContinuity({ ...f.request, [field]: changed[field] })).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_EXECUTOR_CONFLICT' })
  const { commandOverride: _command, args: _args, env: _env, ...omitted } = f.request
  await expect(f.client.ensureAgentContinuity(omitted)).resolves.toMatchObject({ kind: 'resumed', run: observed.current.run })
  await expect(f.client.ensureAgentContinuity({ ...omitted, [field]: f.overrides[field] })).resolves.toMatchObject({ kind: 'resumed' })
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})
it('preserves explicitly empty SDK args and env instead of adopting the unrelated Host owner', async () => {
  const f = await fixture({ owner: true, args: [], env: {} }), first = await f.client.ensureAgentContinuity(f.request)
  const observed = await f.next(first.kind === 'resumed' ? first.run : f.previous.run); originalSdk(f, observed, [], null)
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.input).not.toHaveBeenCalled()
})
it('reconciles the same unknown Start without changing its original private options or replaying input', async () => {
  const f = await fixture({ healthy: true }), native = f.nativeStart
  f.start.mockImplementationOnce(async (spec: any) => { await native(spec); throw new core.AgentMuxError('Original Start acknowledgement unknown', 'CONTROL_UNAVAILABLE', undefined, { disposition: 'unknown', confirmedInputBytes: null }) })
  await expect(f.client.ensureAgentContinuity({ ...f.request, policy: { retryMaxAttempts: 0, recheckMaxAttempts: 0 } })).resolves.toMatchObject({ kind: 'pending', reason: 'operation-unconfirmed' })
  const frozen = (await f.saved()).continuityExecutors
  const { commandOverride: _command, args: _args, env: _env, ...same } = f.request
  await expect(f.client.ensureAgentContinuity(same)).resolves.toMatchObject({ kind: 'resumed' })
  expect((await f.saved()).continuityExecutors).toEqual(frozen); expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled()
  const observed = await f.next(f.previous.run); expect(observed.witness.program).toBe(f.scripts.sdk); await f.raw(observed.current)
  await recordConsumer('unknown-start', { witness: observed.witness, operation: observed.current.continuity, starts: f.start.mock.calls.length, inputCallsBeforeRaw: 0 })
})
it('Hosted and actual compiled CLI consume the original control without exposing private execution options', async () => {
  const f = await fixture(); await f.client.ensureAgentContinuity({ ...f.request, policy: { retryMaxAttempts: 0, retryInitialDelayMs: 10, retryMaxDelayMs: 10 } }); await f.phase('paused')
  const hosted = new core.AgentMuxHostedRuntimeService(f.client, f.root, () => ({ runtimeId: 'private-executor-owner', ownerInstanceId: 'private-executor-instance', protocolVersion: 2, processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }))
  cleanups.push(() => hosted.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const reader = await core.connectHostedAgentMux({ rpc }); cleanups.push(() => reader.dispose())
  const packet = await f.control(); await expect(reader.controlAgentContinuity(packet)).resolves.toMatchObject({ receipt: { outcome: 'continued' } })
  const observed = await f.next(packet.expectedRun); originalSdk(f, observed)
  const input = join(f.root, 'control.json'); await writeFile(input, JSON.stringify(packet))
  const control = await runCompiledObjectCli(['agent', 'continuity', 'control', '--input', input], objectCliEnvironment(f.root))
  expect(control.code, control.stderr).toBe(0); expect(JSON.parse(control.stdout).result.receipt.request).toEqual(packet)
  const before = f.start.mock.calls.length, inputs = f.input.mock.calls.length
  const inspect = await runCompiledObjectCli(['agent', 'inspect', '--session', f.previous.agentSessionId], objectCliEnvironment(f.root))
  expect(inspect.code, inspect.stderr).toBe(0)
  for (const publicValue of [control.stdout, inspect.stdout, JSON.stringify(await reader.statusAgent(f.previous.agentSessionId)), JSON.stringify(f.client.agentSession(f.previous.agentSessionId))]) {
    expect(publicValue).not.toContain(sentinel); expect(publicValue).not.toContain('continuityExecutors')
  }
  expect(f.start).toHaveBeenCalledTimes(before); expect(f.input).toHaveBeenCalledTimes(inputs); expect(f.stop).not.toHaveBeenCalled()
  await f.raw(observed.current)
  await recordConsumer('public-cli-hosted', { packet, control: JSON.parse(control.stdout), inspect: JSON.parse(inspect.stdout), witness: observed.witness, readStarts: f.start.mock.calls.length - before, readInputs: inputs, privateExcluded: true })
})

const configurationRequest = (f: Awaited<ReturnType<typeof fixture>>, operationId = rootId) => ({
  agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId, trigger: 'manual' as const
})
it('session configuration supports a standalone owner and its automatic context-only retry', async () => {
  const f = await fixture({ configuration: true, healthy: true })
  const first = await f.client.ensureAgentContinuity({ ...configurationRequest(f), trigger: 'startup',
    policy: { retryMaxAttempts: 1, retryInitialDelayMs: 20, retryMaxDelayMs: 20 } })
  await recordConsumer('configuration-first-observation', { first, saved: await f.saved() })
  expect(first.kind).toBe('resumed')
  const original = await f.next(f.previous.run)
  expect(original.witness).toMatchObject({ kind: 'owner', sentinel: 'configuration-current' })
  expect(original.witness.args.slice(0, 3)).toEqual(['configuration-argument', 'resume', 'original-native'])
  f.setConfiguration({ env: { SDK_RECOVERY_SENTINEL: 'configuration-after-exit' } })
  await f.client.writeAgent({ agentSessionId: f.previous.agentSessionId, expectedRun: original.current.run, source: 'user', data: 'fixture-exit7' })
  const recovered = await f.next(original.current.run)
  expect(recovered.witness).toMatchObject({ kind: 'owner', sentinel: 'configuration-after-exit' })
  expect(recovered.witness.args).toEqual(['configuration-argument', 'resume', 'original-native'])
  expect(f.configurationReader).toHaveBeenCalledWith(f.previous.executorId)
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.input).toHaveBeenCalledTimes(1)
  await recordConsumer('configuration-automatic', { original: original.witness, recovered: recovered.witness, sameNativeHandle: recovered.current.nativeHandle })
})
it('session configuration is consumed by an explicit restart without a registry', async () => {
  const f = await fixture({ configuration: true, healthy: true })
  await f.client.ensureAgentContinuity(configurationRequest(f)); const first = await f.next(f.previous.run)
  const reader = f.configurationReader.getMockImplementation()!, calls = f.configurationReader.mock.calls.length
  f.configurationReader.mockRejectedValue(new core.AgentMuxError('Original configuration temporarily unreadable', 'ORIGINAL_CONFIGURATION_UNAVAILABLE'))
  await expect(f.client.ensureAgentContinuity({ ...configurationRequest(f, 'healthy-original-reattach'), expectedRun: first.current.run })).resolves.toMatchObject({ kind: 'reattachable', run: first.current.run })
  expect(f.configurationReader).toHaveBeenCalledTimes(calls)
  await f.raw(first.current)
  f.configurationReader.mockImplementation(reader)
  const restarted = await f.client.restartAgent({ agentSessionId: f.previous.agentSessionId, expectedRun: first.current.run, operationId: 'configuration-restart' })
  const next = await f.next(first.current.run)
  expect(next.witness).toMatchObject({ kind: 'owner', sentinel: 'configuration-current' })
  expect(restarted.agentSessionId).toBe(f.previous.agentSessionId); expect(next.current.nativeHandle).toEqual(f.previous.nativeHandle)
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.input).toHaveBeenCalledTimes(1)
  await recordConsumer('configuration-restart', { original: first.current.run, restarted: next.current.run, witness: next.witness })
})
it('session configuration does not replace target-owned registry authority', async () => {
  const f = await fixture({ owner: true, configuration: true, healthy: true })
  const configured = await f.configure(f.scripts.owner, 'target-owner-authority')
  await f.mutate(value => ({ ...value, creation: { createOperationId: 'original-target-creation', initialPrompt: 'not-requested', intentDigest: 'd'.repeat(64), executorRevision: configured.executor.configRevision } }))
  await f.client.ensureAgentContinuity(configurationRequest(f)); const next = await f.next(f.previous.run)
  expect(next.witness).toMatchObject({ kind: 'owner', sentinel: 'target-owner-authority' })
  expect(next.witness.args).toEqual(['owner-argument', 'resume', 'original-native'])
  expect(f.configurationReader).not.toHaveBeenCalled(); expect(f.start).toHaveBeenCalledTimes(1)
})
it('session configuration retains explicit SDK roots and original history options', async () => {
  const f = await fixture({ owner: true, configuration: true, args: [], env: {} })
  const history = {}
  expect(await f.inner.sessionExecutorOptions(f.previous, history, f.previous.agentSessionId)).toEqual(history)
  const first = await f.client.ensureAgentContinuity(f.request)
  const next = await f.next(first.kind === 'resumed' ? first.run : f.previous.run)
  originalSdk(f, next, [], null); expect(f.configurationReader).not.toHaveBeenCalled()
  expect(f.start).toHaveBeenCalledTimes(2); expect(f.input).not.toHaveBeenCalled()
})
it.each(['unreadable', 'provider-conflict'] as const)('session configuration %s retains the original identity without fallback', async failure => {
  const f = await fixture({ owner: true, configuration: true, healthy: true })
  if (failure === 'unreadable') f.configurationReader.mockRejectedValue(new core.AgentMuxError('Original configuration unreadable', 'ORIGINAL_CONFIGURATION_UNAVAILABLE'))
  else f.setConfiguration({ providerId: 'another-provider' })
  const request = configurationRequest(f)
  const result = await f.client.ensureAgentContinuity(request)
  expect(result.kind).not.toBe('resumed')
  expect((await f.saved()).continuity).toMatchObject({ errorCode: failure === 'unreadable' ? 'ORIGINAL_CONFIGURATION_UNAVAILABLE' : 'EXECUTOR_PROVIDER_CONFLICT' })
  expect(f.start).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect(f.client.agentSession(f.previous.agentSessionId)).toMatchObject({ run: f.previous.run, nativeHandle: f.previous.nativeHandle, workspacePath: f.previous.workspacePath })
  f.configurationReader.mockReset(); f.configurationReader.mockResolvedValue({ label: 'Restored original', providerId: f.provider.id, command: f.scripts.owner!, args: [], env: {}, injectAgentMuxGuide: false })
  await expect(f.client.ensureAgentContinuity(request)).resolves.toMatchObject({ kind: 'resumed' })
  expect((await f.next(f.previous.run)).witness.kind).toBe('owner')
})
