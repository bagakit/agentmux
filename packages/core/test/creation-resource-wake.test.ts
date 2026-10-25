import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdir, mkdtemp, realpath, rm, writeFile, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxAgentCreateInput } from '../src/client.js'
import type { AgentMuxAgentSession, AgentMuxClientEvent } from '../src/types.js'
const core: typeof import('./fixtures/creation-resource-wake-source.js') = process.env.AGENTMUX_TEST_CREATION_WAKE_ENTRY
  ? await import(/* @vite-ignore */ process.env.AGENTMUX_TEST_CREATION_WAKE_ENTRY) : await import('./fixtures/creation-resource-wake-source.js')
if (process.env.AGENTMUX_TEST_CREATION_WAKE_MUTANT) expect(Reflect.get(core, 'AGENTMUX_CREATION_WAKE_MUTANT')).toBe(process.env.AGENTMUX_TEST_CREATION_WAKE_MUTANT)
if (process.env.AGENTMUX_TEST_CREATION_WAKE_LOADED) await writeFile(process.env.AGENTMUX_TEST_CREATION_WAKE_LOADED, JSON.stringify({
  entry: process.env.AGENTMUX_TEST_CREATION_WAKE_ENTRY, loadedSHA256: createHash('sha256').update(await readFile(new URL(process.env.AGENTMUX_TEST_CREATION_WAKE_ENTRY!))).digest('hex'),
  mutation: Reflect.get(core, 'AGENTMUX_CREATION_WAKE_MUTANT') ?? null, publicClient: typeof core.AgentMuxClient === 'function' }))
const cliChildren: Array<{ pid: number | undefined; exited: boolean; code?: number | null }> = []
const wakeTimeline: Array<Record<string, unknown>> = []
const cleanupErrors: Array<{ name: string; code?: unknown; message: string }> = []
const cliPhases: Array<{ phase: string; at: number }> = []
const hostedOwners: Array<{ service: string; connector: string; selected: boolean }> = []
const cleanups: Array<() => Promise<void>> = []
const resources: Array<{ root: string; daemonPid: number | undefined; runPids: number[]; listenerPids: number[]; privateCleanup: boolean }> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) {
    errors.push(error); cleanupErrors.push({ name: error instanceof Error ? error.name : 'Unknown', code: (error as any)?.code, message: error instanceof Error ? error.message : String(error) })
  }
  vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private fixture cleanup failed')
})
afterAll(async () => {
  const cliModules: Record<string, string> = {}
  if (process.env.AGENTMUX_TEST_CREATION_WAKE_CLI_MODULES) for (const file of JSON.parse(await readFile(process.env.AGENTMUX_TEST_CREATION_WAKE_CLI_MODULES, 'utf8')))
    cliModules[basename(file)] = createHash('sha256').update(await readFile(file)).digest('hex')
  if (process.env.AGENTMUX_TEST_CREATION_WAKE_RESOURCES) await writeFile(process.env.AGENTMUX_TEST_CREATION_WAKE_RESOURCES, JSON.stringify({ resources,
    privateCleanup: resources.every(value => value.privateCleanup), cliModules, cliChildren, cliPhases, wakeTimeline, cleanupErrors,
    cliSHA256: process.env.AGENTMUX_TEST_CREATION_WAKE_CLI ? createHash('sha256').update(await readFile(process.env.AGENTMUX_TEST_CREATION_WAKE_CLI)).digest('hex') : null }))
  if (process.env.AGENTMUX_TEST_CREATION_WAKE_LOADED) {
    const file = process.env.AGENTMUX_TEST_CREATION_WAKE_LOADED
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), hostedOwners }))
  }
})

async function fixture(prepareExecutionEnvironment?: () => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'acw-')))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
  const resource = { root, daemonPid: undefined as number | undefined, runPids: [] as number[], listenerPids: [] as number[], privateCleanup: false }; resources.push(resource)
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
  const creations: Array<Promise<unknown>> = []
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
    // Join this test's original call before closing Store or deleting its private root.
    for (const value of clients) for (const creation of value.inner.activeCreations.values()) creation.controller.abort()
    await Promise.allSettled(creations)
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
    creations.push(pending)
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



