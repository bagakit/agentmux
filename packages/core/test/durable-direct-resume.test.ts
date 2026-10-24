import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import * as Source from '../src/index.js'
import { agentLifecycleOperationIdentity } from '../src/agent-session-store.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import type { AgentMuxAgentResumeInput } from '../src/agent-session-recovery.js'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession } from '../src/types.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const core: typeof Source & Record<string, any> = process.env.AGENTMUX_TEST_DURABLE_RESUME_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_DURABLE_RESUME_ENTRY)
  : { ...Source, ...await import('../src/public-rpc-server.js'), ...await import('../src/hosted-runtime-service.js') }
if (process.env.AGENTMUX_TEST_DURABLE_RESUME_MUTANT) expect(Reflect.get(core, 'AGENTMUX_DURABLE_RESUME_MUTANT')).toBe(process.env.AGENTMUX_TEST_DURABLE_RESUME_MUTANT)
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(delivery: 'positional-argv' | 'post-launch-only' = 'positional-argv', fatal = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'adr-')))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
  const runtime = join(root, 'r'), state = join(root, 's')
  await mkdir(runtime); await mkdir(state)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const daemon = spawn(process.env.AGENTMUX_TEST_CTXMUXD ?? resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonError = ''; daemon.stderr!.on('data', bytes => { daemonError += String(bytes) })
  cleanups.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited }
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(daemonError) })])
  const provider = core.defineAgentProvider({ catalog: { id: 'resume-process', label: 'Controlled resume process', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: delivery, readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
    ...(fatal ? { terminalHandshake: { query: '\x1b[?u', response: '\x1b[?0u' } } : {}),
    buildArgs: (_prompt, args) => [...args], buildResumeArgs: (id, _path, prompt, args) => [...args, id, ...(prompt ? [prompt] : [])], hook: { rules: [] } })
  const storePath = join(root, 'sessions.sqlite'), clients: Array<any> = []
  async function reader() {
    const store = new core.AgentMuxFileAgentSessionStore(storePath), client = new core.AgentMuxClient({ store, providers: [provider] }), inner = client as any
    Object.defineProperty(inner.hookServer, 'port', { value: 0 }); await client.connect()
    const value = { store, client, inner, nativeStart: inner.kernel.start.bind(inner.kernel), nativeList: inner.kernel.list.bind(inner.kernel),
      start: vi.spyOn(inner.kernel, 'start'), stop: vi.spyOn(inner.kernel, 'stop'), input: vi.spyOn(inner.kernel, 'input') }
    clients.push(value); return value
  }
  const original = await reader()
  cleanups.push(async () => {
    for (const value of clients.slice().reverse()) {
      if (value.inner.kernel.isConnected()) for (const run of await value.nativeList()) if (run.state.type === 'running') await value.inner.kernel.stop(await value.inner.kernel.prepareStop(run.runId))
      await value.client.dispose()
      // Runtime exit callbacks can already be queued for this private Session.
      // Drain that original metadata owner before deleting its fixture files.
      await value.inner.registry.enqueue('original-session', async () => {})
    }
  })
  const ended = await original.nativeStart({ operationKey: 'original-seed', program: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root, env: {} })
  await vi.waitFor(async () => expect((await original.inner.kernel.status(ended.runId)).state.type).toBe('exited'))
  const previous: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-session', providerId: provider.id, executorId: 'configured-resume',
    hostId: 'local', workspacePath: root, run: { runId: ended.runId }, retiredRuns: [], createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1),
    hookBindingId: 'original-binding', hookToken: 'original-token', nativeHandle: { kind: 'provider', providerId: provider.id, sessionId: 'original-native' } }
  await original.store.compareAndSwap(null, previous); await original.inner.registry.load('local')
  const program = fatal ? "console.log('Error: controlled startup exit');process.exit(1)" : "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d.toString()));console.log('LAUNCH:'+JSON.stringify(process.argv.slice(1)));setInterval(()=>{},1000)"
  const request: AgentMuxAgentResumeInput = { agentSessionId: previous.agentSessionId, operationId: 'original-resume', prompt: 'the frozen original task',
    agentMuxNote: 'explicit context', args: ['-e', program], env: { RESUME_FIXTURE: 'original' }, cols: 81, rows: 25 }
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
  return { ...original, root, previous, request, provider, reader, resume, replay, write, noReplacement, correlation }
}

