import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import * as Source from '../src/index.js'
import type { AgentMuxAgentCreateInput } from '../src/client.js'
import type { AgentMuxAgentSession } from '../src/types.js'
import { agentLifecycleOperationIdentity } from '../src/agent-session-store.js'

const core: typeof Source = process.env.AGENTMUX_TEST_DURABLE_CREATE_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_DURABLE_CREATE_ENTRY) : Source
if (process.env.AGENTMUX_TEST_DURABLE_CREATE_MUTANT) expect(Reflect.get(core, 'AGENTMUX_DURABLE_CREATE_MUTANT')).toBe(process.env.AGENTMUX_TEST_DURABLE_CREATE_MUTANT)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'adc-')))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
  const runtime = join(root, 'r'), state = join(root, 's')
  await mkdir(runtime); await mkdir(state)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const daemon = spawn(process.env.AGENTMUX_TEST_CTXMUXD ?? resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonError = ''; daemon.stderr!.on('data', bytes => { daemonError += String(bytes) })
  cleanups.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited }
    await rm(root, { recursive: true, force: true })
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(([code, signal]) => {
    throw new Error(`Test-owned daemon exited before readiness (code=${code}, signal=${signal}). ${daemonError}`)
  })])
  const provider = core.defineAgentProvider({ catalog: { id: 'creation-process', label: 'Controlled creation process',
    executable: process.execPath, expectedProcess: 'node', promptDelivery: 'positional-argv',
    readySignal: { kind: 'foreground-process', expectedProcess: 'node' }, hookStrategy: { kind: 'none' },
    resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: false, replyCorrelation: 'none' } },
    buildArgs: (prompt, args) => [...args, prompt], hook: { rules: [] } })
  const clients: Array<{ client: InstanceType<typeof core.AgentMuxClient>; inner: any; nativeList: () => Promise<any[]>; start: any; stop: any; input: any }> = []
  const storePath = join(root, 'sessions.sqlite')
  async function reader() {
    const store = new core.AgentMuxFileAgentSessionStore(storePath), client = new core.AgentMuxClient({ store, providers: [provider] }), inner = client as any
    Object.defineProperty(inner.hookServer, 'port', { value: 0 })
    await client.connect()
    const value = { store, client, inner, nativeStart: inner.kernel.start.bind(inner.kernel), nativeList: inner.kernel.list.bind(inner.kernel), start: vi.spyOn(inner.kernel, 'start'), stop: vi.spyOn(inner.kernel, 'stop'), input: vi.spyOn(inner.kernel, 'input') }
    clients.push(value); return value
  }
  const original = await reader()
  const events: Source.AgentMuxClientEvent[] = []
  original.client.onEvent(event => { events.push(event) })
  cleanups.push(async () => {
    for (const value of clients.slice().reverse()) {
      if (value.inner.kernel.isConnected()) for (const run of await value.nativeList()) if (run.state.type === 'running') {
        await value.inner.kernel.stop(await value.inner.kernel.prepareStop(run.runId))
      }
      await value.client.dispose()
    }
  })
  const program = "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d.toString()));console.log('LAUNCH:'+JSON.stringify(process.argv[1]));setInterval(()=>{},1000)"
  const request: AgentMuxAgentCreateInput = { createOperationId: 'original-create', providerId: provider.id, executorId: 'configured-process',
    workspacePath: root, args: ['-e', program], injectAgentMuxGuide: false, prompt: 'the frozen original task' }
  const sid = await original.client.resolveAgentCreationSessionId(request.createOperationId!)
  const create = (changes: Partial<AgentMuxAgentCreateInput> = {}, owner = original) => owner.client.createAgentWithDelivery({ ...request, ...changes })
  const replay = async (session: Pick<AgentMuxAgentSession, 'run'>, owner = original) =>
    (await owner.client.readRunReplay(session.run)).replay.map(chunk => chunk.data).join('')
  const write = async (session: AgentMuxAgentSession, owner = original) => {
    await vi.waitFor(async () => expect(await replay(session, owner)).toContain('LAUNCH:' + JSON.stringify(request.prompt)))
    await owner.client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: 'still-working' })
    await vi.waitFor(async () => expect(await replay(session, owner)).toContain('INPUT:still-working'))
  }
  const noReplay = () => { expect(clients.reduce((n, value) => n + value.start.mock.calls.length, 0)).toBe(1)
    for (const value of clients) { expect(value.stop).not.toHaveBeenCalled(); expect(value.input).not.toHaveBeenCalled() } }
  return { ...original, root, sid, request, reader, create, replay, write, noReplay, events, provider }
}

