import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { NodePublishingOwner } from '../src/node-publishing-owner.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { observeHostRuntime, parseHostRuntimeObservation } from '../src/host-runtime-observation.js'
import { parseRuntimeResources } from '../src/runtime-observation-codec.js'
import { parseHostAgentResourceObservation, observeHostAgentResources } from '../src/host-agent-resources.js'
import { parseNodePublishingResult } from '../src/node-publishing.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
async function temporary() { const root = await mkdtemp(join(tmpdir(), 'amx-service-source-')); cleanup.push(() => rm(root, { recursive: true, force: true })); return root }
beforeEach(async () => {
  const root = await temporary()
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_') && key !== 'AGENTMUX_NODE_COMPILED_CORE_ROOT') vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', root); vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root)
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', join(root, 'unused-private-store')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'private-messages.ndjson'))
})
function session(id: string, extra: Partial<AgentMuxStoredAgentSession> = {}): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: tmpdir(),
    run: { runId: 'run-' + id }, retiredRuns: [], hookBindingId: 'binding-' + id, hookToken: 'private-fixture-token', createdAt: 100, updatedAt: 200, ...extra }
}
async function retire(store: AgentMuxAgentSessionStore, original: AgentMuxStoredAgentSession) {
  await store.compareAndSwap(null, original)
  const reservation = { kind: 'stop' as const, agentSessionId: original.agentSessionId, reservationId: 'stop-' + original.agentSessionId,
    ownerId: 'private-fixture', ownerPid: process.pid, operationId: 'stop-op-' + original.agentSessionId, expiresAt: Date.now() + 60_000,
    expectedRun: original.run, stopOperation: { daemonInstance: 'private-native', operationKey: 'stop-op-' + original.agentSessionId, runId: original.run.runId } }
  await store.reserveLifecycle(reservation)
  return (await store.commitLifecycle(reservation, null))!
}
async function populate(store: AgentMuxAgentSessionStore) {
  await store.compareAndSwap(null, session('current', { retiredRuns: [{ runId: 'prior-run' }] }))
  await store.compareAndSwap(null, session('foreign', { hostId: 'another-original-host' }))
  await store.compareAndSwap(null, session('unconfirmed', { creation: { createOperationId: 'unconfirmed-original', initialPrompt: 'not-requested', persistence: 'unconfirmed' } }))
  await retire(store, session('retired'))
  const deleted = await retire(store, session('deleted'))
  await store.deleteRecord(deleted, 'delete-retired-record')
}
function thin(adapter: CtxmuxRunAdapter) {
  const runs = ['run-current', 'prior-run', 'run-retired', 'terminal', 'helper', 'run-foreign'].map(id => ({
    id, backend: 'native' as const, pid: 1, state: { type: 'running' as const }, latest_output_bytes: 1_000_000, retained_output_bytes: 4, attachments: 1 }))
  const listPage = vi.fn(async (cursor: string | null) => ({ runs: cursor === null ? runs.slice(0, 3) : runs.slice(3), nextCursor: cursor === null ? 'page-2' : null }))
  const status = vi.fn(() => { throw new Error('Thin resource reader must never hydrate status') })
  Object.assign(adapter, { client: { listPage, status }, identity: () => ({ daemonInstanceId: 'private-native-instance', protocolVersion: 1, buildIdentity: 'private-native' }) })
  return { listPage, status }
}

it.each(['memory', 'file'])('counts exact current and retired records without history hydration (%s)', async kind => {
  const root = await temporary(), store = kind === 'memory' ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'original.sqlite'))
  await populate(store)
  const metadata = vi.spyOn(store, 'loadMetadata').mockRejectedValue(new Error('No Session enumeration'))
  const retired = vi.spyOn(store, 'loadRetiredAgentSessions').mockRejectedValue(new Error('No retirement hydration'))
  const history = vi.spyOn(store, 'readCapturedHistory').mockRejectedValue(new Error('No history read'))
  expect(await store.agentSessionResourceCounts('local')).toEqual({ saved: 1, retired: 1 })
  expect(await store.runningSavedAgentCount('local', ['run-current', 'run-current', 'prior-run', 'run-retired', 'run-deleted', 'terminal', 'helper', 'run-foreign', 'run-unconfirmed'])).toBe(1)
  expect(metadata).not.toHaveBeenCalled(); expect(retired).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled()
  if (kind === 'file') expect(await new AgentMuxFileAgentSessionStore(join(root, 'original.sqlite')).agentSessionResourceCounts('local')).toEqual({ saved: 1, retired: 1 })
})

