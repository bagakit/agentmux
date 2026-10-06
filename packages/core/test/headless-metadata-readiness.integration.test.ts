import { fixtureDisplayPath as reshapeFixtureDisplayPath, fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { afterEach, expect, it, vi } from 'vitest'
import { execFile, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { hashAgentCapability, issueAgentCapability } from '../src/agent-capability.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { createWorkspaceLayout } from '../src/spatial-layout.js'
import { runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { build } from 'esbuild'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { metadataTestRuntime } from './helpers/metadata-test-runtime.js'
const { AgentMuxFileAgentSessionStore, connectAgentMuxRpc, connectHostedAgentMux, AgentProviderRegistry, AgentMuxError, startHeadlessAgentMux } = metadataTestRuntime

const boundary = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), spawn: boundary.spawn
}))

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.restoreAllMocks(); vi.unstubAllEnvs(); boundary.spawn.mockReset()
})

it('keeps the original semantic owner and durable metadata readable while official native activation is pending', async () => {
  const root = await mkdtemp(reshapeFixtureDisplayPath("private/tmp/amx-meta-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'state'), { recursive: true })
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'state', 'sessions.json'))
  const original: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-metadata-session',
    providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: '11111111-1111-4111-8111-111111111111' }, retiredRuns: [],
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native-handle' },
    hookBindingId: 'private-binding', hookToken: 'private-token',
    capabilityHash: hashAgentCapability(issueAgentCapability()), createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: reshapeFixtureEpoch(0, 0, 1) }
  await store.compareAndSwap(null, original)
  const spatial = new AgentMuxSpatialStateStore(join(root, 'state', 'spatial-state.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [], bindings: [],
    zones: [{ zoneId: 'original-zone', workspaceId: 'original-workspace', kind: 'directory', hostId: 'local', directoryPath: root, branch: null }],
    tabs: [{ tabId: 'original-tab', zoneId: 'original-zone', workspaceId: 'original-workspace', name: null, regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: original.agentSessionId,
      runId: null, execution: { hostId: 'local', cwd: root } }],
    layouts: { 'original-workspace': createWorkspaceLayout('original-group', ['original-tab']) },
    tabLayouts: { 'original-tab': { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } }, resources: {} } })
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const children: ChildProcess[] = []
  const selectedPackage = process.env.AGENTMUX_TEST_METADATA_PACKAGE ?? resolve(import.meta.dirname, '..')
  const expectedDaemon = resolve(selectedPackage, 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd')
  boundary.spawn.mockImplementation((command: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
    if (command !== expectedDaemon) return actual.spawn(command, args, options)
    // Hold only the OS launch boundary. After explicit release, exec preserves this child PID
    // and runs the pinned official binary with its real fd3, artifact, state and public protocol.
    const child = actual.spawn('/bin/sh', ['-c', 'IFS= read -r activation_gate; exec "$@"', 'private-native-gate', command, ...args],
      { ...options, stdio: ['pipe', 'ignore', 'pipe', 'pipe'] })
    children.push(child)
    child.stderr!.on('data', () => {})
    return child
  })
  cleanup.push(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit
    }
  })
  const ownerResult = startHeadlessAgentMux({ store, providers: [], socketPath: join(root, 'runtime', 'control.sock'), service: { spatialState: spatial } })
    .then(owner => ({ owner }), error => ({ error }))
  let owner: Awaited<ReturnType<typeof startHeadlessAgentMux>> | undefined
  cleanup.push(async () => { const result = await ownerResult; if ('owner' in result) await result.owner.stop() })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'runtime', 'control.sock') } })
  cleanup.push(() => rpc.dispose())
  await vi.waitFor(() => expect(children).toHaveLength(1), { timeout: 10_000 })
  const before = await rpc.call('runtime.owner.identity', {}, { signal: AbortSignal.timeout(2000) })
  expect(before.owner).toMatchObject({ protocolVersion: 2, availability: 'connected', ctxmux: null, processId: process.pid })
  const fence = { runtimeId: before.owner.runtimeId, ownerInstanceId: before.owner.ownerInstanceId }
  const opening = await rpc.call('runtime.bootstrap', { consumerId: 'private-metadata-observer', fence }, { signal: AbortSignal.timeout(2000) })
  expect(opening.sessions).toMatchObject([{ agentSessionId: original.agentSessionId, nativeHandle: original.nativeHandle, run: original.run }])
  expect(opening.owner.ctxmux).toBeNull()
  expect(opening).not.toHaveProperty('identity')
  const status = await promisify(execFile)(process.execPath,
    [resolve(import.meta.dirname, '../dist/headless-runtime-cli.js'), '--endpoint', `unix:${join(root, 'runtime', 'control.sock')}`, 'status'],
    { timeout: 2000 })
  expect(JSON.parse(status.stdout).result.owner).toMatchObject({ ...fence, ctxmux: null })
  expect((await rpc.call('space.state', {})).state?.graph.regions).toEqual([{ regionId: 'original-region', tabId: 'original-tab', kind: 'agent',
    agentSessionId: original.agentSessionId, runId: null, execution: { hostId: 'local', cwd: root } }])
  const space = await runCompiledObjectCli(['--endpoint', `unix:${join(root, 'runtime', 'control.sock')}`, 'space', 'state'], process.env, '', 2000)
  expect(space.code, space.stderr).toBe(0)
  expect(JSON.parse(space.stdout).result.state.graph.regions[0]).toMatchObject({ regionId: 'original-region', agentSessionId: original.agentSessionId, runId: null })
  const outcome = await ownerResult
  expect(outcome).toHaveProperty('owner')
  if (!('owner' in outcome)) throw outcome.error
  owner = outcome.owner
  const events: AgentMuxClientEvent[] = []
  const client = await connectHostedAgentMux({ rpc, waitForReady: false })
  cleanup.push(() => client.dispose())
  client.onEvent(event => events.push(event))
  expect(await Promise.race([client.connect().then(() => true), new Promise<boolean>(done => setTimeout(() => done(false), 1500))]),
    'the actual SDK metadata lease must open before the unchanged Native observation window').toBe(true)
  expect(client.agentSessions()[0]?.agentSessionId).toBe(original.agentSessionId)
  expect(await client.readAgentSessions()).toMatchObject([{ agentSessionId: original.agentSessionId, nativeHandle: original.nativeHandle, run: original.run }])
  expect(() => client.runtimeIdentity()).toThrow()
  await vi.waitFor(() => expect(events.some(event => event.type === 'connection-state' &&
    event.observationOrigin?.boundary === 'core-ctxmux' && event.diagnostic?.code === 'CTXMUX_STARTUP_PENDING')).toBe(true), { timeout: 10_000 })
  expect(children).toHaveLength(1)
  expect(children[0]!.exitCode).toBeNull()
  expect((await rpc.call('runtime.owner.identity', {})).owner).toMatchObject({ ...fence, ctxmux: null })
  children[0]!.stdin!.write('release\n')
  await vi.waitFor(async () => expect((await rpc.call('runtime.owner.identity', {})).owner.ctxmux).not.toBeNull(), { timeout: 10_000 })
  expect((await rpc.call('runtime.owner.identity', {})).owner).toMatchObject(fence)
  await vi.waitFor(() => expect(client.runtimeIdentity().protocolVersion).toBe(22), { timeout: 10_000 })
  expect(children).toHaveLength(1)
  const run = await client.createTerminal({ createOperationId: 'after-private-native-readiness', workspacePath: root,
    command: process.execPath, args: ['-e', 'process.stdin.setRawMode(true);process.stdout.write("ready");process.stdin.on("data",b=>process.stdout.write(b));setInterval(()=>{},1000)'] })
  const projection = await client.attachTerminal(run.runId, 0, 'raw')
  await vi.waitFor(async () => {
    const replay = await client.readRunReplay({ runId: run.runId }, 0, 'raw')
    expect(Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()).toContain('ready')
  }, { timeout: 10_000 })
  const accepted = await client.writeTerminal({ runId: run.runId }, { ownerInstanceId: client.runtimeIdentity().instanceId,
    operationId: 'private-readiness-input', expectedByte: projection.run.acceptedInputBytes!, data: 'native-ready' })
  expect(accepted).toMatchObject({ runId: run.runId, acceptedThroughByte: 12,
    appliedByteRange: { startByte: 0, endByte: 12 } })
  await vi.waitFor(async () => {
    const replay = await client.readRunReplay({ runId: run.runId }, 0, 'raw')
    expect(Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes))).toString()).toContain('native-ready')
  }, { timeout: 10_000 })
  await client.stopTerminal({ runId: run.runId })
}, 30_000)

