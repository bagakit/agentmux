import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopConnectorSecrets } from '../../../apps/desktop/src/main/connector-secrets.js'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { enrollmentAvatar, enrollmentEncryption } from '../../connectors/test/fixtures/connection-enrollment.js'
import type { ConnectionAdapter } from '../../connectors/src/connection-host.js'
import type { ConnectionEnrollmentAdvanceInput, ConnectionEnrollmentView } from '../src/connections.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { issueAgentCapability, hashAgentCapability } from '../src/agent-capability.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { privateRpcCorePort } from './helpers/private-rpc-core.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
function result(output: { code: number | null; stdout: string; stderr: string }) { expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result }
function action(view: ConnectionEnrollmentView, kind: ConnectionEnrollmentAdvanceInput['decision']['kind']): ConnectionEnrollmentAdvanceInput {
  const offered = view.actions.find(a => a.kind === kind); expect(offered).toBeDefined()
  return { operationId: view.operation!.operationId, ownRevision: offered!.ownRevision, decision: { actionId: offered!.actionId, kind } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-connections-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const storePath = join(root, 'sessions.json'), store = new AgentMuxFileAgentSessionStore(storePath)
  const capability = issueAgentCapability(), otherCapability = issueAgentCapability()
  for (const [agentSessionId, cap] of [['operator', capability], ['other', otherCapability]]) await store.compareAndSwap(null, {
    kind: 'agent', agentSessionId: agentSessionId!, capabilityHash: hashAgentCapability(cap!), providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    run: { runId: 'run-' + agentSessionId }, hookBindingId: 'hook-' + agentSessionId, hookToken: 'token-' + agentSessionId, retiredRuns: [], createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1)
  })
  const core = await privateRpcCorePort(storePath, join(root, 'messages.ndjson')); cleanup.push(() => core.dispose())
  const effects: string[] = []
  const adapter: ConnectionAdapter = {
    adapterId: 'test-native', test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'unknown' }, intake: { state: 'unknown' }, delivery: { state: 'unknown' } }),
    enrollment: { domains: [{ domain: 'native.example', label: 'Native protocol' }],
      begin: async input => { input.assertCurrent(); effects.push('begin'); return { kind: 'authentication', stage: 'waiting', challenge: { qrPayload: 'private-original-qr', expiresAt: null, nextPollAt: _tailFixtureEpoch(0, 0, 0) }, account: null, privateState: 'signed-native-state' } },
      advance: async input => { input.assertCurrent(); effects.push('poll'); return { kind: 'authentication', stage: 'account', challenge: null, account: { userId: 'native-user', tenantId: 'native-tenant' }, privateState: input.privateState } },
      upload: async input => { input.assertCurrent(); effects.push('upload'); return { kind: 'uploaded', privateState: input.privateState } },
      create: async input => { input.assertCurrent(); effects.push('create'); return { kind: 'created', application: { domain: input.domain, appId: 'app-original' }, privateState: input.privateState } },
      credential: async input => { input.assertCurrent(); effects.push('credential'); return { kind: 'credential', secret: 'private-app-secret', privateState: input.privateState } }
    },
    roomDiscovery: {
      list: async () => ({ observation: { state: 'ready' }, rooms: [], next: null }),
      search: async () => ({ observation: { state: 'ready' }, rooms: [], next: null }),
      get: async () => ({ observation: { state: 'ready' }, room: null }),
      members: async () => ({ observation: { state: 'ready' }, members: [], next: null }),
      createLink: async () => { effects.push('link'); return { kind: 'confirmed', link: { url: 'https://join.example/original-private-link', expiresAtUnixSeconds: _tailFixtureEpoch(2) / 1000 } } }
    },
    setup: { domains: ['native.example'],
      begin: async () => { effects.push('setup'); return { kind: 'challenge', challenge: { qrPayload: 'private-setup-qr', expiresAt: null, nextPollAt: _tailFixtureEpoch(0, 0, 0) }, privateState: 'private-management-state' } },
      advance: async input => ({ kind: 'progress', stage: 'account', account: { userId: 'native-user', tenantId: 'native-tenant' }, challenge: null, privateState: input.privateState })
    }
  }
  let services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer
  const socketPath = join(root, 'owner.sock')
  const open = async () => {
    services = await createDesktopConnections({ directory: join(root, 'connections'), encryption: enrollmentEncryption(), adapters: [adapter] })
    server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: core.clients }); await server.start()
  }
  await open(); cleanup.push(async () => { await server.stop(); services.close() })
  const env = objectCliEnvironment(root, { AGENTMUX_AGENT_SESSION_ID: 'operator', AGENTMUX_AGENT_CAPABILITY: capability, AGENTMUX_AGENT_SESSION_STORE: storePath })
  const cli = (args: string[], input?: unknown, overrides = {}) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, ...args], { ...env, ...overrides }, input === undefined ? '' : JSON.stringify(input))
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath }, credentials: { agentSessionId: 'operator', capability } }); cleanup.push(() => sdk.dispose())
  const human = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => human.dispose())
  const input = { operationId: 'original-enrollment', connectionId: 'original-connection', adapterId: adapter.adapterId, domain: 'native.example', label: 'Original bot', preset: { name: 'Original bot', avatar: { pngDataUrl: enrollmentAvatar } } }
  return { root, effects, cli, input, sdk, human, get services() { return services }, capability, otherCapability,
    reopen: async () => { await server.stop(); services.close(); await open() } }
}

