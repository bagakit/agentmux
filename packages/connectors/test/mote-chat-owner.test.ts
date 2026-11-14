import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { ObjectCliProbe, objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { parseMoteChatParams, parseMoteChatResult, type MoteChatConfigure, type MoteChatGeneration } from '@agentmux/core/mote-chat'
import { ConnectionHost } from '../src/connection-host.js'
import { MoteChatHost, composeMoteChatBindings, type MoteChatAgentPort, type MoteChatCreatedAgent, type MoteChatIncoming, type MoteChatPreparedLaunch } from '../src/mote-chat.js'

const fixtures: Array<{ connections: ConnectionHost; root: string }> = []
afterEach(async () => { for (const f of fixtures.splice(0)) { f.connections.close(); await rm(f.root, { recursive: true, force: true }) }; vi.restoreAllMocks() })
const context = { actor: { kind: 'user' as const, id: 'original-user' } }
const application = { domain: 'chat.example', appId: 'original-app' }
const creator = { application, idType: 'open_id', userId: 'creator' }
const guest = { ...creator, userId: 'guest' }
const lanePerson = { ...creator, userId: 'lane-person' }
const target = { spaceId: 'original-mote', zoneId: 'original-home', expectedResource: { hostId: 'local', workspaceId: 'mote-files', workspacePath: 'mote-home' } }
async function fixture(limit = 4, confirmedCreator = true) {
  const root = await mkdtemp(join(tmpdir(), 'mote-chat-owner-')), databasePath = join(root, 'connections.sqlite')
  const connection = { connectionId: 'original-connection', adapterId: 'sample', application, label: 'Same name', enabled: true, credentialRef: 'private-ref' }
  const profile = vi.fn(async () => ({ connectionId: connection.connectionId, connectionRevision: 1, application, language: null,
    state: 'observed' as const, profile: null, metadata: null, creator: confirmedCreator ? { idType: creator.idType, userId: creator.userId } : null, botId: null, onlineVersionId: null, reviewingVersionId: null, version: null }))
  const connections = new ConnectionHost({ databasePath, secrets: { resolve: async () => 'private-credential' }, adapters: [{ adapterId: 'sample', test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'ready' }, delivery: { state: 'ready' } }), profile: { get: profile } }] })
  await connections.configure({ operationId: 'save-connection', expectedRevision: null, connection })
  let clock = 10
  const created = new Map<string, MoteChatCreatedAgent>(), prepared: Array<{ generation: MoteChatGeneration; recent: MoteChatGeneration[]; systemContext: string }> = []
  const agents: MoteChatAgentPort = {
    prepare: vi.fn(async input => {
      prepared.push(structuredClone(input))
      return { executionHostId: 'local', input: { agentSessionId: input.generation.agentSessionId, createOperationId: input.generation.createOperationId,
        providerId: 'claude', executorId: 'original-executor', workspacePath: 'mote-home', injectAgentMuxGuide: true, agentMuxNote: input.systemContext } }
    }),
    create: vi.fn(async plan => {
      const agentSessionId = plan.input.agentSessionId!
      const result = { executionHostId: plan.executionHostId, agentSessionId, regionId: `region-${agentSessionId}` }
      created.set(plan.input.createOperationId!, result); return result
    }),
    inspect: vi.fn(async plan => created.get(plan.input.createOperationId!) ?? null),
    prepareInput: vi.fn(async () => {}),
    activity: vi.fn(async () => ({ lastActivityAt: 10 }))
  }
  const assertTarget = vi.fn(async () => {})
  const options = { connections, agents, assertTarget, now: () => clock }, host = new MoteChatHost(options)
  const input: MoteChatConfigure = { operationId: 'enable-chat', target, expectedRevision: null, expectedConnectionRevision: 1,
    ...(confirmedCreator ? { refreshCreator: true as const } : {}),
    values: { enabled: true, connection: { connectionId: connection.connectionId, application }, conversationIdleMs: 100, strangerMessageLimit: limit } }
  await host.configure(input, context)
  const incoming = (id: string, actor = lanePerson, externalConversationId = `chat-${actor.userId}`): MoteChatIncoming => ({ conversationKind: 'direct',
    ingressId: `ingress-${id}`, connectionId: connection.connectionId, application, externalMessageId: id, externalConversationId, actor })
  const f = { root, databasePath, connections, connection, profile, input, agents, assertTarget, host, options, prepared, created, incoming,
    time(value: number) { clock = value }, restart() { return new MoteChatHost(options) } }
  fixtures.push(f); return f
}