function errno(code: string) { return Object.assign(new Error(`Controlled storage ${code}`), { code }) }

it('prepares the immutable ordinary creation before native Start and uses one original operation-derived SID', async () => {
  const f = await fixture(), start = f.nativeStart
  f.start.mockImplementation(async (input: any) => {
    const seed = await f.store.loadCreationCorrelation(f.sid)
    expect(seed?.preparedCreation?.creation).toMatchObject({ createOperationId: f.request.createOperationId, intentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(seed?.operationId).toBe(input.operationKey)
    return await start(input)
  })
  const created = await f.create()
  expect(created.session.agentSessionId).toBe(f.sid); expect(created.promptConfirmed).toBe(true)
  await vi.waitFor(async () => expect(await f.replay(created.session)).toContain('LAUNCH:' + JSON.stringify(f.request.prompt)))
  expect((await f.store.readMetadata(f.sid))?.creation?.intentDigest).toBe(created.creation.intentDigest)
  expect((await f.create()).session.run).toEqual(created.session.run)
  f.noReplay()
})

it('keeps acknowledged native work and its original prepared seed when Session commit was not applied', async () => {
  const f = await fixture(), commit = f.store.commitLifecycle.bind(f.store)
  vi.spyOn(f.store, 'commitLifecycle').mockRejectedValueOnce(new Error('Controlled persistence rejected before commit'))
  const outcome = await f.create().then(value => ({ value }), error => ({ error }))
  expect(outcome).not.toHaveProperty('error')
  const created = (outcome as { value: Awaited<ReturnType<typeof f.create>> }).value
  expect(created.creation).toMatchObject({ persistence: 'unconfirmed', failure: { step: 'session-commit' } })
  expect(await f.store.readMetadata(f.sid)).toBeNull()
  expect((await f.store.loadCreationCorrelation(f.sid))?.preparedCreation?.creation?.intentDigest).toBe(created.creation.intentDigest)
  expect((await f.inner.kernel.status(created.session.run.runId)).state.type).toBe('running')
  f.noReplay(); await f.write(created.session)
  vi.mocked(f.store.commitLifecycle).mockImplementation(commit)
  const recovered = await f.create()
  expect(recovered.session.run).toEqual(created.session.run)
  expect((await f.store.readMetadata(f.sid))?.run).toEqual(created.session.run)
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).toHaveBeenCalledTimes(1)
})

it('reads the same canonical Run after applied commit ACK loss without stopping or repeating input', async () => {
  const f = await fixture(), commit = f.store.commitLifecycle.bind(f.store)
  vi.spyOn(f.store, 'commitLifecycle').mockImplementationOnce(async (...args) => { await commit(...args); throw new Error('Controlled commit ACK lost') })
  const created = await f.create(), recovered = await f.create()
  expect(recovered.session.run).toEqual(created.session.run)
  expect((await f.store.readMetadata(f.sid))?.run).toEqual(created.session.run)
  f.noReplay(); await f.write(created.session)
})

it('reconciles an applied Start with lost ACK by original lifecycle after dispose without another Start or input', async () => {
  const f = await fixture(), start = f.nativeStart
  let run: any
  f.start.mockImplementationOnce(async (input: any) => { run = await start(input); throw new core.AgentMuxError('Controlled Start ACK lost', 'CONTROL_UNAVAILABLE', undefined, { disposition: 'unknown', confirmedInputBytes: null }) })
  await expect(f.create()).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
  expect(await f.store.readMetadata(f.sid)).toBeNull()
  expect((await f.store.loadCreationCorrelation(f.sid))?.preparedCreation?.creation?.intentDigest).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u))
  const observation = vi.spyOn(f.inner.kernel, 'inspectCreation').mockResolvedValueOnce(null)
  await expect(f.create()).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
  observation.mockRestore(); f.noReplay()
  await f.client.dispose()
  const reader = await f.reader()
  const inventory = vi.spyOn(reader.inner.kernel, 'list').mockRejectedValue(new Error('Unrelated inventory unavailable'))
  const recovered = await f.create({}, reader)
  expect(inventory).not.toHaveBeenCalled()
  expect(recovered.session.agentSessionId).toBe(f.sid); expect(recovered.session.run.runId).toBe(run.runId)
  expect((await reader.store.readMetadata(f.sid))?.run).toEqual(recovered.session.run)
  f.noReplay(); await f.write(recovered.session, reader)
})