it('compiled Agent CLI creates its own original application and continues management through the actual Desktop connection owner', async () => {
  const f = await fixture()
  const discovered = result(await f.cli(['connection', 'enrollment', 'ls']))
  expect(discovered.operations).toEqual([]); expect(discovered.capabilities).toContainEqual(expect.objectContaining({ adapterId: 'test-native', domain: 'native.example' }))
  let view = result(await f.cli(['connection', 'enrollment', 'begin', '--input', '-'], f.input)) as ConnectionEnrollmentView
  expect(view.challenge?.qrPayload).toBe('private-original-qr')
  expect(f.effects).toEqual(['begin'])
  // There is no automatic polling, account confirmation or creation before an explicit offered decision.
  view = await f.sdk.call('connection.enrollment.advance', action(view, 'continue-authentication'))
  expect(view.account).toEqual({ userId: 'native-user', tenantId: 'native-tenant' }); expect(f.effects).toEqual(['begin', 'poll'])
  view = result(await f.cli(['connection', 'enrollment', 'advance', '--input', '-'], action(view, 'confirm-account')))
  const create = action(view, 'create')
  view = result(await f.cli(['connection', 'enrollment', 'advance', '--input', '-'], create))
  expect(view.operation?.configuration).toBe('configured'); expect(f.effects).toEqual(['begin', 'poll', 'upload', 'create', 'credential'])
  const row = JSON.parse(String(f.services.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(f.input.operationId)!.record_json))
  expect(row.actor).toEqual({ kind: 'agent', id: 'operator' })
  expect(result(await f.cli(['connection', 'ls'])).connections.map((c: any) => c.config.connectionId)).toEqual([f.input.connectionId])
  const setupInput = { operationId: 'original-setup', connectionId: f.input.connectionId, expectedConnectionRevision: 1, goal: { kind: 'agent-conversation', interaction: 'messages' } }
  const setup = result(await f.cli(['connection', 'setup', 'begin', '--input', '-'], setupInput))
  expect(setup.challenge.qrPayload).toBe('private-setup-qr')
  expect(JSON.parse(String(f.services.database!.prepare('SELECT actor_json FROM connection_setup_operation WHERE operation_id=?').get(setupInput.operationId)!.actor_json))).toEqual({ kind: 'agent', id: 'operator' })
  const humanSetup = await f.human.call('connection.setup.begin', { ...setupInput, operationId: 'human-setup' })
  expect(humanSetup.operation?.operationId).toBe('human-setup')
  expect(result(await f.cli(['connection', 'setup', 'ls', '--connection', f.input.connectionId])).operations.map((op: any) => op.operationId)).toEqual(['original-setup'])
  const before = [...f.effects]
  await f.reopen()
  expect(result(await f.cli(['connection', 'enrollment', 'inspect', '--operation-id', f.input.operationId])).operation).toEqual(view.operation)
  expect(result(await f.cli(['connection', 'enrollment', 'advance', '--input', '-'], create)).operation).toEqual(view.operation)
  expect(result(await f.cli(['connection', 'setup', 'inspect', '--operation-id', 'original-setup'])).challenge.qrPayload).toBe('private-setup-qr')
  expect(f.effects).toEqual(before)
}, 30_000)