it('keeps configuration and original operation readable without launching, with exact trusted management and application ownership', async () => {
  const f = await fixture()
  expect((await f.host.inspect({ operationId: f.input.operationId }, context)).operation).toMatchObject({ action: 'configure', configuration: { creator, revision: 1 } })
  expect(await f.host.configure(f.input, context)).toEqual((await f.host.inspect({ operationId: f.input.operationId })).operation)
  expect(f.agents.prepare).not.toHaveBeenCalled(); expect(f.agents.create).not.toHaveBeenCalled()
  await expect(f.host.configure({ ...f.input, operationId: 'agent-attempt' }, { actor: { kind: 'agent', id: 'other-agent' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.host.configure({ ...f.input, operationId: 'another-mote', target: { ...target, spaceId: 'another-mote' } }, context)).rejects.toMatchObject({ code: 'MOTE_CHAT_APPLICATION_IN_USE' })
  await expect(f.host.configure({ ...f.input, values: { ...f.input.values, strangerMessageLimit: 9 } }, context)).rejects.toMatchObject({ code: 'MOTE_CHAT_OPERATION_CONFLICT' })
  await expect(f.host.configure({ ...f.input, operationId: 'stale-save' }, context)).rejects.toMatchObject({ code: 'MOTE_CHAT_REVISION_CONFLICT' })
  const other = { ...f.connection, connectionId: 'other-connection', application: { ...application, appId: 'other-app' } }
  await f.connections.configure({ operationId: 'save-other', expectedRevision: null, connection: other })
  f.profile.mockResolvedValueOnce({ ...(await f.profile()), connectionId: other.connectionId, application: other.application, creator: null } as never)
  const { refreshCreator: _refresh, ...policy } = f.input
  const saved = await f.host.configure({ ...policy, operationId: 'missing-creator', expectedRevision: 1, values: { ...f.input.values, connection: { connectionId: other.connectionId, application: other.application } } }, context)
  expect(saved.configuration.creator).toBeNull()
  expect(saved.configuration.values.connection).toEqual({ connectionId: other.connectionId, application: other.application })
})

it('admits only an explicitly finite guest when the native application cannot confirm a creator', async () => {
  const f = await fixture(1, false)
  expect((await f.host.inspect({ target })).configuration).toMatchObject({ creator: null, values: { enabled: true } })
  const binding = await f.host.prepareIncoming(f.incoming('finite-native-guest', creator))
  expect(binding).toMatchObject({ agentSessionId: expect.any(String) })
  expect(f.agents.create).toHaveBeenCalledOnce()
  expect((await f.host.audience({ target })).people).toMatchObject([{ actor: creator, creator: false, total: 1, used: 1, remaining: 0 }])
  await expect(f.host.prepareIncoming(f.incoming('finite-exhausted', creator))).rejects.toMatchObject({ code: 'MOTE_CHAT_QUOTA_EXHAUSTED' })
  expect(await f.host.prepareIncoming(f.incoming('finite-native-guest', creator))).toEqual(binding)
  expect((await f.host.history({ target })).generations).toHaveLength(1)
})

it('keeps creator-null default zero closed and allocates one exact guest without replaying its refused original input', async () => {
  const f = await fixture(0, false), declined = f.incoming('null-creator-zero', guest)
  await expect(f.host.prepareIncoming(declined)).rejects.toMatchObject({ code: 'MOTE_CHAT_QUOTA_EXHAUSTED' })
  const person = (await f.host.audience({ target })).people[0]!
  expect(person).toMatchObject({ creator: false, total: 0, used: 0, remaining: 0 })
  expect(f.agents.create).not.toHaveBeenCalled()
  await f.host.allocate({ operationId: 'null-creator-allocate', target, expectedConfigurationRevision: 1, actor: guest, expectedPersonRevision: person.revision, total: 1 }, context)
  expect(f.host.store.admissionByIngress(declined.ingressId)).toBeNull()
  await f.host.prepareIncoming(f.incoming('null-creator-authorized', guest))
  expect((await f.host.audience({ target })).people[0]).toMatchObject({ total: 1, used: 1, remaining: 0 })
  expect(f.agents.create).toHaveBeenCalledOnce()
})

it('retains same-application creator proof across unavailable profile observations and connection aliases', async () => {
  const f = await fixture(), alias = { ...f.connection, connectionId: 'same-application-alias' }
  const { refreshCreator: _refresh, ...policy } = f.input
  await f.connections.configure({ operationId: 'save-alias', expectedRevision: null, connection: alias })
  f.profile.mockResolvedValue({ ...(await f.profile()), connectionId: alias.connectionId, creator: null, state: 'unknown', reason: 'online-unconfirmed' } as never)
  const saved = await f.host.configure({ ...policy, operationId: 'select-alias', expectedRevision: 1, values: { ...f.input.values, connection: { connectionId: alias.connectionId, application } } }, context)
  expect(saved.configuration.creator).toEqual(creator)
  expect(saved.configuration.values.connection?.connectionId).toBe(alias.connectionId)
  const get = vi.spyOn(f.connections.profile!, 'get').mockRejectedValueOnce(Object.assign(new Error('Original authority was revoked'), { code: 'CONTROL_PERMISSION_DENIED' }))
  await expect(f.host.configure({ ...f.input, operationId: 'revoked-profile', expectedRevision: 2 }, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(get).toHaveBeenCalledOnce()
  expect((await f.host.inspect({ target })).configuration).toEqual(saved.configuration)
})

it('qualifies only the requested audience page against confirmed current creator while retaining historical receipts and usage', async () => {
  const f = await fixture(4, false)
  await f.host.prepareIncoming(f.incoming('before-confirmation', guest))
  await f.host.prepareIncoming(f.incoming('other-before-confirmation', lanePerson))
  const before = (await f.host.audience({ target })).people, old = before.find(person => person.actor.userId === guest.userId)!
  f.profile.mockResolvedValue({ ...(await f.profile()), creator: { idType: guest.idType, userId: guest.userId } })
  await f.host.configure({ ...f.input, operationId: 'confirm-guest-is-creator', expectedRevision: 1, refreshCreator: true }, context)
  const untouched = f.host.store.person(JSON.stringify([target.spaceId, application.domain, application.appId, lanePerson.idType, lanePerson.userId]))
  const peopleRead = vi.spyOn(f.host.store, 'people')
  const promoted = (await f.host.audience({ target, limit: 1 })).people[0]!
  expect(promoted).toMatchObject({ actor: guest, creator: true, total: null, used: 1, remaining: null, revision: old.revision + 1 })
  expect(peopleRead).toHaveBeenCalledWith(target.spaceId, '', 2)
  expect(f.host.store.person(JSON.stringify([target.spaceId, application.domain, application.appId, lanePerson.idType, lanePerson.userId]))).toEqual(untouched)
  await expect(f.host.allocate({ operationId: 'cannot-allocate-current-creator', target, expectedConfigurationRevision: 2, actor: guest, expectedPersonRevision: promoted.revision, total: 99 }, context)).rejects.toMatchObject({ code: 'MOTE_CHAT_CREATOR_UNLIMITED' })
  f.profile.mockResolvedValue({ ...(await f.profile()), creator: { idType: creator.idType, userId: creator.userId } })
  await f.host.configure({ ...f.input, operationId: 'confirm-different-creator', expectedRevision: 2, refreshCreator: true, values: { ...f.input.values, strangerMessageLimit: 2 } }, context)
  const demoted = (await f.host.audience({ target })).people.find(person => person.actor.userId === guest.userId)!
  expect(demoted).toMatchObject({ creator: false, total: 2, used: 1, remaining: 1, revision: promoted.revision + 1 })
  await f.host.prepareIncoming(f.incoming('after-demotion', guest))
  await expect(f.host.prepareIncoming(f.incoming('demoted-exhausted', guest))).rejects.toMatchObject({ code: 'MOTE_CHAT_QUOTA_EXHAUSTED' })
  expect((await f.host.history({ target })).generations).toHaveLength(2)
})

it('uses the same current qualification in exact allocation and intake before any audience read, preserving original operations and admissions', async () => {
  const f = await fixture(2, false), first = f.incoming('qualification-before-page', guest)
  const binding = await f.host.prepareIncoming(first), old = (await f.host.audience({ target })).people[0]!
  const allocation = { operationId: 'original-finite-allocation', target, expectedConfigurationRevision: 1, actor: guest, expectedPersonRevision: old.revision, total: 3 }
  const receipt = await f.host.allocate(allocation, context)
  f.profile.mockResolvedValue({ ...(await f.profile()), creator: { idType: guest.idType, userId: guest.userId } })
  await f.host.configure({ ...f.input, operationId: 'qualification-promote', expectedRevision: 1, refreshCreator: true }, context)
  await expect(f.host.allocate({ ...allocation, operationId: 'stale-guest-authority', expectedConfigurationRevision: 2, expectedPersonRevision: receipt.person.revision }, context)).rejects.toMatchObject({ code: 'MOTE_CHAT_CREATOR_UNLIMITED' })
  const promoted = (await f.host.audience({ target })).people[0]!
  f.profile.mockResolvedValue({ ...(await f.profile()), creator: { idType: creator.idType, userId: creator.userId } })
  await f.host.configure({ ...f.input, operationId: 'qualification-demote', expectedRevision: 2, refreshCreator: true }, context)
  await expect(f.host.allocate({ ...allocation, operationId: 'stale-creator-authority', expectedConfigurationRevision: 3, expectedPersonRevision: promoted.revision }, context)).rejects.toMatchObject({ code: 'MOTE_CHAT_REVISION_CONFLICT' })
  await f.host.prepareIncoming(f.incoming('qualification-new-guest-input', guest))
  expect((await f.host.audience({ target })).people[0]).toMatchObject({ creator: false, total: 2, used: 2, remaining: 0 })
  expect(await f.host.prepareIncoming(first)).toEqual(binding)
  expect(await f.host.allocate(allocation, context)).toEqual(receipt)
  expect((await f.host.inspect({ operationId: allocation.operationId })).operation).toEqual(receipt)
  expect((await f.host.audience({ target })).people[0]).toMatchObject({ used: 2, remaining: 0 })
  expect(f.agents.create).toHaveBeenCalledOnce()
})

it('strict public chat codec permits nullable creator without accepting cross-application authority, unknown fields or unlimited guest quota', () => {
  const configuration = { target, revision: 1, values: { enabled: true, connection: { connectionId: 'native-bot', application }, conversationIdleMs: 1, strangerMessageLimit: 0 }, creator: null }
  expect(parseMoteChatResult('space.mote.chat.inspect', { configuration, operation: null }, { target })).toEqual({ configuration, operation: null })
  expect(() => parseMoteChatResult('space.mote.chat.inspect', { configuration: { ...configuration, creator: { ...creator, application: { ...application, appId: 'foreign-app' } } }, operation: null }, { target })).toThrow()
  expect(() => parseMoteChatResult('space.mote.chat.inspect', { configuration: { ...configuration, guestUnlimited: true }, operation: null }, { target })).toThrow()
  expect(() => parseMoteChatResult('space.mote.chat.audience', { people: [{ actor: guest, creator: false, revision: 1, total: null, used: 0, remaining: null }], next: null }, { target })).toThrow()
  const input = { operationId: 'strict-refresh', target, expectedRevision: null, expectedConnectionRevision: 1, values: configuration.values }
  expect(parseMoteChatParams('space.mote.chat.configure', { ...input, refreshCreator: true })).toEqual({ ...input, refreshCreator: true })
  const receipt = { operationId: input.operationId, action: 'configure', configuration }
  expect(parseMoteChatResult('space.mote.chat.configure', receipt, input)).toEqual(receipt)
  expect(() => parseMoteChatResult('space.mote.chat.configure', receipt, { ...input, refreshCreator: true })).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  for (const refreshCreator of [false, null, 1, 'true', undefined]) expect(() => parseMoteChatParams('space.mote.chat.configure', { ...input, refreshCreator })).toThrow()
})

it('the actual public RPC client rejects a raw null-creator refresh receipt while retaining the original complete request', async () => {
  const f = await fixture(0, false), input = { ...f.input, operationId: 'raw-null-refresh-receipt', expectedRevision: 1, refreshCreator: true as const }
  const configuration = (await f.host.inspect({ target })).configuration!
  const probe = new ObjectCliProbe(() => ({ operationId: input.operationId, action: 'configure', configuration }))
  await probe.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: probe.socketPath } })
  try {
    await expect(rpc.call('space.mote.chat.configure', input)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + probe.socketPath, 'space', 'mote', 'chat', 'configure', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(input))
    expect(cli.code).not.toBe(0); expect(cli.stdout + cli.stderr).toContain('CONTROL_PROTOCOL_ERROR')
    expect(probe.requests).toMatchObject([{ method: 'space.mote.chat.configure', params: input }, { method: 'space.mote.chat.configure', params: input }])
    expect((await f.host.inspect({ target })).configuration).toEqual(configuration)
  } finally { await rpc.dispose(); await probe.stop() }
}, 15_000)

it('public RPC and compiled CLI ordinary policy saves never wait for online profile and explicit refresh keeps its original action identity', async () => {
  const f = await fixture(0, false), native = (await f.profile.getMockImplementation()!())
  let release!: (value: typeof native) => void
  f.profile.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const online = vi.spyOn(f.connections.profile!, 'get')
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'quick.sock'), moteChat: f.host })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const plain = { ...f.input, operationId: 'public-plain-with-never', expectedRevision: 1 }
  const work = rpc.call('space.mote.chat.configure', plain)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve('profile-waited'), 1_000) })])
    expect(result).toMatchObject({ action: 'configure', configuration: { revision: 2, creator: null } })
    expect(online).not.toHaveBeenCalled(); expect(f.profile).not.toHaveBeenCalled()
    const run = (input: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'space', 'mote', 'chat', 'configure', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(input))
    const cliPlain = { ...plain, operationId: 'cli-plain-with-never', expectedRevision: 2 }
    const saved = await run(cliPlain)
    expect(saved.code, saved.stderr + saved.stdout).toBe(0)
    expect(JSON.parse(saved.stdout).result.configuration).toMatchObject({ revision: 3, creator: null })
    expect(online).not.toHaveBeenCalled(); expect(f.profile).not.toHaveBeenCalled()
    f.profile.mockReset().mockResolvedValue({ ...native, creator: { idType: creator.idType, userId: creator.userId } })
    const refresh = { ...plain, operationId: 'cli-explicit-qualification', expectedRevision: 3, refreshCreator: true }
    const confirmed = await run(refresh)
    expect(confirmed.code, confirmed.stderr + confirmed.stdout).toBe(0)
    expect(JSON.parse(confirmed.stdout).result.configuration).toMatchObject({ revision: 4, creator })
    expect(online).toHaveBeenCalledOnce()
    const changedFlag = await run({ ...cliPlain, refreshCreator: true })
    expect(changedFlag.code).not.toBe(0); expect(changedFlag.stdout + changedFlag.stderr).toContain('MOTE_CHAT_OPERATION_CONFLICT')
    f.profile.mockResolvedValue({ ...native, state: 'unknown', reason: 'online-unconfirmed', creator: null } as never)
    const declined = await run({ ...refresh, operationId: 'cli-unconfirmed-qualification', expectedRevision: 4 })
    expect(declined.code).not.toBe(0); expect(declined.stdout + declined.stderr).toContain('MOTE_CHAT_CREATOR_UNCONFIRMED')
    expect((await rpc.call('space.mote.chat.inspect', { target })).configuration).toMatchObject({ revision: 4, creator })
    expect(f.agents.create).not.toHaveBeenCalled()
  } finally {
    if (timer) clearTimeout(timer)
    release?.(native); await work.catch(() => {})
    await rpc.dispose(); await server.stop()
  }
}, 20_000)

