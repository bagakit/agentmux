import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { AgentMuxFileAgentSessionStore, AgentMuxSpatialStateStore, connectAgentMuxRpc, issueAgentCapability, hashAgentCapability } from '@agentmux/core'
import { configuredDesktopAgentMuxHost, callOriginalDesktopHost } from '../src/main/desktop-host.js'
import * as originalTransport from '../src/main/desktop-host.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { ScratchTopics } from '../../host/src/mote-resources.js'
import { directoryIdentity, homeZoneId, SCRATCH_WORKSPACE_ID } from '../../host/src/mote-model.js'
import type { AppConfig } from '../src/shared/contracts.js'

vi.mock('electron', () => ({ app: { getPath: () => 'unused-original-desktop-profile' }, nativeImage: {} }))
const cleanup: Array<() => void | Promise<void>> = [], facts: unknown[] = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Original Desktop Host consumer cleanup failed')
})
afterAll(async () => { if (process.env.DESKTOP_CONNECTION_FACTS) await writeFile(process.env.DESKTOP_CONNECTION_FACTS, JSON.stringify({
  scope: 'Actual configured Desktop factory, compiled Node index child, original Core/SQLite and runtime-controller transport. Original Runtime byte I/O is controlled. No installed App, live platform, actual SSH deployment or default GUI cutover qualification.', facts
}, null, 2) + '\n') })
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-desktop-owner-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_|HOST_INDEX_)/u.test(key)) vi.stubEnv(key, undefined)
  const state = join(root, 'state'); await mkdir(state, { mode: 0o700 })
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', state)
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', join(state, 'sessions.json')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(state, 'messages.ndjson'))
  vi.stubEnv('AGENTMUX_SPATIAL_STATE_STORE', join(state, 'spatial.json'))
  vi.stubEnv('NODE_OPTIONS', '--import ' + pathToFileURL(resolve('apps/desktop/test/fixtures/desktop-connection-host-native.mjs')).href)
  vi.stubEnv('HOST_INDEX_NATIVE_FACTS', join(root, 'native-facts.json')); vi.stubEnv('HOST_INDEX_WORKSPACE', root)
  const store = new AgentMuxFileAgentSessionStore(join(state, 'sessions.json')), capability = issueAgentCapability()
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'original-managed-caller', providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: root,
    run: { runId: 'original-managed-run' }, retiredRuns: [], hookBindingId: 'original-hook', hookToken: 'synthetic-hook', capabilityHash: hashAgentCapability(capability), createdAt: 1, updatedAt: 1 })
  const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Original Mote source', path: join(root, 'scratch'), kind: 'folder' as const }
  await mkdir(workspace.path)
  const topics = new ScratchTopics(), topic = await topics.ensureMote(workspace, 'view:desktop-host-cold')
  const moteContent = '---\nversion: 1\n---\n# Original ordinary source\n'
  await writeFile(join(topic.physicalDirectoryPath!, 'MOTE.md'), moteContent)
  const spaceId = directoryIdentity('local', topic.identityDirectoryPath!), zoneId = homeZoneId(spaceId)
  const spatial = new AgentMuxSpatialStateStore(join(state, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [{ spaceId, hostId: 'local', kind: 'mote', name: 'Original Mote', directoryPath: topic.physicalDirectoryPath!, projectId: null, topicId: topic.id }],
    zones: [{ zoneId, workspaceId: workspace.id, kind: 'home', hostId: 'local', directoryPath: topic.physicalDirectoryPath!, branch: null }], bindings: [{ spaceId, zoneId }], tabs: [], regions: [], layouts: {}, tabLayouts: {}, resources: {} } })
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'local', label: 'Original local Host', kind: 'local' }], workspaces: [workspace] }
  const configurationPath = join(root, 'original-config.json'); await writeFile(configurationPath, JSON.stringify(config))
  const directory = join(root, 'original-connectors'), connect = configuredDesktopAgentMuxHost(configurationPath, directory)
  const children = new Set<number>()
  const stop = async (pid: number) => {
    process.kill(pid, 'SIGTERM')
    await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow() }, { timeout: 10_000 })
    children.delete(pid)
  }
  cleanup.push(async () => { for (const pid of children) { try { await stop(pid) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } } })
  const client = await connect(config.hosts[0]!, store); cleanup.push(() => client.dispose())
  await client.readAgentSessions()
  const raw = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(root, 'control.sock') } }); cleanup.push(() => raw.dispose())
  const owner = (await raw.call('runtime.owner.identity', {})).owner
  expect(owner.processId).not.toBe(process.pid); expect(owner.processId).toBeGreaterThan(1)
  children.add(owner.processId)
  const runtime = new RuntimeController(store, async () => client); cleanup.push(() => runtime.dispose())
  runtime.commit(await runtime.prepare(config))
  const target = { hostId: 'local', runtimeId: owner.runtimeId }
  const connection = { connectionId: 'same-original-connection', adapterId: 'discord', application: { domain: 'discord.com', appId: '100' }, label: 'Original saved bot', enabled: false, credentialRef: 'original-opaque-ref' }
  const targetMote = { spaceId, zoneId, expectedResource: { hostId: 'local', workspaceId: workspace.id, workspacePath: workspace.path } }
  return { root, state, store, client, connect, runtime, raw, target, owner, stop, children, config, directory, configurationPath, connection, targetMote, capability, moteContent,
    observeChild: async () => { const next = (await raw.call('runtime.owner.identity', {})).owner; children.add(next.processId); return next } }
}