it('authenticates original Agents and refuses foreign receipts, global policy and another Session without leaking private challenge data', async () => {
  const f = await fixture(), original = result(await f.cli(['connection', 'enrollment', 'begin', '--input', '-'], f.input))
  const other = { AGENTMUX_AGENT_SESSION_ID: 'other', AGENTMUX_AGENT_CAPABILITY: f.otherCapability }
  const wrong = await f.cli(['connection', 'enrollment', 'inspect', '--operation-id', f.input.operationId], undefined, other)
  expect(wrong.code).not.toBe(0); expect(wrong.stdout + wrong.stderr).not.toContain('private-original-qr')
  const forged = await f.cli(['connection', 'enrollment', 'ls'], undefined, { AGENTMUX_AGENT_CAPABILITY: 'forged' })
  expect(forged.code).not.toBe(0)
  expect(result(await f.cli(['connection', 'enrollment', 'ls'], undefined, other)).operations).toEqual([])
  expect((await f.cli(['connection', 'service', 'get'])).code).not.toBe(0)
  const humanInput = { ...f.input, operationId: 'human-original', connectionId: 'human-connection' }
  const human = await f.human.call('connection.enrollment.begin', humanInput)
  expect((await f.cli(['connection', 'enrollment', 'inspect', '--operation-id', 'human-original'])).code).not.toBe(0)
  expect((await f.human.call('connection.enrollment.inspect', { operationId: 'human-original' })).challenge).toEqual(human.challenge)
  expect((await f.cli(['connection', 'room', 'create', '--input', '-'], { operationId: 'foreign-room', connectionId: f.input.connectionId, expectedConnectionRevision: 1, agentSessionId: 'other', executionHostId: 'local', regionAnchor: { regionId: 'R' }, name: 'Room', members: [] })).code).not.toBe(0)
  expect((await f.cli(['connection', 'bind', '--input', '-'], { operationId: 'foreign-binding', bindingId: 'B', connectionId: f.input.connectionId, expectedConnectionRevision: 1, agentSessionId: 'other', executionHostId: 'local', regionAnchor: { regionId: 'R' }, externalConversationId: 'room', expectedSource: { providerId: 'codex', nativeSessionId: 'native' }, scope: { input: 'mentions-and-replies', publication: 'future-native-user-facing' } })).code).not.toBe(0)
  expect(f.effects).toEqual(['begin', 'begin'])
  expect((await f.sdk.call('connection.enrollment.inspect', { operationId: f.input.operationId })).operation).toEqual(original.operation)
}, 30_000)

it('generated action help and module skill explain actual Agent input, original authority and platform scan boundaries', async () => {
  const f = await fixture()
  const enrollment = await f.cli(['connection', 'enrollment', 'begin', '--help'])
  expect(enrollment.code).toBe(0); expect(enrollment.stdout).toContain('authenticated managed Agent'); expect(enrollment.stdout).toContain('scan')
  const setup = await f.cli(['connection', 'setup', 'begin', '--help'])
  expect(setup.stdout).toContain('own enrolled Connection'); expect(setup.stdout).toContain('operationId')
  const skill = await f.cli(['connection', '--skill'])
  expect(skill.code).toBe(0); expect(skill.stdout).toContain('connection enrollment begin --input'); expect(skill.stdout).toContain('Only a person can scan'); expect(skill.stdout).toContain('same Agent Session')
}, 30_000)