it('explicit unconfirmed qualification retains the old proof and policy and never records a success or replays an old operation', async () => {
  const f = await fixture(), saved = (await f.host.inspect({ target })).configuration!
  const native = await f.profile.getMockImplementation()!()
  f.profile.mockResolvedValue({ ...native, state: 'unknown', reason: 'online-unconfirmed', creator: null } as never)
  const refresh = { ...f.input, operationId: 'unconfirmed-refresh', expectedRevision: 1 }
  await expect(f.host.configure(refresh, context)).rejects.toMatchObject({ code: 'MOTE_CHAT_CREATOR_UNCONFIRMED' })
  expect((await f.host.inspect({ target })).configuration).toEqual(saved)
  expect((await f.host.inspect({ operationId: refresh.operationId })).operation).toBeNull()
  const { refreshCreator: _refresh, ...plain } = refresh
  expect((await f.host.configure(plain, context)).configuration.creator).toEqual(creator)
  await expect(f.host.configure(refresh, context)).rejects.toMatchObject({ code: 'MOTE_CHAT_OPERATION_CONFLICT' })
})

it('a held public creator refresh cannot block a newer ordinary policy save or overwrite its original configuration CAS', async () => {
  const f = await fixture(), native = await f.profile.getMockImplementation()!()
  let release!: (value: typeof native) => void, reached!: () => void
  const entering = new Promise<void>(resolve => { reached = resolve })
  f.profile.mockImplementationOnce(() => { reached(); return new Promise(resolve => { release = resolve }) })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'held.sock'), moteChat: f.host })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const refresh = { ...f.input, operationId: 'held-original-refresh', expectedRevision: 1 }
  const work = rpc.call('space.mote.chat.configure', refresh).then(value => ({ value }), error => ({ error }))
  try {
    await entering
    const { refreshCreator: _refresh, ...policy } = f.input
    const input = { ...policy, operationId: 'newer-plain-policy', expectedRevision: 1, values: { ...policy.values, strangerMessageLimit: 7 } }
    const saved = await rpc.call('space.mote.chat.configure', input)
    expect(saved.configuration).toMatchObject({ revision: 2, creator, values: { strangerMessageLimit: 7 } })
    release({ ...native, creator: { idType: guest.idType, userId: guest.userId } })
    expect(await work).toMatchObject({ error: { code: 'MOTE_CHAT_REVISION_CONFLICT' } })
    expect((await rpc.call('space.mote.chat.inspect', { target })).configuration).toEqual(saved.configuration)
    expect((await rpc.call('space.mote.chat.inspect', { operationId: refresh.operationId })).operation).toBeNull()
    expect(f.profile).toHaveBeenCalledTimes(2); expect(f.agents.create).not.toHaveBeenCalled()
  } finally { release?.(native); await work; await rpc.dispose(); await server.stop() }
}, 15_000)

