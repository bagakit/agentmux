import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdir, mkdtemp, realpath, rm, writeFile, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import type { AgentMuxAgentCreateInput } from '../src/client.js'
import type { AgentMuxAgentSession } from '../src/types.js'
import { agentLifecycleOperationIdentity } from '../src/agent-session-store.js'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { hashAgentCapability, issueAgentCapability } from '../src/agent-capability.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'

const source = { AgentMuxClient, AgentMuxFileAgentSessionStore, defineAgentProvider, AgentMuxError, AgentMuxCreationAuthority, AgentMuxHostExecutorOwner, hashAgentCapability, issueAgentCapability }
const core: typeof source = process.env.AGENTMUX_TEST_PRE_ADMISSION_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_PRE_ADMISSION_ENTRY) : source
if (process.env.AGENTMUX_TEST_PRE_ADMISSION_MUTANT) expect(Reflect.get(core, 'AGENTMUX_PRE_ADMISSION_MUTANT')).toBe(process.env.AGENTMUX_TEST_PRE_ADMISSION_MUTANT)
if (process.env.AGENTMUX_TEST_PRE_ADMISSION_LOADED) await writeFile(process.env.AGENTMUX_TEST_PRE_ADMISSION_LOADED, JSON.stringify({
  entry: process.env.AGENTMUX_TEST_PRE_ADMISSION_ENTRY, loadedSHA256: createHash('sha256').update(await readFile(new URL(process.env.AGENTMUX_TEST_PRE_ADMISSION_ENTRY!))).digest('hex'),
  mutation: Reflect.get(core, 'AGENTMUX_PRE_ADMISSION_MUTANT') ?? null, publicClient: typeof core.AgentMuxClient === 'function' }))
const cleanups: Array<() => Promise<void>> = []
const resources: Array<{ root: string; daemonPid: number | undefined; runPids: number[]; privateCleanup: boolean }> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private fixture cleanup failed')
})
afterAll(async () => { if (process.env.AGENTMUX_TEST_PRE_ADMISSION_RESOURCES) await writeFile(process.env.AGENTMUX_TEST_PRE_ADMISSION_RESOURCES, JSON.stringify({ resources, privateCleanup: resources.every(value => value.privateCleanup) })) })
async function fixture(prepareExecutionEnvironment?: () => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'adc-')))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
  const resource = { root, daemonPid: undefined as number | undefined, runPids: [] as number[], privateCleanup: false }; resources.push(resource)
  const runtime = join(root, 'r'), state = join(root, 's')
  await mkdir(runtime); await mkdir(state)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', runtime); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const daemon = spawn(process.env.AGENTMUX_TEST_CTXMUXD ?? resolve(import.meta.dirname, '../vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
    ['--socket', join(runtime, 'ctxmux.sock'), '--state-dir', join(state, 'ctxmux'), '--readiness-fd', '3'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
  resource.daemonPid = daemon.pid
  let daemonError = ''; daemon.stderr!.on('data', bytes => { daemonError += String(bytes) })
  cleanups.push(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exited }
    await rm(root, { recursive: true, force: true })
    expect(daemon.exitCode !== null || daemon.signalCode !== null).toBe(true)
    await expect(access(root)).rejects.toThrow()
    resource.privateCleanup = true
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
  const authority = new core.AgentMuxCreationAuthority({ stateDirectory: state, runtimeId: 'pre-admission-target' })
  const executorOwner = new core.AgentMuxHostExecutorOwner({ path: join(state, 'executors.json'), runtimeId: 'pre-admission-target', catalog: () => [provider.catalog] })
  async function reader() {
    const store = new core.AgentMuxFileAgentSessionStore(storePath), client = new core.AgentMuxClient({ store, providers: [provider], prepareExecutionEnvironment: prepareExecutionEnvironment!, creationAuthority: authority, hostExecutorOwner: executorOwner }), inner = client as any
    Object.defineProperty(inner.hookServer, 'port', { value: 0 })
    await client.connect()
    const value = { store, client, inner, nativeStart: inner.kernel.start.bind(inner.kernel), nativeList: inner.kernel.list.bind(inner.kernel), start: vi.spyOn(inner.kernel, 'start'), stop: vi.spyOn(inner.kernel, 'stop'), input: vi.spyOn(inner.kernel, 'input') }
    clients.push(value); return value
  }
  const original = await reader()
  const events: AgentMuxClientEvent[] = []
  original.client.onEvent(event => { events.push(event) })
  cleanups.push(async () => {
    for (const value of clients.slice().reverse()) {
      if (value.inner.kernel.isConnected()) for (const run of await value.nativeList()) if (run.state.type === 'running') {
        if (run.pid) resource.runPids.push(run.pid)
        await value.inner.kernel.stop(await value.inner.kernel.prepareStop(run.runId))
      }
      await value.client.dispose()
    }
  })
  const program = "process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write('INPUT:'+d.toString()));console.log('LAUNCH:'+JSON.stringify(process.argv[1]));setInterval(()=>{},1000)"
  const request: AgentMuxAgentCreateInput = { createOperationId: 'original-create', providerId: provider.id, executorId: 'configured-process',
    workspacePath: root, args: ['-e', program], injectAgentMuxGuide: false, prompt: 'the frozen original task' }
  const sid = await original.client.resolveAgentCreationSessionId(request.createOperationId!)
  const create = (changes: Partial<AgentMuxAgentCreateInput> = {}, owner = original) => {
    const pending = owner.client.createAgentWithDelivery({ ...request, ...changes })
    void pending.catch(() => {}) // Delayed assertions and mutants must retain the original rejection.
    return pending
  }
  const replay = async (session: Pick<AgentMuxAgentSession, 'run'>, owner = original) =>
    (await owner.client.readRunReplay(session.run)).replay.map(chunk => chunk.data).join('')
  const write = async (session: AgentMuxAgentSession, owner = original) => {
    await vi.waitFor(async () => expect(await replay(session, owner)).toContain('LAUNCH:' + JSON.stringify(request.prompt)))
    await owner.client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, source: 'user', data: 'still-working' })
    await vi.waitFor(async () => expect(await replay(session, owner)).toContain('INPUT:still-working'))
  }
  const noReplay = () => { expect(clients.reduce((n, value) => n + value.start.mock.calls.length, 0)).toBe(1)
    for (const value of clients) { expect(value.stop).not.toHaveBeenCalled(); expect(value.input).not.toHaveBeenCalled() } }
  return { ...original, root, sid, request, reader, create, replay, write, noReplay, events, provider, storePath, authority, executorOwner }
}

