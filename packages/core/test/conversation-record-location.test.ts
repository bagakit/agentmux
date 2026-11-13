import { afterEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { ConversationReaderState } from '../src/conversation-reader.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { conversationReaderCli } from './helpers/conversation-reader-cli.js'
import { join } from 'node:path'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { consumeConversationWindowPage, projectConversationWindow, type ConversationTimelineReadInput, type AgentConversationReadPage,
  type ConversationWindowAssembly } from '../src/conversation.js'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function complete(read: (input: ConversationTimelineReadInput) => Promise<AgentConversationReadPage>, input: ConversationTimelineReadInput) {
  let cursor = input.cursor, pending: ConversationWindowAssembly | undefined
  while (true) {
    const page = await read({ ...input, ...(cursor ? { cursor } : {}) }), result = consumeConversationWindowPage(page, pending)
    if (result.kind === 'complete') return result.snapshot
    pending = result.pending
    expect(page.nextCursor).toBeTruthy(); expect(page.nextCursor).not.toBe(cursor)
    cursor = page.nextCursor!
  }
}
async function fixture(count: number) {
  const originals = Array.from({ length: count }, (_, index) => ({ type: 'user', uuid: 'native-' + index, sessionId: 'native-main',
    message: { role: 'user', content: 'Original native body ' + index } }))
  const f = await nativeHistoryFixture('claude', jsonl(originals)); closes.push(f.close)
  const store = new AgentMuxMemoryAgentSessionStore(); await store.compareAndSwap(null, f.session)
  const client = new AgentMuxClient({ store }); closes.push(() => client.dispose())
  for (let index = 0; index < count; index++) await store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId,
    item: { id: 'captured-' + index, agentSessionId: f.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete',
      title: 'Original captured input', content: 'Original captured body ' + index, createdAt: index, updatedAt: index } })
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(Reflect.get(client, 'kernel'), name))
  return { ...f, client, store, controls, ref, read: (input: ConversationTimelineReadInput) => client.readAgentConversation(input) }
}

it.each(['native', 'captured'] as const)('locating an unloaded %s record keeps original mixed-source context, both directions and live return', async kind => {
  const f = await fixture(1500), record = { ...f.ref, source: kind === 'native' ? { kind, providerId: 'claude', nativeSessionId: 'native-main', recordId: 'native-150' }
    : { kind, recordId: 'captured-150' } }
  const prior = await complete(f.read, { ...f.ref, limit: 100 })
  const loaded = await complete(f.read, { ...f.ref, record, limit: 100 })
  expect(loaded.window.id).not.toBe(prior.window.id)
  expect(loaded.window.anchor).toBeUndefined()
  expect(loaded.window.navigation.older).toBeTruthy(); expect(loaded.window.navigation.newer).toBeTruthy()
  const originals = projectConversationWindow(loaded)
  expect(originals.historyPage!.items.some(item => item.id === 'native-150')).toBe(true)
  expect(originals.captured.items.some(item => item.id === 'captured-150')).toBe(true)
  expect(new Set(loaded.units.flatMap(unit => unit.records.map(record => record.id))).size).toBe(loaded.units.flatMap(unit => unit.records).length)
  expect((await complete(f.read, { ...f.ref, view: prior.window.view! })).units).toEqual(prior.units)
  let current = await complete(f.read, { ...f.ref, cursor: loaded.window.navigation.older!, limit: 100 })
  expect(current.window.id).toBe(loaded.window.id)
  await appendFile(f.path, jsonl([{ type: 'user', uuid: 'after-location', sessionId: 'native-main', message: { role: 'user', content: 'After the original location' } }]))
  while (current.window.navigation.newer) current = await complete(f.read, { ...f.ref, cursor: current.window.navigation.newer, limit: 100 })
  const changed = await complete(input => f.client.readConversationChanges({ ...input, view: current.window.view!, checkpoint: current.window.checkpoint }), { ...f.ref, limit: 100 })
  expect(projectConversationWindow(changed).historyPage!.items.at(-1)!.id).toBe('after-location')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
}, 30000)

it('a loaded record location stays navigable while its versioned anchor remains one immutable original', async () => {
  const f = await fixture(3), initial = await complete(f.read, { ...f.ref, limit: 100 }), original = initial.units.flatMap(unit => unit.records)
    .find(record => record.original.kind === 'native' && record.original.item.id === 'native-1')!
  const request = { ...f.ref, record: original.reference!, limit: 1, maxBytes: 16 * 1024 }
  const first = await f.read(request)
  expect(first.window.complete).toBe(false)
  await expect(f.read({ ...request, cursor: first.window.replay, record: { ...original.reference!, source: { ...original.reference!.source, recordId: 'another-original' } } })).rejects.toThrow(/original frontier/)
  await expect(f.read({ ...f.ref, limit: 1, maxBytes: 16 * 1024, cursor: first.window.replay })).rejects.toThrow(/original frontier/)
  const located = await complete(f.read, { ...request, cursor: first.window.replay })
  expect(located.units.length).toBeGreaterThan(1); expect(located.window.anchor).toBeUndefined()
  const anchor = { record: original.reference!, revision: original.revision, frontier: initial.window.checkpoint }
  const exact = await complete(f.read, { ...f.ref, anchor, limit: 100 })
  expect(exact.window.anchor).toEqual(anchor); expect(exact.window.navigation).toEqual({ older: null, newer: null })
  expect(exact.units.flatMap(unit => unit.records).map(record => record.original)).toEqual([original.original])
  await expect(f.client.readConversationChanges({ ...f.ref, view: exact.window.view!, checkpoint: exact.window.checkpoint })).rejects.toThrow(/exact original version/)
})