it('freezes direct native resume input and exact plan before Start with no automatic recovery text', async () => {
  const f = await fixture(), start = f.nativeStart
  f.start.mockImplementation(async (input: any) => {
    const prepared = await f.correlation(), op = prepared?.preparedSession?.continuity
    expect(prepared, 'Original native resume request is not prepared').toBeDefined()
    expect(prepared?.operationId).toBe(input.operationKey)
    expect(op).toMatchObject({ trigger: 'input', requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), recoveryInputs: { reminder: '', continuation: '' },
      previousRun: f.previous.run, nativeTarget: f.previous.nativeHandle, launchInput: { state: 'prepared', input: { prompt: f.request.prompt, agentMuxNote: f.request.agentMuxNote,
        submissionId: `launch-prompt:${input.operationKey}` }, launchPlan: { program: '/usr/bin/env' } } })
    expect(op!.launchInput!.prompt).toBe(input.args.at(-1)); expect(input.args.at(-2)).toBe('original-native')
    return await start(input)
  })
  const resumed = await f.resume()
  expect(resumed.continuity).toMatchObject({ kind: 'resumed', launchInput: { state: 'launch-carried', receipt: { run: resumed.run } } })
  expect(await f.correlation()).toBeUndefined()
  expect((await f.resume()).run).toEqual(resumed.run); f.noReplacement()
  await f.write(resumed)
})

it('keeps acknowledged direct resume work and original prepared input after commit was not applied', async () => {
  const f = await fixture(), commit = vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('Controlled commit rejected'))
  const outcome = await f.resume().then(value => ({ value }), error => ({ error }))
  expect(outcome).not.toHaveProperty('error')
  const resumed = (outcome as { value: AgentMuxAgentSession }).value
  expect(resumed.continuity).toMatchObject({ reason: 'operation-unconfirmed', newRun: resumed.run })
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(f.previous.run)
  expect((await f.client.readAgentSessions())[0]!.run).toEqual(resumed.run)
  await f.inner.registry.load('local'); expect(f.client.agentSession(f.previous.agentSessionId).run).toEqual(resumed.run)
  expect((await f.client.refreshAgentSession(f.previous.agentSessionId)).run).toEqual(resumed.run)
  f.noReplacement(); await f.write(resumed)
  commit.mockRestore(); const recovered = await f.resume()
  expect(recovered.run).toEqual(resumed.run); expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(resumed.run)
  f.noReplacement(1)
})

it('reads the same direct resume receipt after applied commit ACK loss', async () => {
  const f = await fixture(), commit = f.store.commitLifecycle.bind(f.store)
  vi.spyOn(f.store, 'commitLifecycle').mockImplementationOnce(async (...args: any[]) => { await commit(...args as [any, any]); throw new Error('Controlled commit ACK lost') })
  const resumed = await f.resume(), same = await f.resume()
  expect(same.run).toEqual(resumed.run); expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(resumed.run)
  f.noReplacement(); await f.write(same)
})

it('reconciles an applied direct Start with lost ACK after dispose without another Start or input', async () => {
  const f = await fixture(); let actual: any
  f.start.mockImplementationOnce(async (input: any) => { actual = await f.nativeStart(input); throw new core.AgentMuxError('Lost original Start ACK', 'CONTROL_UNAVAILABLE', undefined, { disposition: 'unknown', confirmedInputBytes: null }) })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  expect((await f.correlation())?.preparedSession?.continuity?.launchInput?.state).toBe('prepared')
  const observation = vi.spyOn(f.inner.kernel, 'inspectCreation').mockResolvedValueOnce(null)
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' }); observation.mockRestore()
  await f.client.dispose(); const second = await f.reader(), recovery = f.resume({}, second)
  await expect(recovery).resolves.toMatchObject({ agentSessionId: f.previous.agentSessionId, run: { runId: actual.runId } })
  const recovered = await recovery
  expect(recovered.run.runId).toBe(actual.runId); expect(recovered.nativeHandle).toEqual(f.previous.nativeHandle)
  f.noReplacement(); await f.write(recovered, second)
})