it('does not import, initialize, salvage or rewrite a missing or legacy Store for metrics', async () => {
  const root = await temporary(), path = join(root, 'original.json'), store = new AgentMuxFileAgentSessionStore(path)
  expect(await store.agentSessionResourceCounts('local').catch(() => null)).toBeNull()
  expect(await readdir(root)).toEqual([])
  const original = JSON.stringify({ version: 5, sessions: [session('original')], reservations: [], retiredRuns: [], retiredAgentSessions: [] })
  await writeFile(path, original)
  const before = await stat(path)
  expect(await store.agentSessionResourceCounts('local').catch(() => null)).toBeNull()
  expect(await store.runningSavedAgentCount('local', ['run-original']).catch(() => null)).toBeNull()
  expect(await readFile(path, 'utf8')).toBe(original)
  expect((await stat(path)).ino).toBe(before.ino)
  expect(await readdir(root)).toEqual(['original.json'])
})

it('keeps Native pure and uses a separate thin inventory for Core-owned running-saved bindings', async () => {
  const store = new AgentMuxMemoryAgentSessionStore(); await populate(store)
  const client = new AgentMuxClient({ store }), adapter = new CtxmuxRunAdapter(), native = thin(adapter)
  Object.assign(client, { kernel: adapter, connected: true }); cleanup.push(() => client.dispose())
  const original = await client.runtimeResourceSnapshot()
  expect(original).toMatchObject({ runCount: 6, runningRuns: 6, retainedOutputBytes: 24 })
  expect(original).not.toHaveProperty('runningSavedAgents')
  expect(await client.runningSavedAgentResourceSnapshot()).toMatchObject({ count: 1, nativeObservedAt: expect.any(Number), nativeInstanceId: 'private-native-instance' })
  expect(await client.agentSessionResourceSnapshot()).toMatchObject({ saved: 1, retired: 1 })
  expect(native.listPage.mock.calls).toEqual([[null], ['page-2'], [null], ['page-2']]); expect(native.status).not.toHaveBeenCalled()
  expect(JSON.stringify(original)).not.toContain('run-current')
  vi.spyOn(store, 'runningSavedAgentCount').mockRejectedValueOnce(new Error('Original Store unavailable'))
  await expect(client.runningSavedAgentResourceSnapshot()).rejects.toBeDefined()
  expect(await client.runtimeResourceSnapshot()).toMatchObject({ runningRuns: 6, retainedOutputBytes: 24 })
  vi.spyOn(store, 'runningSavedAgentCount').mockResolvedValueOnce(-1)
  await expect(client.runningSavedAgentResourceSnapshot()).rejects.toMatchObject({ code: 'AGENT_RESOURCE_UNAVAILABLE' })
})

it('consumes healthy Native while the independent original Store count is still pending', async () => {
  const store = new AgentMuxMemoryAgentSessionStore(), client = new AgentMuxClient({ store }), adapter = new CtxmuxRunAdapter(); thin(adapter)
  Object.assign(client, { kernel: adapter, connected: true }); cleanup.push(() => client.dispose())
  let release!: (n: number) => void, entered!: () => void
  const began = new Promise<void>(yes => entered = yes), waiting = new Promise<number>(yes => release = yes)
  vi.spyOn(store, 'runningSavedAgentCount').mockImplementation(() => { entered(); return waiting })
  let runningDone = false, nativeDone = false
  const pending = client.runningSavedAgentResourceSnapshot().then(value => { runningDone = true; return value })
  let native: ReturnType<typeof client.runtimeResourceSnapshot> | undefined
  try {
    await began
    native = client.runtimeResourceSnapshot().then(value => { nativeDone = true; return value })
    await vi.waitFor(() => expect(nativeDone).toBe(true))
    expect(await native).toMatchObject({ runningRuns: 6, retainedOutputBytes: 24 })
    await expect(client.agentSessionResourceSnapshot()).resolves.toMatchObject({ saved: 0, retired: 0 })
    expect(runningDone).toBe(false)
  } finally { release(0); await Promise.allSettled([pending, native]) }
})

