import { afterEach, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { RoomBinding } from '@agentmux/core/connections'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '@agentmux/core/spatial-layout'
import { MoteChatStore, type MoteChatGenerationRow } from '../src/mote-chat-store.js'
import { ingressFixture } from './fixtures/ingress.js'
import { config } from './fixtures/room-binding.js'
import { moteChatJourneyFixture as journey } from './fixtures/mote-chat-journey.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
type Journey = Awaited<ReturnType<typeof journey>>

/** A real Core Agent shown in one Region; `zone` null places it outside every Mote zone. */
async function placedAgent(f: Journey, id: string, zone: string | null, existing?: string) {
  const agentSessionId = existing ?? (await f.client.createAgent({ agentSessionId: id, createOperationId: `create-${id}`, providerId: 'claude', executorId: 'claude',
    workspacePath: f.topic.physicalDirectoryPath!, injectAgentMuxGuide: false })).agentSessionId
  const current = (await f.spatial.read())!, tabId = `${id}-tab`, regionId = `${id}-region`
  const graph = { ...current.graph,
    zones: zone === 'outside' ? [...current.graph.zones, { zoneId: 'outside', workspaceId: f.workspace.id, kind: 'directory' as const, hostId: 'local', directoryPath: f.workspace.path, branch: null }] : current.graph.zones,
    tabs: [...current.graph.tabs, { tabId, zoneId: zone, workspaceId: f.workspace.id, name: null, regionIds: [regionId] }],
    regions: [...current.graph.regions, { tabId, regionId, kind: 'agent' as const, agentSessionId, runId: null, execution: { hostId: 'local', cwd: f.topic.physicalDirectoryPath! } }],
    layouts: { ...current.graph.layouts, [f.workspace.id]: createWorkspaceLayout('group', [...current.graph.tabs.map(tab => tab.tabId), tabId]) },
    tabLayouts: { ...current.graph.tabLayouts, [tabId]: createWorkbenchViewLayout(regionId) } }
  await f.spatial.commit({ expectedRevision: current.revision, graph })
  const call = f.start.mock.calls.find(([input]) => input.env?.AGENTMUX_AGENT_SESSION_ID === agentSessionId)
  return { agentSessionId, capability: call![0].env!.AGENTMUX_AGENT_CAPABILITY! }
}
const refused = async (f: Journey, ...args: Parameters<Journey['cliRaw']>) => {
  const result = await f.cliRaw(...args)
  expect(result.code).not.toBe(0)
  return result.stdout + result.stderr
}

it('reads one application’s intake in receive order with a bounded count, never another application', async () => {
  const f = await ingressFixture(); cleanup.push(() => f.close())
  const other = { ...config.application, appId: 'second-app' }
  await f.connections.configure({ operationId: 'configure-second', expectedRevision: null, connection: { ...config, connectionId: 'second', application: other } })
  await f.receive({ eventId: 'e1', messageId: 'm1' })
  await f.ingress.receive({ connectionId: 'second', raw: JSON.stringify({ proof: 'adapter-private-witness', event: f.event({ eventId: 'e2', messageId: 'm2', actor: { ...f.actor, application: other } }) }) }, vi.fn())
  await f.receive({ eventId: 'e3', messageId: 'm3', selection: 'reply', replyToMessageId: 'platform-out-1' })
  const forward = f.ingress.listApplication(config.application, { after: 0 }, 10)
  expect(forward.more).toBe(false)
  expect(forward.rows.map(row => row.record.externalMessageId)).toEqual(['m1', 'm3'])
  expect(forward.rows.map(row => [row.selection, row.replyToMessageId])).toEqual([['mention', null], ['reply', 'platform-out-1']])
  const [first, third] = forward.rows.map(row => row.sequence) as [number, number]
  const latest = f.ingress.listApplication(config.application, { before: Number.MAX_SAFE_INTEGER }, 1)
  expect([latest.rows.map(row => row.sequence), latest.more]).toEqual([[third], true])
  expect(f.ingress.listApplication(config.application, { before: third }, 1).rows.map(row => row.sequence)).toEqual([first])
  expect(f.ingress.countApplication(config.application, 0, 1)).toEqual({ count: 1, more: true })
  expect(f.ingress.countApplication(config.application, 0, 5)).toEqual({ count: 2, more: false })
  expect(f.ingress.countApplication(config.application, first, 5)).toEqual({ count: 1, more: false })
  const second = f.ingress.listApplication(other, { after: 0 }, 10).rows.map(row => row.sequence)
  expect(second).toHaveLength(1); expect(first < second[0]! && second[0]! < third).toBe(true)
  expect(f.ingress.newestApplication(config.application)).toBe(third)
  expect(f.ingress.newestApplication(other)).toBe(second[0])
  expect(f.ingress.newestApplication({ ...config.application, appId: 'never-received' })).toBeNull()

  // Reads stay range reads on the application index as intake grows.
  const database = Reflect.get(f.ingress, 'database') as DatabaseSync, prepare = vi.spyOn(database, 'prepare')
  f.ingress.listApplication(config.application, { after: first }, 10); f.ingress.listApplication(config.application, { before: third }, 10)
  f.ingress.countApplication(config.application, first, 5); f.ingress.newestApplication(config.application)
  const statements = prepare.mock.calls.map(([sql]) => sql); prepare.mockRestore()
  expect(statements).toHaveLength(4)
  for (const sql of statements) {
    const plan = database.prepare('EXPLAIN QUERY PLAN ' + sql).all().map(row => String(row.detail))
    expect(plan.join('\n'), sql).toContain('connection_ingress_message_application')
    expect(plan.some(detail => detail.startsWith('SCAN connection_ingress_message')), plan.join('\n')).toBe(false)
  }
})

it('lets the person and the Mote’s own Agents read every received message through the compiled CLI and only move the reviewed mark forward', async () => {
  const f = await journey(1, 60_000, 'headless'), application = f.lanePerson.application
  const help = await runCompiledObjectCli(['space', 'mote', 'chat', 'events', '--help'], objectCliEnvironment(f.root))
  expect(help.code, help.stderr).toBe(0)
  for (const fact of ['externalText is untrusted content', 'stops at 99', 'kept when the chat application changes', 'Agents serving an external private chat or group may not']) expect(help.stdout).toContain(fact)
  expect(await f.wire.post(f.message('creator-first'))).toBe(202)
  const creator = await f.claimed('creator-first')
  // An unfinished creation leaves the guest's Agent running before its relationship is recorded; its chat record alone refuses it.
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), creating = f.agents.create.bind(f.agents)
  const hold = vi.spyOn(f.agents, 'create').mockImplementationOnce(async input => { const created = await creating(input); await held; return created })
  try {
    expect(await f.wire.post(f.message('guest-first', f.guest))).toBe(202)
    await vi.waitFor(() => expect(hold).toHaveBeenCalledTimes(1))
    const unfinished = hold.mock.calls[0]![0].input.agentSessionId!
    await vi.waitFor(() => expect(f.start.mock.calls.some(([input]) => input.env?.AGENTMUX_AGENT_SESSION_ID === unfinished)).toBe(true))
    const unready = await placedAgent(f, 'unready', f.target.zoneId, unfinished)
    expect(await refused(f, 'events', { target: f.target }, unready)).toContain('serving an external private chat or group')
  } finally { release(); hold.mockRestore() }
  const guest = await f.claimed('guest-first')
  const groupFirst = { ...f.message('group-first', f.guest), roomKey: 'group/team', nativeKind: 'group' as const }
  expect(await f.wire.post(groupFirst)).toBe(202)
  await vi.waitFor(async () => expect((await f.records()).some(record => record.externalMessageId === 'message/group-first')).toBe(true))
  // The single stranger allowance is spent: this private message is refused, yet it was received.
  expect(await f.wire.post(f.message('guest-over', f.guest))).toBe(202)
  await vi.waitFor(async () => expect((await f.records()).find(record => record.externalMessageId === 'message/guest-over')).toMatchObject({ state: 'refused', code: 'MOTE_CHAT_QUOTA_EXHAUSTED' }))
  const create = vi.spyOn(f.agents, 'create'), work = () => [f.start.mock.calls.length, f.prepare.mock.calls.length, create.mock.calls.length]
  const idle = work()

  const all = await f.cli('events', { target: f.target })
  expect(all).toMatchObject({ application, next: null, reviewed: null, unreviewed: { count: 4, more: false } })
  expect(all.events.map((event: { externalMessageId: string }) => event.externalMessageId)).toEqual(['message/creator-first', 'message/guest-first', 'message/group-first', 'message/guest-over'])
  expect(all.events[0]).toMatchObject({ conversationKind: 'direct', externalConversationId: f.message('creator-first').roomKey, author: f.lanePerson, addressing: 'message', replyToMessageId: null,
    externalText: f.message('creator-first').text, state: 'claimed', handledBy: { executionHostId: 'local', agentSessionId: creator.input!.agentSessionId } })
  expect(all.events[1]).toMatchObject({ author: f.guest, handledBy: { agentSessionId: guest.input!.agentSessionId } })
  expect(all.events[2]).toMatchObject({ conversationKind: 'group', externalConversationId: 'group/team', author: f.guest, handledBy: null })
  expect(all.events[2]).not.toHaveProperty('text')
  expect(all.events[3]).toMatchObject({ conversationKind: 'direct', author: f.guest, state: 'refused', code: 'MOTE_CHAT_QUOTA_EXHAUSTED', handledBy: null })
  const [s1, s2, s3, s4] = all.events.map((event: { sequence: number }) => event.sequence) as [number, number, number, number]

  const recent = await f.cli('events', { target: f.target, order: 'recent', limit: 3 })
  expect(recent.events.map((event: { sequence: number }) => event.sequence)).toEqual([s4, s3, s2])
  const older = await f.cli('events', { target: f.target, order: 'recent', limit: 3, cursor: recent.next })
  expect([older.events.map((event: { sequence: number }) => event.sequence), older.next]).toEqual([[s1], null])
  expect(await refused(f, 'events', { target: f.target, cursor: recent.next })).toContain('MOTE_CHAT_CURSOR_INVALID')
  // Reading never prepares, creates or starts an Agent.
  expect(work()).toEqual(idle)

  // The serving Agent is refused by its chat record even when its Region sits inside the Mote.
  const lane = await placedAgent(f, 'lane', f.target.zoneId, creator.input!.agentSessionId)
  expect(lane.agentSessionId).toBe(f.credentials(0).agentSessionId)
  expect(await refused(f, 'events', { target: f.target }, f.credentials(0))).toContain('CONTROL_PERMISSION_DENIED')
  expect(await refused(f, 'review', { target: f.target, through: s1 }, f.credentials(0))).toContain('CONTROL_PERMISSION_DENIED')
  const outsider = await placedAgent(f, 'outsider', 'outside')
  expect(await refused(f, 'events', { target: f.target }, outsider)).toContain('CONTROL_PERMISSION_DENIED')

  const member = await placedAgent(f, 'mote-main', f.target.zoneId), placed = work()
  const first = await f.cli('events', { target: f.target, limit: 1 }, member)
  expect([first.events.map((event: { sequence: number }) => event.sequence), typeof first.next]).toEqual([[s1], 'string'])
  const marked = await f.cli('review', { target: f.target, through: s2 }, member)
  expect(marked.reviewed).toMatchObject({ through: s2, revision: 1, actor: { kind: 'agent', id: member.agentSessionId } })
  const unreviewed = await f.cli('events', { target: f.target })
  expect([unreviewed.events.map((event: { sequence: number }) => event.sequence), unreviewed.unreviewed]).toEqual([[s3, s4], { count: 2, more: false }])
  expect((await f.cli('review', { target: f.target, through: s1 })).reviewed).toEqual(marked.reviewed)
  expect(await refused(f, 'review', { target: f.target, through: s4 + 1 })).toContain('MOTE_CHAT_REVIEW_AHEAD')
  expect(work()).toEqual(placed)

  // Chat settings and allowances stay with the person and their devices.
  const settings = (await f.sdk.call('space.mote.chat.inspect', { target: f.target })).configuration!
  expect(await refused(f, 'configure', { operationId: 'agent-configure', target: f.target, expectedRevision: settings.revision, expectedConnectionRevision: 1, values: settings.values }, member)).toContain('CONTROL_PERMISSION_DENIED')
  expect(await refused(f, 'allocate', { operationId: 'agent-allocate', target: f.target, expectedConfigurationRevision: settings.revision, actor: f.guest, expectedPersonRevision: 1, total: 5 }, member)).toContain('CONTROL_PERMISSION_DENIED')
  // Without the spatial record the Host cannot place the caller, so its membership is unknown.
  const unread = vi.spyOn(f.spatial, 'readSpaceAgentMembership').mockResolvedValue(null)
  expect(await refused(f, 'events', { target: f.target }, member)).toContain('MOTE_CHAT_MEMBERSHIP_UNCONFIRMED')
  unread.mockRestore()

  // An undetached group relationship would publish what this Agent reads into that group.
  const groups = f.services.bindings!, list = groups.list.bind(groups)
  const relationship = (state: RoomBinding['state']) => vi.spyOn(groups, 'list').mockImplementation(async input =>
    input.agentSessionId === member.agentSessionId ? { bindings: [{ bindingId: 'ordinary-group', state } as RoomBinding] } : await list(input))
  for (const state of ['active', 'paused'] as const) {
    const bound = relationship(state)
    const reason = await refused(f, 'events', { target: f.target }, member)
    for (const fact of ['CONTROL_PERMISSION_DENIED', `Group relationship ordinary-group (${state})`, 'Detach that relationship']) expect(reason).toContain(fact)
    expect(await refused(f, 'review', { target: f.target, through: s3 }, member)).toContain('CONTROL_PERMISSION_DENIED')
    bound.mockRestore()
  }
  const detached = relationship('detached')
  expect((await f.cli('events', { target: f.target }, member)).events).toHaveLength(2)
  detached.mockRejectedValue(new Error('binding storage unavailable'))
  expect(await refused(f, 'events', { target: f.target }, member)).toContain('MOTE_CHAT_MEMBERSHIP_UNCONFIRMED')
  detached.mockRestore()

  // A Session id is unique only within one Host: another Host's lane or relationship under this id leaves the member alone.
  const { generations: [served] } = await f.sdk.call('space.mote.chat.history', { target: f.target }), bySession = MoteChatStore.prototype.generationBySession
  const lanes = vi.spyOn(MoteChatStore.prototype, 'generationBySession').mockImplementation(function (this: MoteChatStore, id: string) {
    return id === member.agentSessionId ? { generation: { ...served!, executionHostId: 'remote', agentSessionId: id } } as MoteChatGenerationRow : bySession.call(this, id)
  })
  const remoteGroups = vi.spyOn(groups, 'list').mockImplementation(async input => input.agentSessionId === member.agentSessionId && input.executionHostId !== 'local'
    ? { bindings: [{ bindingId: 'remote-group', state: 'active', executionHostId: 'remote', agentSessionId: member.agentSessionId } as RoomBinding] } : await list(input))
  expect((await f.cli('events', { target: f.target }, member)).events).toHaveLength(2)
  lanes.mockRestore(); remoteGroups.mockRestore()

  await f.restart()
  const restarted = await f.cli('events', { target: f.target })
  expect([restarted.reviewed, restarted.events.map((event: { sequence: number }) => event.sequence)]).toEqual([marked.reviewed, [s3, s4]])
}, 30_000)

