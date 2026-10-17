import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, hostAgentCreationIntent } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'
import { spawnOwnerFixture } from './helpers/a2a-spawn-owner.js'
import { RuntimeController } from '../../../apps/desktop/src/main/runtime-controller.js'
import { executeSpatialControl, type SpatialWorkbench, type SpatialControlPorts } from '../../../apps/desktop/src/renderer/src/lib/space-agent-control.js'
import type { AppConfig } from '../../../apps/desktop/src/shared/contracts.js'
import { directoryIdentity, workspaceZoneId } from '../../../apps/desktop/src/shared/space-addresses.js'
import { parseAgentMuxControlReceipt } from '../src/control-codec.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'

// Native image decoding is outside this creation path; no Electron app is launched.
vi.mock('electron', () => ({ nativeImage: {} }))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  vi.restoreAllMocks()
  if (failures.length) throw new AggregateError(failures, 'Private spawn product cleanup failed')
})
const fixture = (remote = false) => spawnOwnerFixture(cleanups, remote)
const creator = { agentSessionId: 'creator', run: { runId: 'run-creator' }, owner: { kind: 'local' } }

it('a signed remote no-body creation records the original source once and Hosted reads it without connecting Runtime or appending a message', async () => {
  const h = await fixture(true), sourceStore = new AgentMuxFileAgentSessionStore(join(h.root, 'source', 'sessions.json'))
  const sourceRecord = (await h.store.readMetadata('creator'))!
  await sourceStore.compareAndSwap(null, { ...sourceRecord, agentSessionId: 'remote-creator' })
  const source = new AgentMuxClient({ store: sourceStore,
    creationAuthority: new AgentMuxCreationAuthority({ stateDirectory: join(h.root, 'source-authority'), runtimeId: 'source-runtime' }) })
  cleanups.push(() => source.dispose())
  const sourceIdentity = await source.agentCreationAuthority(), targetIdentity = await h.client.agentCreationAuthority()
  await h.client.trustCreationSource({ sourceRuntimeId: sourceIdentity.runtimeId, publicKey: sourceIdentity.publicKey,
    targetRuntimeId: targetIdentity.runtimeId, targetKeyFingerprint: targetIdentity.fingerprint }, { kind: 'user', id: 'configured-user' })
  const executor = (await h.client.listHostExecutors()).executors[0]!
  const intent = { agentSessionId: 'remote-child', createOperationId: 'original-remote-spawn', executorId: executor.executorId,
    executorRevision: executor.configRevision, workspacePath: h.root }
  const remoteCaller = { agentSessionId: 'remote-creator', capability: h.capability }
  const admission = await source.attestAgentCreation({ caller: remoteCaller,
    target: { runtimeId: targetIdentity.runtimeId, intentDigest: hostAgentCreationIntent(intent) } })
  const request = { ...intent, initialMessageAdmission: admission }
  const target = await hostedTestClient(h.client); cleanups.push(() => target.dispose())
  vi.spyOn(h.client, 'connect').mockResolvedValue()
  const config = { hosts: [{ id: 'source', kind: 'local', label: 'Source' },
    { id: 'target', kind: 'ssh', label: 'Target', hostname: 'private.invalid' }], executors: {}, workspaces: [] } as unknown as AppConfig
  const controller = new RuntimeController(sourceStore, async () => source)
  const hosts = Reflect.get(controller, 'hosts') as Map<string, unknown>
  for (const host of config.hosts) hosts.set(host.id, { client: host.id === 'source' ? source : target.sdk,
    config: host, historyObservationDisposers: new Set(), unsubscribe: () => {} })
  const result = await controller.launchAgent({ ...intent, hostId: 'target', creationCaller: remoteCaller }, config)
  const remoteCreator = { ...creator, agentSessionId: remoteCaller.agentSessionId, owner: { kind: 'runtime', runtimeId: 'source-runtime' } }
  expect(result.creation).toMatchObject({ createdBy: remoteCreator, createdRun: result.created.run, initialPrompt: 'not-requested' })
  expect(result.creation.initialMessageId).toBeUndefined()
  expect(JSON.stringify(h.launches)).not.toContain(h.capability)
  expect(h.launches[0]!.args.join('\n')).toContain('Runtime source-runtime')
  const repeated = await h.client.createHostAgentWithDelivery(request)
  expect(repeated.session.run).toEqual(result.created.run)
  expect(repeated.promptConfirmed).toBe(true)
  const connect = vi.spyOn(h.client, 'connect').mockRejectedValue(new Error('Read-only provenance must not connect unrelated recovery')); connect.mockClear()
  const runtime = vi.spyOn(h.client, 'connectRuntime').mockRejectedValue(new Error('Runtime unavailable'))
  const related = await target.sdk.listAgentSpawns({ participantSessionId: 'remote-creator', direction: 'created', creatorRuntimeId: 'source-runtime' })
  expect(related.records.map(row => row.agentSessionId)).toEqual(['remote-child'])
  expect(related.records[0]!.creation.createdBy).toEqual(remoteCreator)
  expect((await target.sdk.listAgentSpawns({ participantSessionId: 'remote-creator', direction: 'created' })).records).toEqual([])
  const router = new AgentMuxControlServer({ socketPath: join(h.root, 'both-owners.sock'),
    coreClients: () => [{ hostId: 'local', client: source }, { hostId: 'target', client: target.sdk }] })
  await router.start(); cleanups.push(() => router.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: router.path }, credentials: remoteCaller })
  cleanups.push(() => rpc.dispose())
  const query = { hostId: 'target', participantSessionId: remoteCaller.agentSessionId, direction: 'created' as const }
  const publicRead = await rpc.call('agent.spawn.ls', query)
  expect(publicRead.creatorRuntimeId).toBe('source-runtime')
  expect(publicRead.records).toEqual(related.records)
  await expect(rpc.call('agent.spawn.ls', { ...query, direction: 'creator' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(rpc.call('agent.spawn.ls', { ...query, creatorRuntimeId: 'forged-source-runtime' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(h.client.createHostAgentWithDelivery({ ...request, agentSessionId: 'tampered-child' })).rejects.toBeDefined()
  expect(connect).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled()
  expect(h.start).toHaveBeenCalledOnce(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  expect((await h.client.listMessages({ participantSessionId: 'creator', direction: 'outgoing', caller: h.credentials })).messages).toEqual([])
})

it.each([undefined, 'Original authorized task'])('Desktop spatial open preserves the creator through Main, Core and its original receipt (prompt=%s)', async prompt => {
  const h = await fixture()
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }],
    executors: { 'private-executor': { label: 'Private executor', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'workspace', hostId: 'local', name: 'Private workspace', path: h.root, kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const controller = new RuntimeController(h.store, async () => h.client)
  // Only the configured Desktop Host route is supplied by the fixture. The launch owner,
  // Core creation/authentication, durable Store and receipt codecs are production code.
  const hosts = Reflect.get(controller, 'hosts') as Map<string, unknown>
  hosts.set('local', { client: h.client, config: config.hosts[0], historyObservationDisposers: new Set(), unsubscribe: () => {} })
  vi.spyOn(h.client, 'connect').mockResolvedValue()
  let state: SpatialWorkbench = { config, sessions: [], tabs: {}, layouts: {}, spaceZoneBindings: {}, spatialRequests: {} }
  const launch = vi.fn((input: Parameters<SpatialControlPorts['launch']>[0]) => controller.launchAgent(input, config))
  const ports: SpatialControlPorts = { get: () => state, patch: patch => { state = { ...state, ...patch } }, topics: async () => [],
    launch, creation: (_host, sid) => h.client.inspectAgentCreation(sid), attach: async () => {},
    createResource: async () => { throw new Error('No resource creation is requested') },
    save: async layoutApplied => ({ layoutApplied, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'confirmed', reason: null }),
    focus: vi.fn(), isFocused: () => false, notice: vi.fn(), closing: () => false }
  const request = { schemaVersion: 5 as const, operation: 'agent.open' as const, requestId: 'original-desktop-open',
    content: { kind: 'new-agent' as const, executorId: 'private-executor', ...(prompt === undefined ? {} : { prompt }) },
    destination: { zoneId: workspaceZoneId(directoryIdentity('local', h.root), 'workspace') }, focus: false,
    caller: { agentSessionId: 'creator', capability: h.capability } }
  const result = await executeSpatialControl(ports, request)
  if (result.operation !== 'agent.open') throw new Error('Wrong original creation operation')
  expect(result.agent).toMatchObject({ createdBy: creator, createdRun: { runId: 'child-run-1' }, createOperationId: request.requestId })
  expect(result.agent?.initialMessageId === undefined).toBe(prompt === undefined)
  expect(launch.mock.calls[0]![0].creationCaller).toEqual(h.credentials)
  const { operation, ...body } = result
  const parsed = parseAgentMuxControlReceipt({ schemaVersion: 5, requestId: request.requestId, operation, ok: true, result: body })
  expect(parsed.ok).toBe(true)
  const repeated = await executeSpatialControl(ports, request)
  expect(repeated.operation === 'agent.open' && repeated.agent?.createdBy).toEqual(creator)
  expect(launch).toHaveBeenCalledOnce(); expect(h.start).toHaveBeenCalledOnce()
  expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(ports.focus).not.toHaveBeenCalled()
  expect(JSON.stringify(state.spatialRequests)).not.toContain(h.capability)
})