it('consumes original Saved records through public source composition before a deferred Native inventory', async () => {
  const store = new AgentMuxMemoryAgentSessionStore(), client = new AgentMuxClient({ store }), adapter = new CtxmuxRunAdapter(), native = thin(adapter)
  await populate(store); Object.assign(client, { kernel: adapter, connected: true }); cleanup.push(() => client.dispose())
  let release!: (v: Awaited<ReturnType<typeof native.listPage>>) => void, entered!: () => void
  const began = new Promise<void>(yes => entered = yes), waiting = new Promise<Awaited<ReturnType<typeof native.listPage>>>(yes => release = yes)
  native.listPage.mockImplementation(() => { entered(); return waiting })
  let nativeDone = false
  const pending = client.runtimeResourceSnapshot().then(value => { nativeDone = true; return value })
  let recordDone = false, records: ReturnType<typeof observeHostAgentResources> | undefined
  try {
    await began
    const owner: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'source-runtime', ownerInstanceId: 'source-instance', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'unverified' }
    records = observeHostAgentResources({ hostId: 'selected', kind: 'records' }, client, () => owner).then(value => { recordDone = true; return value })
    await vi.waitFor(() => expect(recordDone).toBe(true))
    expect(await records).toMatchObject({ kind: 'records', measurement: { state: 'available', value: { saved: 1, retired: 1 } } })
    expect(nativeDone).toBe(false)
  } finally { release({ runs: [], nextCursor: null }); await pending; await records }
})

it('keeps Saved/Retired observation independent of Native and treats unsupported custom Store as unknown', async () => {
  const store = new AgentMuxMemoryAgentSessionStore(); await populate(store)
  const client = new AgentMuxClient({ store }); cleanup.push(() => client.dispose())
  await expect(client.runtimeResourceSnapshot()).rejects.toBeDefined()
  await expect(client.agentSessionResourceSnapshot()).resolves.toMatchObject({ saved: 1, retired: 1, observedAt: expect.any(Number) })
  Object.defineProperty(store, 'agentSessionResourceCounts', { value: undefined })
  await expect(client.agentSessionResourceSnapshot()).rejects.toMatchObject({ code: 'AGENT_RESOURCE_UNAVAILABLE' })
})

it('keeps original Native facts available with a busy or unreadable Store without joining its write queue', async () => {
  const root = await temporary(), path = join(root, 'original.sqlite'), store = new AgentMuxFileAgentSessionStore(path)
  await populate(store)
  const client = new AgentMuxClient({ store }), adapter = new CtxmuxRunAdapter(); thin(adapter)
  Object.assign(client, { kernel: adapter, connected: true }); cleanup.push(() => client.dispose())
  const writer = new DatabaseSync(path)
  try {
    writer.exec('BEGIN EXCLUSIVE')
    await expect(client.runningSavedAgentResourceSnapshot()).rejects.toBeDefined()
    expect(await client.runtimeResourceSnapshot()).toMatchObject({ runningRuns: 6, retainedOutputBytes: 24 })
  } finally { writer.exec('ROLLBACK'); writer.close() }
  const marker = await readFile(path + '.sqlite-identity')
  const original = await readFile(path)
  try {
    await writeFile(path, 'unreadable original database')
    await expect(client.runningSavedAgentResourceSnapshot()).rejects.toBeDefined()
    expect(await client.runtimeResourceSnapshot()).toMatchObject({ runningRuns: 6 })
    expect(await readFile(path, 'utf8')).toBe('unreadable original database')
    expect(await readFile(path + '.sqlite-identity')).toEqual(marker)
  } finally { await writeFile(path, original) } // Restore only this deliberately damaged fixture for normal Client disposal.
})