it('scoped private chat policy pauses new creation and publication without deleting the original route or Agent', async () => {
  const f = await fixture(), adapterId = f.connection.adapterId
  const policy = (operationId: string, expectedRevision: number, enabled: boolean) => ({ operationId, expectedRevision, adapterId, service: { enabled } })
  await f.connections.service.configure(policy('pause-private-adapter', 0, false))
  await expect(f.host.prepareIncoming(f.incoming('paused-message'))).rejects.toMatchObject({ code: 'CONNECTION_SERVICE_DISABLED' })
  expect(f.agents.prepare).not.toHaveBeenCalled(); expect(f.agents.create).not.toHaveBeenCalled()
  expect((await f.host.inspect({ target }, context)).configuration?.values).toEqual(f.input.values)
  expect(await f.connections.service.get()).toEqual({ enabled: true, revision: 0 })
  await f.connections.service.configure(policy('enable-private-adapter', 1, true))
  const binding = (await f.host.prepareIncoming(f.incoming('paused-message')))!
  expect(f.agents.create).toHaveBeenCalledOnce()
  expect(f.host.publicationAuthority(binding.bindingId, binding.revision).authorized).toBe(true)
  await f.connections.service.configure(policy('pause-existing-private-adapter', 2, false))
  expect(f.host.publicationAuthority(binding.bindingId, binding.revision)).toMatchObject({ binding, authorized: false, reason: 'service-disabled' })
  expect(f.host.readExact(binding.bindingId, binding.revision)).toEqual(binding)
  expect((await f.host.inspect({ target }, context)).configuration?.values).toEqual(f.input.values)
  expect(f.agents.create).toHaveBeenCalledOnce()
})

