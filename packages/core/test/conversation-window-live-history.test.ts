import { afterEach, expect, it } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { ConversationReaderState, readAgentConversation as readWindow, readConversationChanges as readWindowChanges, type ConversationReaderPort } from '../src/conversation-reader.js'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import type { AgentSessionHistoryItem } from '../src/types.js'
import { consumeConversationWindowPage, projectConversationWindow, type ConversationTimelineReadInput, type ConversationWindowAssembly, type AgentConversationReadPage, type ConversationWindowSnapshot } from '../src/conversation.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ type: 'user', uuid: 'original-' + (from + i), sessionId: 'native-main',
  message: { role: 'user', content: 'Original body ' + (from + i) } }))
async function complete(read: (input: ConversationTimelineReadInput) => Promise<AgentConversationReadPage>, input: ConversationTimelineReadInput) {
  let pending: ConversationWindowAssembly | undefined, cursor = input.cursor
  for (let i = 0; i < 200; i++) {
    const page = await read({ ...input, ...(cursor ? { cursor } : {}) }), result = consumeConversationWindowPage(page, pending)
    if (result.kind === 'complete') return result.snapshot
    pending = result.pending; cursor = page.nextCursor!
  }
  throw new Error('The original frame did not finish within its bounded wire pages')
}
const numbers = (snapshot: ConversationWindowSnapshot) => projectConversationWindow(snapshot).historyPage!.items.map(item => Number(item.id.slice('original-'.length)))
async function session(count: number) {
  const f = await nativeHistoryFixture('claude', jsonl(rows(0, count))); closes.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, input = { ...ref, limit: 100, maxBytes: 4 * 1024 * 1024 }
  const read = (cursor?: string) => complete(value => f.client.readAgentConversation(value), { ...input, ...(cursor ? { cursor } : {}) })
  // Follow live changes the way a following reader does: until the cut stops moving.
  const changes = async (from: ConversationWindowSnapshot) => {
    let snapshot = from
    for (let index = 0; index < 40; index++) {
      const next = await complete(value => f.client.readConversationChanges({ ...value, checkpoint: snapshot.window.checkpoint, view: snapshot.window.view! }), input)
      if (JSON.stringify(next.window.checkpoint) === JSON.stringify(snapshot.window.checkpoint)) return next
      snapshot = next
    }
    throw new Error('Live changes did not settle')
  }
  return { f, read, changes, append: (from: number, total: number) => appendFile(f.path, jsonl(rows(from, total))) }
}

it('reading an older page keeps the live frontier the view already reached', async () => {
  const { read, changes, append } = await session(300)
  const opened = await read()
  await append(300, 50)
  const live = await changes(opened)
  expect(numbers(live).slice(-50)).toEqual(Array.from({ length: 50 }, (_, i) => 300 + i))
  const older = await read(live.window.navigation.older!)
  // Earlier only adds older records; the frontier stays where live reading reached.
  expect(older.window.checkpoint).toEqual(live.window.checkpoint)
  await append(350, 1)
  const next = await changes(older)
  const values = numbers(next)
  expect(values.filter(value => value >= 300)).toEqual(Array.from({ length: 51 }, (_, i) => 300 + i))
  expect(values).toEqual([...new Set(values)].sort((a, b) => a - b))
}, 60000)

it('records evicted from a live window stay reachable through newer navigation', async () => {
  const { read, changes, append } = await session(400)
  const opened = await read()
  await append(400, 1300)
  const live = await changes(opened)
  expect(numbers(live).at(-1)).toBe(1699)
  let snapshot = await read(live.window.navigation.older!)
  const earlier = numbers(snapshot)
  // The older page joins the oldest retained record without a silent hole.
  expect(earlier).toEqual(Array.from({ length: earlier.length }, (_, i) => earlier[0]! + i))
  expect(earlier[0]).toBeLessThan(numbers(live)[0]!)
  expect(snapshot.window.navigation.newer, 'evicted live records need a way back').toBeTruthy()
  const reached = new Set(earlier)
  for (let index = 0; snapshot.window.navigation.newer && index < 40; index++) {
    snapshot = await read(snapshot.window.navigation.newer)
    const values = numbers(snapshot)
    expect(values).toEqual(Array.from({ length: values.length }, (_, i) => values[0]! + i))
    for (const value of values) reached.add(value)
  }
  expect(snapshot.window.navigation.newer).toBeNull()
  // Nothing newer is outside once the window is back at the live edge.
  expect(snapshot.window.outside.newer).toBeNull()
  expect(numbers(snapshot).at(-1)).toBe(1699)
  for (let value = earlier[0]!; value <= 1699; value++) expect(reached.has(value), 'original-' + value).toBe(true)
  // Back at the live edge, new records continue after the frontier without re-reading.
  await append(1700, 1)
  const next = await changes(snapshot)
  const values = numbers(next)
  expect(values.at(-1)).toBe(1700)
  expect(values).toEqual(Array.from({ length: values.length }, (_, i) => values[0]! + i))
}, 120000)