it('keeps original metadata and Native-only I/O while full Provider observation is held or fails', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  boundary.spawn.mockImplementation(actual.spawn)
  const scope = await headlessFixture(); cleanup.push(() => scope.cleanup())
  const old = await scope.client()
  const created = await old.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
    injectAgentMuxGuide: false, createOperationId: 'original-observation-agent', commandOverride: resolve(import.meta.dirname, 'fixtures/fake-codex-cli.mjs'),
    env: { AGENTMUX_FAKE_NATIVE_RECORD: '1' } })
  const original = await until(() => old.agentSession(created.agentSessionId), session => Boolean(session.nativeHandle) && session.semanticStatus?.state === 'done', 'original native handle')
  const before = await old.readRunReplay(original.run, 0, 'raw'), originalNative = old.runtimeIdentity()
  await scope.stopOwner()
  for (const [key, value] of Object.entries(scope.env)) if (value !== undefined && (key.startsWith('AGENTMUX_') || key === 'HOME')) vi.stubEnv(key, value)
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), observing = new Promise<void>(resolve => { entered = resolve })
  cleanup.push(async () => { release() })
  const provider = { ...new AgentProviderRegistry().get('codex'), observeSessionStatus: async (context: Parameters<NonNullable<import('../src/agent-provider.js').AgentProvider['observeSessionStatus']>>[0]) => {
    entered()
    await held
    context.signal.throwIfAborted()
    throw new AgentMuxError('Private original Provider reader unavailable.', 'PRIVATE_PROVIDER_OBSERVATION_FAILED')
  } }
  const store = new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  let releaseLifecycle!: () => void, enteredLifecycle!: () => void
  const lifecycle = new Promise<void>(resolve => { releaseLifecycle = resolve }), lifecycleEntered = new Promise<void>(resolve => { enteredLifecycle = resolve })
  cleanup.push(async () => { releaseLifecycle() })
  const claim = store.claimStaleLifecycles.bind(store)
  vi.spyOn(store, 'claimStaleLifecycles').mockImplementationOnce(async (...args) => { enteredLifecycle(); await lifecycle; return await claim(...args) })
  const owner = await startHeadlessAgentMux({ store, providers: [provider], socketPath: scope.socketPath })
  cleanup.push(() => owner.stop())
  await lifecycleEntered
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } }); cleanup.push(() => rpc.dispose())
  const client = await connectHostedAgentMux({ rpc }); cleanup.push(() => client.dispose())
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => events.push(event))
  expect(await client.readAgentSessions()).toMatchObject([{ agentSessionId: original.agentSessionId, nativeHandle: original.nativeHandle, run: original.run }])
  expect(client.runtimeIdentity()).toEqual(originalNative)
  // Existing P1 boundary, preserved honestly: before registry.load, the exact SID
  // raw route cannot resolve its active binding. This task does not move that owner.
  await expect(client.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data: 'must-not-guess-binding' }))
    .rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  await expect(client.reattachAgent(original.agentSessionId, 0, 'raw')).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  expect((await client.readRunReplay(original.run, 0, 'raw')).run).toMatchObject({ pid: before.run.pid, state: 'running', acceptedInputBytes: before.run.acceptedInputBytes })
  releaseLifecycle(); await observing
  const snapshot = await rpc.call('runtime.bootstrap', { consumerId: 'held-provider-metadata', fence: { runtimeId: owner.ownerIdentity().runtimeId, ownerInstanceId: owner.ownerIdentity().ownerInstanceId } })
  expect(snapshot.sessions).toMatchObject([{ agentSessionId: original.agentSessionId, nativeHandle: original.nativeHandle, run: original.run }])
  expect(snapshot.connection).toMatchObject({ state: 'restored', diagnostic: { code: 'CTXMUX_CONNECTION_OBSERVATION_PENDING', message: expect.stringContaining('native status observation') } })
  expect(snapshot.owner.ctxmux).toEqual(originalNative)
  expect(client.runtimeIdentity()).toEqual(originalNative)
  const waiting = await client.submitAgentPrompt({ agentSessionId: original.agentSessionId, expectedRun: original.run,
    prompt: 'must-not-bypass-provider', operationId: 'cancelled-provider-prompt', afterSubmissionId: null, signal: AbortSignal.timeout(100) })
    .then(value => ({ value }), error => ({ error }))
  expect(waiting).toHaveProperty('error')
  const exact = await client.readRunReplay(original.run, 0, 'raw')
  expect(exact.run).toMatchObject({ runId: original.run.runId, pid: before.run.pid, state: 'running', acceptedInputBytes: before.run.acceptedInputBytes })
  expect((await client.reattachAgent(original.agentSessionId, 0, 'raw')).session).toMatchObject({ agentSessionId: original.agentSessionId, nativeHandle: original.nativeHandle, run: original.run })
  const text = '🧪'
  const ack = await client.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: original.run, source: 'user', data: text })
  expect(ack).toMatchObject({ runId: original.run.runId, acceptedThroughByte: exact.run.acceptedInputBytes! + Buffer.byteLength(text) })
  await until(async () => Buffer.concat((await client.readRunReplay(original.run, 0, 'raw')).replay.map(chunk => Buffer.from(chunk.dataBytes))).toString(), value => value.includes(text), 'actual original Native echo while Provider held')
  release()
  await vi.waitFor(() => expect(events.some(event => event.type === 'agent-error' && event.code === 'PRIVATE_PROVIDER_OBSERVATION_FAILED' && event.agentSessionId === original.agentSessionId)).toBe(true))
  expect((await client.readRunReplay(original.run, 0, 'raw')).run).toMatchObject({ pid: before.run.pid, state: 'running' })
  expect(await client.readAgentSessions()).toMatchObject([{ agentSessionId: original.agentSessionId, nativeHandle: original.nativeHandle, run: original.run }])
  expect(client.runtimeIdentity()).toEqual(originalNative)
  await client.stopAgent(original.agentSessionId, original.run)
}, 45_000)