it('reserves one generation for concurrent first messages and charges each original message once across duplicate events', async () => {
  const f = await fixture(2), original = f.agents.create
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), entering = new Promise<void>(resolve => { reached = resolve })
  f.agents.create = vi.fn(async plan => { reached(); await gate; return await original(plan) })
  const first = f.host.prepareIncoming(f.incoming('first', guest)); await entering
  const second = f.host.prepareIncoming(f.incoming('second', guest)), duplicate = f.host.prepareIncoming(f.incoming('first', guest))
  release(); const ready = Promise.all([first, second, duplicate])
  await expect(ready).resolves.toHaveLength(3)
  const bindings = await ready
  expect(new Set(bindings.map(b => b?.agentSessionId)).size).toBe(1)
  expect(f.agents.prepare).toHaveBeenCalledTimes(1); expect(f.agents.create).toHaveBeenCalledTimes(1)
  expect(f.prepared[0]!.generation.generationId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/u)
  expect((await f.host.audience({ target })).people).toMatchObject([{ actor: guest, used: 2, total: 2, remaining: 0 }])
  const binding = bindings[0]!
  expect(f.host.hasAdmission('ingress-first', binding.bindingId, guest)).toBe(true)
  expect(f.host.hasAdmission('ingress-second', binding.bindingId, guest)).toBe(true)
  expect(f.host.readGrant(f.host.grants(binding.bindingId, 1)[0]!.grantId)).toMatchObject({ state: 'active' })
  await expect(f.host.prepareIncoming(f.incoming('third', guest))).rejects.toMatchObject({ code: 'MOTE_CHAT_QUOTA_EXHAUSTED' })
  expect(f.agents.create).toHaveBeenCalledTimes(1)
  expect(f.host.publicationAuthority(binding.bindingId, 1).authorized).toBe(true)
})

it('shows a zero-allowance guest without a launch, preserves used on allocation and seeds changed defaults only for new people', async () => {
  const f = await fixture(0)
  await expect(f.host.prepareIncoming(f.incoming('declined', guest))).rejects.toMatchObject({ code: 'MOTE_CHAT_QUOTA_EXHAUSTED' })
  const person = (await f.host.audience({ target })).people[0]!
  expect(person).toMatchObject({ creator: false, total: 0, used: 0 }); expect(f.agents.create).not.toHaveBeenCalled()
  await f.host.allocate({ operationId: 'allocate-two', target, expectedConfigurationRevision: 1, actor: guest, expectedPersonRevision: person.revision, total: 2 }, context)
  await f.host.prepareIncoming(f.incoming('accepted', guest))
  const used = (await f.host.audience({ target })).people[0]!
  await f.host.allocate({ operationId: 'allocate-three', target, expectedConfigurationRevision: 1, actor: guest, expectedPersonRevision: used.revision, total: 3 }, context)
  const changed = await f.host.configure({ ...f.input, operationId: 'new-default', expectedRevision: 1, values: { ...f.input.values, strangerMessageLimit: 8 } }, context)
  expect(changed.configuration.revision).toBe(2)
  await f.host.prepareIncoming(f.incoming('another-person', { ...guest, userId: 'new-person' }))
  const audience = (await f.host.audience({ target })).people
  expect(audience.find(p => p.actor.userId === guest.userId)).toMatchObject({ total: 3, used: 1, remaining: 2 })
  expect(audience.find(p => p.actor.userId === 'new-person')).toMatchObject({ total: 8, used: 1, remaining: 7 })
  await expect(f.host.prepareIncoming(f.incoming('creator-message', creator))).rejects.toMatchObject({ code: 'MOTE_CHAT_MAIN_UNCONFIRMED' })
})

it('does not write an allowance after the original management authorization is revoked during target verification', async () => {
  const f = await fixture(0)
  await expect(f.host.prepareIncoming(f.incoming('declined', guest))).rejects.toMatchObject({ code: 'MOTE_CHAT_QUOTA_EXHAUSTED' })
  const person = (await f.host.audience({ target })).people[0]!
  let authorized = true
  f.assertTarget.mockImplementationOnce(async () => { authorized = false })
  const assertCurrent = vi.fn(async () => { if (!authorized) throw new Error('Original management access revoked') })
  const input = { operationId: 'revoked-allocation', target, expectedConfigurationRevision: 1, actor: guest, expectedPersonRevision: person.revision, total: 2 }
  await expect(f.host.allocate(input, { ...context, assertCurrent })).rejects.toThrow('Original management access revoked')
  expect(assertCurrent).toHaveBeenCalledTimes(2)
  expect((await f.host.audience({ target })).people).toEqual([person])
  expect((await f.host.inspect({ operationId: input.operationId })).operation).toBeNull()
  authorized = true
  expect((await f.host.allocate(input, { ...context, assertCurrent })).person).toMatchObject({ total: 2, used: 0 })
  expect(f.agents.create).not.toHaveBeenCalled()
})

