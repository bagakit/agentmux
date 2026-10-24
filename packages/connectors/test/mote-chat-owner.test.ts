import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { parseMoteChatParams, parseMoteChatResult, type MoteChatConfigure, type MoteChatGeneration } from '@agentmux/core/mote-chat'
import { ConnectionHost } from '../src/connection-host.js'
import { MoteChatHost, composeMoteChatBindings, type MoteChatAgentPort, type MoteChatCreatedAgent, type MoteChatIncoming, type MoteChatPreparedLaunch } from '../src/mote-chat.js'

const fixtures: Array<{ connections: ConnectionHost; root: string }> = []
afterEach(async () => { for (const f of fixtures.splice(0)) { f.connections.close(); await rm(f.root, { recursive: true, force: true }) }; vi.restoreAllMocks() })
const context = { actor: { kind: 'user' as const, id: 'original-user' } }
const application = { domain: 'chat.example', appId: 'original-app' }
const creator = { application, idType: 'open_id', userId: 'creator' }
const guest = { ...creator, userId: 'guest' }
const target = { spaceId: 'original-mote', zoneId: 'original-home', expectedResource: { hostId: 'local', workspaceId: 'mote-files', workspacePath: 'mote-home' } }
async function fixture(limit = 4) {
  const root = await mkdtemp(join(tmpdir(), 'mote-chat-owner-')), databasePath = join(root, 'connections.sqlite')
  const connection = { connectionId: 'original-connection', adapterId: 'sample', application, label: 'Same name', enabled: true, credentialRef: 'private-ref' }
  const profile = vi.fn(async () => ({ connectionId: connection.connectionId, connectionRevision: 1, application, language: null,
    state: 'observed' as const, profile: null, metadata: null, creator: { idType: creator.idType, userId: creator.userId }, botId: null, onlineVersionId: null, reviewingVersionId: null, version: null }))
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
    values: { enabled: true, connection: { connectionId: connection.connectionId, application }, conversationIdleMs: 100, strangerMessageLimit: limit } }
  await host.configure(input, context)
  const incoming = (id: string, actor = creator, externalConversationId = `chat-${actor.userId}`): MoteChatIncoming => ({ conversationKind: 'direct',
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
  await expect(f.host.configure({ ...f.input, operationId: 'missing-creator', expectedRevision: 1, values: { ...f.input.values, connection: { connectionId: other.connectionId, application: other.application } } }, context)).rejects.toMatchObject({ code: 'MOTE_CHAT_CREATOR_UNCONFIRMED' })
  expect((await f.host.inspect({ target })).configuration?.values).toEqual(f.input.values)
})

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
  await f.host.prepareIncoming(f.incoming('creator-message'))
  expect((await f.host.audience({ target })).people.find(p => p.creator)).toMatchObject({ actor: creator, total: null, used: 1, remaining: null })
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
  expect(f.host.hasAdmission('ingress-first', first.bindingId, creator)).toBe(true)
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
  expect(f.host.hasAdmission('ingress-first', binding.bindingId, creator)).toBe(false)
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
  await expect(f.host.prepareIncoming(f.incoming('pending', creator, 'pending-private'))).rejects.toThrow('Original creation not confirmed')
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

it('preserves the original binding when another local alias selects the same native application', async () => {
  const f = await fixture(), first = (await f.host.prepareIncoming(f.incoming('first')))!
  const alias = { ...f.connection, connectionId: 'connection-alias' }
  await f.connections.configure({ operationId: 'save-alias', expectedRevision: null, connection: alias })
  const aliasObservation = await f.connections.inspect({ connectionId: alias.connectionId })
  vi.spyOn(f.connections, 'inspect').mockResolvedValueOnce({ ...aliasObservation, connection: { ...aliasObservation.connection!, initialSetup: { state: 'unconfirmed' } } })
  const observed = await f.profile(); f.profile.mockResolvedValueOnce({ ...observed, connectionId: alias.connectionId })
  await f.host.configure({ ...f.input, operationId: 'select-alias', expectedRevision: 1, values: { ...f.input.values, connection: { connectionId: alias.connectionId, application } } }, context)
  expect(f.host.publicationAuthority(first.bindingId, 1).authorized).toBe(true)
  expect((await f.host.prepareIncoming({ ...f.incoming('through-alias'), connectionId: alias.connectionId }))!.agentSessionId).toBe(first.agentSessionId)
  expect(f.agents.create).toHaveBeenCalledTimes(1)
})

it('creates and replies through an exact Core Session without requiring a presentation Region', async () => {
  const f = await fixture(), create = f.agents.create
  f.agents.create = vi.fn(async plan => { const { regionId: _region, ...result } = await create(plan); return result })
  const creating = f.host.prepareIncoming(f.incoming('background'))
  await expect(creating).resolves.toMatchObject({ agentSessionId: expect.any(String) })
  const binding = (await creating)!
  expect(binding.regionAnchor).toBeUndefined()
  expect(f.host.hasAdmission('ingress-background', binding.bindingId, creator)).toBe(true)
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
