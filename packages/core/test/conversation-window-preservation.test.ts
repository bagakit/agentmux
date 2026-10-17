import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { consumeConversationWindowPage, projectConversationWindow, parseConversationTimelineReadInput,
  type AgentConversationReadPage, type ConversationTimelineReadInput, type ConversationWindowAssembly,
  type ConversationWindowSnapshot } from '../src/conversation.js'
import { conversationReaderCli } from './helpers/conversation-reader-cli.js'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const native = (id: string, role: 'user' | 'assistant' = 'assistant') => ({ type: role, uuid: id,
  sessionId: 'native-main', message: { role, content: id } })
type Read = (input: ConversationTimelineReadInput) => Promise<AgentConversationReadPage>
async function complete(read: Read, input: ConversationTimelineReadInput) {
  let pending: ConversationWindowAssembly | undefined, cursor = input.cursor
  for (let count = 0; count < 160; count++) {
    const page = await read({ ...input, ...(cursor ? { cursor } : {}) }), result = consumeConversationWindowPage(page, pending)
    if (result.kind === 'complete') return result.snapshot
    pending = result.pending; cursor = page.nextCursor!; expect(cursor).toBeTruthy()
  }
  throw Error('The original bounded conversation frame did not finish')
}
async function fixture(rows: unknown[]) {
  const f = await nativeHistoryFixture('claude', jsonl(rows)); closes.push(f.close)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, options = { ...ref, limit: 100, maxBytes: 4 * 1024 * 1024 }
  const sdk: Read = input => f.client.readAgentConversation(input), remote: Read = input => rpc.call('agent.conversation.inspect', input)
  return { ...f, server, rpc, ref, options, sdk, remote }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function fill(f: Fixture, pages: number, read = f.remote) {
  let snapshot = await complete(read, f.options)
  for (let index = 1; index < pages; index++) snapshot = await complete(read,
    { ...f.options, cursor: snapshot.window.navigation.older!, preserveCurrent: true })
  return snapshot
}
async function unchanged(f: Fixture, snapshot: ConversationWindowSnapshot, read = f.remote) {
  const current = await complete(read, { ...f.options, view: snapshot.window.view! })
  expect(current.units, 'A declined expansion must preserve every original accepted contribution').toEqual(snapshot.units)
  expect(current.window.id).toBe(snapshot.window.id); expect(current.window.revision).toBe(snapshot.window.revision)
  expect(current.window.checkpoint).toEqual(snapshot.window.checkpoint)
  expect(current.window.navigation).toEqual(snapshot.window.navigation)
  expect(current.window.outside).toEqual(snapshot.window.outside)
}
async function declined(f: Fixture, snapshot: ConversationWindowSnapshot, read = f.remote, reason?: RegExp) {
  await expect(read({ ...f.options,
    cursor: snapshot.window.navigation.older!, preserveCurrent: true })).rejects.toMatchObject({ code: 'AGENT_CONVERSATION_WINDOW_FULL', ...(reason ? { message: expect.stringMatching(reason) } : {}) })
  await unchanged(f, snapshot, read)
}
const untouched = (f: Fixture) => expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])