it('compiled Agent Mote flow reads saved identity, creates its original child and saves the exact default without crossing Workspace or actor', async () => {
  const { moteConnectionOwner } = await import('../../../apps/desktop/test/fixtures/mote-connection-owner.js')
  const root = await mkdtemp(join(tmpdir(), 'agent-mote-bot-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const f = await moteConnectionOwner(root, { generic: true }); cleanup.push(f.close)
  const storePath = join(root, 'agent-sessions.json'), store = new AgentMuxFileAgentSessionStore(storePath), capability = issueAgentCapability()
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: 'mote-operator', capabilityHash: hashAgentCapability(capability), providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: f.motes[0]!.directory, run: { runId: 'original-run' }, hookBindingId: 'hook-original', hookToken: 'token-original', retiredRuns: [], createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1) })
  const core = await privateRpcCorePort(storePath, join(root, 'agent-messages.ndjson')); cleanup.push(() => core.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(root, 'agent.sock'), moteConnections: f.parent, connections: f.connections.connections, spatialState: f.spatial, coreClients: core.clients }); await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(root, { AGENTMUX_AGENT_SESSION_ID: 'mote-operator', AGENTMUX_AGENT_CAPABILITY: capability, AGENTMUX_AGENT_SESSION_STORE: storePath })
  const cli = (args: string[], input?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'space', 'mote', 'connection', ...args], env, input === undefined ? '' : JSON.stringify(input))
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: { agentSessionId: 'mote-operator', capability } }); cleanup.push(() => sdk.dispose())
  const input = await f.input('agent-original-mote')
  let operation = result(await cli(['create', '--input', '-'], input))
  expect(operation.enrollment.authentication.stage).toBe('waiting'); expect(f.counts.begin).toBe(1)
  for (const kind of ['continue-authentication', 'confirm-account', 'create'] as const) {
    const view = await sdk.call('connection.enrollment.inspect', { operationId: operation.enrollmentOperationId })
    operation = result(await cli(['advance', '--input', '-'], { operationId: input.operationId, enrollment: action(view, kind) }))
  }
  expect(operation.defaultLink.state).toBe('saved'); expect(operation.connection).toEqual(expect.objectContaining({ connectionId: expect.any(String) }))
  expect((await f.preferences.read({ kind: 'connection', target: f.target() })).values?.connection).toEqual(operation.connection)
  expect(f.counts).toMatchObject({ begin: 1, authentication: 1, create: 1, credential: 1 })
  expect(JSON.stringify(operation)).not.toContain('DO-NOT-PUBLISH-SOUL')
  const humanInput = await f.input('human-original-mote')
  await f.client.call('space.mote.connection.create', humanInput)
  expect((await cli(['inspect', '--operation-id', humanInput.operationId])).code).not.toBe(0)
  expect(result(await cli(['ls', '--input', '-'], { target: f.target() })).operations.map((op: any) => op.operationId)).toEqual([input.operationId])
  const unrelatedMote = await f.input('unrelated-mote', 1)
  expect((await cli(['create', '--input', '-'], unrelatedMote)).code).not.toBe(0)
  const outside = { ...input, operationId: 'wrong-workspace', source: { ...input.source, target: { ...input.source.target, expectedResource: { ...input.source.target.expectedResource, workspacePath: join(root, 'unrelated') } } } }
  expect((await cli(['create', '--input', '-'], outside)).code).not.toBe(0)
  expect(result(await cli(['inspect', '--operation-id', input.operationId])).operation.defaultLink.state).toBe('saved')
  expect(f.counts.begin).toBe(2)
}, 30_000)

async function saveOriginal(f: Awaited<ReturnType<typeof fixture>>) {
  let view = await f.sdk.call('connection.enrollment.begin', f.input)
  for (const kind of ['continue-authentication', 'confirm-account', 'create'] as const) view = await f.sdk.call('connection.enrollment.advance', action(view, kind))
  expect(view.operation?.configuration).toBe('configured')
  return view
}