it('a cancelled or missing location releases only its candidate and leaves the accepted original readable', async () => {
  const f = await fixture(220), initial = await complete(f.read, { ...f.ref, limit: 100 })
  const create = vi.spyOn(ConversationReaderState.prototype, 'create')
  const missing = { ...f.ref, source: { kind: 'native' as const, providerId: 'claude', nativeSessionId: 'native-main', recordId: 'missing-original' } }
  await expect(f.read({ ...f.ref, record: missing })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_RECORD_UNAVAILABLE' })
  const candidate = create.mock.results[0]!.value!, state = create.mock.instances[0]! as unknown as ConversationReaderState
  expect(() => state.get(candidate.id, f.ref, candidate.scope)).toThrow(/expired/)
  const controller = new AbortController(), reader = f.client as unknown as { readSessionHistoryPage: AgentMuxClient['sessionHistoryPage'] }
  const read = reader.readSessionHistoryPage.bind(f.client)
  vi.spyOn(reader, 'readSessionHistoryPage').mockImplementation(async (...args) => {
    const page = await read(...args); controller.abort(new Error('A later navigation owns focus')); return page
  })
  await expect(f.client.readAgentConversation({ ...f.ref, record: missing }, { signal: controller.signal })).rejects.toThrow('A later navigation owns focus')
  expect((await complete(f.read, { ...f.ref, view: initial.window.view! })).units).toEqual(initial.units)
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('the compiled public CLI locates current context and releases its exact reader through the original owner', async () => {
  const f = await fixture(8), server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const cli = await conversationReaderCli(f.root); closes.push(cli.close)
  const record = { ...f.ref, source: { kind: 'native' as const, providerId: 'claude', nativeSessionId: 'native-main', recordId: 'native-1' } }
  const receipt = await cli.run(['agent', 'conversation', 'inspect', '--input', '-'], JSON.stringify({ ...f.ref, record, limit: 100, maxBytes: 4 * 1024 * 1024 }))
  expect(receipt.code, receipt.stderr).toBe(0)
  const page = JSON.parse(receipt.stdout).result as AgentConversationReadPage, consumed = consumeConversationWindowPage(page)
  expect(consumed.kind).toBe('complete'); expect(page.window.anchor).toBeUndefined()
  expect(page.window.itemCount).toBe(16)
  const ids = page.items.flatMap(entry => entry.kind === 'item' ? entry.item.records.map(record => record.reference!.source.recordId) : [])
  expect(ids).toContain('native-1'); expect(ids).toContain('captured-1')
  const release = await cli.run(['agent', 'conversation', 'release', '--host', 'local', '--session', f.ref.agentSessionId, '--view', page.window.view!])
  expect(release.code, release.stderr).toBe(0); expect(JSON.parse(release.stdout).result).toMatchObject({ viewId: page.window.id, released: true })
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('record-location source work grows with its own pages rather than unrelated Sessions', async () => {
  const f = await fixture(220), record = { ...f.ref, source: { kind: 'native' as const, providerId: 'claude', nativeSessionId: 'native-main', recordId: 'native-0' } }
  const reader = f.client as unknown as { readSessionHistoryPage: AgentMuxClient['sessionHistoryPage'] }
  const native = vi.spyOn(reader, 'readSessionHistoryPage'), captured = vi.spyOn(f.store, 'readCapturedHistory')
  const first = await complete(f.read, { ...f.ref, record, limit: 100 })
  const costs = [native.mock.calls.length, captured.mock.calls.length]
  expect(costs[0]).toBeGreaterThan(0); expect(costs[1]).toBeGreaterThan(0)
  await f.client.releaseConversationView({ ...f.ref, view: first.window.view! })
  for (let index = 0; index < 48; index++) await f.store.compareAndSwap(null, { ...f.session, agentSessionId: 'unrelated-' + index, run: { runId: 'unrelated-run-' + index }, retiredRuns: [], nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'unrelated-native-' + index } })
  native.mockClear(); captured.mockClear()
  const again = await complete(f.read, { ...f.ref, record, limit: 100 })
  expect([native.mock.calls.length, captured.mock.calls.length]).toEqual(costs)
  expect(again.units).toEqual(first.units)
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
