import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc'
import { consumeConversationWindowPage, projectConversationWindow, type ConversationTimelineReadInput, type ConversationWindowAssembly, type AgentConversationReadPage } from '../src/conversation'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ type: 'user', uuid: 'original-' + i, sessionId: 'native-main',
  timestamp: new Date(i % 2 ? _historyFixtureEpoch(0, 1, 0) : _historyFixtureEpoch(0, 5, 0)).toISOString(), message: { role: 'user', content: 'Original body ' + i } }))
async function complete(read: (input: ConversationTimelineReadInput) => Promise<AgentConversationReadPage>, input: ConversationTimelineReadInput) {
  let pending: ConversationWindowAssembly | undefined, cursor = input.cursor
  for (let i = 0; i < 200; i++) {
    const page = await read({ ...input, ...(cursor ? { cursor } : {}) }), result = consumeConversationWindowPage(page, pending)
    if (result.kind === 'complete') return result.snapshot
    pending = result.pending; cursor = page.nextCursor!; expect(cursor).toBeTruthy()
  }
  throw new Error('The original frame did not finish within its bounded wire pages')
}
it('retains earlier navigation through changes and recovers evicted newer pages in original source order', async () => {
  const f = await nativeHistoryFixture('claude', jsonl(rows(1400))); closes.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, read = (input: ConversationTimelineReadInput) => f.client.readAgentConversation(input)
  let snapshot = await complete(read, { ...ref, limit: 100, maxBytes: 4 * 1024 * 1024 })
  const changed = await complete(input => f.client.readConversationChanges({ ...input, checkpoint: snapshot.window.checkpoint, view: snapshot.window.view! }), { ...ref, limit: 100, maxBytes: 4 * 1024 * 1024 })
  expect(changed.window.navigation.older).toBeTruthy()
  snapshot = changed
  for (let i = 0; i < 12; i++) snapshot = await complete(read, { ...ref, cursor: snapshot.window.navigation.older!, limit: 100, maxBytes: 4 * 1024 * 1024 })
  expect(snapshot.units).toHaveLength(1200)
  expect(snapshot.window.navigation.newer).toBeTruthy()
  snapshot = await complete(read, { ...ref, cursor: snapshot.window.navigation.newer!, limit: 100, maxBytes: 4 * 1024 * 1024 })
  const originals = projectConversationWindow(snapshot).historyPage!.items
  expect(originals.map(item => item.id)).toEqual(Array.from({ length: 1200 }, (_, i) => 'original-' + (i + 200)))
  expect(snapshot.window.navigation.older).toBeTruthy()
  expect(snapshot.window.navigation.newer).toBeNull()
  const record = snapshot.units.at(-1)!.records[0]!, anchor = { record: record.reference!, revision: record.revision, frontier: snapshot.window.checkpoint }
  const exact = await complete(read, { ...ref, anchor, limit: 100 })
  expect(exact.window.anchor).toEqual(anchor)
  await expect(f.client.readConversationChanges({ ...ref, checkpoint: exact.window.checkpoint, view: exact.window.view! })).rejects.toThrow(/exact original version/)
  expect((await complete(read, { ...ref, view: exact.window.view!, limit: 100 })).window.anchor).toEqual(anchor)
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
it.each(['native', 'captured'] as const)('recovers the original %s contribution when only the other source of its mixed page remains', async missing => {
  const originals = missing === 'native' ? rows(2400) : rows(1).map(item => ({ ...item, timestamp: new Date(0).toISOString() }))
  const f = await nativeHistoryFixture('claude', jsonl(originals)); closes.push(f.close)
  // Both sources go through their actual original owners. Memory persistence
  // keeps this adjacency case independent of thousands of individual disk writes.
  const store = new AgentMuxMemoryAgentSessionStore(); await store.compareAndSwap(null, f.session)
  const client = new AgentMuxClient({ store }); closes.push(() => client.dispose())
  const capturedCount = missing === 'captured' ? 2400 : 1
  for (let index = 0; index < capturedCount; index++) await store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId,
    item: { id: 'captured-' + index, agentSessionId: f.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete',
      title: 'Original input', content: 'Original captured body ' + index, createdAt: index + 1, updatedAt: index + 1 } })
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, read = (input: ConversationTimelineReadInput) => client.readAgentConversation(input)
  const input = { ...ref, limit: 100, maxBytes: 4 * 1024 * 1024 }
  let first = await complete(read, input)
  for (let index = 0; index < 2; index++) first = await complete(read, { ...input, cursor: first.window.navigation.older! })
  const originalHead = first.units.flatMap(unit => unit.records)
  const sourceIds = (snapshot: typeof first, kind: typeof missing) => snapshot.units.flatMap(unit => unit.records)
    .filter(record => record.original.kind === kind).map(record => record.id)
  const initialMissing = sourceIds(first, missing), survivor = sourceIds(first, missing === 'native' ? 'captured' : 'native')
  expect(initialMissing).toHaveLength(300); expect(survivor).toHaveLength(1)
  let snapshot = first
  for (let index = 0; index < 21; index++) {
    expect(snapshot.window.navigation.older).toBeTruthy()
    snapshot = await complete(read, { ...input, cursor: snapshot.window.navigation.older! })
    expect(snapshot.units.flatMap(unit => unit.records).length).toBeLessThanOrEqual(1200)
    const values = sourceIds(snapshot, missing).map(id => Number(JSON.parse(id).at(-1).split('-').at(-1))).sort((a, b) => a - b)
    expect(values).toEqual(Array.from({ length: values.length }, (_, offset) => values[0]! + offset))
  }
  const current = new Set(snapshot.units.flatMap(unit => unit.records).map(record => record.id))
  expect(initialMissing.every(id => !current.has(id))).toBe(true)
  expect(survivor.every(id => current.has(id))).toBe(true)
  expect(snapshot.window.navigation.older).toBeNull()
  expect(snapshot.window.navigation.newer, 'The surviving source cannot conceal the evicted source of its original page').toBeTruthy()
  const nativeRead = vi.spyOn(client as unknown as { readSessionHistoryPage: AgentMuxClient['sessionHistoryPage'] }, 'readSessionHistoryPage')
  for (let index = 0; snapshot.window.navigation.newer && index < 24; index++) {
    snapshot = await complete(read, { ...input, cursor: snapshot.window.navigation.newer })
    const values = sourceIds(snapshot, missing).map(id => Number(JSON.parse(id).at(-1).split('-').at(-1))).sort((a, b) => a - b)
    expect(values.length).toBeGreaterThan(0)
    expect(values).toEqual(Array.from({ length: values.length }, (_, offset) => values[0]! + offset))
  }
  const returned = new Map(snapshot.units.flatMap(unit => unit.records).map(record => [record.id, record]))
  for (const record of originalHead) expect(returned.get(record.id)).toEqual(record)
  expect(snapshot.window.navigation.newer).toBeNull()
  expect(snapshot.window.navigation.older).toBeTruthy()
  const projected = projectConversationWindow(snapshot)
  const sequence = missing === 'native' ? projected.historyPage!.items.map(item => Number(item.id.slice('original-'.length)))
    : projected.captured.items.map(item => Number(item.id.slice('captured-'.length)))
  expect(sequence).toEqual([...sequence].sort((a, b) => a - b))
  const calls = nativeRead.mock.calls.length
  const retained = await complete(read, { ...input, view: snapshot.window.view! })
  expect(retained.units).toEqual(snapshot.units); expect(nativeRead).toHaveBeenCalledTimes(calls)
  expect(retained.window.navigation.newer).toBeNull()
}, 60000)
it('explicit previous source uses the original retained native binding through history, changes and exact watch', async () => {
  const f = await nativeHistoryFixture('claude', jsonl(rows(3))); closes.push(f.close)
  const currentPath = join(f.root, 'current.jsonl')
  await writeFile(currentPath, jsonl([{ type: 'user', uuid: 'current-source-item', sessionId: 'native-current', message: { role: 'user', content: 'Current body' } }]))
  const nativeHandle = { kind: 'provider' as const, providerId: 'claude', sessionId: 'native-current', transcriptPath: currentPath }
  const updated = { ...f.session, updatedAt: _historyFixtureEpoch(0, 0, 3), nativeHandle, nativeConfirmation: { operationId: 'explicit-original-source-confirmation', run: f.session.run, previousNativeHandle: f.session.nativeHandle!, nativeHandle, observedAt: _historyFixtureEpoch(0, 0, 3), candidateObservedAt: _historyFixtureEpoch(0, 0, 2) } }
  await f.store.compareAndSwap(f.session, updated)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const snapshot = await complete(input => f.client.readAgentConversation(input), { ...ref, nativeSource: { providerId: 'claude', nativeSessionId: 'native-main' }, limit: 100 })
  expect(projectConversationWindow(snapshot).historyPage!.items.map(item => item.id)).toEqual(['original-0', 'original-1', 'original-2'])
  const watch = await f.client.observeConversation({ ...ref, view: snapshot.window.view! }, () => {})
  const page = await f.client.readConversationChanges({ ...ref, checkpoint: snapshot.window.checkpoint, view: snapshot.window.view! })
  expect(page.scope).toEqual(snapshot.scope); expect(watch.scope).toEqual(snapshot.scope)
  watch.dispose()
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('parks exact accepted views without reads, pins watched views and releases only their temporary resource', async () => {
  const f = await nativeHistoryFixture('claude', jsonl(rows(3))); closes.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, read = (input: ConversationTimelineReadInput) => f.client.readAgentConversation(input)
  const snapshot = await complete(read, { ...ref, limit: 100 })
  const watch = await f.client.observeConversation({ ...ref, view: snapshot.window.view! }, () => {})
  const nativeRead = vi.spyOn(f.client, 'sessionHistoryPage')
  const capturedRead = vi.spyOn(f.client, 'readAgentSessionHistory')
  watch.dispose()
  expect(nativeRead).not.toHaveBeenCalled(); expect(capturedRead).not.toHaveBeenCalled()
  await appendFile(f.path, jsonl([{ type: 'user', uuid: 'after-park', sessionId: 'native-main', message: { role: 'user', content: 'Later, outside original frame' } }]))
  const resume = complete(read, { ...ref, view: snapshot.window.view! })
  await expect(resume).resolves.toMatchObject({ window: { id: snapshot.window.id } })
  const resumed = await resume
  expect(resumed.window.id).toBe(snapshot.window.id)
  expect(resumed.units).toEqual(snapshot.units)
  expect(nativeRead).not.toHaveBeenCalled(); expect(capturedRead).not.toHaveBeenCalled()
  const active = await f.client.observeConversation({ ...ref, view: resumed.window.view! }, () => {})
  for (let index = 0; index < 18; index++) await complete(read, { ...ref, limit: 1 })
  const keep = complete(read, { ...ref, view: resumed.window.view! })
  await expect(keep).resolves.toMatchObject({ window: { id: snapshot.window.id } })
  const kept = await keep
  expect(kept.window.id).toBe(snapshot.window.id)
  active.dispose()
  expect((await f.client.releaseConversationView({ ...ref, view: kept.window.view! })).released).toBe(true)
  await expect(read({ ...ref, view: kept.window.view! })).rejects.toThrow(/expired/)
  expect((await f.client.releaseConversationView({ ...ref, view: kept.window.view! })).released).toBe(false)
  const parked = await complete(read, { ...ref, limit: 1 })
  for (let index = 0; index < 17; index++) await complete(read, { ...ref, limit: 1 })
  await expect(read({ ...ref, view: parked.window.view! })).rejects.toThrow(/expired/)
  expect(projectConversationWindow(parked).historyPage!.items[0]!.id).toBe('after-park')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
it('replays the original first page after append instead of substituting the current native head', async () => {
  const f = await nativeHistoryFixture('claude', jsonl(rows(1300))); closes.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, read = (input: ConversationTimelineReadInput) => f.client.readAgentConversation(input)
  let snapshot = await complete(read, { ...ref, limit: 100, maxBytes: 4 * 1024 * 1024 })
  const originalLast = projectConversationWindow(snapshot).historyPage!.items.at(-1)!
  for (let index = 0; index < 12; index++) snapshot = await complete(read, { ...ref, cursor: snapshot.window.navigation.older!, limit: 100, maxBytes: 4 * 1024 * 1024 })
  expect(snapshot.window.navigation.newer).toBeTruthy()
  await appendFile(f.path, jsonl([{ type: 'user', uuid: 'concurrent-new-head', sessionId: 'native-main', message: { role: 'user', content: 'Outside the original frozen page' } }]))
  snapshot = await complete(read, { ...ref, cursor: snapshot.window.navigation.newer!, maxBytes: 4 * 1024 * 1024 })
  const page = projectConversationWindow(snapshot).historyPage!
  expect(page.items.at(-1)).toEqual(originalLast)
  expect(page.items.some(item => item.id === 'concurrent-new-head')).toBe(false)
})

it('accounts for both immutable head and live versions when a Provider cannot replay its original head', async () => {
  const body = 'x'.repeat(700 * 1024), data = { type: 'assistant', uuid: 'unrepeatable-head', sessionId: 'native-main', message: { role: 'assistant', content: body } }
  const f = await nativeHistoryFixture('claude', jsonl([data])); closes.push(f.close)
  const store = new AgentMuxMemoryAgentSessionStore(); await store.compareAndSwap(null, f.session)
  const client = new AgentMuxClient({ store }); closes.push(() => client.dispose())
  const capturedBody = 'original captured body '.padEnd(120 * 1024, 'c')
  for (let index = 0; index < 262; index++) await store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId,
    item: { id: 'retained-' + index, agentSessionId: f.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', title: 'Original input', content: capturedBody, createdAt: index, updatedAt: index } })
  const reader = client as unknown as { readSessionHistoryPage: AgentMuxClient['sessionHistoryPage'] }
  const originalPage = reader.readSessionHistoryPage.bind(client)
  // Omit only the optional replay capability. Native originals and their exact
  // changes cut still come from the real physical Provider read.
  const physicalRead = vi.spyOn(reader, 'readSessionHistoryPage').mockImplementation(async (...args) => { const { replayCursor: _replay, ...page } = await originalPage(...args); return page })
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, read = (input: ConversationTimelineReadInput) => client.readAgentConversation(input)
  let snapshot = await complete(read, { ...ref, limit: 100, maxBytes: 4 * 1024 * 1024 })
  while (snapshot.window.navigation.older) snapshot = await complete(read, { ...ref, cursor: snapshot.window.navigation.older, limit: 100, maxBytes: 4 * 1024 * 1024 })
  expect(snapshot.units, JSON.stringify(snapshot.coverage)).toHaveLength(263)
  expect(physicalRead).toHaveBeenCalled()
  const originalHead = snapshot.units.flatMap(unit => unit.records).find(record => record.original.kind === 'native')!
  await appendFile(f.path, jsonl([{ ...data, message: { ...data.message, content: 'y'.repeat(body.length) } }]))
  const changed = await complete(input => client.readConversationChanges({ ...input, view: snapshot.window.view!, checkpoint: snapshot.window.checkpoint }), { ...ref, limit: 100, maxBytes: 4 * 1024 * 1024 })
  const retainedBytes = changed.units.flatMap(unit => unit.records).reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)), 0) + Buffer.byteLength(JSON.stringify(originalHead))
  expect(retainedBytes).toBeLessThanOrEqual(32 * 1024 * 1024)
  expect(changed.units.length).toBeLessThan(snapshot.units.length)
  expect(changed.window.outside.older).not.toBeNull()
  expect(projectConversationWindow(changed).historyPage!.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'y'.repeat(body.length), contentEligibility: 'public' }])
  expect(originalHead.original.kind === 'native' && originalHead.original.item.contentParts).toEqual([{ kind: 'text', text: body, contentEligibility: 'public' }])
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
}, 30000)