function errno(code: string) { return Object.assign(new Error(`Controlled storage ${code}`), { code }) }


async function waiting(f: Awaited<ReturnType<typeof fixture>>) {
  await vi.waitFor(() => expect(f.events.some(event => event.type === 'agent-error' && event.code === 'AGENT_CREATION_WAITING_FOR_STORAGE')).toBe(true))
  expect(f.start).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect(f.events.filter(event => event.type === 'agent-error' && event.code === 'AGENT_CREATION_WAITING_FOR_STORAGE')
    .every(event => !('message' in event) || !event.message.includes('has not started'))).toBe(true)
}
async function confirmed(f: Awaited<ReturnType<typeof fixture>>, result: Awaited<ReturnType<typeof f.create>>) {
  expect(result.session.agentSessionId).toBe(f.sid)
  expect(result.creation.createOperationId).toBe(f.request.createOperationId)
  await vi.waitFor(async () => expect(await f.replay(result.session)).toContain(JSON.stringify(f.request.prompt)))
  expect((await f.inner.kernel.status(result.session.run.runId)).acceptedInputBytes).toBe(0)
  expect((await f.store.readMetadata(f.sid))?.run).toEqual(result.session.run)
  f.noReplay()
}

it('automatically resumes the original public creation after environment capacity returns', async () => {
  let available = false, prepares = 0
  const f = await fixture(async () => { prepares++; if (!available) throw errno('ENOSPC') })
  const attempts = vi.spyOn(f.inner, 'createAgentWithDeliveryAttempt')
  const pending = f.create()
  await waiting(f); available = true
  await confirmed(f, await pending); expect(prepares).toBeGreaterThanOrEqual(2); expect(attempts).toHaveBeenCalledTimes(1)
})

it.each(['store', 'queue'] as const)('owns the original CID before omitted-SID %s resolution and rejects changed or cross-entry competitors', async stage => {
  const f = await fixture(), owner = stage === 'store' ? f.store : f.inner.messageQueue
  const method = stage === 'store' ? 'loadCreationSessionId' : 'readByOperationId'
  vi.spyOn(owner, method).mockRejectedValueOnce(errno('EDQUOT'))
  const first = f.create(), joined = f.create()
  await waiting(f)
  expect(f.inner.activeCreations.size).toBe(1); expect(f.inner.activeCreationSessions.size).toBe(0)
  await expect(f.create({ prompt: 'different task' })).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  await expect(f.client.createHostAgentWithDelivery({ agentSessionId: f.sid, createOperationId: f.request.createOperationId!,
    executorId: f.request.executorId, executorRevision: 'a'.repeat(64), workspacePath: f.root })).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  const result = await first; expect((await joined).session.run).toEqual(result.session.run)
  await confirmed(f, result); expect(f.inner.activeCreations.size).toBe(0); expect(f.inner.activeCreationSessions.size).toBe(0)
})