const target = (f: Awaited<ReturnType<typeof fixture>>) => ({ createOperationId: f.request.createOperationId!, agentSessionId: f.sid })
async function currentWait(f: Awaited<ReturnType<typeof fixture>>, atLeast = 1) {
  const count = () => f.events.filter(event => event.type === 'agent-error' && event.code === 'AGENT_CREATION_WAITING_FOR_STORAGE').length
  if (count() >= atLeast) return
  await new Promise<void>(resolve => {
    let release = () => {}
    const ready = () => { if (count() >= atLeast) { release(); resolve() } }
    release = f.client.onEvent(ready, { observeMessages: false })
    cleanups.push(async () => { release() })
    ready()
  })
}
async function publicOwner(f: Awaited<ReturnType<typeof fixture>>) {
  const hosted = await core.hostedTestClient(f.client, core)
  const selected = hosted.service.constructor === core.AgentMuxHostedRuntimeService
  expect(selected).toBe(true)
  hostedOwners.push({ service: 'AgentMuxHostedRuntimeService', connector: 'connectHostedAgentMux', selected })
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'wake.sock'),
    coreClients: () => [{ hostId: 'original-host', client: hosted.sdk }] })
  await server.start()
  const listener = (server as any).publication.current.child.pid
  expect(listener).toBeGreaterThan(1); resources.find(value => value.root === f.root)!.listenerPids.push(listener)
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'wake.sock') } })
  cleanups.push(async () => { await rpc.dispose(); await server.stop(); await hosted.dispose() })
  return { rpc, server, hosted }
}
async function cli(f: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  const entry = process.env.AGENTMUX_TEST_CREATION_WAKE_CLI
  if (!entry) throw new Error('This actual CLI consumer requires the producer compiled source entry')
  const child = spawn(process.execPath, [entry, '--endpoint', 'unix:' + join(f.root, 'wake.sock'), ...args],
    { env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const owned = { pid: child.pid, exited: false, code: null as number | null }; cliChildren.push(owned)
  cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed }
    owned.exited = true; owned.code = child.exitCode })
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  const [code] = await once(child, 'close')
  owned.exited = true; owned.code = child.exitCode
  return { code, stdout, stderr, value: stdout.startsWith('{') ? JSON.parse(stdout) : null }
}

it('wakes only the exact current CID and SID wait, never changing its original request or final result', async () => {
  let available = false
  const f = await fixture(async () => { if (!available) throw errno('ENOSPC') })
  const pending = f.create(); await currentWait(f)
  await expect(f.client.continueAgentCreation({ ...target(f), agentSessionId: 'foreign-session' })).rejects.toMatchObject({ code: 'AGENT_CREATION_OPERATION_CONFLICT' })
  expect(await f.client.continueAgentCreation({ ...target(f), createOperationId: 'foreign-cid' })).toEqual({ createOperationId: 'foreign-cid', status: 'unknown' })
  available = true
  const results = await Promise.all([f.client.continueAgentCreation(target(f)), f.client.continueAgentCreation(target(f))])
  expect(results.map(value => value.status)).toEqual(['woken', 'not-waiting'])
  const created = await pending
  expect(created.session.agentSessionId).toBe(f.sid); expect(created.creation.createOperationId).toBe(f.request.createOperationId)
  await vi.waitFor(async () => expect(await f.replay(created.session)).toContain(JSON.stringify(f.request.prompt)), { timeout: 20_000 })
  expect((await f.inner.kernel.status(created.session.run.runId)).acceptedInputBytes).toBe(0)
  f.noReplay()
  expect(await f.client.continueAgentCreation(target(f))).toEqual({ createOperationId: f.request.createOperationId, status: 'unknown' })
})