it('does not claim a foreign lifecycle or repeat an unknown Start without a matching original Run', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new core.AgentMuxError('Original Start unknown', 'CONTROL_UNAVAILABLE'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const originalStart: any = f.start.mock.calls[0]![0]
  const foreign = await f.nativeStart({ ...originalStart, operationKey: 'foreign-operation', env: { ...originalStart.env, AGENTMUX_LIFECYCLE_OPERATION_ID: 'foreign-operation' } })
  expect(foreign.lifecycleOperationId).toBe('foreign-operation')
  const inventory = vi.spyOn(f.inner.kernel, 'list').mockRejectedValue(new Error('Unrelated inventory unavailable'))
  vi.spyOn(f.inner.kernel, 'inspectCreation').mockResolvedValueOnce(foreign)
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(f.previous.run); expect(await f.correlation()).toBeDefined(); f.noReplacement(); expect(inventory).not.toHaveBeenCalled()
})

it.each([{ prompt: 'changed task' }, { agentMuxNote: 'changed context' }, { args: ['-e', 'process.exit(1)'] },
  { env: { RESUME_FIXTURE: 'changed' } }, { cols: 93 }, { commandOverride: 'another-command' }])('rejects changed direct input or launch intent against the immutable original operation: %j', async patch => {
  const f = await fixture()
  f.start.mockImplementationOnce(async (input: any) => { await f.nativeStart(input); throw new core.AgentMuxError('Original Start unknown', 'CONTROL_UNAVAILABLE') })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const original = await f.correlation()
  await expect(f.resume(patch)).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(await f.correlation()).toEqual(original); f.noReplacement()
})

it('serializes same-client original operation and preserves strict distinct-operation running rejection', async () => {
  const f = await fixture(), results = await Promise.all([f.resume(), f.resume()])
  expect(results[0].run).toEqual(results[1].run)
  await expect(f.resume({ operationId: 'different-resume' })).rejects.toMatchObject({ code: 'AGENT_SESSION_STILL_RUNNING' })
  f.noReplacement()
})

it('admits one direct resume across independent FileStore clients and reconciles their original receipt', async () => {
  const f = await fixture(), second = await f.reader(), prepare = f.store.prepareResume.bind(f.store)
  let release!: () => void, entered!: () => void
  const arrived = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
  vi.spyOn(f.store, 'prepareResume').mockImplementationOnce(async (...args: any[]) => { const result = await prepare(...args as [any, any]); entered(); await held; return result })
  const first = f.resume(); await arrived
  try { await expect(f.resume({}, second)).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' }) } finally { release() }
  const resumed = await first
  expect((await f.resume({}, second)).run).toEqual(resumed.run); f.noReplacement()
})

it('delivers post-launch-only direct input once through the original frozen submission key', async () => {
  const f = await fixture('post-launch-only'), resumed = await f.resume()
  const original = resumed.continuity!.launchInput!
  expect(original).toMatchObject({ delivery: 'post-launch', state: 'terminal-confirmed', input: { submissionId: expect.stringMatching(/^launch-prompt:/u) } })
  // PTY reads can split a long payload anywhere. The controlled process marks
  // each received chunk, so remove those marks before checking the exact wire.
  await vi.waitFor(async () => expect((await f.replay(resumed)).replaceAll('\r\n', '\n').replaceAll('INPUT:', '')).toContain(original.prompt))
  expect((await f.resume()).run).toEqual(resumed.run)
  expect((await f.client.inspectAgentPromptSubmission(original.key!))?.admission).toMatchObject({ acknowledged: true })
  f.noReplacement(1)
})

it('retains the original unknown post-launch claim without replay after retry', async () => {
  const f = await fixture('post-launch-only'), nativeInput = f.input.getMockImplementation()!
  f.input.mockImplementationOnce(async (...args: any[]) => { await nativeInput(...args); throw new core.AgentMuxError('Original input ACK lost', 'CONTROL_UNAVAILABLE') })
  const resumed = await f.resume(), original = resumed.continuity!.launchInput!
  expect(original).toMatchObject({ delivery: 'post-launch', state: 'unknown' })
  const before = f.input.mock.calls.length
  expect((await f.resume()).run).toEqual(resumed.run)
  expect(f.input).toHaveBeenCalledTimes(before); expect(before).toBe(1); expect(f.stop).not.toHaveBeenCalled()
})

it('releases unused direct preparation for an authoritatively not-applied Start', async () => {
  const f = await fixture()
  f.start.mockImplementationOnce(async (input: { operationKey: string }) => {
    throw new core.AgentMuxError('Start not applied', 'CONTROL_UNAVAILABLE', undefined, undefined, undefined,
      { operationId: input.operationKey, disposition: 'not_applied' })
  })
  await expect(f.resume()).rejects.toMatchObject({ creationFailure: { disposition: 'not_applied' } })
  expect(await f.correlation()).toBeUndefined(); expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(f.previous.run)
  expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})

it.each(['foreign-operation', 'input-receipt', 'unknown-start'] as const)('retains direct resume preparation for a %s negative receipt', async kind => {
  const f = await fixture()
  const storageFailure = { stage: 'start' as const, sqlitePrimaryCode: 14, sqliteExtendedCode: 14,
    systemErrno: 2, transactionOutcome: 'not_started' as const }
  const original = new core.AgentMuxError('Original Start transport outcome unknown', 'CTXMUX_io', undefined,
    kind === 'input-receipt' ? { disposition: 'not_applied', confirmedInputBytes: null } : undefined,
    undefined, kind === 'foreign-operation' ? { operationId: 'unrelated-start', disposition: 'not_applied' }
      : kind === 'unknown-start' ? { operationId: agentLifecycleOperationIdentity('resume', f.previous.agentSessionId, f.request.operationId), disposition: 'unknown' } : undefined, storageFailure)
  f.start.mockRejectedValueOnce(original)
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED', cause: original, storageFailure,
    creationFailure: { operationId: agentLifecycleOperationIdentity('resume', f.previous.agentSessionId, f.request.operationId), disposition: 'unknown' } })
  expect(await f.correlation()).toMatchObject({ preparedSession: { run: f.previous.run } })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  f.noReplacement()
})