it('does not replace or claim foreign lifecycle work while the original Start result is unknown', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(new core.AgentMuxError('No Start receipt', 'CONTROL_UNAVAILABLE', undefined, { disposition: 'unknown', confirmedInputBytes: null }))
  await expect(f.create()).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
  const foreign = await f.nativeStart({ operationKey: 'foreign-operation', program: process.execPath,
    args: [...f.request.args!, f.request.prompt!], cwd: f.root, env: { AGENTMUX_LIFECYCLE_OPERATION_ID: 'foreign-operation' } })
  expect(foreign.lifecycleOperationId).toBe('foreign-operation')
  const inventory = vi.spyOn(f.inner.kernel, 'list').mockRejectedValue(new Error('Unrelated inventory unavailable'))
  vi.spyOn(f.inner.kernel, 'inspectCreation').mockResolvedValueOnce(foreign)
  await expect(f.create()).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
  expect(await f.store.readMetadata(f.sid)).toBeNull(); expect(await f.store.loadCreationCorrelation(f.sid)).not.toBeNull(); f.noReplay(); expect(inventory).not.toHaveBeenCalled()
})

it('rejects a changed body for the same prepared ordinary operation without overwriting its original digest', async () => {
  const f = await fixture()
  f.start.mockImplementationOnce(async (input: any) => { await f.nativeStart(input); throw new core.AgentMuxError('Unknown original Start', 'CONTROL_UNAVAILABLE') })
  await expect(f.create()).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
  const seed = await f.store.loadCreationCorrelation(f.sid)
  await expect(f.create({ prompt: 'different task' })).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  expect((await f.store.loadCreationCorrelation(f.sid))?.preparedCreation).toEqual(seed?.preparedCreation); f.noReplay()
})

it('admits one original ordinary creation across independent FileStore clients before Start', async () => {
  const f = await fixture(), second = await f.reader(), prepare = f.store.prepareCreate.bind(f.store)
  let release!: () => void, entered!: () => void
  const arrived = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
  vi.spyOn(f.store, 'prepareCreate').mockImplementationOnce(async (...args) => { const result = await prepare(...args); entered(); await held; return result })
  const first = f.create(); await arrived
  try { await expect(f.create({}, second)).rejects.toMatchObject({ code: 'AGENT_SESSION_BUSY' }) }
  finally { release() }
  const created = await first
  expect(created.session.agentSessionId).toBe(f.sid); expect((await second.store.readMetadata(f.sid))?.run).toEqual(created.session.run)
  f.noReplay(); await f.write(created.session)
})

it('releases only unused preparation when preparation or Start is authoritatively not applied', async () => {
  const f = await fixture(), prepare = vi.spyOn(f.store, 'prepareCreate').mockRejectedValueOnce(new Error('Controlled preparation unavailable'))
  await expect(f.create()).rejects.toMatchObject({ message: 'Controlled preparation unavailable',
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: null },
    creationFailure: { operationId: agentLifecycleOperationIdentity('create', f.sid, f.request.createOperationId!), disposition: 'not_applied' } })
  expect(f.start).not.toHaveBeenCalled(); expect(await f.store.loadCreationCorrelation(f.sid)).toBeNull()
  prepare.mockRestore()
  f.start.mockImplementationOnce(async (input: any) => {
    throw new core.AgentMuxError('Controlled Start not applied', 'CONTROL_UNAVAILABLE', undefined, undefined, undefined,
      { operationId: input.operationKey, disposition: 'not_applied' })
  })
  await expect(f.create()).rejects.toMatchObject({ creationFailure: { disposition: 'not_applied' },
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: null } })
  expect(await f.store.loadCreationCorrelation(f.sid)).toBeNull(); expect(await f.store.readMetadata(f.sid)).toBeNull()
  expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})