it('keeps unresolved SID unknown without echoed binding while exact CID alone can wake the original resolver', async () => {
  const f = await fixture()
  vi.spyOn(f.store, 'loadCreationSessionId').mockRejectedValueOnce(errno('ENOSPC'))
  const pending = f.create(); await currentWait(f)
  const unknown = await f.client.continueAgentCreation(target(f))
  expect(unknown).toEqual({ createOperationId: f.request.createOperationId, status: 'unknown' })
  expect(core.parseCreationContinueReceipt(unknown, target(f))).toEqual(unknown)
  expect(await f.client.continueAgentCreation({ createOperationId: f.request.createOperationId! })).toEqual({ createOperationId: f.request.createOperationId, status: 'woken' })
  expect((await pending).session.agentSessionId).toBe(f.sid); f.noReplay()
})

it('absent or aborted owners stay unknown without Store lookup or Runtime connection', async () => {
  const f = await fixture(), connect = vi.spyOn(f.client, 'connectRuntime'), read = vi.spyOn(f.store, 'readMetadata')
  expect(await f.client.continueAgentCreation(target(f))).toEqual({ createOperationId: f.request.createOperationId, status: 'unknown' })
  expect(connect).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
  const failure = errno('ENOSPC'); vi.spyOn(f.store, 'loadCreationSessionId').mockRejectedValue(failure)
  const pending = f.create().catch(error => error); await currentWait(f)
  await f.client.dispose(); expect(await pending).toBe(failure)
  expect(await f.client.continueAgentCreation(target(f))).toEqual({ createOperationId: f.request.createOperationId, status: 'unknown' })
  expect(connect).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
})