it('never transfers a user link receipt through Agent create re-entry or the original transaction race', async () => {
  const f = await fixture(); await saveOriginal(f)
  const input = { operationId: 'human-original-link', connectionId: f.input.connectionId, expectedConnectionRevision: 1, externalConversationId: 'original-room' }
  const human = await f.human.call('connection.room.link.create', input)
  expect(human.state).toBe('confirmed')
  const reentry = await f.cli(['connection', 'room', 'link', 'create', '--input', '-'], input)
  expect(reentry.code).not.toBe(0); expect(reentry.stdout + reentry.stderr).not.toContain('original-private-link')
  expect((await f.cli(['connection', 'room', 'link', 'inspect', '--operation-id', input.operationId])).code).not.toBe(0)
  expect(await f.human.call('connection.room.link.create', input)).toEqual(human)
  let entered!: () => void, release!: () => void, first = true
  const reached = new Promise<void>(done => { entered = done }), held = new Promise<void>(done => { release = done })
  const resolve = DesktopConnectorSecrets.prototype.resolve
  vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve').mockImplementation(async function (ref) {
    const value = await resolve.call(this, ref)
    if (first) { first = false; entered(); await held }
    return value
  })
  const racedInput = { ...input, operationId: 'raced-original-link' }
  const pending = f.cli(['connection', 'room', 'link', 'create', '--input', '-'], racedInput)
  await reached
  try { expect((await f.human.call('connection.room.link.create', racedInput)).state).toBe('confirmed') } finally { release() }
  const raced = await pending
  expect(raced.code).not.toBe(0); expect(raced.stdout + raced.stderr).not.toContain('original-private-link')
  expect(f.effects.filter(effect => effect === 'link')).toEqual(['link', 'link'])
  const own = result(await f.cli(['connection', 'room', 'link', 'create', '--input', '-'], { ...input, operationId: 'agent-own-link' }))
  expect(own.authorizedBy).toEqual({ kind: 'agent', id: 'operator' }); expect(own.state).toBe('confirmed')
}, 30_000)

it('keeps later human profile drafts outside the enrolled Agent actor while retaining its own inspectable operations', async () => {
  const f = await fixture(); await saveOriginal(f)
  const humanInput = { operationId: 'human-profile', connectionId: f.input.connectionId, expectedConnectionRevision: 1, desired: { name: 'private-human-profile-draft' } }
  const human = await f.human.call('connection.profile.sync', humanInput)
  expect(human.desired.name).toBe('private-human-profile-draft')
  const inspected = await f.cli(['connection', 'profile', 'inspect', '--operation-id', humanInput.operationId])
  expect(inspected.code).not.toBe(0); expect(inspected.stdout + inspected.stderr).not.toContain('private-human-profile-draft')
  expect(result(await f.cli(['connection', 'profile', 'ls', '--connection', f.input.connectionId])).operations).toEqual([])
  const own = result(await f.cli(['connection', 'profile', 'sync', '--input', '-'], { ...humanInput, operationId: 'agent-profile', desired: { name: 'Agent original profile' } }))
  expect(result(await f.cli(['connection', 'profile', 'inspect', '--operation-id', 'agent-profile'])).operation).toEqual(own)
  expect(result(await f.cli(['connection', 'profile', 'ls', '--connection', f.input.connectionId])).operations).toEqual([own])
  expect((await f.human.call('connection.profile.inspect', { operationId: humanInput.operationId })).operation).toEqual(human)
}, 30_000)

it('compiled binding discovery filters another actor bot even when that actor bound the same original Session', async () => {
  const { roomBindingFixture } = await import('../../connectors/test/fixtures/room-binding.js')
  const f = await roomBindingFixture(true, { retired: false }); cleanup.push(() => f.close())
  const capability = issueAgentCapability(), retained = (await f.store.load()).find(session => session.agentSessionId === f.session.agentSessionId)!
  await f.store.compareAndSwap(retained, { ...retained, capabilityHash: hashAgentCapability(capability) })
  const bound = await f.bindings.bind(f.input, { actor: { kind: 'user', id: 'human-original-operator' } })
  expect(bound.state).toBe('applied')
  const core = await privateRpcCorePort(f.storePath, join(f.root, 'messages.ndjson')); cleanup.push(() => core.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'agent-binding.sock'), connections: f.connections, spatialState: f.spatial, coreClients: core.clients }); await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_ID: f.session.agentSessionId, AGENTMUX_AGENT_CAPABILITY: capability, AGENTMUX_AGENT_SESSION_STORE: f.storePath })
  const listed = result(await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'binding', 'ls', '--session', f.session.agentSessionId], env))
  expect(listed.bindings).toEqual([])
  const original = await f.bindings.inspect({ operationId: f.input.operationId })
  expect(original.operation).toEqual(bound)
}, 30_000)