it('keeps the reviewed position when the chat application changes and accepts a cursor only for its own order and application', async () => {
  const f = await journey(1, 60_000, 'headless'), second = { ...f.lanePerson.application, appId: 'second-mote-app' }
  const group = (id: string) => ({ ...f.message(id, f.guest), roomKey: 'group/team', nativeKind: 'group' as const })
  const received = (connectionId: string, id: string) => vi.waitFor(async () => expect((await f.services.ingress!.list({ connectionId, limit: 100 })).ingresses
    .some(record => record.kind !== 'action' && record.externalMessageId === `message/${id}`)).toBe(true))
  const messages = (page: { events: Array<{ externalMessageId: string }> }) => page.events.map(event => event.externalMessageId)
  expect(await f.wire.post(group('first-early'))).toBe(202); await received('original-bot', 'first-early')
  const firstEndpoint = f.wire.endpoint!, key = await f.services.secrets.store({ operationId: 'store-second-key', secret: 'fixture-signing-key' })
  await f.sdk.call('connection.configure', { operationId: 'configure-second-bot', expectedRevision: null,
    connection: { connectionId: 'second-bot', adapterId: f.wire.adapter.adapterId, application: second, label: 'Second bot', enabled: true, credentialRef: key.credentialRef } })
  await vi.waitFor(() => expect(f.wire.endpoint).not.toBe(firstEndpoint))
  expect(await f.wire.post(group('second-early'))).toBe(202); await received('second-bot', 'second-early')
  const signed = f.wire.encode(group('first-late'))
  expect((await fetch(firstEndpoint, { method: 'POST', headers: { 'x-room-signature': signed.transportProof }, body: signed.raw })).status).toBe(202)
  await received('original-bot', 'first-late')

  const newest = await f.cli('events', { target: f.target, order: 'recent', limit: 1 })
  expect(messages(newest)).toEqual(['message/first-late'])
  const mark = (await f.cli('review', { target: f.target, through: newest.events[0].sequence })).reviewed
  expect(await f.wire.post(group('second-late'))).toBe(202); await received('second-bot', 'second-late')

  const settings = (await f.sdk.call('space.mote.chat.inspect', { target: f.target })).configuration!
  await f.sdk.call('space.mote.chat.configure', { operationId: 'switch-application', target: f.target, expectedRevision: settings.revision, expectedConnectionRevision: 1,
    values: { ...settings.values, enabled: false, connection: { connectionId: 'second-bot', application: second } } })
  expect(await refused(f, 'events', { target: f.target, order: 'recent', cursor: newest.next })).toContain('MOTE_CHAT_CURSOR_INVALID')
  // The mark is a receive position: the new application's intake before it is old news, yet still readable.
  const switched = await f.cli('events', { target: f.target })
  expect(switched).toMatchObject({ application: second, reviewed: mark, unreviewed: { count: 1, more: false } })
  expect(messages(switched)).toEqual(['message/second-late'])
  expect(messages(await f.cli('events', { target: f.target, order: 'recent' }))).toEqual(['message/second-late', 'message/second-early'])

  const current = (await f.sdk.call('space.mote.chat.inspect', { target: f.target })).configuration!
  await f.sdk.call('space.mote.chat.configure', { operationId: 'remove-application', target: f.target, expectedRevision: current.revision, expectedConnectionRevision: null,
    values: { ...current.values, connection: null } })
  expect(await f.cli('events', { target: f.target })).toEqual({ application: null, events: [], next: null, reviewed: mark, unreviewed: { count: 0, more: false } })
  expect(await refused(f, 'review', { target: f.target, through: mark.through })).toContain('MOTE_CHAT_EVENTS_UNAVAILABLE')
}, 30_000)