it.each(['managed-hooks', 'prepared-seed'] as const)('preserves exact pre-Start failure facts at %s and explicitly retries the same identity', async stage => {
  const f = await fixture(), cause = errno('EIO')
  const storageFailure = { stage: 'start' as const, sqlitePrimaryCode: 10, sqliteExtendedCode: 10,
    systemErrno: 5, transactionOutcome: 'not_committed' as const }
  const original = new core.AgentMuxError('Controlled preparation write failure', 'ORIGINAL_STORAGE_FAILURE', 'original detail', undefined,
    undefined, undefined, storageFailure)
  Object.defineProperty(original, 'cause', { value: cause })
  if (stage === 'managed-hooks') vi.spyOn(f.inner, 'ensureManagedHooks').mockRejectedValueOnce(original)
  else {
    const prepare = f.store.prepareCreate.bind(f.store)
    vi.spyOn(f.store, 'prepareCreate').mockImplementationOnce(async (...args) => { await prepare(...args); throw original })
  }
  const failure = await f.create().catch(error => error)
  expect(failure).toMatchObject({ code: original.code, detail: original.detail, storageFailure,
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: null },
    creationFailure: { operationId: agentLifecycleOperationIdentity('create', f.sid, f.request.createOperationId!), disposition: 'not_applied' } })
  expect(failure.cause).toBe(original); expect(failure.cause.cause).toBe(cause)
  expect(f.start).not.toHaveBeenCalled(); expect(await f.store.loadCreationCorrelation(f.sid)).toBeNull()
  const created = await f.create()
  expect(created.session.agentSessionId).toBe(f.sid); f.noReplay(); await f.write(created.session)
})

it('attests only a locked unused reservation write failure, preserves its errno, and releases its exact owner', async () => {
  const f = await fixture(), cause = errno('EIO'), write = vi.spyOn(f.store as any, 'write').mockRejectedValueOnce(cause)
  const failure = await f.create().catch(error => error)
  expect(write).toHaveBeenCalled()
  expect(failure).toMatchObject({ code: 'AGENT_SESSION_STORE_UNAVAILABLE',
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: null },
    creationFailure: { operationId: agentLifecycleOperationIdentity('create', f.sid, f.request.createOperationId!), disposition: 'not_applied' } })
  expect(failure.cause.cause).toBe(cause)
  expect(f.start).not.toHaveBeenCalled(); expect(await f.store.readLifecycleReservation(f.sid)).toBeNull()
  const created = await f.create(); expect(created.session.agentSessionId).toBe(f.sid); f.noReplay()
})

it.each(['reservation', 'preparation', 'native-start'] as const)('automatically continues the frozen original creation after %s storage recovers', async stage => {
  const f = await fixture(), prepare = vi.spyOn(f.store, 'prepareCreate')
  if (stage === 'reservation') vi.spyOn(f.store as any, 'write').mockRejectedValueOnce(errno('ENOSPC'))
  else if (stage === 'preparation') prepare.mockRejectedValueOnce(errno('ENOSPC'))
  else f.start.mockImplementationOnce(async (input: any) => {
    throw new core.AgentMuxError('Native storage is full', 'CTXMUX_storage', undefined, undefined, undefined,
      { operationId: input.operationKey, disposition: 'not_applied' },
      { stage: 'start', sqlitePrimaryCode: 13, sqliteExtendedCode: 13, systemErrno: 28, transactionOutcome: 'not_started' })
  })
  const pending = f.create()
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error',
    agentSessionId: f.sid, code: 'AGENT_CREATION_WAITING_FOR_STORAGE' })))
  const duplicate = f.create()
  // An identical caller joins the resource wait; it cannot bypass that wait and
  // perform a second preparation/Start while the original owner is backing off.
  await new Promise(done => setTimeout(done, 100))
  expect(prepare).toHaveBeenCalledTimes(stage === 'reservation' ? 0 : 1)
  expect(f.start).toHaveBeenCalledTimes(stage === 'native-start' ? 1 : 0)
  const created = await pending, joined = await duplicate
  expect(created.session.agentSessionId).toBe(f.sid); expect(joined.session.run).toEqual(created.session.run)
  expect(created.creation.createOperationId).toBe(f.request.createOperationId)
  expect(f.start).toHaveBeenCalledTimes(stage === 'native-start' ? 2 : 1)
  expect(await f.nativeList()).toHaveLength(1)
  expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
  await vi.waitFor(async () => expect(await f.replay(created.session)).toContain('LAUNCH:' + JSON.stringify(f.request.prompt)))
})