it('existing Hosted direct resume and actual public CLI inspect share the original typed receipt', async () => {
  const f = await fixture()
  const hosted = new core.AgentMuxHostedRuntimeService(f.client, f.store.path, () => ({ runtimeId: 'resume-runtime', ownerInstanceId: 'resume-owner', protocolVersion: 2,
    processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }))
  cleanups.push(() => hosted.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const reader = await core.connectHostedAgentMux({ rpc }); cleanups.push(() => reader.dispose())
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('Controlled Hosted commit rejected'))
  const resumed = await reader.resumeAgent(f.request)
  expect(resumed.continuity!.reason).toBe('operation-unconfirmed')
  if (process.env.AGENTMUX_TEST_OBJECT_CLI) {
    const inspected = await runCompiledObjectCli(['agent', 'inspect', '--session', f.previous.agentSessionId], objectCliEnvironment(f.root))
    expect(inspected.code, inspected.stderr).toBe(0)
    expect(JSON.parse(inspected.stdout)).toMatchObject({ ok: true, result: { session: { run: resumed.run,
      continuity: { reason: 'operation-unconfirmed', requestDigest: resumed.continuity!.requestDigest, launchInput: { state: 'launch-carried' } } } } })
  } else expect((await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: f.previous.agentSessionId } })).session.run).toEqual(resumed.run)
  expect((await reader.resumeAgent(f.request)).run).toEqual(resumed.run)
  f.noReplacement()
})

it('reconciles post-launch-only Start ACK loss before dispatching the original first input once', async () => {
  const f = await fixture('post-launch-only')
  f.start.mockImplementationOnce(async (input: any) => { await f.nativeStart(input); throw new core.AgentMuxError('Original Start ACK lost', 'CONTROL_UNAVAILABLE') })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' }); expect(f.input).not.toHaveBeenCalled()
  await f.client.dispose(); const second = await f.reader(), resumed = await f.resume({}, second)
  expect(resumed.continuity!.launchInput).toMatchObject({ delivery: 'post-launch', state: 'terminal-confirmed' })
  expect((await f.resume({}, second)).run).toEqual(resumed.run); f.noReplacement(1)
})

it('rejects a mismatching actual RunSpec without claiming or replacing the original unknown Start', async () => {
  const f = await fixture(); let actual: any
  f.start.mockImplementationOnce(async (input: any) => { actual = await f.nativeStart(input); throw new core.AgentMuxError('Original Start ACK lost', 'CONTROL_UNAVAILABLE') })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  vi.spyOn(f.inner.kernel, 'inspectCreation').mockResolvedValueOnce({ ...actual, program: 'foreign-program' })
  await expect(f.resume()).rejects.toMatchObject({ code: 'CONTINUITY_OPERATION_MISMATCH' })
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(f.previous.run); f.noReplacement()
})

it('does not retain an unconfirmed started projection after its original canonical Host changes', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('Controlled commit rejected'))
  const resumed = await f.resume(), old = (await f.store.readMetadata(f.previous.agentSessionId))!
  await f.store.compareAndSwapMetadata(old, { ...old, hostId: 'foreign-host' })
  expect((await f.client.readAgentSessions())[0]!.hostId).toBe('foreign-host')
  await expect(f.resume()).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  expect((await f.inner.kernel.status(resumed.run.runId)).state.type).toBe('running'); f.noReplacement()
})