it('inspection never wakes an installed wait and wake cannot bypass current caller qualification', async () => {
  let available = false
  const f = await fixture(async () => { if (!available) throw errno('ENOSPC') }), capability = core.issueAgentCapability()
  const caller = { kind: 'agent' as const, agentSessionId: 'caller', providerId: f.provider.id, executorId: f.request.executorId,
    hostId: 'local', workspacePath: f.root, run: { runId: 'caller-run' }, retiredRuns: [], hookBindingId: 'caller-binding', hookToken: 'caller-token',
    capabilityHash: core.hashAgentCapability(capability), createdAt: 1, updatedAt: 1 }
  await f.store.compareAndSwap(null, caller)
  const pending = f.create({ creationCaller: { agentSessionId: caller.agentSessionId, capability } }).catch(error => error)
  await currentWait(f)
  const entry = f.inner.activeCreations.get(f.request.createOperationId), wake = entry.wake
  await expect(f.client.inspectAgentCreation(f.sid)).rejects.toMatchObject({ code: 'AGENT_CREATION_UNKNOWN' })
  expect(entry.wake).toBe(wake)
  await f.store.compareAndSwapMetadata(caller, { ...caller, capabilityHash: core.hashAgentCapability(core.issueAgentCapability()), updatedAt: 2 })
  available = true
  expect((await f.client.continueAgentCreation(target(f))).status).toBe('woken')
  expect(await pending).toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(f.start).not.toHaveBeenCalled(); expect(f.input).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('public service checks current device authority and refuses managed callers before touching the original wait', async () => {
  const f = await fixture(), method = vi.spyOn(f.client, 'continueAgentCreation')
  const service = new core.AgentMuxRpcService({ coreClients: () => [{ hostId: 'original-host', client: f.client }] })
  cleanups.push(() => service.dispose())
  const input = { ...target(f), hostId: 'original-host' }
  await expect(service.call('agent.creation.continue', input, { principal: { kind: 'device', id: 'original-device' } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  await expect(service.call('agent.creation.continue', input, { principal: { kind: 'user', id: 'user' }, caller: { agentSessionId: 'caller', capability: 'no-authority' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(method).not.toHaveBeenCalled()
  const live = vi.fn()
  expect((await service.call('agent.creation.continue', input, { principal: { kind: 'device', id: 'original-device' }, assertCurrent: live })).status).toBe('unknown')
  expect(live).toHaveBeenCalledTimes(1); expect(method).toHaveBeenCalledTimes(1)
})

it('public client routes only the exact original Host without connecting or rebuilding a missing owner', async () => {
  const f = await fixture(), h = await publicOwner(f), connect = vi.spyOn(f.client, 'connectRuntime'), read = vi.spyOn(f.store, 'loadCreationSessionId')
  expect(await h.rpc.call('agent.creation.continue', { ...target(f), hostId: 'original-host' })).toEqual({ createOperationId: f.request.createOperationId, status: 'unknown', hostId: 'original-host' })
  await expect(h.rpc.call('agent.creation.continue', { ...target(f), hostId: 'foreign-host' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(connect).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
})

it('revoked device authority rejects both the direct public action and runtime invocation before wake', async () => {
  const f = await fixture(), h = await publicOwner(f), method = vi.spyOn(f.client, 'continueAgentCreation')
  const service = new core.AgentMuxRpcService({ coreClients: () => [{ hostId: 'original-host', client: f.client }],
    hostedRuntime: () => h.hosted.service as any })
  cleanups.push(() => service.dispose())
  const principal = { kind: 'device' as const, id: 'revoked-device' }, assertCurrent = vi.fn(async () => { throw new core.AgentMuxError('revoked original device', 'CONTROL_PERMISSION_DENIED') })
  await expect(service.call('agent.creation.continue', { ...target(f), hostId: 'original-host' }, { principal, assertCurrent })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const { owner } = await h.hosted.service.call('runtime.owner.identity', {})
  await expect(service.call('runtime.invoke', { consumerId: 'revoked', fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId },
    invocation: { method: 'continueAgentCreation', args: [target(f)] } }, { principal, assertCurrent })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(assertCurrent).toHaveBeenCalledTimes(2); expect(method).not.toHaveBeenCalled()
})

it('strict continuation receipts reject malformed status and foreign targets across the real Hosted boundary', async () => {
  const f = await fixture(), h = await publicOwner(f)
  for (const status of [['woken'], { toString: () => 'woken' }, 1, null]) {
    expect(() => core.parseCreationContinueReceipt({ ...target(f), status }, target(f))).toThrow()
  }
  vi.spyOn(f.client, 'continueAgentCreation').mockResolvedValueOnce({ ...target(f), status: ['woken'] } as any)
  await expect(h.hosted.sdk.continueAgentCreation(target(f))).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(() => core.parseCreationContinueReceipt({ createOperationId: 'foreign', status: 'woken' }, target(f))).toThrow()
  await expect(h.rpc.call('agent.creation.continue', { ...target(f), hostId: 'original-host', force: true } as any)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
})

it.runIf(Boolean(process.env.AGENTMUX_TEST_CREATION_WAKE_CLI))('actual public CLI wakes the retained long wait through Hosted and preserves one Native creation', async () => {
  let available = false, preparations = 0
  const f = await fixture(async () => { preparations++; if (!available) throw errno('ENOSPC') }), h = await publicOwner(f)
  const timers = createRequire(import.meta.url)('node:timers/promises') as typeof import('node:timers/promises')
  const delay = timers.setTimeout.bind(timers)
  const installed: Array<{ ms: number; registeredAt: number; deadline: number; wake: () => boolean; abortedAt?: number; naturalAt?: number }> = []
  vi.spyOn(timers, 'setTimeout').mockImplementation(((ms: number, value: unknown, options: { signal?: AbortSignal } | undefined) => {
    const entry = f.inner.activeCreations.get(f.request.createOperationId)
    const record = entry?.wake && options?.signal ? { ms, registeredAt: Date.now(), deadline: Date.now() + ms, wake: entry.wake } as typeof installed[number] : undefined
    const abort = () => { if (record) record.abortedAt = Date.now() }
    if (record) { installed.push(record); options!.signal!.addEventListener('abort', abort, { once: true }) }
    return delay(ms, value, options).then(result => {
      if (record) record.naturalAt = Date.now()
      options?.signal?.removeEventListener('abort', abort); return result
    }, error => { options?.signal?.removeEventListener('abort', abort); throw error })
  }) as typeof timers.setTimeout)
  syncBuiltinESMExports()
  let startedAt: number | undefined
  f.start.mockImplementation(async (input: any) => { startedAt = Date.now(); return await f.nativeStart(input) })
  const pending = f.create()
  for (let count = 1; count <= 5; count++) {
    await currentWait(f, count)
    expect((await f.client.continueAgentCreation(target(f))).status).toBe('woken')
  }
  await currentWait(f, 6)
  expect(preparations).toBe(6)
  const originalWake = f.inner.activeCreations.get(f.request.createOperationId).wake
  const originalTimer = installed.slice().reverse().find(value => value.wake === originalWake)!
  expect(originalTimer?.ms).toBe(30_000)
  expect(originalTimer.abortedAt).toBeUndefined(); expect(originalTimer.naturalAt).toBeUndefined()
  available = true
  cliPhases.push({ phase: 'action-start', at: Date.now() })
  const result = await cli(f, ['agent', 'creation', 'continue', '--host', 'original-host', '--operation-id', f.request.createOperationId!, '--session', f.sid])
  cliPhases.push({ phase: 'action-returned', at: Date.now() })
  expect(result.code, result.stderr + result.stdout).toBe(0)
  expect(result.value).toMatchObject({ ok: true, result: { hostId: 'original-host', ...target(f), status: 'woken' } })
  expect(originalTimer.abortedAt).toBeDefined(); expect(originalTimer.abortedAt!).toBeLessThan(originalTimer.deadline)
  expect(originalTimer.naturalAt).toBeUndefined()
  const created = await pending
  expect(created.session.agentSessionId).toBe(f.sid); expect(created.creation.createOperationId).toBe(f.request.createOperationId)
  await vi.waitFor(async () => expect(await f.replay(created.session)).toContain(JSON.stringify(f.request.prompt)), { timeout: 20_000 })
  const nativeStatus = await f.inner.kernel.status(created.session.run.runId)
  expect(nativeStatus.acceptedInputBytes).toBe(0)
  f.noReplay()
  expect((f.start.mock.calls[0]![0] as any).operationKey).toBe(core.agentLifecycleOperationIdentity('create', f.sid, f.request.createOperationId!))
  wakeTimeline.push({ createOperationId: f.request.createOperationId, agentSessionId: f.sid, runId: created.session.run.runId, registeredAt: originalTimer.registeredAt, deadline: originalTimer.deadline, wakeAt: originalTimer.abortedAt, startedAt, naturallyReleased: originalTimer.naturalAt !== undefined, starts: f.start.mock.calls.length, inputCalls: f.input.mock.calls.length, acceptedInputBytes: nativeStatus.acceptedInputBytes, pid: nativeStatus.pid })
  expect((await h.rpc.call('agent.creation.continue', { ...target(f), hostId: 'original-host' })).status).toBe('unknown')
})

it.runIf(Boolean(process.env.AGENTMUX_TEST_CREATION_WAKE_CLI))('actual CLI help and module guide disclose original operation and managed-caller refusal', async () => {
  const f = { root: '/unused-help-endpoint' } as Awaited<ReturnType<typeof fixture>>
  const help = await cli(f, ['agent', 'creation', 'continue', '--help'])
  expect(help.code, help.stderr + help.stdout).toBe(0); expect(help.stdout).toContain('managed Agent callers are refused')
  const guide = await cli(f, ['agent', '--skill'])
  expect(guide.code, guide.stderr + guide.stdout).toBe(0); expect(guide.stdout).toContain('agent creation continue'); expect(guide.stdout).toContain('Managed Agent callers are refused')
})
