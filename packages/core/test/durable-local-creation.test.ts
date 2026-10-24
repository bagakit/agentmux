import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as Source from '../src/index.js'
import type { AgentMuxAgentCreateInput } from '../src/client.js'
import type { AgentMuxAgentSession } from '../src/types.js'

const core: typeof Source = process.env.AGENTMUX_TEST_DURABLE_CREATE_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_DURABLE_CREATE_ENTRY) : Source
if (process.env.AGENTMUX_TEST_DURABLE_CREATE_MUTANT) expect(Reflect.get(core, 'AGENTMUX_DURABLE_CREATE_MUTANT')).toBe(process.env.AGENTMUX_TEST_DURABLE_CREATE_MUTANT)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'adc-')))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  const runtime = join(root, 'r'), state = join(root, 's')
  await mkdir(runtime); await mkdir(state)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const daemon = spawn(resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  let daemonError = ''; daemon.stderr!.on('data', bytes => { daemonError += String(bytes) })
  cleanups.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited }
    await rm(root, { recursive: true, force: true })
  })
  await Promise.race([once(daemon.stdio[3]!, 'data'), once(daemon, 'exit').then(() => { throw new Error(daemonError) })])
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
  return { ...original, root, sid, request, reader, create, replay, write, noReplay }
}

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
  const list = vi.spyOn(f.inner.kernel, 'list').mockResolvedValueOnce([])
  await expect(f.create()).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
  list.mockRestore(); f.noReplay()
  await f.client.dispose()
  const reader = await f.reader(), recovered = await f.create({}, reader)
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
  await expect(f.create()).rejects.toMatchObject({ code: 'AGENT_CREATION_UNCONFIRMED' })
  expect(await f.store.readMetadata(f.sid)).toBeNull(); expect(await f.store.loadCreationCorrelation(f.sid)).not.toBeNull(); f.noReplay()
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
  await expect(f.create()).rejects.toThrow('Controlled preparation unavailable')
  expect(f.start).not.toHaveBeenCalled(); expect(await f.store.loadCreationCorrelation(f.sid)).toBeNull()
  prepare.mockRestore()
  f.start.mockImplementationOnce(async (input: { operationKey: string }) => {
    throw new core.AgentMuxError('Controlled Start not applied', 'CONTROL_UNAVAILABLE', undefined, undefined, undefined,
      { operationId: input.operationKey, disposition: 'not_applied' })
  })
  await expect(f.create()).rejects.toMatchObject({ creationFailure: { disposition: 'not_applied' } })
  expect(await f.store.loadCreationCorrelation(f.sid)).toBeNull(); expect(await f.store.readMetadata(f.sid)).toBeNull()
  expect(f.stop).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled()
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