it('does not revive the prepared projection after authoritative user retirement', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('Controlled commit rejected'))
  await f.resume(); const reservation = (await f.correlation())!
  await f.store.releaseLifecycle(reservation)
  const retired = { reservationId: 'user-retirement', ownerId: 'private-user-owner', ownerPid: process.pid,
    expiresAt: Date.now() + 1000, kind: 'stop' as const, agentSessionId: f.previous.agentSessionId, operationId: 'user-stop', expectedRun: f.previous.run,
    stopOperation: { daemonInstance: 'private-runtime', operationKey: 'user-stop', runId: f.previous.run.runId } }
  await f.store.reserveLifecycle(retired); await f.store.commitLifecycle(retired, null)
  expect(await f.client.readAgentSessions()).toEqual([])
  await expect(f.resume()).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  expect(await f.store.loadRetiredAgentSessions()).toEqual([expect.objectContaining({ source: 'user', agentSessionId: f.previous.agentSessionId })]); f.noReplacement()
})


it('reports an already-exited original Start as typed fatal after ACK loss without replaying its task', async () => {
  const f = await fixture('positional-argv', true); let actual: any
  f.start.mockImplementationOnce(async (input: any) => { actual = await f.nativeStart(input); throw new core.AgentMuxError('Original Start ACK lost', 'CONTROL_UNAVAILABLE') })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  await vi.waitFor(async () => expect((await f.inner.kernel.status(actual.runId)).state.type).toBe('exited'))
  await f.client.dispose(); const second = await f.reader()
  await expect(f.resume({}, second)).rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED', message: expect.stringContaining('controlled startup exit') })
  const original = (await second.store.readMetadata(f.previous.agentSessionId))!.continuityOperations![f.request.operationId]!
  expect(original).toMatchObject({ errorCode: 'AGENT_TERMINAL_HANDSHAKE_FAILED', reason: 'process-exited', newRun: { runId: actual.runId } })
  await expect(f.resume({}, second)).rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' }); f.noReplacement()
})


it.each(['executorId', 'workspacePath'] as const)('does not overwrite a changed original canonical %s while reconciling prepared resume', async field => {
  const f = await fixture()
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('Controlled commit rejected'))
  const resumed = await f.resume(), old = (await f.store.readMetadata(f.previous.agentSessionId))!
  await f.store.compareAndSwapMetadata(old, { ...old, [field]: field === 'workspacePath' ? join(f.root, 'another-workspace') : 'another-executor' })
  expect((await f.client.readAgentSessions())[0]!.run).toEqual(f.previous.run)
  await expect(f.resume()).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect((await f.store.readMetadata(f.previous.agentSessionId))?.[field]).not.toBe(f.previous[field])
  expect((await f.inner.kernel.status(resumed.run.runId)).state.type).toBe('running'); f.noReplacement()
})

it('keeps the prepared operation after a real fatal exit and unconfirmed original commit', async () => {
  const f = await fixture('positional-argv', true)
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('Controlled commit rejected'))
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' })
  expect(await f.correlation()).toBeDefined(); expect((await f.store.readMetadata(f.previous.agentSessionId))?.run).toEqual(f.previous.run)
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' })
  f.noReplacement()
})