it('preserves the original SID owner when a different CID competes during a wait', async () => {
  let available = false
  const f = await fixture(async () => { if (!available) throw errno('ENOSPC') })
  const pending = f.create({ agentSessionId: f.sid }); await waiting(f)
  await expect(f.create({ agentSessionId: f.sid, createOperationId: 'competitor' })).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  expect(f.inner.activeCreations.size).toBe(1); available = true; await confirmed(f, await pending)
})

it('dispose cancels the exact waiting CID before SID exists and never starts after storage returns', async () => {
  const f = await fixture(), cause = errno('ENOSPC')
  const load = vi.spyOn(f.store, 'loadCreationSessionId').mockRejectedValue(cause)
  const pending = f.create().catch(error => error)
  await waiting(f); expect(f.inner.activeCreationSessions.size).toBe(0)
  await f.client.dispose(); expect(await pending).toBe(cause); load.mockRestore()
  expect(f.inner.activeCreations.size).toBe(0); expect(f.start).not.toHaveBeenCalled()
})

it.each(['claim', 'reserve'] as const)('waits only the original %s admission and then starts once', async stage => {
  const f = await fixture()
  vi.spyOn(f.inner.registry, stage === 'claim' ? 'claimCreate' : 'reserveNew').mockRejectedValueOnce(errno('SQLITE_FULL'))
  const pending = f.create(); await waiting(f); await confirmed(f, await pending)
})

async function sourceCaller(f: Awaited<ReturnType<typeof fixture>>) {
  const capability = core.issueAgentCapability()
  const stored = { kind: 'agent' as const, agentSessionId: 'original-caller', providerId: f.provider.id,
    executorId: f.request.executorId, hostId: 'local', workspacePath: f.root, run: { runId: 'original-caller-run' }, retiredRuns: [],
    hookBindingId: 'caller-binding', hookToken: 'caller-token', capabilityHash: core.hashAgentCapability(capability), createdAt: 1, updatedAt: 1 }
  await f.store.compareAndSwap(null, stored)
  return { capability, stored }
}

it('rechecks the original caller immediately before Start after an admission capacity wait', async () => {
  const f = await fixture(), { capability, stored } = await sourceCaller(f)
  vi.spyOn(f.inner.registry, 'reserveNew').mockRejectedValueOnce(errno('ENOSPC'))
  const pending = f.create({ creationCaller: { agentSessionId: stored.agentSessionId, capability } }).catch(error => error)
  await waiting(f)
  await f.store.compareAndSwapMetadata(stored, { ...stored, capabilityHash: core.hashAgentCapability(core.issueAgentCapability()), updatedAt: 2 })
  expect(await pending).toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(f.start).not.toHaveBeenCalled(); expect(await f.store.loadCreationCorrelation(f.sid)).toBeNull()
})

it('reads the exact original append receipt after ACK loss without changing the message or sending input twice', async () => {
  const f = await fixture(), { capability, stored } = await sourceCaller(f), queue = f.inner.messageQueue
  const append = queue.append.bind(queue), envelopes: unknown[] = []
  vi.spyOn(queue, 'append').mockImplementation(async (input: any) => {
    envelopes.push(structuredClone(input)); const receipt = await append(input)
    if (envelopes.length === 1) throw errno('ENOSPC')
    return receipt
  })
  const pending = f.create({ initialMessage: { callerAgentSessionId: stored.agentSessionId, capability } })
  await waiting(f); const result = await pending
  expect(envelopes).toHaveLength(2); expect(envelopes[1]).toEqual(envelopes[0])
  const receipt = await queue.readByOperationId(f.request.createOperationId)
  expect(receipt.envelope.messageId).toBe(result.creation.initialMessageId)
  expect(receipt.envelope.body).toBe(f.request.prompt)
  expect(receipt.envelope.senderRunId).toBe(stored.run.runId)
  expect(result.session.agentSessionId).toBe(f.sid); f.noReplay()
  expect((await f.inner.kernel.status(result.session.run.runId)).acceptedInputBytes).toBe(0)
})

async function hostRequest(f: Awaited<ReturnType<typeof fixture>>) {
  const config = { label: 'Private original Executor', providerId: f.provider.id, command: process.execPath,
    args: [...f.request.args!], env: { ORIGINAL_EXECUTOR: 'original' }, injectAgentMuxGuide: false }
  const registered = await f.executorOwner.configure({ executorId: f.request.executorId, config })
  return { config, request: { agentSessionId: f.sid, createOperationId: f.request.createOperationId!,
    executorId: f.request.executorId, executorRevision: registered.executor.configRevision, workspacePath: f.root, prompt: f.request.prompt! } }
}