it.runIf(process.env.AGENTMUX_UNIFIED_COMPILED === '1')('the compiled public SDK and CLI preserve previous-source selection, parked views and both history directions', async () => {
  const f = await nativeHistoryFixture('claude', jsonl(rows(1300))); closes.push(f.close)
  const compiled = await import('../dist/index.js')
  const client = new compiled.AgentMuxClient({ store: new compiled.AgentMuxFileAgentSessionStore(f.storePath) }); closes.push(() => client.dispose())
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(Reflect.get(client, 'kernel'), name))
  const server = new compiled.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await (await import('../dist/public-rpc-client.js')).connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }, read = (input: ConversationTimelineReadInput) => rpc.call('agent.conversation.inspect', input)
  let snapshot = await complete(read, { ...ref, limit: 100, maxBytes: 4 * 1024 * 1024 })
  for (let index = 0; index < 12; index++) snapshot = await complete(read, { ...ref, cursor: snapshot.window.navigation.older!, limit: 100, maxBytes: 4 * 1024 * 1024 })
  expect(snapshot.window.navigation.newer).toBeTruthy()
  const env = objectCliEnvironment(f.root)
  const cliRead = async (input: ConversationTimelineReadInput) => {
    const result = await runCompiledObjectCli(['agent', 'conversation', 'inspect', '--input', '-'], env, JSON.stringify(input))
    expect(result.code, result.stderr).toBe(0)
    return JSON.parse(result.stdout).result as AgentConversationReadPage
  }
  snapshot = await complete(cliRead, { ...ref, cursor: snapshot.window.navigation.newer!, limit: 100, maxBytes: 4 * 1024 * 1024 })
  expect(projectConversationWindow(snapshot).historyPage!.items.map(item => item.id)).toEqual(Array.from({ length: 1200 }, (_, index) => 'original-' + (index + 100)))
  expect(snapshot.window.navigation.older).toBeTruthy(); expect(snapshot.window.navigation.newer).toBeNull()
  const sourceRead = vi.spyOn(client, 'sessionHistoryPage')
  const parked = await complete(cliRead, { ...ref, view: snapshot.window.view!, limit: 100, maxBytes: 4 * 1024 * 1024 })
  // The frame replay token describes this request's wire slice. Identity,
  // revision, cut, outside boundaries and navigation remain the accepted facts.
  const { replay: _originalReplay, ...acceptedWindow } = snapshot.window
  const { replay: _parkedReplay, ...parkedWindow } = parked.window
  expect(parkedWindow).toEqual(acceptedWindow); expect(parked.units).toEqual(snapshot.units); expect(sourceRead).not.toHaveBeenCalled()
  const original = parked.units.at(-1)!.records[0]!
  const anchor = { record: original.reference!, revision: original.revision, frontier: parked.window.checkpoint }
  const exact = await complete(cliRead, { ...ref, anchor, limit: 100 })
  expect(exact.window.anchor).toEqual(anchor); expect(exact.window.navigation).toEqual({ older: null, newer: null })
  expect(exact.units.flatMap(unit => unit.records).map(record => record.original)).toEqual([original.original])
  const currentPath = join(f.root, 'current.jsonl'), nativeHandle = { kind: 'provider' as const, providerId: 'claude', sessionId: 'native-current', transcriptPath: currentPath }
  await writeFile(currentPath, jsonl([{ type: 'user', uuid: 'other-original', sessionId: 'native-current', message: { role: 'user', content: 'Separate native source' } }]))
  await f.store.compareAndSwap(f.session, { ...f.session, updatedAt: _historyFixtureEpoch(0, 0, 3), nativeHandle, nativeConfirmation: { operationId: 'exact-previous-source', run: f.session.run, previousNativeHandle: f.session.nativeHandle!, nativeHandle, observedAt: _historyFixtureEpoch(0, 0, 3), candidateObservedAt: _historyFixtureEpoch(0, 0, 2) } })
  const previous = await cliRead({ ...ref, nativeSource: { providerId: 'claude', nativeSessionId: 'native-main' }, limit: 1 })
  expect(previous.scope.sources).toContainEqual({ kind: 'native', providerId: 'claude', nativeSessionId: 'native-main' })
  expect(previous.items[0]!.kind === 'item' && previous.items[0]!.item.records[0]!.original.item.id).toBe('original-1299')
  const released = await runCompiledObjectCli(['agent', 'conversation', 'release', '--host', 'local', '--session', ref.agentSessionId, '--view', snapshot.window.view!], env)
  expect(released.code, released.stderr).toBe(0); expect(JSON.parse(released.stdout).result).toMatchObject({ released: true, viewId: snapshot.window.id })
  expect(controls.every(control => control.mock.calls.length === 0)).toBe(true)
}, 45000)