it('the actual cold Desktop factory opts the compiled Node index into its original connector and Mote namespace', async () => {
  const f = await fixture()
  const hosting = await f.runtime.connectionHostingTarget().then(target => ({ target }), error => ({ error: error.code }))
  expect(hosting).toEqual({ target: f.target })
  expect(await f.runtime.callConnectionHost(f.target, 'connection.owner.inspect', {})).toEqual({ ownership: 'local' })
  const listed = await f.runtime.callConnectionHost(f.target, 'connection.ls', {}).then(value => ({ connections: value.connections }), error => ({ error: error.code }))
  expect(listed).toEqual({ connections: [] })
  expect(await f.runtime.callConnectionHost(f.target, 'space.mote.connection.inspect', { operationId: 'original-absent-parent' })).toEqual({ operation: null })
  const preferences = await f.runtime.callConnectionHost(f.target, 'space.mote.preferences.read', { kind: 'connection', target: f.targetMote })
  expect(preferences).toMatchObject({ status: 'ready', target: f.targetMote, source: { result: { status: 'read', document: { content: f.moteContent, revision: 'sha256:' + sha(Buffer.from(f.moteContent)) } } } })
  expect(await f.runtime.callConnectionHost(f.target, 'space.mote.chat.inspect', { target: f.targetMote })).toMatchObject({ configuration: null })
  const db = join(f.directory, 'connections.sqlite'); expect((await readFile(db)).byteLength).toBeGreaterThan(0)
  const log = await readFile(join(f.state, 'agentmux-host.log'), 'utf8')
  expect(log).toContain('jsonrpc-2.0'); expect(log).not.toContain('synthetic-hook')
  facts.push({ case: 'actual-cold-original-namespace', pid: f.owner.processId, namespace: true, motePreferences: preferences.status, databaseSHA256: sha(await readFile(db)), compiledIndexSHA256: sha(await readFile(resolve('apps/host/dist/index.js'))) })
})