it('carries exact I/O operation scope through private/public Node resources and keeps CPU on I/O failure', async () => {
  const root = await temporary(), owner = new NodePublishingOwner({ stateDirectory: root, runtimeId: 'original-runtime', ownerInstanceId: 'original-instance' })
  const usage = process.resourceUsage()
  vi.spyOn(process, 'resourceUsage').mockReturnValue({ ...usage, fsRead: 17, fsWrite: 29 })
  const initial = await owner.call('settings.node.inspect', {})
  const privateRead = await owner.call('settings.node.resources', {})
  expect(privateRead.status).toBe('available'); if (privateRead.status !== 'available') throw Error('Expected actual owner sample')
  expect(privateRead.sample.filesystemIo).toEqual({ state: 'available', value: { scope: process.platform === 'win32' ? 'process-io' : 'filesystem', readOperations: 17, writeOperations: 29 } })
  expect(parseNodePublishingResult('settings.node.resources', privateRead, {})).toEqual(privateRead)
  expect(await owner.call('node.resources', { hostId: 'local' })).toMatchObject({ status: 'withheld' })
  await owner.call('settings.node.configure', { expectedRevision: initial.policyRevision, operationId: 'private-fixture-share', policy: { ...initial.policy, shareResources: true } })
  expect(await owner.call('node.resources', { hostId: 'local' })).toMatchObject({ status: 'available', sample: { filesystemIo: privateRead.sample.filesystemIo } })
  vi.spyOn(process, 'resourceUsage').mockImplementation(() => { throw Error('I/O unavailable') })
  expect(await owner.call('settings.node.resources', {})).toMatchObject({ status: 'available', sample: { process: { state: 'available' }, filesystemIo: { state: 'unavailable' } } })
  const old = structuredClone(privateRead); delete old.sample.filesystemIo
  expect(parseNodePublishingResult('settings.node.resources', old, {})).toEqual(old)
  const malformed = structuredClone(privateRead); malformed.sample.filesystemIo = { state: 'available', value: { scope: 'filesystem', readOperations: 1.5, writeOperations: 2 } }
  expect(() => parseNodePublishingResult('settings.node.resources', malformed, {})).toThrow()
})