it('reuses at the exact interval, rolls strictly above it, keeps older reply authority and injects only the recent three same-lane Agents', async () => {
  const f = await fixture(10), first = (await f.host.prepareIncoming(f.incoming('first')))!; f.time(110)
  expect((await f.host.prepareIncoming(f.incoming('equal')))!.agentSessionId).toBe(first.agentSessionId)
  f.time(211); const second = (await f.host.prepareIncoming(f.incoming('above')))!
  expect(second.agentSessionId).not.toBe(first.agentSessionId)
  expect(f.host.publicationAuthority(first.bindingId, 1).authorized).toBe(true)
  expect(f.host.readCurrent(first.bindingId)?.state).toBe('active')
  expect(f.host.hasAdmission('ingress-first', first.bindingId, lanePerson)).toBe(true)
  const refs = [first, second]
  for (const [index, at] of [312, 413, 514].entries()) { f.time(at); refs.push((await f.host.prepareIncoming(f.incoming(`roll-${index}`)))!) }
  const last = f.prepared.at(-1)!
  expect(last.recent.map(g => g.agentSessionId)).toEqual(refs.slice(-4, -1).reverse().map(b => b.agentSessionId))
  expect(last.systemContext).toContain('space mote chat history --input -')
  for (const g of last.recent) expect(last.systemContext).toContain(`amux://agent/${g.agentSessionId}`)
  expect(last.systemContext).not.toContain(`amux://agent/${first.agentSessionId}`)
  const stranger = (await f.host.prepareIncoming(f.incoming('stranger', guest)))!
  const agentContext = { actor: { kind: 'agent' as const, id: second.agentSessionId } }
  const page = await f.host.history({ target, limit: 2 }, agentContext)
  expect(page.generations).toHaveLength(2); expect(page.next).toBeTruthy()
  const more = await f.host.history({ target, limit: 2, cursor: page.next! }, agentContext)
  expect(new Set([...page.generations, ...more.generations].map(g => g.agentSessionId)).size).toBe(4)
  expect([...page.generations, ...more.generations].some(g => g.agentSessionId === stranger.agentSessionId)).toBe(false)
  await expect(f.host.history({ target, actor: guest }, agentContext)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.host.history({ target }, { actor: { kind: 'agent', id: 'unrelated-agent' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.host.audience({ target }, agentContext)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
})

it('retains the frozen creation across unknown ACK and owner replacement without recharging or launching another Agent', async () => {
  const f = await fixture(1), original = f.agents.create
  f.agents.create = vi.fn(async plan => { await original(plan); throw new Error('Creation acknowledgement lost') })
  const incoming = f.incoming('unknown-create', guest)
  await expect(f.host.prepareIncoming(incoming)).rejects.toThrow('Creation acknowledgement lost')
  const reserved = (await f.host.history({ target })).generations[0]!
  expect(reserved.phase).toBe('preparing')
  const recovering = f.restart().prepareIncoming(incoming)
  await expect(recovering).resolves.toMatchObject({ agentSessionId: reserved.agentSessionId })
  const rebound = await recovering
  expect(rebound?.agentSessionId).toBe(reserved.agentSessionId)
  expect(f.agents.prepare).toHaveBeenCalledTimes(1); expect(f.agents.create).toHaveBeenCalledTimes(1); expect(f.agents.inspect).toHaveBeenCalledTimes(1)
  expect((await f.host.audience({ target })).people[0]).toMatchObject({ used: 1, total: 1 })
  const ownerModule = process.env.AGENTMUX_MOTE_CHAT_RESTART_MODULE
  const imports = ownerModule ? `import {ConnectionHost,MoteChatHost} from ${JSON.stringify(ownerModule)};`
    : `import {ConnectionHost} from './packages/connectors/dist/connection-host.js';import {MoteChatHost} from './packages/connectors/dist/mote-chat.js';`
  const script = imports + `const [path,target]=process.argv.slice(1);const connections=new ConnectionHost({databasePath:path,secrets:{resolve:async()=>null}});const forbidden=async()=>{throw new Error('Read must not launch')};const host=new MoteChatHost({connections,assertTarget:forbidden,agents:{prepare:forbidden,create:forbidden,inspect:forbidden,prepareInput:forbidden,activity:forbidden}});console.log(JSON.stringify({history:await host.history({target:JSON.parse(target)}),audience:await host.audience({target:JSON.parse(target)})}));connections.close()`
  const restarted = JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, f.databasePath, JSON.stringify(target)])).stdout)
  expect(restarted.history.generations).toMatchObject([{ phase: 'ready', agentSessionId: reserved.agentSessionId }])
  expect(restarted.audience.people).toMatchObject([{ used: 1, total: 1 }])
})

it('uses durable accepted activity when an extra observation fails and isolates route disable from unrelated bindings', async () => {
  const f = await fixture(), binding = (await f.host.prepareIncoming(f.incoming('first')))!
  f.time(1000); f.agents.activity = vi.fn(async () => { throw new Error('Activity observation unavailable') })
  const next = (await f.host.prepareIncoming(f.incoming('unknown-activity')))!
  expect(next.agentSessionId).not.toBe(binding.agentSessionId)
  expect(f.host.publicationAuthority(binding.bindingId, 1).authorized).toBe(true)
  const unrelated = { ...binding, bindingId: 'unrelated-group', agentSessionId: 'another-agent' }
  const groups = { readExact: () => unrelated, readCurrent: () => unrelated, findActiveAudience: () => unrelated, listActive: () => [unrelated],
    publicationAuthority: () => ({ binding: unrelated, authorized: true }), readGrant: () => null, findGrant: () => null, effectiveGrant: () => null, effectiveGrants: () => ({ grants: [], issue: null }) }
  const combined = composeMoteChatBindings(groups, f.host)
  await f.host.configure({ ...f.input, operationId: 'pause-route', expectedRevision: 1, values: { ...f.input.values, enabled: false } }, context)
  expect(combined.readCurrent(binding.bindingId)?.state).toBe('paused')
  expect(combined.publicationAuthority(binding.bindingId, 1).authorized).toBe(false)
  expect(combined.publicationAuthority(unrelated.bindingId, 1).authorized).toBe(true)
  expect(f.host.listBindings({ agentSessionId: binding.agentSessionId })).toMatchObject([{ bindingId: binding.bindingId, state: 'paused' }])
  expect(f.host.listActive({ agentSessionId: binding.agentSessionId })).toEqual([])
  expect(f.host.hasAdmission('ingress-first', binding.bindingId, lanePerson)).toBe(false)
  expect((await f.host.history({ target })).generations).toHaveLength(2)
  expect(f.agents.create).toHaveBeenCalledTimes(2)
})

it('keeps a known private audience from borrowing a manual binding while paused or preparing and leaves unrelated groups available', async () => {
  const f = await fixture(), binding = (await f.host.prepareIncoming(f.incoming('first')))!
  const manual = { ...binding, bindingId: 'manual-private-binding', agentSessionId: 'manual-agent' }
  const group = { ...manual, bindingId: 'unrelated-group', externalConversationId: 'original-group' }
  const find = vi.fn((input: { application: typeof application; externalConversationId: string }) => input.externalConversationId === group.externalConversationId ? group : { ...manual, externalConversationId: input.externalConversationId })
  const groups = { readExact: () => manual, readCurrent: () => manual, findActiveAudience: find, listActive: () => [manual, group],
    publicationAuthority: () => ({ binding: manual, authorized: true }), readGrant: () => null, findGrant: () => null, effectiveGrant: () => null, effectiveGrants: () => ({ grants: [], issue: null }) }
  const combined = composeMoteChatBindings(groups, f.host), audience = { application, externalConversationId: binding.externalConversationId }
  expect(combined.findActiveAudience(audience)?.bindingId).toBe(binding.bindingId)
  expect(find).not.toHaveBeenCalled()
  f.agents.create = vi.fn(async () => { throw new Error('Original creation not confirmed') })
  await expect(f.host.prepareIncoming(f.incoming('pending', lanePerson, 'pending-private'))).rejects.toThrow('Original creation not confirmed')
  expect(combined.findActiveAudience({ application, externalConversationId: 'pending-private' })).toBeNull()
  expect(find).not.toHaveBeenCalled()
  await f.host.configure({ ...f.input, operationId: 'pause-known-audience', expectedRevision: 1, values: { ...f.input.values, enabled: false } }, context)
  expect(combined.findActiveAudience(audience)).toBeNull()
  expect(find).not.toHaveBeenCalled()
  expect(combined.findActiveAudience({ application, externalConversationId: group.externalConversationId })).toBe(group)
  expect(find).toHaveBeenCalledOnce()
  const other = { ...application, appId: 'another-original-app' }
  expect(combined.findActiveAudience({ application: other, externalConversationId: binding.externalConversationId })?.bindingId).toBe(manual.bindingId)
  expect(find).toHaveBeenCalledTimes(2)
  expect(f.restart().knowsAudience(audience)).toBe(true)
})