it('declines record overflow through SDK and Unix RPC without displacing the original live view or its cursor', async () => {
  const f = await fixture([native('oldest-input', 'user'), ...Array.from({ length: 1200 }, (_, index) => native('later-' + index))])
  const snapshot = await fill(f, 12, f.sdk), observations: unknown[] = []
  expect(snapshot.units.flatMap(unit => unit.records)).toHaveLength(1200)
  const watch = await f.client.observeConversation({ ...f.ref, view: snapshot.window.view! }, value => observations.push(value)); closes.push(() => watch.dispose())
  await declined(f, snapshot, f.sdk)
  const routed = await fill(f, 12)
  const ordinaryPending = await f.remote({ ...f.options, cursor: routed.window.navigation.older!, limit: 1 })
  expect(ordinaryPending.window.complete).toBe(false)
  await declined(f, routed)
  const cli = await conversationReaderCli(f.root); closes.push(cli.close)
  const result = await cli.run(['agent', 'conversation', 'inspect', '--input', '-'], JSON.stringify({ ...f.options,
    cursor: routed.window.navigation.older!, preserveCurrent: true }))
  expect(result.code).not.toBe(0); expect(result.stdout + result.stderr).toContain('AGENT_CONVERSATION_WINDOW_FULL')
  await unchanged(f, routed)
  expect(watch.closed.aborted).toBe(false)
  await appendFile(f.path, jsonl([native('live-input', 'user')]))
  await vi.waitFor(() => expect(observations.length).toBeGreaterThan(0))
  const live = await complete(input => f.client.readConversationChanges({ ...input,
    checkpoint: snapshot.window.checkpoint, view: snapshot.window.view! }), f.options)
  expect(live.window.id).toBe(snapshot.window.id); expect(live.window.navigation.newer).toBeNull()
  expect(projectConversationWindow(live).inputs.map(input => input.rawId)).toEqual(['live-input'])
  expect(projectConversationWindow(live).historyPage!.items.at(-2)!.id).toBe('later-1199')
  expect(watch.closed.aborted).toBe(false)
  const ordinary = await fill(f, 12), navigated = await complete(f.remote, { ...f.options, cursor: ordinary.window.navigation.older! })
  expect(navigated.window.navigation.newer).toBeTruthy(); expect(navigated.window.outside.newer).toBeTruthy()
  expect(projectConversationWindow(navigated).inputs.map(input => input.rawId)).toContain('oldest-input')
  await expect(f.remote({ ...f.options, cursor: navigated.window.navigation.newer!, preserveCurrent: true })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  untouched(f)
})

it.each([['original byte retention', 110], ['canonical assembly', 108]] as const)(
  'declines %s overflow before publication while preserving same-view live changes', async (_phase, kib) => {
    const f = await fixture([]), content = 'x'.repeat(kib * 1024)
    for (let index = 0; index < 300; index++) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.ref.agentSessionId,
      item: { id: 'original-' + index, agentSessionId: f.ref.agentSessionId, kind: 'assistant_message', source: 'native-hook',
        status: 'complete', title: 'Original reply', content, createdAt: index + 1, updatedAt: index + 1 } })
    const snapshot = await fill(f, 2)
    expect(snapshot.units.flatMap(unit => unit.records)).toHaveLength(200)
    await declined(f, snapshot, f.remote, _phase === 'canonical assembly' ? /canonical/ : /record and byte/)
    const direct = await fill(f, 2, f.sdk)
    await declined(f, direct, f.sdk, _phase === 'canonical assembly' ? /canonical/ : /record and byte/)
    await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.ref.agentSessionId,
      item: { id: 'live-input', agentSessionId: f.ref.agentSessionId, kind: 'user_message', source: 'user', status: 'complete',
        title: 'Original input', content: 'Live input', authorHuman: true, publicContent: 'confirmed', createdAt: 301, updatedAt: 301 } })
    const live = await complete(input => f.rpc.call('agent.conversation.changes', { ...input, checkpoint: snapshot.window.checkpoint,
      view: snapshot.window.view! }), f.options)
    expect(live.window.id).toBe(snapshot.window.id); expect(live.window.navigation.newer).toBeNull()
    expect(live.units.flatMap(unit => unit.records)).toHaveLength(201)
    expect(projectConversationWindow(live).inputs[0]).toMatchObject({ rawId: 'live-input', author: { kind: 'human' } })
    const ordinary = await fill(f, 2), firstOlder = await complete(f.remote, { ...f.options, cursor: ordinary.window.navigation.older! })
    // The live append makes 301 originals: two further source pages reach its original oldest record.
    expect(firstOlder.window.navigation.older).toBeTruthy()
    const navigated = await complete(f.remote, { ...f.options, cursor: firstOlder.window.navigation.older! })
    expect(navigated.window.outside.newer).toBeTruthy()
    expect(navigated.units.flatMap(unit => unit.records).length).toBeLessThan(301)
    untouched(f)
  })