it('serializes the registered owner SDK and exact Host inspection through real RPC and CLI', async () => {
  const f = await rpcOwnerFixture(['current']); cleanup.push(f.close)
  const source = await rpcOwnerFixture(['independent-one', 'independent-two']); cleanup.push(source.close)
  thin(f.inner.kernel as unknown as CtxmuxRunAdapter)
  const identity: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'semantic-original', ownerInstanceId: 'core-original', protocolVersion: 2, processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }
  Object.assign(f.client, { runtimeOwnerIdentity: () => identity })
  const hosted = new AgentMuxHostedRuntimeService(f.client, null, () => identity)
  cleanup.push(() => hosted.dispose())
  const node = new NodePublishingOwner({ stateDirectory: f.root, runtimeId: identity.runtimeId, ownerInstanceId: identity.ownerInstanceId })
  let configuration = { id: 'selected', kind: 'ssh', label: 'Original fixture', hostname: 'original.invalid' }
  const sources = vi.fn((hostId?: string) => [{ hostId: 'local', client: source.client }, { hostId: 'selected', client: f.client }]
    .filter(entry => hostId === undefined || entry.hostId === hostId))
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'service.sock'), hostedRuntime: () => hosted,
    hostConfiguration: id => id === 'selected' ? configuration : null,
    nodePublishing: node, coreClients: sources })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const consumer = await connectHostedAgentMux({ rpc }); cleanup.push(() => consumer.dispose())
  expect(typeof consumer.agentSessionResourceSnapshot).toBe('function')
  expect(await consumer.agentSessionResourceSnapshot()).toMatchObject({ saved: 1, retired: 0 })
  sources.mockClear()
  const observed = await rpc.call('settings.hosts.inspect', { hostId: 'selected' })
  expect(observed).toMatchObject({ routeHostId: 'selected', resources: { state: 'available', value: { runningRuns: 6 } } })
  expect(observed).not.toHaveProperty('agents')
  const records = await rpc.call('settings.hosts.agent-resources', { hostId: 'selected', kind: 'records', expectedRuntimeId: identity.runtimeId, expected: configuration })
  expect(records).toMatchObject({ routeHostId: 'selected', kind: 'records', measurement: { state: 'available', value: { saved: 1, retired: 0 } } })
  const running = await rpc.call('settings.hosts.agent-resources', { hostId: 'selected', kind: 'running' })
  expect(running).toMatchObject({ kind: 'running', measurement: { state: 'available', value: { count: 1, nativeInstanceId: 'private-native-instance' } } })
  expect(sources.mock.calls.map(([hostId]) => hostId)).toEqual(Array(6).fill('selected'))
  expect(parseHostAgentResourceObservation(records, { hostId: 'selected', kind: 'records' })).toEqual(records)
  expect(parseHostRuntimeObservation(observed, 'selected')).toEqual(observed)
  const io = await rpc.call('settings.node.resources', {})
  expect(io).toMatchObject({ status: 'available', sample: { filesystemIo: { state: 'available' } } })
  const cliPath = process.env.SERVICE_PRIVATE_CORE
  if (!cliPath) throw Error('Exact private compiled CLI required by this real consumer')
  const env = objectCliEnvironment(f.root, { AGENTMUX_TEST_OBJECT_CLI: join(cliPath, 'bin/amux') })
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'settings', 'hosts', 'agent-resources', '--host', 'selected', '--kind', 'records', '--expected-runtime', identity.runtimeId], env)
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.measurement).toMatchObject({ state: 'available', value: { saved: 1, retired: 0 } })
  const runningCli = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'settings', 'hosts', 'agent-resources', '--host', 'selected', '--kind', 'running'], env)
  expect(runningCli.code, runningCli.stderr).toBe(0)
  expect(JSON.parse(runningCli.stdout).result.measurement).toMatchObject({ state: 'available', value: { count: 1 } })
  const nodeCli = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'settings', 'node', 'resources'], env)
  expect(nodeCli.code, nodeCli.stderr).toBe(0)
  expect(JSON.parse(nodeCli.stdout).result.sample.filesystemIo.state).toBe('available')
  const initial = await node.call('settings.node.inspect', {})
  await node.call('settings.node.configure', { expectedRevision: initial.policyRevision, operationId: 'only-private-fixture-share', policy: { ...initial.policy, shareResources: true } })
  const publishedCli = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'node', 'resources', '--host', 'local', '--expected-runtime', identity.runtimeId], env)
  expect(publishedCli.code, publishedCli.stderr).toBe(0)
  expect(JSON.parse(publishedCli.stdout).result.sample.filesystemIo.state).toBe('available')
  await expect(rpc.call('settings.node.resources', {}, { credentials: source.credentials })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(await rpc.call('node.resources', { hostId: 'local' }, { credentials: source.credentials })).toMatchObject({ status: 'available', sample: { filesystemIo: { state: 'available' } } })
  const help = await runCompiledObjectCli(['settings', 'hosts', 'agent-resources', '--help'], env)
  expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('Running saved bindings')
  const settingsGuide = await runCompiledObjectCli(['settings', '--skill'], env), nodeGuide = await runCompiledObjectCli(['node', '--skill'], env)
  expect(settingsGuide.code, settingsGuide.stderr).toBe(0); expect(settingsGuide.stdout).toContain('settings hosts agent-resources --host HOST --kind records')
  expect(nodeGuide.code, nodeGuide.stderr).toBe(0); expect(nodeGuide.stdout).toContain('filesystemIo reports this Core process')
  vi.spyOn(f.client, 'agentSessionResourceSnapshot').mockRejectedValueOnce(new Error('Store source missing'))
  expect(await rpc.call('settings.hosts.agent-resources', { hostId: 'selected', kind: 'records' })).toMatchObject({ measurement: { state: 'unavailable' } })
  expect(await rpc.call('settings.hosts.inspect', { hostId: 'selected' })).toMatchObject({ resources: { state: 'available' } })
  await expect(rpc.call('settings.hosts.agent-resources', { hostId: 'selected', kind: 'records', expectedRuntimeId: 'foreign-runtime' })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_UNCONFIRMED' })
  await expect(rpc.call('settings.hosts.agent-resources', { hostId: 'selected', kind: 'records', expected: { ...configuration, hostname: 'foreign.invalid' } })).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_CHANGED' })
  let release!: (v: { saved: number; retired: number; observedAt: number }) => void, entered!: () => void
  const began = new Promise<void>(yes => entered = yes)
  vi.spyOn(f.client, 'agentSessionResourceSnapshot').mockImplementationOnce(() => { entered(); return new Promise(yes => release = yes) })
  const late = rpc.call('settings.hosts.agent-resources', { hostId: 'selected', kind: 'records', expected: configuration })
  await began; configuration = { ...configuration, hostname: 'later-route.invalid' }; release({ saved: 1, retired: 0, observedAt: Date.now() })
  await expect(late).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_CHANGED' })
})