it('captured records evicted from a live window stay reachable at their accepted versions', async () => {
  const f = await nativeHistoryFixture('claude', jsonl(rows(0, 1))); closes.push(f.close)
  const store = new AgentMuxMemoryAgentSessionStore(); await store.compareAndSwap(null, f.session)
  const client = new AgentMuxClient({ store }); closes.push(() => client.dispose())
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, input = { ...ref, limit: 100, maxBytes: 4 * 1024 * 1024 }
  const write = (index: number, content = 'Captured body ' + index) => store.applyTimelineMutation({ type: 'upsert', agentSessionId: ref.agentSessionId,
    item: { id: 'captured-' + index, agentSessionId: ref.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', title: 'Original input', content, createdAt: index + 1, updatedAt: index + 1 } })
  for (let index = 0; index < 400; index++) await write(index)
  const read = (cursor?: string) => complete(value => client.readAgentConversation(value), { ...input, ...(cursor ? { cursor } : {}) })
  const captured = (snapshot: ConversationWindowSnapshot) => projectConversationWindow(snapshot).captured.items
  const changes = async (from: ConversationWindowSnapshot) => {
    let snapshot = from
    for (let index = 0; index < 40; index++) {
      const next = await complete(value => client.readConversationChanges({ ...value, checkpoint: snapshot.window.checkpoint, view: snapshot.window.view! }), input)
      if (JSON.stringify(next.window.checkpoint) === JSON.stringify(snapshot.window.checkpoint)) return next
      snapshot = next
    }
    throw new Error('Live changes did not settle')
  }
  const opened = await read()
  // A record from before the opening cut that the window never loaded gains a later version live,
  // as a long-running tool call does; it stays at its own position, outside the live records.
  await write(50, 'Edited body 50')
  for (let index = 400; index < 1700; index++) await write(index)
  // A record first delivered live then gains a later version the window accepts.
  await write(1650, 'Edited body 1650')
  const live = await changes(opened)
  expect(captured(live).at(-1)!.id).toBe('captured-1699')
  // Walk to the oldest page, then back: the walk back alone reaches every record, each once per page.
  let snapshot = live
  for (let index = 0; snapshot.window.navigation.older && index < 40; index++) snapshot = await read(snapshot.window.navigation.older)
  expect(snapshot.window.navigation.older).toBeNull()
  const reached = new Map(captured(snapshot).map(item => [item.id, item.content]))
  expect(snapshot.window.navigation.newer, 'evicted live records need a way back').toBeTruthy()
  for (let index = 0; snapshot.window.navigation.newer && index < 40; index++) {
    snapshot = await read(snapshot.window.navigation.newer)
    const ids = captured(snapshot).map(item => item.id)
    expect(ids).toEqual([...new Set(ids)])
    for (const item of captured(snapshot)) reached.set(item.id, item.content)
  }
  expect(snapshot.window.navigation.newer).toBeNull()
  const missing = Array.from({ length: 1700 }, (_, index) => 'captured-' + index).filter(id => !reached.has(id))
  expect(missing).toEqual([])
  expect(reached.get('captured-1650')).toBe('Edited body 1650')
}, 120000)

it('a live span re-read keeps one record once, at the latest version the source delivered', async () => {
  // A Provider that grows one reply in place delivers the same record again at each later cut,
  // and returns small pages, so following takes many short live reads.
  const source = { providerId: 'grok', nativeSessionId: 'native-main' }, agentSessionId = 'private-agent'
  const message = (id: string, text: string): AgentSessionHistoryItem => ({ id, kind: 'assistant-message', contentParts: [{ kind: 'text', text, contentEligibility: 'public' }] })
  const log: { cut: number; item: AgentSessionHistoryItem }[] = []
  for (let index = 0; index < 1300; index++) log.push({ cut: log.length + 1, item: message('live-' + index, 'Live body ' + index) })
  // The continued record belongs to an older span than the read that re-delivers it.
  log.splice(1290, 0, { cut: 0, item: message('live-1100', 'Live body 1100, continued') })
  log.forEach((entry, index) => { entry.cut = index + 1 })
  const opening = Array.from({ length: 100 }, (_, index) => message('opening-' + index, 'Opening body ' + index))
  const state = new ConversationReaderState(); closes.push(async () => state.dispose())
  let written = 0
  let delivered = 0
  const port: ConversationReaderPort = { state, descriptor: { agentSessionId, hostId: 'local', state: 'active', history: { providerId: 'grok', nativeHandle: { kind: 'provider', providerId: 'grok', sessionId: 'native-main' } } } as never,
    captured: async () => { throw Object.assign(Error('No captured source'), { code: 'AGENT_CONVERSATION_SOURCE_UNAVAILABLE' }) },
    nativeCheckpoint: async () => ({ agentSessionId, source, cursor: '0' }), nativeRecord: async () => { throw Error('unused') },
    nativePage: async () => ({ agentSessionId, source, items: opening, nextCursor: null, changesCursor: '0' }),
    nativeChanges: async (checkpoint, limit, through) => {
      const upper = Math.min(Number(through?.cursor ?? written), written), entries = log.slice(Number(checkpoint.cursor), upper).slice(0, Math.min(limit, 10))
      delivered += entries.length
      const cursor = String(Number(checkpoint.cursor) + entries.length)
      return { hostId: 'local', agentSessionId, source, items: entries.map(entry => entry.item), checkpoint: { agentSessionId, source, cursor }, more: Number(cursor) < upper }
    } }
  const ref = { hostId: 'local', agentSessionId }, input = { ...ref, limit: 100, maxBytes: 4 * 1024 * 1024 }
  const frame = async (first: () => Promise<AgentConversationReadPage>, next: (cursor: string) => Promise<AgentConversationReadPage>) => {
    let page = await first(), pending: ConversationWindowAssembly | undefined
    for (let index = 0; index < 200; index++) {
      const result = consumeConversationWindowPage(page, pending)
      if (result.kind === 'complete') return result.snapshot
      pending = result.pending; page = await next(page.nextCursor!)
    }
    throw new Error('The frame did not finish')
  }
  const read = (cursor?: string) => frame(() => readWindow({ ...input, ...(cursor ? { cursor } : {}) }, port), next => readWindow({ ...input, cursor: next }, port))
  let snapshot = await read()
  written = log.length
  for (let index = 0; index < 200; index++) {
    const from = snapshot
    snapshot = await frame(() => readWindowChanges({ ...input, checkpoint: from.window.checkpoint, view: from.window.view! }, port), next => readWindowChanges({ ...input, checkpoint: from.window.checkpoint, view: from.window.view!, cursor: next }, port))
    if (JSON.stringify(snapshot.window.checkpoint) === JSON.stringify(from.window.checkpoint)) break
  }
  const text = (value: ConversationWindowSnapshot) => new Map(projectConversationWindow(value).historyPage!.items.map(item => [item.id, item.contentParts[0]]))
  const latest = { text: 'Live body 1100, continued' }
  // Walk to the oldest page and back; every window holds each record once, at its latest delivered version.
  // Short live reads join one span, so the walk takes a page per hundred records, not one per read.
  const seen = new Set<string>(), visit = (value: ConversationWindowSnapshot) => {
    const ids = projectConversationWindow(value).historyPage!.items.map(item => item.id)
    expect(ids).toEqual([...new Set(ids)])
    if (text(value).has('live-1100')) expect(text(value).get('live-1100')).toMatchObject(latest)
    for (const id of ids) seen.add(id)
  }
  visit(snapshot)
  for (let index = 0; snapshot.window.navigation.older && index < 20; index++) visit(snapshot = await read(snapshot.window.navigation.older))
  expect(snapshot.window.navigation.older).toBeNull()
  for (let index = 0; snapshot.window.navigation.newer && index < 20; index++) visit(snapshot = await read(snapshot.window.navigation.newer))
  expect(snapshot.window.navigation.newer).toBeNull()
  expect(text(snapshot).get('live-1100')).toMatchObject(latest)
  const missing = [...opening.map(item => item.id), ...Array.from({ length: 1300 }, (_, index) => 'live-' + index)].filter(id => !seen.has(id))
  expect(missing).toEqual([])
  // Re-reading one evicted span reads that span's records, not the source from the opening cut.
  delivered = 0
  snapshot = await read(snapshot.window.navigation.older!)
  expect(delivered).toBeGreaterThan(0)
  expect(delivered).toBeLessThanOrEqual(110)
}, 120000)