it('original transport retains caller authority and refuses a foreign Runtime without falling back to a healthy local owner', async () => {
  const f = await fixture()
  await expect(f.runtime.callConnectionHost({ ...f.target, runtimeId: 'foreign-original-runtime' }, 'connection.configure', { operationId: 'wrong-owner-write', expectedRevision: null, connection: f.connection })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(await f.raw.call('connection.inspect', { connectionId: f.connection.connectionId })).toEqual({ connection: null, operation: null })
  const caller = { agentSessionId: 'original-managed-caller', capability: f.capability }
  expect((await f.raw.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: caller.agentSessionId } }, { credentials: caller })).session.agentSessionId).toBe(caller.agentSessionId)
  expect((await f.runtime.callConnectionHost(f.target, 'connection.ls', {}, { transport: 'unix', caller })).connections).toEqual([])
  const denied = await f.raw.call('connection.service.get', {}, { credentials: caller }).then(value => ({ value }), error => ({ code: error.code }))
  expect(denied).toHaveProperty('code')
  await expect(f.runtime.callConnectionHost(f.target, 'connection.service.get', {}, { transport: 'unix', caller })).rejects.toMatchObject(denied)
  await expect(f.runtime.callConnectionHost(f.target, 'connection.ls', {}, { transport: 'unix', principal: { kind: 'device', id: 'original-device' } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  const prior = (await f.store.readMetadata(caller.agentSessionId))!
  await f.store.compareAndSwapMetadata(prior, { ...prior, capabilityHash: hashAgentCapability(issueAgentCapability()) })
  await expect(f.runtime.callConnectionHost(f.target, 'connection.configure', { operationId: 'revoked-caller-write', expectedRevision: null, connection: f.connection }, { transport: 'unix', caller })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(await f.raw.call('connection.inspect', { connectionId: f.connection.connectionId })).toEqual({ connection: null, operation: null })
  expect((await f.raw.call('runtime.owner.identity', {})).owner).toEqual(f.owner)
  facts.push({ case: 'wrong-runtime-and-authority', wrongOwnerEffects: 0, healthyOriginalOwner: true })
})

it('a same-Runtime replacement between inspection and dispatch cannot receive the original frozen write', async () => {
  const f = await fixture(), call = originalTransport.callOriginalDesktopHost
  let replace = true
  vi.spyOn(originalTransport, 'callOriginalDesktopHost').mockImplementation(async (...args) => {
    const result = await call(...args)
    if (args[1] === 'connection.owner.inspect' && replace) {
      replace = false; await f.stop(f.owner.processId)
      f.client.disconnect(); await f.client.connect()
      const current = await f.observeChild()
      expect(current.runtimeId).toBe(f.owner.runtimeId); expect(current.ownerInstanceId).not.toBe(f.owner.ownerInstanceId)
    }
    return result
  })
  const outcome = await f.runtime.callConnectionHost(f.target, 'connection.configure', { operationId: 'frozen-original-write', expectedRevision: null, connection: f.connection }).then(value => ({ value }), error => ({ error }))
  const current = await f.raw.call('connection.inspect', { connectionId: f.connection.connectionId })
  facts.push({ case: 'same-runtime-replacement', currentConnection: current.connection, rejected: 'error' in outcome })
  expect(current.connection).toBeNull()
  expect(outcome).toMatchObject({ error: { code: 'RUNTIME_OWNER_CHANGED' } })
})

it('metadata uses the original fenced subscription and client disposal leaves its exact child and saved connection alive', async () => {
  const f = await fixture(), initial: unknown[] = [], events: unknown[] = []
  const watch = await f.runtime.watchConnectionMetadata(f.target, { onInitial: value => initial.push(value), onEvent: value => events.push(value) })
  cleanup.push(() => watch.dispose())
  expect(initial).toEqual([{}])
  await f.runtime.callConnectionHost(f.target, 'connection.configure', { operationId: 'original-retained-config', expectedRevision: null, connection: f.connection })
  const metadata = { connectionId: f.connection.connectionId, expectedConnectionRevision: 1, subject: { kind: 'conversation' as const, externalConversationId: '300' }, expectedCacheRevision: null }
  await f.runtime.callConnectionHost(f.target, 'connection.metadata.clear', metadata)
  await vi.waitFor(() => expect(events).toEqual([{ type: 'change', data: { connectionId: f.connection.connectionId, application: f.connection.application, subject: metadata.subject } }]))
  await f.client.dispose()
  const next = await f.connect(f.config.hosts[0]!, f.store); cleanup.push(() => next.dispose())
  const same = await callOriginalDesktopHost(next, 'runtime.owner.identity', {}, { transport: 'unix' })
  expect(same.owner.processId).toBe(f.owner.processId); expect(same.owner.ownerInstanceId).toBe(f.owner.ownerInstanceId)
  expect((await callOriginalDesktopHost(next, 'connection.inspect', { connectionId: f.connection.connectionId }, { transport: 'unix' })).connection?.config).toEqual(f.connection)
  await expect(f.runtime.watchConnectionMetadata(f.target, { onInitial() {}, onEvent() {} }, { caller: { agentSessionId: 'original-managed-caller', capability: 'synthetic-invalid-capability' } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  await callOriginalDesktopHost(next, 'connection.metadata.clear', metadata, { transport: 'unix' })
  expect(events).toHaveLength(1)
  facts.push({ case: 'metadata-reader-client-lifetime', initial: initial.length, deliveredEvents: events.length, lateEvents: 0, sameChild: true, savedConnection: true })
})