it('retains an unknown Start even when its machine cause is ENOSPC, without another Start', async () => {
  const f = await fixture()
  f.start.mockRejectedValueOnce(errno('ENOSPC'))
  const failure = await f.create().catch(error => error)
  expect(failure).toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED', creationFailure: { disposition: 'unknown' } })
  expect(failure.controlFailure).toBeUndefined()
  expect(await f.store.loadCreationCorrelation(f.sid)).not.toBeNull()
  expect(f.events.filter(event => event.type === 'agent-error' && event.code === 'AGENT_CREATION_WAITING_FOR_STORAGE')).toEqual([])
  f.noReplay()
})

it('cancels a waiting creation on dispose without starting or discarding its original request', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'prepareCreate').mockRejectedValue(errno('ENOSPC'))
  const pending = f.create().catch(error => error)
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_CREATION_WAITING_FOR_STORAGE' })))
  await f.client.dispose()
  expect(await pending).toMatchObject({ code: 'ENOSPC', creationFailure: { disposition: 'not_applied' } })
  expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})

it('fences Start when disconnect cancels an already preparing retry even after reconnect', async () => {
  const f = await fixture(), prepare = f.store.prepareCreate.bind(f.store)
  let entered!: () => void, release!: () => void
  const arrived = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
  vi.spyOn(f.store, 'prepareCreate').mockRejectedValueOnce(errno('ENOSPC')).mockImplementationOnce(async (...args) => {
    const result = await prepare(...args); entered(); await held; return result
  })
  const pending = f.create().catch(error => error)
  await arrived
  try { await f.client.disconnect(); await f.client.connect() } finally { release() }
  expect(await pending).toMatchObject({ creationFailure: { disposition: 'not_applied' } })
  expect(await f.store.readLifecycleReservation(f.sid)).toBeNull()
  expect(f.start).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})

it('retries only failed exact cleanup actions before the original capacity-blocked creation continues', async () => {
  const f = await fixture(), prepare = vi.spyOn(f.store, 'prepareCreate').mockRejectedValueOnce(errno('ENOSPC'))
  const close = vi.fn().mockRejectedValueOnce(errno('ENOSPC')).mockResolvedValue(undefined)
  const binding = f.inner.hookServer.createBinding.bind(f.inner.hookServer)
  vi.spyOn(f.inner.hookServer, 'createBinding').mockImplementationOnce((...args: unknown[]) => {
    const value = binding(...args), originalClose = value.close.bind(value)
    value.close = async () => { await close(); await originalClose() }
    return value
  })
  const release = vi.spyOn(f.store, 'releaseLifecycle').mockRejectedValueOnce(errno('ENOSPC'))
  const pending = f.create()
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_CREATION_WAITING_FOR_STORAGE' })))
  expect(close).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce()
  expect(prepare).toHaveBeenCalledOnce(); expect(f.start).not.toHaveBeenCalled()
  const created = await pending
  expect(close).toHaveBeenCalledTimes(2); expect(release).toHaveBeenCalledTimes(2)
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(created.session.agentSessionId).toBe(f.sid); expect(await f.store.readLifecycleReservation(f.sid)).toBeNull(); f.noReplay()
})

