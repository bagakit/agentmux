import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as Source from '../src/index.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentMuxAgentRestartIdentity } from '../src/agent-session-recovery/restart-contract.js'
import { createWorkspaceLayout } from '../src/spatial-layout.js'

const core: typeof Source & Record<string, any> = process.env.AGENTMUX_TEST_RESTART_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_RESTART_ENTRY)
  : { ...await import('../src/index.js'), ...await import('../src/public-rpc-server.js'), ...await import('../src/hosted-runtime-service.js') }
if (process.env.AGENTMUX_TEST_RESTART_MUTANT) expect(core.AGENTMUX_RESTART_MUTANT).toBe(process.env.AGENTMUX_TEST_RESTART_MUTANT)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const program = "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d.toString()));console.log('LAUNCH:'+JSON.stringify(process.argv.slice(1)));setInterval(()=>{},1000)"
function provider(resumable = true, fatal = false) {
  return core.defineAgentProvider({ catalog: { id: 'restart-process', label: 'Private restart process', executable: process.execPath,
    expectedProcess: 'node', promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'node' },
    hookStrategy: { kind: 'none' }, resumeStrategy: resumable ? { kind: 'provider-native', locator: 'session-id' } : { kind: 'none' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: resumable, replyCorrelation: 'none' } },
    ...(fatal ? { terminalHandshake: { query: '\x1b[?u', response: '\x1b[?0u' } } : {}),
    buildArgs: (_prompt: any, args: any) => args,
    buildResumeArgs: (id: string, _path: string, prompt: string | undefined) => ['-e', fatal ? "console.log('Private startup failed');process.exit(1)" : program, id, ...(prompt ? [prompt] : [])], hook: { rules: [] } })
}
// Private legacy fixture injection only: emulate a previous binary's already committed row.
function injectLegacySession(path: string, session: AgentMuxStoredAgentSession) {
  const db = new DatabaseSync(path)
  try { db.prepare('UPDATE sessions SET json=? WHERE id=?').run(JSON.stringify(session), session.agentSessionId) }
  finally { db.close() }
}
async function fixture(ended = false, native = true, resumable = true, fatal = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amr-')))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
  const runtime = join(root, 'r'), state = join(root, 's')
  await mkdir(runtime); await mkdir(state)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const daemon = spawn(process.env.AGENTMUX_TEST_CTXMUXD ?? resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let error = ''; daemon.stderr!.on('data', bytes => { error += String(bytes) })
  cleanups.push(async () => { if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited }; await rm(root, { recursive: true, force: true }) })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(error) })])
  const storePath = join(root, 'sessions.sqlite'), readers: any[] = []
  async function reader(observe?: (event: any) => void) {
    const store = new core.AgentMuxFileAgentSessionStore(storePath), client = new core.AgentMuxClient({ store, providers: [provider(resumable, fatal)] }), inner = client as any
    Object.defineProperty(inner.hookServer, 'port', { value: 0 }); if (observe) inner.publisher.onStatusEvent(observe); await client.connect()
    const value = { store, client, inner, nativeStart: inner.kernel.start.bind(inner.kernel), nativeList: inner.kernel.list.bind(inner.kernel),
      nativeStop: inner.kernel.stop.bind(inner.kernel), start: vi.spyOn(inner.kernel, 'start'), stop: vi.spyOn(inner.kernel, 'stop'), input: vi.spyOn(inner.kernel, 'input') }
    readers.push(value); return value
  }
  const first = await reader()
  cleanups.push(async () => { for (const value of readers.slice().reverse()) { if (value.inner.kernel.isConnected()) for (const run of await value.nativeList()) if (run.state.type === 'running') await value.nativeStop(await value.inner.kernel.prepareStop(run.runId)); await value.client.dispose() } })
  const seed = await first.nativeStart({ operationKey: 'restart-original-seed', program: process.execPath,
    args: ended ? ['-e', 'process.exit(0)'] : ['-e', program, 'original-native'], cwd: root, env: {} })
  if (ended) await vi.waitFor(async () => expect((await first.inner.kernel.status(seed.runId)).state.type).toBe('exited'))
  const original: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'restart-original', providerId: 'restart-process', executorId: 'restart-process',
    hostId: 'local', workspacePath: root, run: { runId: seed.runId }, retiredRuns: [], createdAt: _tailFixtureEpoch(0, 0, 1000), updatedAt: _tailFixtureEpoch(0, 0, 1000),
    hookBindingId: 'original-hook', hookToken: 'private-hook', ...(native ? { nativeHandle: { kind: 'provider' as const, providerId: 'restart-process', sessionId: 'original-native' } } : {}) }
  await first.store.compareAndSwap(null, original); await first.inner.registry.load('local')
  const unrelated = await first.nativeStart({ operationKey: 'unrelated-seed', program: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: root, env: {} })
  const request: AgentMuxAgentRestartIdentity = { agentSessionId: original.agentSessionId, expectedRun: original.run, operationId: 'original-restart' }
  const restart = (owner = first) => owner.client.restartAgent(request)
  async function invariants(owner = first, starts = 1, stops = ended ? 0 : 1) {
    expect(readers.reduce((n, one) => n + one.start.mock.calls.length, 0)).toBe(starts)
    expect(readers.reduce((n, one) => n + one.stop.mock.calls.length, 0)).toBe(stops)
    for (const one of readers) expect(one.input).not.toHaveBeenCalled()
    expect((await owner.inner.kernel.status(unrelated.runId)).state.type).toBe('running')
    expect(await owner.store.readRetiredAgentSession(original.agentSessionId)).toBeNull()
    expect((await owner.store.readMetadata(original.agentSessionId))?.nativeHandle).toEqual(original.nativeHandle)
  }
  return { ...first, root, original, request, reader, restart, invariants, unrelated, storePath }
}