it('the actual compiled Host entry publishes a pending owner and survives to the same official Native child', async () => {
  const root = await mkdtemp(reshapeFixtureDisplayPath("private/tmp/amx-entry-")); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
  await mkdir(join(root, 'home')); await mkdir(join(root, 'state')); await mkdir(join(root, 'runtime'))
  const daemon = resolve(process.env.AGENTMUX_TEST_METADATA_PACKAGE ?? resolve(import.meta.dirname, '..'), 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd')
  const preload = join(root, 'launch.cjs'), entry = join(root, 'host.mjs')
  // Test-only launch interception in a real separate Node process. It changes no public
  // Native response: the same child executes the qualified official artifact after release.
  await writeFile(preload, `const cp=require('node:child_process');const spawn=cp.spawn;let native;
cp.spawn=(command,args,options)=>{if(command!==${JSON.stringify(daemon)})return spawn(command,args,options);
native=spawn('/bin/sh',['-c','IFS= read -r activation_gate; exec "$@"','private-entry-native',command,...args],{...options,stdio:['pipe','ignore','pipe','pipe']});
process.send({privateNativePid:native.pid});native.stderr.on('data',()=>{});return native};
require('node:module').syncBuiltinESMExports();process.on('message',message=>{if(message?.privateReleaseNative)native.stdin.write('release\\n')});`, { mode: 0o600 })
  await symlink(resolve(import.meta.dirname, '../../../apps/host/node_modules'), join(root, 'node_modules'), 'dir')
  const compiled = await build({ entryPoints: [resolve(import.meta.dirname, '../../../apps/host/src/index.ts')], outfile: entry,
    bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', metafile: true, logLevel: 'silent',
    plugins: process.env.AGENTMUX_TEST_METADATA_PACKAGE ? [{ name: 'exact-counter-core', setup(build) {
      build.onResolve({ filter: /^@agentmux\/core$/ }, () => ({ path: resolve(process.env.AGENTMUX_TEST_METADATA_PACKAGE!, 'dist/index.js'), external: true }))
    } }] : [] })
  expect(Object.keys(compiled.metafile!.inputs).some(path => path.endsWith('apps/host/src/index.ts'))).toBe(true)
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const child = actual.spawn(process.execPath, ['--require', preload, entry], { env: { ...env, HOME: join(root, 'home'),
    AGENTMUX_AGENT_SESSION_STORE: join(root, 'state', 'sessions.json'), AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'),
    AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'state', 'messages.ndjson'),
    AGENTMUX_MOBILE_BUILD_DIRECTORY: join(root, 'no-mobile-assets') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let nativePid: number | undefined, stdout = '', stderr = ''
  child.on('message', message => { nativePid = (message as { privateNativePid?: number }).privateNativePid })
  child.stdout!.on('data', value => { stdout += value.toString() }); child.stderr!.on('data', value => { stderr += value.toString() })
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit }
    if (nativePid) try { process.kill(nativePid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  })
  await vi.waitFor(() => { expect(child.exitCode, stderr).toBeNull(); expect(stdout).toContain('\n'); expect(nativePid).toBeTypeOf('number') }, { timeout: 10_000 })
  const published = JSON.parse(stdout.split('\n')[0]!)
  expect(published).toMatchObject({ protocol: 'jsonrpc-2.0', pid: child.pid, owner: { protocolVersion: 2, processId: child.pid, ctxmux: null } })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'runtime', 'control.sock') } }); cleanup.push(() => rpc.dispose())
  const client = await connectHostedAgentMux({ rpc }); cleanup.push(() => client.dispose())
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => events.push(event))
  await vi.waitFor(() => expect(events.some(event => event.type === 'connection-state' && event.diagnostic?.code === 'CTXMUX_STARTUP_PENDING')).toBe(true), { timeout: 10_000 })
  expect(child.exitCode).toBeNull()
  const observedPid = nativePid
  child.send({ privateReleaseNative: true })
  await vi.waitFor(() => expect(client.runtimeIdentity().protocolVersion).toBe(22), { timeout: 10_000 })
  expect(client.runtimeOwnerIdentity()).toMatchObject({ runtimeId: published.owner.runtimeId, ownerInstanceId: published.owner.ownerInstanceId, processId: child.pid })
  expect(nativePid).toBe(observedPid); expect(child.exitCode).toBeNull()
}, 30_000)