it('settles the original SQLite close and lock handle before retrying, while retaining historical cleanup diagnostics', async () => {
  const f = await fixture(), owner = f.store as any, originalWrite = owner.write.bind(owner)
  const capacity = errno('ENOSPC'), failedClose = errno('ENOSPC')
  let closed: any, originalFailure: any, returnedFailure: any
  const attempt = f.inner.createAgentWithDeliveryAttempt.bind(f.inner)
  vi.spyOn(f.inner, 'createAgentWithDeliveryAttempt').mockImplementationOnce(async (...args: unknown[]) => {
    try { return await attempt(...args) } catch (error) { returnedFailure = error; throw error }
  })
  const prepare = f.store.prepareCreate.bind(f.store)
  vi.spyOn(f.store, 'prepareCreate').mockImplementationOnce(async (...args) => {
    try { return await prepare(...args) } catch (error) { originalFailure = error; throw error }
  })
  vi.spyOn(owner, 'write').mockImplementation(async (document: any, ...rest: unknown[]) => {
    if (!closed && document.reservations.some((reservation: any) => reservation.preparedCreation)) {
      closed = vi.spyOn(owner.db, 'close').mockImplementationOnce(() => { throw failedClose })
        .mockImplementationOnce(() => { throw failedClose })
      throw capacity
    }
    return await originalWrite(document, ...rest)
  })
  const created = await f.create()
  expect(closed).toHaveBeenCalledTimes(3)
  expect(originalFailure).toMatchObject({ cause: capacity, cleanup: [failedClose] })
  expect(returnedFailure.cause).toBe(originalFailure); expect(returnedFailure.cleanup).toBeUndefined()
  expect(owner.pendingLockRelease).toBeNull()
  expect(created.session.agentSessionId).toBe(f.sid); expect(await f.store.readLifecycleReservation(f.sid)).toBeNull(); f.noReplay()
})

it('recovers from real SQLite page exhaustion in the original FileStore preparation transaction', async () => {
  const f = await fixture(), owner = f.store as any, originalWrite = owner.write.bind(owner)
  const prompt = 'original frozen storage task '.repeat(2_048)
  let constrained = false, nativeFailure: any
  vi.spyOn(owner, 'write').mockImplementation(async (document: any, ...rest: unknown[]) => {
    if (!constrained && document.reservations.some((reservation: any) => reservation.preparedCreation)) {
      constrained = true
      const pages = Number(owner.db.prepare('PRAGMA page_count').get().page_count)
      expect(pages).toBeGreaterThan(0)
      expect(Number(owner.db.prepare(`PRAGMA max_page_count=${pages}`).get().max_page_count)).toBe(pages)
      // The real prepared original exceeds this test-owned SQLite connection's page budget.
      // Closing this failed transaction removes the injected connection constraint.
      try { return await originalWrite(document, ...rest) }
      catch (error) { nativeFailure = error; throw error }
    }
    return await originalWrite(document, ...rest)
  })
  const pending = f.create({ prompt })
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_CREATION_WAITING_FOR_STORAGE' })))
  expect(constrained).toBe(true)
  expect(nativeFailure).toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 13 })
  expect(f.start).not.toHaveBeenCalled()
  const created = await pending
  expect(created.session.agentSessionId).toBe(f.sid); expect(created.creation.createOperationId).toBe(f.request.createOperationId)
  expect((f.start.mock.calls[0]![0] as { args: string[] }).args.at(-1)).toBe(prompt)
  expect(await f.nativeList()).toHaveLength(1); f.noReplay()
  await vi.waitFor(async () => expect(await f.replay(created.session)).toContain('LAUNCH:' + JSON.stringify(prompt)))
  await f.client.dispose()
  const worker = join(f.root, 'read-original-creation.mjs')
  await build({ stdin: { contents: `
    import { AgentMuxClient } from './packages/core/src/client.ts';
    import { AgentMuxFileAgentSessionStore } from './packages/core/src/agent-session-store.ts';
    import { defineAgentProvider } from './packages/core/src/agent-provider.ts';
    const provider = defineAgentProvider({ catalog: JSON.parse(process.argv[4]), buildArgs: (prompt, args) => [...args, prompt], hook: { rules: [] } });
    const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(process.argv[2]), providers: [provider] });
    Object.defineProperty(client.hookServer, 'port', { value: 0 });
    const calls = { start: 0, input: 0 };
    client.kernel.start = async () => { calls.start++; throw new Error('Read-only child attempted Start'); };
    client.kernel.input = async () => { calls.input++; throw new Error('Read-only child attempted Input'); };
    try {
      await client.connect();
      const session = await client.readAgentSession(process.argv[3]);
      const creation = await client.inspectAgentCreation(process.argv[3]);
      const replay = (await client.readRunReplay(session.run)).replay.map(chunk => chunk.data).join('');
      console.log(JSON.stringify({ pid: process.pid, sid: session.agentSessionId, operationId: creation.creation.createOperationId,
        run: session.run, inspectedRun: creation.run, hasOriginalPrompt: replay.includes('LAUNCH:' + JSON.stringify(process.argv[5])), calls }));
    } finally { await client.dispose(); }
  `, resolveDir: resolve('.'), sourcefile: 'read-original-creation.ts' },
    bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: worker })
  await symlink(resolve('packages/core/node_modules'), join(f.root, 'node_modules'), 'dir')
  const child = spawn(process.execPath, [worker, join(f.root, 'sessions.sqlite'), f.sid, JSON.stringify(f.provider.catalog), prompt],
    { env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  const exit = await new Promise<number | null>((accept, reject) => { child.once('error', reject); child.once('exit', accept) })
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
  const restored = JSON.parse(stdout.trim())
  expect(restored.pid).not.toBe(process.pid)
  expect(restored).toMatchObject({ sid: f.sid, operationId: f.request.createOperationId, run: created.session.run,
    inspectedRun: created.session.run, hasOriginalPrompt: true, calls: { start: 0, input: 0 } })
  await f.reader() // Reconnect only to clean up this fixture's surviving Run after the child read.
})