it('atomically records the original receipt before an interrupted admission returns', async () => {
  const f = await fixture(), reserve = f.inner.registry.reserveRestart.bind(f.inner.registry)
  vi.spyOn(f.inner.registry, 'reserveRestart').mockImplementationOnce(async (...args: any[]) => {
    await reserve(...args)
    const metadata = await f.store.readMetadata(f.original.agentSessionId)
    expect(metadata?.continuityOperations?.[f.request.operationId]).toMatchObject({ action: 'restart', previousRun: f.original.run })
    throw new Error('Private owner interruption after admission')
  })
  await expect(f.restart()).rejects.toThrow('Private owner interruption after admission')
  expect((await f.inner.kernel.status(f.original.run.runId)).state.type).toBe('running')
  await f.client.dispose(); const second = await f.reader()
  const retained = second.client.agentSession(f.original.agentSessionId).continuityOperations?.[f.request.operationId]
  expect(retained).toMatchObject({ action: 'restart', operationId: f.request.operationId })
  const observed = await second.client.ensureAgentContinuity({ ...f.request, operationId: 'startup-observer', trigger: 'startup' })
  expect(observed.kind).toBe('reattachable')
  expect((await second.store.readMetadata(f.original.agentSessionId))?.continuityOperations?.[f.request.operationId]).toEqual(retained)
  await f.restart(second); await f.invariants(second)
})
it('restores a legacy missing receipt only after the original owner releases it', async () => {
  const f = await fixture(), reserve = f.inner.registry.reserveRestart.bind(f.inner.registry)
  vi.spyOn(f.inner.registry, 'reserveRestart').mockImplementationOnce(async (...args: any[]) => {
    await reserve(...args)
    const session = (await f.store.readMetadata(f.original.agentSessionId))!
    const { [f.request.operationId]: _removed, ...other } = session.continuityOperations!
    injectLegacySession(f.storePath, { ...session, continuity: undefined, continuityOperations: other })
    throw new Error('Legacy interruption before receipt')
  })
  await expect(f.restart()).rejects.toThrow('Legacy interruption before receipt')
  const foreign = await f.reader()
  expect((await foreign.store.readMetadata(f.original.agentSessionId))?.continuityOperations?.[f.request.operationId]).toBeUndefined()
  await expect(f.restart(foreign)).rejects.toMatchObject({ code: 'AGENT_SESSION_BUSY' })
  await f.client.dispose(); const owner = await f.reader()
  expect(owner.client.agentSession(f.original.agentSessionId).continuityOperations?.[f.request.operationId]).toMatchObject({ action: 'restart', previousRun: f.original.run })
  await f.restart(owner); await f.invariants(owner)
})
it('reports a conflicting legacy same-ID receipt without overwriting it or blocking other Sessions', async () => {
  const f = await fixture(), reserve = f.inner.registry.reserveRestart.bind(f.inner.registry)
  vi.spyOn(f.inner.registry, 'reserveRestart').mockImplementationOnce(async (...args: any[]) => {
    await reserve(...args)
    const session = (await f.store.readMetadata(f.original.agentSessionId))!
    const { [f.request.operationId]: _removed, ...other } = session.continuityOperations!
    injectLegacySession(f.storePath, { ...session, continuity: undefined, continuityOperations: other })
    throw new Error('Legacy owner interruption')
  })
  await expect(f.restart()).rejects.toThrow('Legacy owner interruption')
  await expect(f.client.ensureAgentContinuity({ ...f.request, trigger: 'startup' })).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
  const generic = await f.client.ensureAgentContinuity({ ...f.request, operationId: 'other-observer', trigger: 'startup' })
  expect(generic.kind).toBe('reattachable')
  const current = (await f.store.readMetadata(f.original.agentSessionId))!
  // Simulate an older version which wrote this same-ID generic receipt before this fence existed.
  const before = { ...generic.continuity, operationId: f.request.operationId }
  const contaminated = { ...current, continuity: before,
    continuityOperations: { ...current.continuityOperations, [f.request.operationId]: before } }
  await expect(f.store.compareAndSwapMetadata(current, contaminated)).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
  await expect(f.store.compareAndSwap(current, contaminated)).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
  injectLegacySession(f.storePath, contaminated)
  expect(before.action).toBeUndefined()
  await f.client.dispose()
  const events: any[] = [], owner = await f.reader(event => events.push(event))
  expect(events).toContainEqual(expect.objectContaining({ type: 'agent-error', agentSessionId: f.original.agentSessionId,
    code: 'AGENT_RESTART_RECEIPT_UNCONFIRMED', message: expect.stringContaining(f.request.operationId) }))
  expect((await owner.store.readMetadata(f.original.agentSessionId))!.continuityOperations![f.request.operationId]).toEqual(before)
  expect(await owner.client.inspectAgentRestart(f.request)).toMatchObject({ phase: 'unconfirmed', canRetry: false, detail: expect.stringContaining('retained receipt') })
  expect((await owner.inner.kernel.status(f.original.run.runId)).state.type).toBe('running')
  expect((await owner.inner.kernel.status(f.unrelated.runId)).state.type).toBe('running')
  expect(owner.start).not.toHaveBeenCalled(); expect(owner.input).not.toHaveBeenCalled()
  await owner.client.stopAgent(f.original.agentSessionId, f.original.run)
  expect(await owner.store.readRetiredAgentSession(f.original.agentSessionId)).toMatchObject({ history: { nativeHandle: f.original.nativeHandle } })
})
it('a legacy receipt with a different native target is retained and reported as unconfirmed', async () => {
  const f = await fixture(), reserve = f.inner.registry.reserveRestart.bind(f.inner.registry)
  vi.spyOn(f.inner.registry, 'reserveRestart').mockImplementationOnce(async (...args: any[]) => { await reserve(...args); throw new Error('Legacy target conflict') })
  await expect(f.restart()).rejects.toThrow('Legacy target conflict')
  const session = (await f.store.readMetadata(f.original.agentSessionId))!, prior = session.continuityOperations![f.request.operationId]
  const conflict = { ...prior, nativeTarget: { ...prior.nativeTarget!, sessionId: 'another-native' } }
  injectLegacySession(f.storePath, { ...session, continuity: conflict, continuityOperations: { ...session.continuityOperations, [f.request.operationId]: conflict } })
  await f.client.dispose()
  const events: any[] = [], owner = await f.reader(event => events.push(event))
  expect(events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_RESTART_RECEIPT_UNCONFIRMED', message: expect.stringContaining(f.request.operationId) }))
  expect((await owner.store.readMetadata(f.original.agentSessionId))?.continuityOperations?.[f.request.operationId]).toEqual(conflict)
  expect(await owner.client.inspectAgentRestart(f.request)).toMatchObject({ phase: 'unconfirmed', canRetry: false, detail: expect.stringContaining('retained receipt') })
  expect((await owner.inner.kernel.status(f.original.run.runId)).state.type).toBe('running')
  await owner.client.stopAgent(f.original.agentSessionId, f.original.run)
  expect(await owner.store.readRetiredAgentSession(f.original.agentSessionId)).toMatchObject({ history: { nativeHandle: f.original.nativeHandle } })
})
it('a conflicting receipt with unknown prepared Start does not suggest or perform close', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new core.AgentMuxError('Private Start result unknown', 'CONTROL_UNAVAILABLE'))
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const session = (await f.store.readMetadata(f.original.agentSessionId))!, prior = session.continuityOperations![f.request.operationId]
  const conflict = { ...prior, nativeTarget: { ...prior.nativeTarget!, sessionId: 'another-native' } }
  injectLegacySession(f.storePath, { ...session, continuity: conflict, continuityOperations: { ...session.continuityOperations, [f.request.operationId]: conflict } })
  await f.client.dispose(); const owner = await f.reader()
  const before = await owner.store.readLifecycleReservation(f.original.agentSessionId)
  expect(before?.preparedSession).toBeDefined()
  const inspection = await owner.client.inspectAgentRestart(f.request)
  expect(inspection).toMatchObject({ phase: 'unconfirmed', canRetry: false, detail: expect.stringContaining('original Start') })
  expect(inspection.detail).not.toContain('close the exact Session')
  await expect(owner.client.stopAgent(f.original.agentSessionId, f.original.run)).rejects.toMatchObject({ code: 'AGENT_SESSION_BUSY' })
  expect(await owner.store.readLifecycleReservation(f.original.agentSessionId)).toEqual(before)
  expect((await owner.store.readMetadata(f.original.agentSessionId))!.continuityOperations![f.request.operationId]).toEqual(conflict)
  expect(owner.start).not.toHaveBeenCalled(); expect(owner.input).not.toHaveBeenCalled()
})
it('a found prepared Start cannot overwrite a conflicting original receipt on reconnect', async () => {
  const f = await fixture(); let successor: any
  f.start.mockImplementationOnce(async (input: any) => { successor = await f.nativeStart(input); throw new core.AgentMuxError('Private Start ACK lost', 'CONTROL_UNAVAILABLE') })
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const session = (await f.store.readMetadata(f.original.agentSessionId))!, prior = session.continuityOperations![f.request.operationId]
  const conflict = { ...prior, nativeTarget: { ...prior.nativeTarget!, sessionId: 'another-native' } }
  injectLegacySession(f.storePath, { ...session, continuity: conflict, continuityOperations: { ...session.continuityOperations, [f.request.operationId]: conflict } })
  await f.client.dispose(); const owner = await f.reader()
  expect((await owner.store.readMetadata(f.original.agentSessionId))!.continuityOperations![f.request.operationId]).toEqual(conflict)
  expect((await owner.store.readLifecycleReservation(f.original.agentSessionId))?.preparedSession).toBeDefined()
  const inspection = await owner.client.inspectAgentRestart(f.request)
  expect(inspection).toMatchObject({ phase: 'unconfirmed', canRetry: false, newRun: { runId: successor.runId }, detail: expect.stringContaining('original Start was found') })
  expect(inspection.detail).not.toContain('resolve the conflict')
  expect(inspection.detail).not.toContain('close the exact Session')
  expect((await owner.inner.kernel.status(successor.runId)).state.type).toBe('running')
  await expect(owner.client.stopAgent(f.original.agentSessionId, f.original.run)).rejects.toMatchObject({ code: 'AGENT_SESSION_BUSY' })
  expect(owner.start).not.toHaveBeenCalled(); expect(owner.input).not.toHaveBeenCalled()
})
it('exact restart receipt writes do not scan unrelated Sessions', async () => {
  const f = await fixture(), reserve = f.inner.registry.reserveRestart.bind(f.inner.registry)
  vi.spyOn(f.inner.registry, 'reserveRestart').mockImplementationOnce(async (...args: any[]) => { await reserve(...args); throw new Error('Pause admitted restart') })
  await expect(f.restart()).rejects.toThrow('Pause admitted restart')
  const reservation = await f.store.readLifecycleReservation(f.original.agentSessionId)
  const read = vi.spyOn(f.store as any, 'read'), write = vi.spyOn(f.store as any, 'write')
  const metadata = vi.spyOn(f.store as any, 'sessionMetadata'), save = vi.spyOn(f.store as any, 'saveSession')
  const measure = async () => {
    read.mockClear(); write.mockClear(); metadata.mockClear(); save.mockClear()
    await f.store.recordRestartAdmission(reservation)
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
    return [metadata.mock.calls.length, save.mock.calls.length]
  }
  const baseline = await measure()
  for (let i = 0; i < 20; i++) await f.store.compareAndSwap(null, { ...f.original, agentSessionId: `unrelated-${i}`,
    run: { runId: `unrelated-run-${i}` }, nativeHandle: { ...f.original.nativeHandle!, sessionId: `unrelated-native-${i}` } })
  expect(await measure()).toEqual(baseline)
  expect(baseline).toEqual([1, 1])
})
it('restart admission touches only the target as unrelated Session count grows', async () => {
  async function measure(size: number) {
    const f = await fixture()
    for (let i = 0; i < size; i++) await f.store.compareAndSwap(null, { ...f.original, agentSessionId: `admission-other-${i}`,
      run: { runId: `admission-other-run-${i}` }, nativeHandle: { ...f.original.nativeHandle!, sessionId: `admission-other-native-${i}` } })
    const read = vi.spyOn(f.store as any, 'read'), write = vi.spyOn(f.store as any, 'write')
    const metadata = vi.spyOn(f.store as any, 'sessionMetadata'), save = vi.spyOn(f.store as any, 'saveSession')
    const reserve = f.store.reserveLifecycle.bind(f.store)
    let counts: number[] = []
    vi.spyOn(f.store, 'reserveLifecycle').mockImplementationOnce(async (value: any) => {
      read.mockClear(); write.mockClear(); metadata.mockClear(); save.mockClear()
      await reserve(value)
      counts = [read.mock.calls.length, write.mock.calls.length, metadata.mock.calls.length, save.mock.calls.length]
      throw new Error('Private interrupted admission')
    })
    await expect(f.restart()).rejects.toThrow('Private interrupted admission')
    return counts
  }
  const baseline = await measure(0)
  expect(await measure(20)).toEqual(baseline)
  expect(baseline).toEqual([0, 0, 1, 1])
})
it('Memory Store atomically publishes admission and fences a superseding Stop', async () => {
  const f = await fixture(), reserve = f.inner.registry.reserveRestart.bind(f.inner.registry)
  vi.spyOn(f.inner.registry, 'reserveRestart').mockImplementationOnce(async (...args: any[]) => { await reserve(...args); throw new Error('Pause for Store comparison') })
  await expect(f.restart()).rejects.toThrow('Pause for Store comparison')
  const original = await f.store.readLifecycleReservation(f.original.agentSessionId)
  const memory = new core.AgentMuxMemoryAgentSessionStore()
  await memory.compareAndSwap(null, f.original)
  await memory.reserveLifecycle(original)
  expect((await memory.readMetadata(f.original.agentSessionId))?.continuityOperations?.[f.request.operationId]).toMatchObject({ action: 'restart' })
  await memory.reserveLifecycle({ kind: 'stop', reservationId: 'other-reservation', operationId: 'other-stop',
    ownerId: original.ownerId, ownerPid: original.ownerPid, agentSessionId: original.agentSessionId,
    expectedRun: original.expectedRun, stopOperation: original.restart.stopOperation, expiresAt: original.expiresAt })
  await expect(memory.recordRestartAdmission(original)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect((await memory.readLifecycleReservation(f.original.agentSessionId))?.kind).toBe('stop')
})
it.each(['new', 'legacy'] as const)('a dead owner process retains the original %s restart before Stop', async kind => {
  const f = await fixture()
  const entry = process.env.AGENTMUX_TEST_RESTART_CHILD_ENTRY ?? process.env.AGENTMUX_TEST_RESTART_ENTRY ?? new URL('../dist/index.js', import.meta.url).href
  const code = `import * as core from ${JSON.stringify(entry)};const program=${JSON.stringify(program)};const provider=${provider.toString()};const store=new core.AgentMuxFileAgentSessionStore(${JSON.stringify(f.storePath)});const client=new core.AgentMuxClient({store,providers:[provider()]});Object.defineProperty(client.hookServer,'port',{value:0});await client.connect();const reserve=client.registry.reserveRestart.bind(client.registry);client.registry.reserveRestart=async (...args)=>{await reserve(...args);if(${JSON.stringify(kind)}==='legacy'){const current=await store.readMetadata(${JSON.stringify(f.original.agentSessionId)});const operations={...current.continuityOperations};delete operations[${JSON.stringify(f.request.operationId)}];const db=new (await import('node:sqlite')).DatabaseSync(${JSON.stringify(f.storePath)});db.prepare('UPDATE sessions SET json=? WHERE id=?').run(JSON.stringify({...current,continuity:undefined,continuityOperations:operations}),current.agentSessionId);db.close()}process.exit(77)};await client.restartAgent(${JSON.stringify(f.request)});process.exit(78)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''; child.stderr!.on('data', value => { stderr += String(value) })
  const [exit] = await once(child, 'exit')
  expect(exit, stderr).toBe(77)
  expect((await f.inner.kernel.status(f.original.run.runId)).state.type).toBe('running')
  const next = await f.reader()
  expect(next.client.agentSession(f.original.agentSessionId).continuityOperations?.[f.request.operationId]).toMatchObject({ action: 'restart', previousRun: f.original.run })
  expect((await next.client.ensureAgentContinuity({ ...f.request, operationId: 'startup-observer', trigger: 'startup' })).kind).toBe('reattachable')
  await f.restart(next); await f.invariants(next)
})
it.each(['file', 'memory'] as const)('%s Store fences full and metadata CAS on original restart identity', async kind => {
  const f = await fixture(), reserve = f.inner.registry.reserveRestart.bind(f.inner.registry)
  vi.spyOn(f.inner.registry, 'reserveRestart').mockImplementationOnce(async (...args: any[]) => { await reserve(...args); throw new Error('Pause for CAS test') })
  await expect(f.restart()).rejects.toThrow('Pause for CAS test')
  const reservation = await f.store.readLifecycleReservation(f.original.agentSessionId)
  const store = kind === 'file' ? f.store : new core.AgentMuxMemoryAgentSessionStore()
  if (kind === 'memory') { await store.compareAndSwap(null, f.original); await store.reserveLifecycle(reservation) }
  for (const method of ['compareAndSwap', 'compareAndSwapMetadata'] as const) {
    for (const mutation of ['remove', 'digest', 'run', 'native'] as const) {
      const current = (await store.readMetadata(f.original.agentSessionId))!
      const original = current.continuityOperations![f.request.operationId]
      const altered = mutation === 'remove' ? undefined : { ...original,
        ...(mutation === 'digest' ? { requestDigest: 'other' } : {}),
        ...(mutation === 'run' ? { previousRun: { runId: 'other-run' } } : {}),
        ...(mutation === 'native' ? { nativeTarget: { ...original.nativeTarget!, sessionId: 'other-native' } } : {}) }
      const operations = { ...current.continuityOperations }
      if (altered) operations[f.request.operationId] = altered; else delete operations[f.request.operationId]
      await expect(store[method](current, { ...current, continuityOperations: operations })).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
    }
    const current = (await store.readMetadata(f.original.agentSessionId))!
    const original = current.continuityOperations![f.request.operationId]
    const badPointer = { ...original, action: undefined }
    await expect(store[method](current, { ...current, continuity: badPointer })).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
    const otherPointer = { ...original, operationId: 'unrelated-pointer', action: undefined }
    await expect(store[method](current, { ...current, continuity: otherPointer })).resolves.toBeUndefined()
    const latest = (await store.readMetadata(f.original.agentSessionId))!
    const phase = { ...original, kind: 'pending', reason: 'operation-unconfirmed' }
    await expect(store[method](latest, { ...latest, continuityOperations: { ...latest.continuityOperations, [f.request.operationId]: phase } })).resolves.toBeUndefined()
  }
})
it('a healthy original Run accepts a new authorized input while a live owner holds restart', async () => {
  const f = await fixture(), reserve = f.inner.registry.reserveRestart.bind(f.inner.registry)
  vi.spyOn(f.inner.registry, 'reserveRestart').mockImplementationOnce(async (...args: any[]) => { await reserve(...args); throw new Error('Owner stopped before Stop') })
  await expect(f.restart()).rejects.toThrow('Owner stopped before Stop')
  const other = await f.reader(), original = (await other.store.readMetadata(f.original.agentSessionId))!.continuityOperations![f.request.operationId]
  await other.client.writeAgent({ agentSessionId: f.original.agentSessionId, expectedRun: f.original.run, data: 'new-authorized-input', source: 'user' })
  await vi.waitFor(async () => expect((await other.client.readRunReplay(f.original.run)).replay.map((chunk: any) => chunk.data).join('')).toContain('INPUT:new-authorized-input'))
  await expect(other.client.ensureAgentContinuity({ ...f.request, trigger: 'input', input: { submissionId: 'new-authored', prompt: 'do not conflate' } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect((await other.store.readMetadata(f.original.agentSessionId))!.continuityOperations![f.request.operationId]).toEqual(original)
  expect(other.start).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
  expect((await other.inner.kernel.status(f.unrelated.runId)).state.type).toBe('running')
})
it('an unavailable lifecycle observation preserves healthy input and fences the unknown same-ID write', async () => {
  const f = await fixture(), reserve = f.inner.registry.reserveRestart.bind(f.inner.registry)
  vi.spyOn(f.inner.registry, 'reserveRestart').mockImplementationOnce(async (...args: any[]) => {
    await reserve(...args)
    const session = (await f.store.readMetadata(f.original.agentSessionId))!
    const { [f.request.operationId]: _removed, ...other } = session.continuityOperations!
    injectLegacySession(f.storePath, { ...session, continuity: undefined, continuityOperations: other })
    throw new Error('Legacy interruption')
  })
  await expect(f.restart()).rejects.toThrow('Legacy interruption')
  const events: any[] = [], observer = await f.reader(event => events.push(event))
  vi.spyOn(observer.store, 'readLifecycleReservation').mockRejectedValue(new Error('Private lifecycle read unavailable'))
  const result = await observer.client.ensureAgentContinuity({ ...f.request, operationId: 'healthy-observer', trigger: 'startup' })
  expect(result.kind).toBe('reattachable')
  await observer.client.writeAgent({ agentSessionId: f.original.agentSessionId, expectedRun: f.original.run, data: 'fresh-input-under-observation-failure', source: 'user' })
  await vi.waitFor(async () => expect((await observer.client.readRunReplay(f.original.run)).replay.map((chunk: any) => chunk.data).join('')).toContain('INPUT:fresh-input-under-observation-failure'))
  await expect(observer.client.ensureAgentContinuity({ ...f.request, trigger: 'input', input: { submissionId: 'protected-original', prompt: 'do-not-replay' } })).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
  expect((await observer.store.readMetadata(f.original.agentSessionId))?.continuityOperations?.[f.request.operationId]).toBeUndefined()
  expect(events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_LIFECYCLE_OBSERVATION_UNCONFIRMED', agentSessionId: f.original.agentSessionId }))
  expect(f.start).not.toHaveBeenCalled(); expect(observer.start).not.toHaveBeenCalled()
})
it('reports lifecycle and Run observation failures without asserting the Run is healthy or starting a replacement', async () => {
  const f = await fixture(), reserve = f.inner.registry.reserveRestart.bind(f.inner.registry)
  vi.spyOn(f.inner.registry, 'reserveRestart').mockImplementationOnce(async (...args: any[]) => { await reserve(...args); throw new Error('Interruption') })
  await expect(f.restart()).rejects.toThrow('Interruption')
  const events: any[] = [], observer = await f.reader(event => events.push(event))
  vi.spyOn(observer.store, 'readLifecycleReservation').mockRejectedValue(new Error('Private lifecycle read unavailable'))
  vi.spyOn(observer.inner.kernel, 'status').mockRejectedValue(new Error('Private Run status unavailable'))
  const result = await observer.client.ensureAgentContinuity({ ...f.request, operationId: 'unknown-observer', trigger: 'startup' })
  expect(result.kind).toBe('pending')
  const error = events.find(event => event.code === 'AGENT_LIFECYCLE_OBSERVATION_UNCONFIRMED')
  expect(error?.message).toContain('check this exact Run')
  expect(error?.message).not.toContain('Run and input remain available')
  expect(observer.start).not.toHaveBeenCalled(); expect(observer.input).not.toHaveBeenCalled()
})
it('a late admission cannot recreate a restart after exact Stop replaces its reservation', async () => {
  const f = await fixture(), reserve = f.inner.registry.reserveRestart.bind(f.inner.registry)
  let entered!: () => void, release!: () => void
  const admitted = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(f.inner.registry, 'reserveRestart').mockImplementationOnce(async (...args: any[]) => {
    const result = await reserve(...args); entered(); await waiting; return result
  })
  const restarting = f.restart().catch(error => error)
  await admitted
  try { await f.client.stopAgent(f.original.agentSessionId, f.original.run) } finally { release() }
  expect(await restarting).toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(await f.store.readMetadata(f.original.agentSessionId)).toBeNull()
  expect(f.start).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
  expect((await f.inner.kernel.status(f.unrelated.runId)).state.type).toBe('running')
})
it('a generic same-ID reader cannot overwrite an intervening atomic restart admission', async () => {
  const f = await fixture(), observer = await f.reader()
  let paused!: () => void, releaseObserver!: () => void, admitted!: () => void, releaseRestart!: () => void
  const readerPaused = new Promise<void>(resolve => { paused = resolve }), readerWait = new Promise<void>(resolve => { releaseObserver = resolve })
  const restartAdmitted = new Promise<void>(resolve => { admitted = resolve }), restartWait = new Promise<void>(resolve => { releaseRestart = resolve })
  const cas = observer.store.compareAndSwapMetadata.bind(observer.store)
  vi.spyOn(observer.store, 'compareAndSwapMetadata').mockImplementationOnce(async (...args: any[]) => { paused(); await readerWait; return await cas(...args) })
  const reserve = f.inner.registry.reserveRestart.bind(f.inner.registry)
  vi.spyOn(f.inner.registry, 'reserveRestart').mockImplementationOnce(async (...args: any[]) => { const result = await reserve(...args); admitted(); await restartWait; return result })
  const generic = observer.client.ensureAgentContinuity({ ...f.request, trigger: 'startup' }).catch((error: unknown) => error)
  await readerPaused
  const restarting = f.restart().catch((error: unknown) => error)
  await restartAdmitted
  try {
    releaseObserver()
    expect(await generic).toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
    expect((await f.store.readMetadata(f.original.agentSessionId))?.continuityOperations?.[f.request.operationId]).toMatchObject({ action: 'restart', kind: 'starting' })
  } finally { releaseRestart() }
  expect(await restarting).toMatchObject({ agentSessionId: f.original.agentSessionId })
  await f.invariants(f)
})
it('restarts the exact working Run once, retains native identity and never submits old input', async () => {
  const f = await fixture(), stopped = f.nativeStop
  f.stop.mockImplementationOnce(async (operation: any) => {
    const reservation = await f.store.readLifecycleReservation(f.original.agentSessionId)
    expect(reservation?.kind).toBe('resume'); expect(reservation?.restart?.stopOperation).toEqual(operation)
    expect((await f.store.readMetadata(f.original.agentSessionId))?.continuity).toMatchObject({ action: 'restart', reason: 'restart-stopping', previousRun: f.original.run })
    await stopped(operation)
  })
  const next = await f.restart()
  expect(next.agentSessionId).toBe(f.original.agentSessionId); expect(next.nativeHandle).toEqual(f.original.nativeHandle)
  expect(next.run).not.toEqual(f.original.run); expect(next.retiredRuns).toContainEqual(f.original.run)
  expect((await f.restart()).run).toEqual(next.run)
  expect(await f.client.inspectAgentRestart(f.request)).toMatchObject({ phase: 'restarted', canRetry: false, previousRun: f.original.run, newRun: next.run })
  await vi.waitFor(async () => expect((await f.client.readRunReplay(next.run)).replay.map((chunk: any) => chunk.data).join('')).toContain('LAUNCH:["original-native"]'))
  await f.invariants()
})
it('restores an ended original without stopping any Run', async () => { const f = await fixture(true); await f.restart(); await f.invariants() })
it.each(['native', 'provider', 'stale', 'prompt'] as const)('rejects invalid %s prerequisites before stopping useful work', async kind => {
  const f = await fixture(false, kind !== 'native', kind !== 'provider')
  const request = { ...f.request, ...(kind === 'stale' ? { expectedRun: { runId: f.unrelated.runId } } : {}), ...(kind === 'prompt' ? { prompt: 'old unknown prompt' } : {}) }
  await expect(f.client.restartAgent(request as any)).rejects.toMatchObject({ code: kind === 'stale' ? 'STALE_AGENT_SESSION' : kind === 'prompt' ? 'INVALID_AGENT_RESTART' : 'AGENT_RESUME_UNAVAILABLE' })
  expect(f.stop).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
  expect((await f.inner.kernel.status(f.original.run.runId)).state.type).toBe('running')
})
it('keeps one original Stop identity after an unknown receipt and permits its explicit retry', async () => {
  const f = await fixture()
  f.stop.mockRejectedValueOnce(new core.AgentMuxError('Private Stop reply lost before receipt', 'CONTROL_UNAVAILABLE'))
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESTART_UNCONFIRMED' })
  expect(await f.client.inspectAgentRestart(f.request)).toMatchObject({ phase: 'stopping', canRetry: true })
  expect(f.start).not.toHaveBeenCalled()
  const originalStop = f.stop.mock.calls[0]![0]
  const admittedAt = (await f.store.readMetadata(f.original.agentSessionId))!.continuity!.admittedAt
  const next = await f.restart()
  expect(f.stop.mock.calls[1]![0]).toEqual(originalStop)
  expect(next.run).not.toEqual(f.original.run)
  expect(next.continuity!.admittedAt).toBe(admittedAt)
  await f.invariants(f, 1, 2)
})
it('recovers an applied Stop with lost reply after the original Core owner is disposed', async () => {
  const f = await fixture()
  f.stop.mockImplementationOnce(async (operation: any) => { await f.nativeStop(operation); throw new Error('Private original Stop ACK lost') })
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESTART_UNCONFIRMED' })
  expect(f.start).not.toHaveBeenCalled(); await f.client.dispose()
  const second = await f.reader()
  expect(await second.store.readMetadata(f.original.agentSessionId)).not.toBeNull()
  await f.restart(second); await f.invariants(second)
})
it('startup and restored generic observers preserve the original restart receipt and frozen executor', async () => {
  const f = await fixture()
  f.stop.mockImplementationOnce(async (operation: any) => { await f.nativeStop(operation); throw new Error('Original Stop reply lost') })
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESTART_UNCONFIRMED' })
  const original = (await f.store.readMetadata(f.original.agentSessionId))!.continuity!
  for (const operationId of ['new-startup-observer', f.request.operationId]) {
    await expect(f.client.ensureAgentContinuity({ ...f.request, operationId, trigger: 'startup' })).resolves.toMatchObject({
      kind: 'pending', reason: 'operation-unconfirmed', continuity: original })
    expect((await f.store.readMetadata(f.original.agentSessionId))!.continuity).toEqual(original)
  }
  // Reproduce a receipt polluted by an older observer. Reconnection must not
  // run its legacy timer through the generic executor reconstruction again.
  const current = (await f.store.readMetadata(f.original.agentSessionId))!
  const polluted = { ...original, kind: 'pending' as const, reason: 'provider-unverified',
    nextActionAt: Date.now() + 60, errorCode: 'AGENT_CONTINUITY_EXECUTOR_UNCONFIRMED' }
  await f.store.compareAndSwap(current, { ...current, continuity: polluted,
    continuityOperations: { ...current.continuityOperations, [original.operationId]: polluted } })
  await f.client.dispose()
  const second = await f.reader()
  await new Promise(resolve => setTimeout(resolve, 120))
  expect((await second.store.readMetadata(f.original.agentSessionId))!.continuityOperations![original.operationId]).toEqual(polluted)
  await expect(f.restart(second)).resolves.toMatchObject({
    continuity: { action: 'restart', operationId: original.operationId, kind: 'resumed' } })
  await f.invariants(second)
})
it.each([false, true])('explicit close supersedes an unprepared restart without starting a replacement (Stop applied=%s)', async applied => {
  const f = await fixture()
  f.stop.mockImplementationOnce(async (operation: any) => { if (applied) await f.nativeStop(operation); throw new Error('Original Stop reply lost') })
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESTART_UNCONFIRMED' })
  const old = await f.store.readLifecycleReservation(f.original.agentSessionId)
  expect(old).toMatchObject({ kind: 'resume', restart: expect.any(Object) }); expect(old.preparedSession).toBeUndefined()
  await f.client.dispose(); const second = await f.reader()
  await expect(second.client.stopAgent(f.original.agentSessionId, f.original.run)).resolves.toBeUndefined()
  expect(second.start).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
  expect(await second.store.readMetadata(f.original.agentSessionId)).toBeNull()
  expect(await second.store.readRetiredAgentSession(f.original.agentSessionId)).toMatchObject({
    agentSessionId: f.original.agentSessionId, history: { nativeHandle: f.original.nativeHandle } })
  await expect(second.inner.registry.prepareResume(old, f.original)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect((await second.inner.kernel.status(f.unrelated.runId)).state.type).toBe('running')
  expect(second.input).not.toHaveBeenCalled()
})
it('explicit close cannot discard a prepared unknown replacement Start', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new core.AgentMuxError('Original Start result unknown', 'CONTROL_UNAVAILABLE'))
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  await f.client.dispose(); const second = await f.reader()
  const before = await second.store.readLifecycleReservation(f.original.agentSessionId)
  expect(before.preparedSession).toBeDefined()
  await expect(second.client.stopAgent(f.original.agentSessionId, f.original.run)).rejects.toMatchObject({ code: 'AGENT_SESSION_BUSY' })
  expect(await second.store.readLifecycleReservation(f.original.agentSessionId)).toEqual(before)
  expect(second.start).not.toHaveBeenCalled(); expect(second.stop).not.toHaveBeenCalled()
  expect((await second.inner.kernel.status(f.unrelated.runId)).state.type).toBe('running')
})
it('close wins atomically against a late original restart reader before Start preparation', async () => {
  const f = await fixture(); let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  f.stop.mockImplementationOnce(async (operation: any) => { await f.nativeStop(operation); await waiting })
  const restarting = f.restart().catch(error => error)
  await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1))
  await vi.waitFor(async () => expect((await f.inner.kernel.status(f.original.run.runId)).state.type).not.toBe('running'))
  try { await f.client.stopAgent(f.original.agentSessionId, f.original.run) }
  finally { release() }
  expect(await restarting).toBeInstanceOf(Error)
  expect(f.start).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
  expect(await f.store.readRetiredAgentSession(f.original.agentSessionId)).toMatchObject({ agentSessionId: f.original.agentSessionId })
  expect((await f.inner.kernel.status(f.unrelated.runId)).state.type).toBe('running')
})
it('a live foreign restart owner cannot be stolen by close', async () => {
  const f = await fixture()
  f.stop.mockRejectedValueOnce(new Error('Original Stop reply unknown'))
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESTART_UNCONFIRMED' })
  const second = await f.reader()
  await expect(second.client.stopAgent(f.original.agentSessionId, f.original.run)).rejects.toMatchObject({ code: 'AGENT_SESSION_BUSY' })
  expect(second.start).not.toHaveBeenCalled(); expect(second.stop).not.toHaveBeenCalled()
  expect((await f.inner.kernel.status(f.original.run.runId)).state.type).toBe('running')
})
it('the original prepareResume cannot overwrite an admitted Stop before its retirement commits', async () => {
  const f = await fixture()
  f.stop.mockImplementationOnce(async (operation: any) => { await f.nativeStop(operation); throw new Error('Original Stop reply lost') })
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESTART_UNCONFIRMED' })
  const restart = await f.store.readLifecycleReservation(f.original.agentSessionId)
  let release!: () => void, admitted!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve }), admission = new Promise<void>(resolve => { admitted = resolve })
  const commit = f.store.commitLifecycle.bind(f.store)
  vi.spyOn(f.store, 'commitLifecycle').mockImplementation(async (reservation: any, session: any) => {
    if (reservation.kind === 'stop') { admitted(); await waiting }
    return await commit(reservation, session)
  })
  const closing = f.client.stopAgent(f.original.agentSessionId, f.original.run).catch(error => error)
  try {
    await admission
    const stop = await f.store.readLifecycleReservation(f.original.agentSessionId)
    expect(stop.kind).toBe('stop')
    await expect(f.store.prepareResume(restart, f.original)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    expect(await f.store.readLifecycleReservation(f.original.agentSessionId)).toEqual(stop)
  } finally { release(); await closing }
  expect(await closing).toBeUndefined()
  expect(f.start).not.toHaveBeenCalled()
})
it('reconciles an applied Start with lost reply without another Start or successor Stop', async () => {
  const f = await fixture(); let actual: any
  f.start.mockImplementationOnce(async (input: any) => { actual = await f.nativeStart(input); throw new core.AgentMuxError('Private original Start ACK lost', 'CONTROL_UNAVAILABLE') })
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const inventory = vi.spyOn(f.inner.kernel, 'list').mockRejectedValue(new Error('Unrelated inventory unavailable'))
  expect(await f.client.inspectAgentRestart(f.request)).toMatchObject({ phase: 'starting', newRun: { runId: actual.runId } })
  expect(inventory).not.toHaveBeenCalled()
  await f.client.dispose(); const second = await f.reader()
  await expect(f.restart(second)).resolves.toMatchObject({ run: { runId: actual.runId } }); await f.invariants(second)
})
it('keeps completed original restart discovery after another explicit restart replaces its successor', async () => {
  const f = await fixture(), first = await f.restart()
  const original = (await f.store.readMetadata(f.original.agentSessionId))!.continuityOperations![f.request.operationId]
  await expect(f.client.ensureAgentContinuity(f.request)).resolves.toMatchObject({ kind: 'resumed', run: first.run, continuity: original })
  await expect(f.client.ensureAgentContinuity({ ...f.request, expectedRun: { runId: f.unrelated.runId } })).rejects.toMatchObject({ code: 'CONTINUITY_OPERATION_MISMATCH' })
  await expect(f.client.ensureAgentContinuity({ ...f.request, trigger: 'input', input: { submissionId: 'another-input', prompt: 'not part of restart' } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  const second = await f.client.restartAgent({ ...f.request, expectedRun: first.run, operationId: 'second-restart' })
  expect(second.run).not.toEqual(first.run)
  expect(await f.client.inspectAgentRestart(f.request)).toMatchObject({ phase: 'restarted', newRun: first.run })
  await expect(f.client.ensureAgentContinuity(f.request)).resolves.toMatchObject({ kind: 'conflict', reason: 'session-run-changed', currentRun: second.run, continuity: original })
  expect((await f.store.readMetadata(f.original.agentSessionId))!.continuityOperations![f.request.operationId]).toEqual(original)
  await expect(f.restart()).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' }); await f.invariants(f, 2, 2)
})
it('the real Hosted, public service and compiled CLI consume the same original restart operation', async () => {
  const f = await fixture()
  const hosted = new core.AgentMuxHostedRuntimeService(f.client, f.store.path, () => ({ runtimeId: 'restart-runtime', ownerInstanceId: 'restart-owner', protocolVersion: 2,
    processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }))
  cleanups.push(() => hosted.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hosted })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const hostedClient = await core.connectHostedAgentMux({ rpc }); cleanups.push(() => hostedClient.dispose())
  const next = await hostedClient.restartAgent(f.request)
  await expect(rpc.call('agent.restart', f.request)).resolves.toMatchObject({ session: { run: next.run } })
  expect(await hostedClient.inspectAgentRestart(f.request)).toMatchObject({ phase: 'restarted', newRun: next.run })
  const env = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + join(f.root, 'control.sock') })
  const args = ['--session', f.original.agentSessionId, '--run', f.original.run.runId, '--operation-id', f.request.operationId]
  for (const action of [['agent', 'restart'], ['agent', 'restart', 'inspect']]) {
    const reply = await runCompiledObjectCli([...action, ...args], env)
    expect(reply.code, reply.stderr).toBe(0)
    expect(JSON.parse(reply.stdout)).toMatchObject({ ok: true, result: action.length === 2 ? { session: { run: next.run } } : { phase: 'restarted', newRun: next.run } })
  }
  const stale = await runCompiledObjectCli(['agent', 'restart', '--session', f.original.agentSessionId, '--run', f.unrelated.runId, '--operation-id', 'stale-public-restart'], env)
  expect(stale.code).toBe(1); expect(JSON.parse(stale.stderr)).toMatchObject({ ok: false, error: { code: 'STALE_AGENT_SESSION' } })
  const help = await runCompiledObjectCli(['agent', 'restart', '--help'], env)
  expect(help.stdout).toContain('--run ID'); expect(help.stdout).toContain('original'); expect(help.stdout).toContain('never replays')
  await f.invariants()
})
it('retains an unknown Start without a candidate and never dispatches a second Start', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new core.AgentMuxError('Private Start transport outcome unknown', 'CONTROL_UNAVAILABLE'))
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  expect(await f.client.inspectAgentRestart(f.request)).toMatchObject({ phase: 'unconfirmed', canRetry: false })
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESTART_UNCONFIRMED' })
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1)
  expect(await f.store.readMetadata(f.original.agentSessionId)).not.toBeNull()
})
it('refuses a different request under the original operation without stopping its successor', async () => {
  const f = await fixture(); await f.restart()
  await expect(f.client.restartAgent({ ...f.request, cols: 121 })).rejects.toMatchObject({ code: 'AGENT_RESTART_CONFLICT' })
  await f.invariants()
})
it('keeps a healthy Run and input capability when Runtime observation for restart is unknown', async () => {
  const f = await fixture()
  const observe = f.inner.kernel.status.bind(f.inner.kernel)
  vi.spyOn(f.inner.kernel, 'status').mockImplementation(async (id: string) => { if (id === f.original.run.runId) throw new Error('Private Runtime observation unavailable'); return observe(id) })
  await expect(f.restart()).rejects.toThrow('Private Runtime observation unavailable')
  expect(f.stop).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
  expect((await f.store.readMetadata(f.original.agentSessionId))?.run).toEqual(f.original.run)
})
it('rejects a second owner while the original Stop is executing and prevents another Start', async () => {
  const f = await fixture(); let release!: () => void
  const wait = new Promise<void>(done => { release = done })
  f.stop.mockImplementationOnce(async (operation: any) => { await wait; await f.nativeStop(operation) })
  const first = f.restart()
  await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1))
  let disposed = false
  const disposal = f.client.dispose().then(() => { disposed = true })
  await new Promise(done => setTimeout(done, 5)); expect(disposed).toBe(false)
  const second = await f.reader()
  await expect(f.restart(second)).rejects.toMatchObject({ code: 'AGENT_SESSION_BUSY' })
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESTART_OWNER_DISPOSED' })
  release(); await first; await disposal; await f.invariants(second)
})
it.each(['Stop', 'Start'] as const)('a distinct process recovers the original interrupted restart after lost %s reply without retiring its Session', async stage => {
  const f = await fixture(); let originalSuccessor: any
  if (stage === 'Stop') f.stop.mockImplementationOnce(async (operation: any) => { await f.nativeStop(operation); throw new Error('Original private Stop reply lost') })
  else f.start.mockImplementationOnce(async (input: any) => { originalSuccessor = await f.nativeStart(input); throw new core.AgentMuxError('Original private Start reply lost', 'CONTROL_UNAVAILABLE') })
  await expect(f.restart()).rejects.toMatchObject({ code: stage === 'Stop' ? 'AGENT_RESTART_UNCONFIRMED' : 'AGENT_RESUME_UNCONFIRMED' })
  const spatialPath = join(f.root, 'workface.json')
  const workface = await new core.AgentMuxSpatialStateStore(spatialPath).commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'original-space', kind: 'folder', name: 'Original work', hostId: 'local', directoryPath: f.root, projectId: 'original-project' }],
    zones: [{ zoneId: 'original-zone', workspaceId: 'original-workspace', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'original-tab', zoneId: 'original-zone', workspaceId: 'original-workspace', name: null, regionIds: ['original-region', 'neighbor-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: f.original.agentSessionId,
      runId: f.original.run.runId, execution: { hostId: 'local', cwd: f.root } },
      { regionId: 'neighbor-region', tabId: 'original-tab', kind: 'browser', agentSessionId: null, runId: null, execution: null }],
    bindings: [{ zoneId: 'original-zone', spaceId: 'original-space' }],
    layouts: { 'original-workspace': createWorkspaceLayout('original-group', ['original-tab']) },
    tabLayouts: { 'original-tab': { root: { type: 'split', direction: 'horizontal', ratio: 0.4,
      first: { type: 'leaf', regionId: 'original-region' }, second: { type: 'leaf', regionId: 'neighbor-region' } }, activeRegionId: 'original-region' } },
    resources: { 'original-tab': { draft: 'Original unsent draft', browserId: 'original-browser' } }
  } })
  await f.client.dispose()
  const entry = process.env.AGENTMUX_TEST_RESTART_CHILD_ENTRY ?? process.env.AGENTMUX_TEST_RESTART_ENTRY ?? new URL('../dist/index.js', import.meta.url).href
  const code = `import * as core from ${JSON.stringify(entry)};const program=${JSON.stringify(program)};const provider=${provider.toString()};const store=new core.AgentMuxFileAgentSessionStore(${JSON.stringify(f.storePath)});const spatial=new core.AgentMuxSpatialStateStore(${JSON.stringify(spatialPath)});const before=await spatial.read();const client=new core.AgentMuxClient({store,providers:[provider()]});Object.defineProperty(client.hookServer,'port',{value:0});await client.connect();client.kernel.list=async()=>{throw Error('Original operation must not read unrelated inventory')};try{const session=await client.restartAgent(${JSON.stringify(f.request)});console.log(JSON.stringify({pid:process.pid,session,inspection:await client.inspectAgentRestart(${JSON.stringify(f.request)}),workfaceBefore:before,workfaceAfter:await spatial.read()}))}finally{await client.dispose()}`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended } })
  const [exit] = await once(child, 'exit')
  expect(exit, stderr).toBe(0)
  const result = JSON.parse(stdout.trim())
  expect(result.pid).not.toBe(process.pid)
  expect(result.workfaceBefore).toEqual(workface); expect(result.workfaceAfter).toEqual(workface)
  expect(result.session.agentSessionId).toBe(f.original.agentSessionId); expect(result.session.nativeHandle).toEqual(f.original.nativeHandle)
  expect(result.inspection).toMatchObject({ phase: 'restarted', newRun: result.session.run })
  if (originalSuccessor) { expect(result.session.run.runId).toBe(originalSuccessor.runId) }
  const second = await f.reader()
  expect((await f.restart(second)).run).toEqual(result.session.run)
  if (originalSuccessor) expect((await second.inner.kernel.status(originalSuccessor.runId)).pid).toBe(originalSuccessor.pid)
  expect((await second.client.listRuns()).filter((run: any) => run.state === 'running')).toHaveLength(2)
  expect(await second.store.readRetiredAgentSession(f.original.agentSessionId)).toBeNull()
})
it('does not Start a successor until the original Stop has an authoritative terminal Run state', async () => {
  const f = await fixture()
  f.stop.mockResolvedValueOnce(undefined)
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESTART_UNCONFIRMED' })
  expect(f.start).not.toHaveBeenCalled(); expect((await f.inner.kernel.status(f.original.run.runId)).state.type).toBe('running')
  expect(await f.client.inspectAgentRestart(f.request)).toMatchObject({ phase: 'stopping', canRetry: true })
})

it('keeps an original Start with mismatching launch evidence unknown instead of claiming a foreign native writer', async () => {
  const f = await fixture(); let actual: any
  f.start.mockImplementationOnce(async (input: any) => { actual = await f.nativeStart(input); throw new core.AgentMuxError('Original private Start ACK lost', 'CONTROL_UNAVAILABLE') })
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  const observation = f.inner.kernel.inspectCreation.bind(f.inner.kernel)
  vi.spyOn(f.inner.kernel, 'inspectCreation').mockImplementation(async (key: unknown) => {
    const run = await observation(key); return run?.runId === actual.runId ? { ...run, args: ['foreign-native-target'] } : run
  })
  expect(await f.client.inspectAgentRestart(f.request)).toMatchObject({ phase: 'unconfirmed', canRetry: false })
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESTART_CONFLICT' })
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).toHaveBeenCalledTimes(1)
  expect((await f.inner.kernel.status(actual.runId)).state.type).toBe('running')
})
it('an identity-only caller resumes the original frozen executor after config changes and Core restart', async () => {
  const f = await fixture()
  f.stop.mockRejectedValueOnce(new Error('Original Stop outcome unknown'))
  const initial = { ...f.request, env: { RESTART_MARKER: 'original-frozen-value' } }
  await expect(f.client.restartAgent(initial)).rejects.toMatchObject({ code: 'AGENT_RESTART_UNCONFIRMED' })
  await f.client.dispose(); const second = await f.reader()
  vi.spyOn(second.inner, 'sessionExecutorOptions').mockRejectedValue(new Error('Mutable new executor config must not replace an original restart'))
  await expect(second.client.restartAgent(f.request)).resolves.toMatchObject({ agentSessionId: f.original.agentSessionId })
  const result = second.client.agentSession(f.original.agentSessionId)
  expect(second.start).toHaveBeenCalledTimes(1)
  expect(second.start.mock.calls[0]![0].env.RESTART_MARKER).toBe('original-frozen-value')
  expect((await second.client.restartAgent(f.request)).run).toEqual(result.run)
  await expect(second.client.restartAgent({ ...f.request, env: { RESTART_MARKER: 'changed-config' } })).rejects.toMatchObject({ code: 'AGENT_RESTART_CONFLICT' })
  await f.invariants(second, 1, 2)
})
it('an authoritative not-applied Start remains explicitly retryable under its original operation after Core restart', async () => {
  const f = await fixture()
  const storageFailure = { stage: 'start' as const, sqlitePrimaryCode: 14, sqliteExtendedCode: 14,
    systemErrno: 2, transactionOutcome: 'not_started' as const }
  let original: InstanceType<typeof core.AgentMuxError>
  f.start.mockImplementationOnce(async (input: { operationKey: string }) => {
    original = new core.AgentMuxError('Original Start was not dispatched', 'CONTROL_UNAVAILABLE', undefined, undefined, undefined,
      { operationId: input.operationKey, disposition: 'not_applied' }, storageFailure)
    throw original
  })
  const rejected = await f.restart().catch(error => error)
  expect(rejected).toMatchObject({ code: 'AGENT_RESTART_START_NOT_APPLIED', controlFailure: { disposition: 'unknown' },
    creationFailure: { disposition: 'not_applied' }, storageFailure, cause: original! })
  expect(await f.client.inspectAgentRestart(f.request)).toMatchObject({ phase: 'starting', canRetry: true, detail: expect.stringContaining('confirmed not applied') })
  const saved = await f.store.readLifecycleReservation(f.original.agentSessionId)
  expect(saved?.restart?.startNotApplied).toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(saved?.preparedSession).toBeUndefined()
  const originalStartKey = f.start.mock.calls[0]![0].operationKey
  await f.client.dispose(); const second = await f.reader()
  const result = await f.restart(second)
  expect(second.start.mock.calls[0]![0].operationKey).toBe(originalStartKey)
  expect(result.continuity).toMatchObject({ action: 'restart', kind: 'resumed' })
  expect(result.continuity?.errorCode).toBeUndefined()
  expect(await second.client.inspectAgentRestart(f.request)).toMatchObject({ phase: 'restarted', newRun: result.run })
  await f.invariants(second, 2, 1)
})

it.each(['foreign-operation', 'input-receipt'] as const)('keeps restart Start unconfirmed for a %s negative receipt', async kind => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new core.AgentMuxError('No matching Start receipt', 'CTXMUX_io', undefined,
    kind === 'input-receipt' ? { disposition: 'not_applied', confirmedInputBytes: null } : undefined,
    undefined, kind === 'foreign-operation' ? { operationId: 'unrelated-start', disposition: 'not_applied' } : undefined))
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED', creationFailure: { disposition: 'unknown' } })
  expect(await f.client.inspectAgentRestart(f.request)).toMatchObject({ phase: 'unconfirmed', canRetry: false })
  const saved = await f.store.readLifecycleReservation(f.original.agentSessionId)
  expect(saved?.restart?.startNotApplied).toBeUndefined(); expect(saved?.preparedSession).toBeDefined()
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_RESTART_UNCONFIRMED' })
  await f.invariants()
})

it('reports a genuinely exited replacement as a known failed restart and retains original native recovery', async () => {
  const f = await fixture(false, true, true, true)
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' })
  await expect(f.client.ensureAgentContinuity(f.request)).rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' })
  const failed = await f.client.inspectAgentRestart(f.request)
  expect(failed).toMatchObject({ phase: 'failed', canRetry: false, newRun: expect.any(Object), detail: expect.any(String), failure: { code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' } })
  expect(failed.session?.agentSessionId).toBe(f.original.agentSessionId)
  expect(failed.session?.nativeHandle).toEqual(f.original.nativeHandle)
  await expect(f.restart()).rejects.toMatchObject({ code: 'AGENT_TERMINAL_HANDSHAKE_FAILED' })
  expect((await f.client.inspectAgentRestart(f.request)).failure).toEqual(failed.failure)
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'fatal-control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  await expect(rpc.call('agent.restart.inspect', f.request)).resolves.toMatchObject({ phase: 'failed', failure: failed.failure, newRun: failed.newRun })
  await f.invariants()
})
it('public inspection and compiled CLI retain the original restart after legacy receipt interruption', async () => {
  const f = await fixture(), reserve = f.inner.registry.reserveRestart.bind(f.inner.registry)
  vi.spyOn(f.inner.registry, 'reserveRestart').mockImplementationOnce(async (...args: any[]) => {
    await reserve(...args)
    const session = (await f.store.readMetadata(f.original.agentSessionId))!
    const { [f.request.operationId]: _removed, ...other } = session.continuityOperations!
    injectLegacySession(f.storePath, { ...session, continuity: undefined, continuityOperations: other })
    throw new Error('Private legacy interruption before first receipt')
  })
  await expect(f.restart()).rejects.toThrow('Private legacy interruption before first receipt')
  await f.client.dispose()
  const owner = await f.reader()
  const hosted = new core.AgentMuxHostedRuntimeService(owner.client, owner.store.path, () => ({ runtimeId: 'restart-runtime', ownerInstanceId: 'restart-owner', protocolVersion: 2,
    processId: process.pid, ctxmux: owner.client.runtimeIdentity(), availability: 'connected' }))
  cleanups.push(() => hosted.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: owner.client }], hostedRuntime: () => hosted })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const hostedClient = await core.connectHostedAgentMux({ rpc }); cleanups.push(() => hostedClient.dispose())
  const expected = { action: 'restart', operationId: f.request.operationId, previousRun: f.original.run }
  const publicObservation = await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: f.original.agentSessionId } })
  expect(publicObservation).toMatchObject({ session: { agentSessionId: f.original.agentSessionId,
    continuityOperations: { [f.request.operationId]: expected } } })
  const env = objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + join(f.root, 'control.sock') })
  const inspected = await runCompiledObjectCli(['agent', 'inspect', '--session', f.original.agentSessionId], env)
  expect(inspected.code, inspected.stderr).toBe(0)
  expect(JSON.parse(inspected.stdout)).toMatchObject({ ok: true, result: { session: { continuityOperations: { [f.request.operationId]: expected } } } })
  const args = ['--session', f.original.agentSessionId, '--run', f.original.run.runId, '--operation-id', f.request.operationId]
  const restartInspection = await runCompiledObjectCli(['agent', 'restart', 'inspect', ...args], env)
  expect(restartInspection.code, restartInspection.stderr).toBe(0)
  expect(JSON.parse(restartInspection.stdout)).toMatchObject({ ok: true, result: { operationId: f.request.operationId, canRetry: true } })
  for (const method of ['agent.restart', 'agent.restart.inspect'] as const) {
    await expect((server as any).service.call(method, f.request, { caller: { agentSessionId: f.original.agentSessionId, capability: 'private-test' },
      principal: { kind: 'user', id: 'private-local-user' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  }
  expect(owner.start).not.toHaveBeenCalled(); expect(owner.stop).not.toHaveBeenCalled(); expect(owner.input).not.toHaveBeenCalled()
  const restarted = await runCompiledObjectCli(['agent', 'restart', ...args], env)
  expect(restarted.code, restarted.stderr).toBe(0)
  const next = JSON.parse(restarted.stdout).result.session
  expect(next).toMatchObject({ agentSessionId: f.original.agentSessionId, nativeHandle: f.original.nativeHandle })
  expect(await hostedClient.inspectAgentRestart(f.request)).toMatchObject({ phase: 'restarted', newRun: next.run })
  expect((await rpc.call('agent.restart.inspect', f.request))).toMatchObject({ phase: 'restarted', newRun: next.run })
  await f.invariants(owner)
})