it.each(['authority', 'executor'] as const)('resumes the public Hosted Host creation after original %s read capacity returns', async stage => {
  const f = await fixture(), { request } = await hostRequest(f), cause = errno('ENOSPC')
  const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
  const path = join(f.root, 's', stage === 'authority' ? 'agent-creation-identity.json' : 'executors.json')
  const method = stage === 'authority' ? 'lstat' : 'readFile', original = fs[method].bind(fs)
  let injected = false
  vi.spyOn(fs, method).mockImplementation((async (...args: any[]) => {
    if (String(args[0]) === path && !injected) { injected = true; throw cause }
    return await (original as (...args: any[]) => Promise<any>)(...args)
  }) as any)
  syncBuiltinESMExports()
  const hosted = await hostedTestClient(f.client)
  cleanups.push(() => hosted.dispose())
  const pending = hosted.sdk.createHostAgentWithDelivery(request)
  void pending.catch(() => {})
  await waiting(f)
  expect(injected).toBe(true)
  const notice = f.events.find(event => event.type === 'agent-error' && event.code === 'AGENT_CREATION_WAITING_FOR_STORAGE')
  expect(notice).toMatchObject({ agentSessionId: f.sid })
  await confirmed(f, await pending)
})

it('keeps the first Host config and rejects its changed revision after resource waiting before Start', async () => {
  let available = false
  const f = await fixture(async () => { if (!available) throw errno('ENOSPC') }), { request, config } = await hostRequest(f)
  const pending = f.client.createHostAgentWithDelivery(request).catch(error => error)
  await waiting(f)
  await f.executorOwner.configure({ executorId: f.request.executorId, expectedRevision: request.executorRevision, config: { ...config, env: { ORIGINAL_EXECUTOR: 'changed' } } })
  available = true
  expect(await pending).toMatchObject({ code: 'EXECUTOR_REVISION_CONFLICT' })
  expect(f.start).not.toHaveBeenCalled(); expect(await f.store.loadCreationCorrelation(f.sid)).toBeNull()
})