it('freezes caller input through storage waiting and refuses a conflicting join without disturbing the original', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'prepareCreate').mockRejectedValueOnce(errno('ENOSPC'))
  const request = { ...f.request, args: ['-e', `console.log('ENV:'+process.env.ORIGINAL_ENV);${f.request.args![1]}`],
    env: { ORIGINAL_ENV: 'frozen env' }, prompt: 'frozen body' }
  const pending = f.client.createAgentWithDelivery(request)
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: 'agent-error', code: 'AGENT_CREATION_WAITING_FOR_STORAGE' })))
  request.args[1] = 'process.exit(71)'; request.env.ORIGINAL_ENV = 'changed env'; request.prompt = 'changed body'
  await expect(f.client.createAgentWithDelivery(request)).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  const created = await pending
  expect(created.session.agentSessionId).toBe(f.sid); f.noReplay()
  await vi.waitFor(async () => {
    const output = await f.replay(created.session)
    expect(output).toContain('ENV:frozen env'); expect(output).toContain('LAUNCH:"frozen body"')
  })
  expect(f.start.mock.calls[0]![0]).toMatchObject({ args: [expect.any(String), expect.stringContaining('ORIGINAL_ENV'), 'frozen body'],
    env: { ORIGINAL_ENV: 'frozen env' } })
})

it.each(['another-operation', 'input-receipt'] as const)('retains original creation when the negative receipt belongs to %s', async mismatch => {
  const f = await fixture()
  f.start.mockImplementationOnce(async () => {
    throw new core.AgentMuxError('Unrelated negative receipt', 'CTXMUX_io', undefined,
      mismatch === 'input-receipt' ? { disposition: 'not_applied', confirmedInputBytes: null } : undefined,
      undefined, mismatch === 'another-operation' ? { operationId: 'another-operation', disposition: 'not_applied' } : undefined)
  })
  await expect(f.create()).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED', creationFailure: { disposition: 'unknown' } })
  expect(await f.store.loadCreationCorrelation(f.sid)).not.toBeNull()
  expect(f.start).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
})