it('binds older preservation to the signed wire intent and pending request identity, including compiled CLI reads', async () => {
  const f = await fixture([native('earliest', 'user'), native('middle'), native('latest')])
  const initial = await complete(f.remote, { ...f.options, limit: 1 }), cursor = initial.window.navigation.older!
  const ordinaryPending = await f.remote({ ...f.options, cursor, limit: 1 })
  expect(ordinaryPending.window.complete).toBe(false)
  const preserved = await f.remote({ ...f.options, cursor, limit: 1, preserveCurrent: true })
  expect(preserved.window.complete).toBe(false)
  await expect(f.remote({ ...f.options, cursor: preserved.nextCursor!, limit: 1 })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await expect(f.remote({ ...f.options, cursor: ordinaryPending.nextCursor!, limit: 1, preserveCurrent: true })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await unchanged(f, initial)
  const pending = consumeConversationWindowPage(preserved)
  expect(pending.kind).toBe('pending'); if (pending.kind !== 'pending') throw Error('Expected the original partial frame')
  const last = await f.remote({ ...f.options, cursor: preserved.nextCursor!, limit: 1, preserveCurrent: true })
  const accepted = consumeConversationWindowPage(last, pending.pending)
  expect(accepted.kind).toBe('complete'); if (accepted.kind !== 'complete') throw Error('Expected the complete preserved frame')
  const finished = accepted.snapshot
  expect(finished.window.id).toBe(initial.window.id); expect(finished.window.revision).toBe(initial.window.revision + 1)
  const cli = await conversationReaderCli(f.root); closes.push(cli.close)
  const result = await cli.run(['agent', 'conversation', 'inspect', '--host', 'local', '--session', f.ref.agentSessionId,
    '--cursor', finished.window.navigation.older!, '--preserve-current', '--max-bytes', String(4 * 1024 * 1024)])
  expect(result.code, result.stderr).toBe(0)
  const output = JSON.parse(result.stdout), reading = consumeConversationWindowPage(output.result)
  expect(reading.kind).toBe('complete')
  if (reading.kind === 'complete') expect(projectConversationWindow(reading.snapshot).inputs[0]!.rawId).toBe('earliest')
  const help = await cli.run(['agent', 'conversation', 'inspect', '--help'])
  expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('--preserve-current')
  expect(help.stdout).toContain('preserveCurrent:true'); expect(help.stdout).toContain('AGENT_CONVERSATION_WINDOW_FULL')
  await expect(f.remote({ ...f.options, cursor: ordinaryPending.window.replay, preserveCurrent: true })).rejects.toBeDefined()
  const record = initial.units[0]!.records[0]!, modes: Record<string, unknown>[] = [{}, { view: initial.window.view! },
    { cursor, record: record.reference }, { cursor, anchor: { record: record.reference, revision: record.revision, frontier: initial.window.checkpoint } },
    { cursor, nativeSource: { providerId: 'claude', nativeSessionId: 'native-main' } }, { preserveCurrent: 'true', cursor }]
  for (const mode of modes) {
    expect(() => parseConversationTimelineReadInput({ ...f.ref, ...mode, preserveCurrent: mode.preserveCurrent ?? true })).toThrow()
  }
  untouched(f)
})

it('preserves original canonical coalescence while older contributions expand the same event', async () => {
  const f = await fixture([native('canonical-input', 'user')])
  for (let index = 0; index < 105; index++) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.ref.agentSessionId,
    item: { id: 'contribution-' + index, agentSessionId: f.ref.agentSessionId, kind: 'tool_call', source: 'native-hook',
      status: 'complete', title: 'Original detail', content: 'Detail ' + index, createdAt: index + 1, updatedAt: index + 1,
      conversation: { sameEvent: { ...f.ref, source: { kind: 'native', providerId: 'claude', nativeSessionId: 'native-main', recordId: 'canonical-input' } } } } })
  const first = await fill(f, 1), earlier = await complete(f.remote, { ...f.options, cursor: first.window.navigation.older!, preserveCurrent: true })
  expect(first.units).toHaveLength(1); expect(earlier.units).toHaveLength(1)
  expect(earlier.units[0]!.event.id).toBe(first.units[0]!.event.id)
  expect(earlier.units[0]!.records).toHaveLength(106)
  expect(projectConversationWindow(earlier).inputs[0]!.id).toBe(projectConversationWindow(first).inputs[0]!.id)
  untouched(f)
})