it('does not repeat an unknown Start or prepared completion under a capacity-looking failure', async () => {
  const f = await fixture(), start = f.nativeStart
  f.start.mockImplementationOnce(async (input: any) => { await start(input); throw errno('ENOSPC') })
  await expect(f.create()).rejects.toMatchObject({ creationFailure: { disposition: 'unknown' } })
  const complete = vi.spyOn(f.inner, 'completePreparedCreate').mockRejectedValueOnce(errno('ENOSPC'))
  await expect(f.create()).rejects.toMatchObject({ code: 'ENOSPC' })
  expect(complete).toHaveBeenCalledTimes(1); expect(f.events.some(event => event.type === 'agent-error' && event.code === 'AGENT_CREATION_WAITING_FOR_STORAGE')).toBe(false)
  expect(f.start).toHaveBeenCalledTimes(1); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('rechecks earlier author permission when the final second-caller qualification itself waited for capacity', async () => {
  const f = await fixture(), author = await sourceCaller(f), callerCapability = core.issueAgentCapability()
  const caller = { ...author.stored, agentSessionId: 'second-caller', run: { runId: 'second-caller-run' }, capabilityHash: core.hashAgentCapability(callerCapability) }
  await f.store.compareAndSwap(null, caller)
  const read = f.inner.currentStoredAgentSession.bind(f.inner)
  let callerReads = 0
  vi.spyOn(f.inner, 'currentStoredAgentSession').mockImplementation(async (sid: unknown) => {
    if (sid === caller.agentSessionId && ++callerReads === 2) throw errno('ENOSPC')
    return await read(sid)
  })
  const pending = f.create({ initialMessage: { callerAgentSessionId: author.stored.agentSessionId, capability: author.capability },
    creationCaller: { agentSessionId: caller.agentSessionId, capability: callerCapability } }).catch(error => error)
  await waiting(f)
  await f.store.compareAndSwapMetadata(author.stored, { ...author.stored, capabilityHash: core.hashAgentCapability(core.issueAgentCapability()), updatedAt: 2 })
  expect(await pending).toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(f.start).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect(await f.store.loadCreationCorrelation(f.sid)).toBeNull()
})

it('cancels an in-flight canonical SID read and preserves a late result without starting', async () => {
  const f = await fixture(), original = f.store.loadCreationSessionId.bind(f.store)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const read = vi.spyOn(f.store, 'loadCreationSessionId').mockImplementationOnce(async cid => { await held; return await original(cid) })
  const pending = f.create().catch(error => error)
  await vi.waitFor(() => expect(read).toHaveBeenCalled())
  expect(f.inner.activeCreations.size).toBe(1)
  await f.client.dispose(); release()
  expect(await pending).toBeInstanceOf(Error)
  expect(f.start).not.toHaveBeenCalled(); expect(f.inner.activeCreations.size).toBe(0); expect(f.inner.activeCreationSessions.size).toBe(0)
})

it.runIf(Boolean(process.env.AGENTMUX_TEST_PRE_ADMISSION_ENTRY))('a fresh OS reader reads the original recovered durable CID SID and Run without reseeding', async () => {
  let available = false
  const f = await fixture(async () => { if (!available) throw errno('ENOSPC') })
  const pending = f.create(); await waiting(f); available = true
  const result = await pending; await confirmed(f, result)
  const entry = process.env.AGENTMUX_TEST_PRE_ADMISSION_ENTRY!
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { AgentMuxFileAgentSessionStore } = await import(process.argv[1]);
    const store = new AgentMuxFileAgentSessionStore(process.argv[2]);
    try {
      const sid = await store.loadCreationSessionId(process.argv[3]);
      const session = await store.readMetadata(sid);
      console.log(JSON.stringify({ pid:process.pid, sid, cid:session.creation.createOperationId, run:session.run }));
    } finally { await store.close?.(); }
  `, entry, f.storePath, f.request.createOperationId!], { env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', diagnostic = ''
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { diagnostic += data })
  const [code] = await once(child, 'exit')
  expect(code, diagnostic).toBe(0)
  const read = JSON.parse(output)
  expect(read.pid).not.toBe(process.pid)
  expect(read).toMatchObject({ sid: f.sid, cid: f.request.createOperationId, run: result.session.run })
  expect((await f.inner.kernel.status(result.session.run.runId)).acceptedInputBytes).toBe(0)
  f.noReplay()
})

it.each(['unknown', 'foreign', 'exact-negative'] as const)('preserves the entire original %s creation receipt tree at a preparation boundary', async kind => {
  let reads = 0, error: Error
  const f = await fixture(async () => { if (++reads === 1) throw error })
  const receipt = new core.AgentMuxError('Original receipt', 'ORIGINAL_CREATION_FAILURE', undefined, undefined, undefined,
    { operationId: kind === 'foreign' ? 'foreign-lifecycle' : agentLifecycleOperationIdentity('create', f.sid, f.request.createOperationId!), disposition: kind === 'unknown' ? 'unknown' : 'not_applied' })
  error = Object.assign(new Error('Resource wrapper', { cause: new AggregateError([receipt], 'original causal tree') }), { code: 'ENOSPC' })
  const outcome = await f.create().then(value => ({ value }), error => ({ error }))
  expect(outcome).toHaveProperty('error', error)
  expect((outcome as { error: Error }).error.cause).toBe(error.cause)
  expect(reads).toBe(1)
  expect(f.events.some(event => event.type === 'agent-error' && event.code === 'AGENT_CREATION_WAITING_FOR_STORAGE')).toBe(false)
  expect(f.start).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
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

it('preserves a post-Start capacity failure without repeating its creation or initial delivery', async () => {
  const f = await fixture(), author = await sourceCaller(f), failure = errno('ENOSPC')
  const delivery = vi.spyOn(f.inner, 'recordInitialMessageDelivery').mockRejectedValueOnce(failure)
  const request = { initialMessage: { callerAgentSessionId: author.stored.agentSessionId, capability: author.capability } }
  await expect(f.create(request)).rejects.toBe(failure)
  expect(delivery).toHaveBeenCalledTimes(1)
  expect(f.events.some(event => event.type === 'agent-error' && event.code === 'AGENT_CREATION_WAITING_FOR_STORAGE')).toBe(false)
  const original = await f.store.readMetadata(f.sid)
  expect(original?.creation?.createOperationId).toBe(f.request.createOperationId)
  expect((await f.create(request)).session.run).toEqual(original!.run)
  expect(delivery).toHaveBeenCalledTimes(1); f.noReplay()
  expect((await f.inner.kernel.status(original!.run.runId)).acceptedInputBytes).toBe(0)
})

it('the eight creation owners remain the same public Core exports', async () => {
  const publicCore = await import('../src/index.js')
  for (const name of Object.keys(source) as Array<keyof typeof source>) expect(publicCore[name]).toBe(source[name])
})