it('uses exact issuer audience indexes after reopening old storage without scanning foreign generations', async () => {
  const f = await fixture(), binding = (await f.host.prepareIncoming(f.incoming('original')))!
  const db = f.connections.database
  const original = db.prepare('SELECT * FROM mote_chat_generation LIMIT 1').get()!
  const insert = db.prepare('INSERT INTO mote_chat_generation(generation_id,lane_key,space_id,session_id,binding_id,grant_id,snapshot_json) VALUES(?,?,?,?,?,?,?)')
  db.exec('BEGIN')
  try {
    for (let i = 0; i < 5000; i++) {
      const row = JSON.parse(String(original.snapshot_json))
      row.generation.application.issuer = 'https://foreign-' + i + '.example'
      insert.run('foreign-' + i, 'foreign-' + i, String(original.space_id), 'foreign-session-' + i, 'foreign-binding-' + i, 'foreign-grant-' + i, JSON.stringify(row))
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  // Reopen an existing database whose original audience indexes predate issuer support.
  db.exec(`DROP INDEX IF EXISTS mote_chat_generation_scoped_audience;
    DROP INDEX IF EXISTS mote_chat_generation_scoped_native_audience;
    CREATE INDEX IF NOT EXISTS mote_chat_generation_audience ON mote_chat_generation(space_id,json_extract(snapshot_json,'$.generation.application.domain'),json_extract(snapshot_json,'$.generation.application.appId'),json_extract(snapshot_json,'$.generation.externalConversationId'),sequence DESC);
    CREATE INDEX IF NOT EXISTS mote_chat_generation_native_audience ON mote_chat_generation(json_extract(snapshot_json,'$.generation.application.domain'),json_extract(snapshot_json,'$.generation.application.appId'),json_extract(snapshot_json,'$.generation.externalConversationId'));`)
  const host = f.restart(), queries: Array<{ sql: string; args: Parameters<ReturnType<typeof db.prepare>['get']> }> = []
  const prepare = db.prepare.bind(db)
  const spy = vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql)
    if (!sql.includes("json_extract(snapshot_json,'$.generation.application.issuer') IS ?")) return statement
    const get = statement.get.bind(statement)
    vi.spyOn(statement, 'get').mockImplementation((...args) => { queries.push({ sql, args }); return get(...args) })
    return statement
  })
  try {
    const audience = { application, externalConversationId: binding.externalConversationId }
    const manual = { ...binding, bindingId: 'manual-group' }
    const groups = { readExact: () => manual, readCurrent: () => manual, findActiveAudience: vi.fn(() => manual), listActive: () => [manual],
      publicationAuthority: () => ({ binding: manual, authorized: true }), readGrant: () => null, findGrant: () => null, effectiveGrant: () => null, effectiveGrants: () => ({ grants: [], issue: null }) }
    const combined = composeMoteChatBindings(groups, host)
    expect(combined.findActiveAudience(audience)?.bindingId).toBe(binding.bindingId)
    expect(combined.findActiveAudience({ ...audience, application: { ...application, issuer: 'https://missing.example' } })).toBe(manual)
    expect(groups.findActiveAudience).toHaveBeenCalledOnce()
  } finally { spy.mockRestore() }
  expect(queries).toHaveLength(3)
  for (const { sql, args } of queries) {
    const detail = prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map(row => String(row.detail)).join(' ')
    // Domain, app ID, issuer and room all constrain the real index lookup, including absent issuers.
    expect(detail).toMatch(/USING (?:COVERING )?INDEX mote_chat_generation_scoped_/)
    expect(detail.match(/<expr>=\?/g)).toHaveLength(4)
  }
  expect(db.prepare('SELECT count(*) AS n FROM mote_chat_generation').get()?.n).toBe(5001)
}, 15_000)

it('preserves the original binding when another local alias selects the same native application', async () => {
  const f = await fixture(), first = (await f.host.prepareIncoming(f.incoming('first')))!
  const alias = { ...f.connection, connectionId: 'connection-alias' }
  await f.connections.configure({ operationId: 'save-alias', expectedRevision: null, connection: alias })
  const aliasObservation = await f.connections.inspect({ connectionId: alias.connectionId })
  vi.spyOn(f.connections, 'inspect').mockResolvedValueOnce({ ...aliasObservation, connection: { ...aliasObservation.connection!, initialSetup: { state: 'unconfirmed' } } })
  const observed = await f.profile(); f.profile.mockResolvedValueOnce({ ...observed, connectionId: alias.connectionId })
  await f.host.configure({ ...f.input, operationId: 'select-alias', expectedRevision: 1, values: { ...f.input.values, connection: { connectionId: alias.connectionId, application } } }, context)
  expect(f.host.publicationAuthority(first.bindingId, 1).authorized).toBe(true)
  expect(f.host.hasAdmission('ingress-first', first.bindingId, lanePerson)).toBe(true)
  expect(f.host.hasAdmission('ingress-first', 'wrong-binding', lanePerson)).toBe(false)
  expect(f.host.hasAdmission('ingress-first', first.bindingId, guest)).toBe(false)
  expect((await f.host.prepareIncoming({ ...f.incoming('through-alias'), connectionId: alias.connectionId }))!.agentSessionId).toBe(first.agentSessionId)
  await f.connections.configure({ operationId: 'disable-original-alias', expectedRevision: 1, connection: { ...f.connection, enabled: false } })
  expect(f.host.hasAdmission('ingress-first', first.bindingId, lanePerson)).toBe(false)
  await expect(f.connections.configure({ operationId: 'change-original-alias-application', expectedRevision: 2, connection: { ...f.connection, application: { ...application, appId: 'another-original-application' } } })).rejects.toMatchObject({ code: 'CONNECTION_IDENTITY_CONFLICT' })
  expect(f.host.hasAdmission('ingress-first', first.bindingId, lanePerson)).toBe(false)
  expect(f.agents.create).toHaveBeenCalledTimes(1)
})