it('keeps a real failed recovery terminal through source CLI reads and permits a separate explicit recovery', async () => {
  const f = await fixture('positional-argv', true)
  const request = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: 'failed-manual-recovery',
    trigger: 'manual' as const, args: f.request.args!, env: f.request.env! }
  const failure = { code: 'AGENT_TERMINAL_HANDSHAKE_FAILED', message: expect.stringContaining('controlled startup exit') }
  await expect(f.client.ensureAgentContinuity(request)).rejects.toMatchObject(failure)
  const failed = (await f.store.readMetadata(f.previous.agentSessionId))!, operation = failed.continuityOperations![request.operationId]!
  expect(failed).toMatchObject({ run: f.previous.run, nativeHandle: f.previous.nativeHandle,
    retiredRuns: [operation.newRun], continuity: { kind: 'unavailable', reason: 'process-exited', errorCode: failure.code, error: failure.message } })
  expect((await f.inner.kernel.status(operation.newRun!.runId)).state).toMatchObject({ type: 'exited', code: 1 })
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanups.push(() => server.stop())
  const env = objectCliEnvironment(f.root, { NODE_NO_WARNINGS: '1' })
  for (let i = 0; i < 2; i++) {
    const checked = await runSourceObjectCli(['agent', 'resume', '--session', f.previous.agentSessionId, '--operation-id', request.operationId], env)
    expect(checked.code, checked.stderr).toBe(1)
    expect(JSON.parse(checked.stderr)).toMatchObject({ ok: false, error: { code: failure.code, message: failure.message } })
  }
  const inspected = await runSourceObjectCli(['agent', 'inspect', '--session', f.previous.agentSessionId], env)
  expect(inspected.code, inspected.stderr).toBe(0)
  expect(JSON.parse(inspected.stdout)).toMatchObject({ ok: true, result: { session: { run: f.previous.run, nativeHandle: f.previous.nativeHandle,
    continuity: operation, continuityOperations: { [request.operationId]: operation } } } })
  expect(f.start).toHaveBeenCalledOnce(); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  const healthy = "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d));process.stdout.write('\\x1b[?u');setInterval(()=>{},1000)"
  const recovered = await f.client.ensureAgentContinuity({ ...request, operationId: 'new-explicit-recovery', args: ['-e', healthy] })
  expect(recovered.kind).toBe('resumed')
  if (recovered.kind !== 'resumed') throw new Error('Explicit recovery did not return its actual Run')
  expect(recovered.run).not.toEqual(f.previous.run); expect(recovered.run).not.toEqual(operation.newRun)
  expect(recovered.session.nativeHandle).toEqual(f.previous.nativeHandle)
  const saved = (await f.store.readMetadata(f.previous.agentSessionId))!
  expect(saved.continuityOperations![request.operationId]).toEqual(operation)
  expect(saved.retiredRuns).toEqual([operation.newRun, f.previous.run])
  await expect(f.client.ensureAgentContinuity(request)).rejects.toMatchObject(failure)
  const oldResult = await runSourceObjectCli(['agent', 'resume', '--session', f.previous.agentSessionId, '--operation-id', request.operationId], env)
  expect(oldResult.code, oldResult.stderr).toBe(1)
  expect(JSON.parse(oldResult.stderr)).toMatchObject({ ok: false, error: { code: failure.code, message: failure.message } })
  expect(await f.store.readMetadata(f.previous.agentSessionId)).toEqual(saved)
  expect((await f.inner.kernel.status(recovered.run.runId)).state.type).toBe('running')
  await expect(f.client.ensureAgentContinuity({ ...request, operationId: 'new-explicit-recovery', args: ['-e', healthy] }))
    .resolves.toMatchObject({ kind: 'resumed', run: recovered.run })
  const before = f.input.mock.calls.length
  await f.client.writeAgent({ agentSessionId: f.previous.agentSessionId, expectedRun: recovered.run, source: 'user', data: 'still-usable' })
  await vi.waitFor(async () => expect(await f.replay(recovered)).toContain('INPUT:still-usable'))
  expect(f.input).toHaveBeenCalledTimes(before + 1); expect(f.start).toHaveBeenCalledTimes(2); expect(f.stop).not.toHaveBeenCalled()
})

it('keeps an unknown recovery Start reconcilable after a new Core owner without classifying it as a rolled-back failure', async () => {
  const f = await fixture()
  const request = { agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run, operationId: f.request.operationId,
    trigger: 'manual' as const, args: f.request.args!, env: f.request.env! }
  f.start.mockImplementationOnce(async (input: any) => { await f.nativeStart(input); throw new core.AgentMuxError('Original Start ACK lost', 'CONTROL_UNAVAILABLE') })
  await expect(f.client.ensureAgentContinuity(request)).resolves.toMatchObject({ kind: 'pending', reason: 'operation-unconfirmed' })
  expect((await f.store.readMetadata(f.previous.agentSessionId))!.run).toEqual(f.previous.run)
  expect(await f.correlation()).toBeDefined()
  await f.client.dispose(); const second = await f.reader()
  const restored = await second.client.ensureAgentContinuity(request)
  expect(restored.kind).toBe('resumed')
  if (restored.kind !== 'resumed') throw new Error('Original Start was not reconciled')
  await f.write(restored.session, second)
  await expect(second.client.ensureAgentContinuity(request)).resolves.toMatchObject({ kind: 'resumed', run: restored.run })
  f.noReplacement(1)
})