it('keeps an old Core source local to missing Agent fields and rejects malformed additions', async () => {
  const resources = { observedAt: 1, runCount: 0, runningRuns: 0, terminatedRuns: 0, terminatedUnattachedRuns: 0, attachments: 0, retainedOutputBytes: 0 }
  const owner: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'old-runtime', ownerInstanceId: 'old-instance', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'unverified' }
  const old = { runtimeIdentity: () => { throw Error('Native unavailable') }, runtimeDiagnostics: async () => { throw Error('Old diagnostics') }, runtimeResourceSnapshot: async () => resources }
  const observed = await observeHostRuntime('selected', old, () => owner)
  expect(observed).toMatchObject({ resources: { state: 'available', value: resources } })
  expect(observed).not.toHaveProperty('agents')
  expect(parseRuntimeResources(resources)).toEqual(resources)
  expect(await observeHostAgentResources({ hostId: 'selected', kind: 'records' }, {}, () => owner)).toMatchObject({ measurement: { state: 'unavailable', code: 'AGENT_RESOURCE_UNAVAILABLE' } })
  expect(await observeHostAgentResources({ hostId: 'selected', kind: 'records' }, { agentSessionResourceSnapshot: async () => ({ saved: 1, retired: 0, observedAt: 1 }) }, () => null)).toMatchObject({
    owner: { state: 'unavailable', code: 'RUNTIME_OWNER_UNCONFIRMED' }, measurement: { state: 'available', value: { saved: 1 } } })
  expect(() => parseRuntimeResources({ ...resources, runningSavedAgents: { state: 'available', value: 1, observedAt: 1 } })).toThrow()
})

it('reads a pinned cold Hosted source through its own control identity while general events are unavailable', async () => {
  const f = await rpcOwnerFixture(['cold-original']); cleanup.push(f.close)
  const identity: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'cold-runtime', ownerInstanceId: 'cold-instance', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'unverified' }
  const hosted = new AgentMuxHostedRuntimeService(f.client, null, () => identity); cleanup.push(() => hosted.dispose())
  let release!: (v: AgentMuxHostedRuntimeService) => void
  const available = new Promise<AgentMuxHostedRuntimeService>(yes => release = yes)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'cold.sock'), coreClients: f.coreClients, hostedRuntime: () => available })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  vi.spyOn(rpc, 'subscribe').mockRejectedValue(new Error('The unrelated general event channel is unavailable'))
  const prepare = vi.spyOn(f.client, 'connectRuntime')
  const client = await connectHostedAgentMux({ rpc, waitForReady: false, expectedRuntimeId: identity.runtimeId }); cleanup.push(() => client.dispose())
  expect(client.runtimeOwnerIdentity()).toBeNull()
  let entered!: () => void; const began = new Promise<void>(yes => entered = yes)
  const reading = observeHostAgentResources({ hostId: 'cold-selected', kind: 'records', expectedRuntimeId: identity.runtimeId }, client, () => { entered(); return client.runtimeOwnerIdentity() })
  try { await began; release(hosted); await expect(reading).resolves.toMatchObject({ owner: { state: 'available', value: { runtimeId: identity.runtimeId } }, measurement: { state: 'available', value: { saved: 1 } } }) }
  finally { release(hosted); await reading.catch(() => undefined) }
  expect(prepare).not.toHaveBeenCalled()
})

it('reads original aggregate records after a real independent-process reopen without modifying identity', async () => {
  const compiled = process.env.SERVICE_PRIVATE_CORE; if (!compiled) throw Error('Exact private Core required')
  const root = await temporary(), path = join(root, 'original.sqlite'), store = new AgentMuxFileAgentSessionStore(path)
  await populate(store)
  const before = await stat(path), bytes = await readFile(path), files = await readdir(root)
  const script = `import {AgentMuxFileAgentSessionStore} from ${JSON.stringify(pathToFileURL(join(compiled, 'dist/agent-session-store.js')).href)}; const s=new AgentMuxFileAgentSessionStore(process.argv[1]); console.log(JSON.stringify({pid:process.pid,counts:await s.agentSessionResourceCounts('local'),running:await s.runningSavedAgentCount('local',['run-current','prior-run','run-retired'])}));`
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, path], { env: objectCliEnvironment(root) })
  const restored = JSON.parse(child.stdout)
  expect(restored).toMatchObject({ counts: { saved: 1, retired: 1 }, running: 1 }); expect(restored.pid).not.toBe(process.pid)
  expect(await readFile(path)).toEqual(bytes); expect((await stat(path)).ino).toBe(before.ino); expect(await readdir(root)).toEqual(files)
  if (process.env.SERVICE_EXTENSION_EVIDENCE) await writeFile(join(process.env.SERVICE_EXTENSION_EVIDENCE, 'store-reopen.json'), JSON.stringify({ passed: true, producingPid: process.pid, restoredPid: restored.pid,
    original: { device: before.dev, inode: before.ino, sha256: createHash('sha256').update(bytes).digest('hex') }, restored, originalFileBytesUnchanged: true, originalFilesUnchanged: true, noNativeOrLifecycleCalls: true }) + '\n')
})