it('creates and replies through an exact Core Session without requiring a presentation Region', async () => {
  const f = await fixture(), create = f.agents.create
  f.agents.create = vi.fn(async plan => { const { regionId: _region, ...result } = await create(plan); return result })
  const creating = f.host.prepareIncoming(f.incoming('background'))
  await expect(creating).resolves.toMatchObject({ agentSessionId: expect.any(String) })
  const binding = (await creating)!
  expect(binding.regionAnchor).toBeUndefined()
  expect(f.host.hasAdmission('ingress-background', binding.bindingId, lanePerson)).toBe(true)
  expect(f.host.publicationAuthority(binding.bindingId, 1).authorized).toBe(true)
})

it('rejects malformed public parameters and another target receipt without accepting display or quota facts as authority', () => {
  expect(() => parseMoteChatParams('space.mote.chat.configure', { operationId: 'unsafe', target, expectedRevision: null, expectedConnectionRevision: null,
    values: { enabled: true, connection: null, conversationIdleMs: 100, strangerMessageLimit: 0 } })).toThrow()
  expect(() => parseMoteChatParams('space.mote.chat.history', { target, limit: 0 })).toThrow()
  expect(() => parseMoteChatParams('space.mote.chat.allocate', { operationId: 'unsafe', target, expectedConfigurationRevision: 1, actor: guest, expectedPersonRevision: 1, total: -1 })).toThrow()
  expect(() => parseMoteChatResult('space.mote.chat.history', { generations: [{ target: { ...target, spaceId: 'another-mote' } }], next: null }, { target })).toThrow()
  expect(() => parseMoteChatParams('not-a-chat-method' as never, { target })).toThrow()
  expect(() => parseMoteChatResult('space.mote.chat.history', { generations: Array(2), next: null }, { target })).toThrow()
  let getterReads = 0
  const fabricated: unknown[] = []
  Object.defineProperty(fabricated, '0', { enumerable: true, get() { getterReads++; return {} } })
  expect(() => parseMoteChatResult('space.mote.chat.history', { generations: fabricated, next: null }, { target })).toThrow()
  expect(getterReads).toBe(0)
})

it('derives native API identity from current private-chat lane and selected policy independently of automatic sync', async () => {
  const f = await fixture(), first = await f.host.prepareIncoming(f.incoming('first-native-api'))
  expect(first).not.toBeNull()
  expect(f.host.apiBinding(first!.bindingId)).toEqual(first)
  await f.connections.service.configure({ operationId: 'pause-sync-for-native-api', expectedRevision: 0, service: { enabled: false } })
  expect(f.host.apiBinding(first!.bindingId)).toEqual(first)
  await f.connections.service.configure({ operationId: 'resume-sync-for-next-generation', expectedRevision: 1, service: { enabled: true } })
  f.time(500)
  const next = await f.host.prepareIncoming(f.incoming('next-native-api'))
  expect(next?.bindingId).not.toBe(first!.bindingId)
  expect(f.host.apiBinding(first!.bindingId)).toBeNull()
  expect(f.host.apiBinding(next!.bindingId)).toEqual(next)
  await f.host.configure({ ...f.input, operationId: 'disable-native-chat', expectedRevision: 1, values: { ...f.input.values, enabled: false } }, context)
  expect(f.host.apiBinding(next!.bindingId)).toBeNull()
  await f.host.configure({ ...f.input, operationId: 'reenable-native-chat', expectedRevision: 2 }, context)
  expect(f.host.apiBinding(next!.bindingId)).toEqual(next)
  const replacement = { ...f.connection, connectionId: 'replacement-same-application' }
  await f.connections.configure({ operationId: 'save-replacement-native-bot', expectedRevision: null, connection: replacement })
  f.profile.mockResolvedValueOnce({ ...(await f.profile()), connectionId: replacement.connectionId })
  await f.host.configure({ ...f.input, operationId: 'select-replacement-native-bot', expectedRevision: 3,
    values: { ...f.input.values, connection: { connectionId: replacement.connectionId, application } } }, context)
  expect(f.host.apiBinding(next!.bindingId)).toBeNull()
  expect(f.host.readExact(first!.bindingId, 1)).toEqual(first)
  expect(f.agents.create).toHaveBeenCalledTimes(2)
})

it('keeps a stored legacy creator admission on its original private Agent without consulting Main', async () => {
  const f = await fixture()
  const original = (await f.host.prepareIncoming(f.incoming('legacy-seed', guest)))!
  const row = f.host.store.generationBySession(original.agentSessionId)!
  const incoming = f.incoming('legacy-creator', creator)
  // A pre-existing schema snapshot: the creator already had this dedicated
  // generation before new messages began addressing the logical Main.
  f.host.store.saveGeneration({ ...row, generation: { ...row.generation, actor: creator, externalConversationId: incoming.externalConversationId },
    binding: { ...row.binding!, externalConversationId: incoming.externalConversationId }, grant: { ...row.grant!, actor: creator, externalConversationId: incoming.externalConversationId } })
  f.host.store.saveAdmission({ ingressId: incoming.ingressId, application, externalMessageId: incoming.externalMessageId,
    actor: creator, externalConversationId: incoming.externalConversationId, generationId: row.generation.generationId })
  expect(await f.restart().prepareIncoming(incoming)).toMatchObject({ agentSessionId: original.agentSessionId, externalConversationId: incoming.externalConversationId })
  expect(f.agents.create).toHaveBeenCalledOnce(); expect(f.agents.prepare).toHaveBeenCalledOnce()
  await expect(f.host.prepareIncoming(f.incoming('new-creator', creator))).rejects.toMatchObject({ code: 'MOTE_CHAT_MAIN_UNCONFIRMED' })
})
