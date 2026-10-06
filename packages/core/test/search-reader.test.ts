import { afterEach, expect, it, vi } from 'vitest'
import { createAgentMuxSearchReader, type AgentMuxSearchOwner } from '../src/search-reader.js'
import { createAgentMuxSearchObservationOwner } from '../src/search-observation.js'
import { parseAgentMuxSearchInput, parseAgentMuxSearchPage, readAgentMuxSearch } from '../src/search-codec.js'
import type { AgentTimelineItem } from '../src/types.js'
import type { AgentMuxSearchInput, AgentMuxSearchPage } from '../src/search-contract.js'
import { createHistoryQueryFixture } from './helpers/session-history-query.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
async function fixture() {
  const f = await createHistoryQueryFixture(cleanups)
  const owner = createAgentMuxSearchObservationOwner({
    clients: async () => [{ hostId: 'local', client: f.client }],
    catalog: async () => ({ spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }), projects: async () => [],
    snapshot: async () => ({ workspaces: [], topics: [], motes: [], unavailable: [] }),
    history: (input, context) => f.client.readAgentSessionHistory(input, context)
  })
  const reader = createAgentMuxSearchReader(owner)
  cleanups.push(async () => reader.dispose())
  const input: AgentMuxSearchInput = { mode: 'history', query: 'needle', hostId: 'local', agentSessionId: f.session.agentSessionId, source: 'captured', limit: 1, scanLimit: 2 }
  return { ...f, owner, reader, input }
}
const assistant = (item: AgentTimelineItem): AgentTimelineItem => { const { authorHuman: _human, ...original } = item; return { ...original, kind: 'assistant_message' } }
const recordIds = (page: AgentMuxSearchPage) => page.hits.flatMap(hit => hit.kind === 'history' ? hit.page.items.flatMap(entry => entry.kind === 'item' ? [entry.item.id] : []) : [])

it('keeps captured and native original records and unavailable native coverage without controlling a Run', async () => {
  const f = await fixture(), { nativeHandle: _native, ...capturedOnly } = f.session
  await f.store.compareAndSwap(null, { ...capturedOnly, agentSessionId: 'captured-only', run: { runId: 'another-original-run' } })
  for (const id of [f.session.agentSessionId, 'captured-only']) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: id,
    item: { ...assistant(f.captured(10, 'assistant-only needle')), agentSessionId: id } })
  const input: AgentMuxSearchInput = { mode: 'history', query: 'needle', limit: 1, scanLimit: 2 }, hits: AgentMuxSearchPage['hits'] = [], issues: string[] = []
  let page = await f.reader.read(input, {}), reads = 0
  do {
    hits.push(...page.hits); issues.push(...page.coverage.unavailable.map(issue => issue.code)); reads++
    if (!page.nextCursor) break
    expect(page.coverage.complete).toBe(false)
    page = await f.reader.read({ ...input, cursor: page.nextCursor }, {})
  } while (reads < 20)
  expect(hits.filter(hit => hit.kind === 'history').map(hit => hit.reference.source)).toContain('native')
  expect(hits.filter(hit => hit.kind === 'history').map(hit => hit.reference.agentSessionId)).toContain('captured-only')
  expect(issues).toContain('AGENT_NATIVE_HISTORY_UNAVAILABLE')
  expect(page.nextCursor).toBeNull(); expect(page.coverage.complete).toBe(false)
  expect(page.coverage.completedSources).toBe(3); expect(page.coverage.unavailableCount).toBe(1)
  await f.noControls()
})

it('continues a zero-match scan through the original fixed source without rediscovery or moving appended work into it', async () => {
  const f = await fixture(), original = Array.from({ length: 9 }, (_, index) => f.captured(index, index === 0 ? 'old needle' : 'other text'))
  const snapshot = vi.spyOn(f.client, 'sessionTimeline').mockResolvedValue({ agentSessionId: f.session.agentSessionId, revision: 1, items: original })
  const discovery = vi.spyOn(f.owner, 'sources')
  let page = await f.reader.read(f.input, { authority: 'first-reader' })
  expect(page.hits).toEqual([]); expect(page.coverage.examined).toBe(2); expect(page.nextCursor).toBeTypeOf('string')
  const cursor = page.nextCursor!
  snapshot.mockResolvedValue({ agentSessionId: f.session.agentSessionId, revision: 2, items: [...original, f.captured(20, 'new needle')] })
  const replay = await f.reader.read({ ...f.input, cursor }, { authority: 'first-reader' })
  expect(await f.reader.read({ ...f.input, cursor }, { authority: 'first-reader' })).toEqual(replay)
  const all: string[] = []
  for (let reads = 0; page.nextCursor && reads < 8; reads++) {
    page = await f.reader.read({ ...f.input, cursor: page.nextCursor }, { authority: 'first-reader' }); all.push(...recordIds(page))
  }
  expect(all).toEqual(['captured-0']); expect(page.coverage.complete).toBe(true)
  expect(discovery).toHaveBeenCalledOnce(); expect(snapshot).toHaveBeenCalledOnce()
  for (const changed of [
    { ...f.input, query: 'different', cursor }, { mode: 'metadata' as const, query: f.input.query, hostId: f.input.hostId!, agentSessionId: f.input.agentSessionId!, cursor },
    { ...f.input, source: 'native' as const, cursor }, { ...f.input, hostId: 'another-host', cursor },
    { ...f.input, cursor: (cursor[0] === 'A' ? 'B' : 'A') + cursor.slice(1) }
  ]) await expect(f.reader.read(changed, { authority: 'first-reader' })).rejects.toMatchObject({ code: 'AGENTMUX_SEARCH_SOURCE_CHANGED' })
  await expect(f.reader.read({ ...f.input, cursor }, { authority: 'another-reader' })).rejects.toMatchObject({ code: 'AGENTMUX_SEARCH_SOURCE_CHANGED' })
  expect(discovery).toHaveBeenCalledOnce(); await f.noControls()
})

it('recovers an oversized whole original record at the exact search cursor and preserves the original query', async () => {
  const f = await fixture(), content = 'x'.repeat(64 * 1024) + ' needle', item = assistant(f.captured(10, content))
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item })
  const read = vi.fn((input: AgentMuxSearchInput) => f.reader.read(input, {}))
  const input = { ...f.input, maxBytes: 4096 }
  const page = await readAgentMuxSearch(input, read)
  expect({ ids: recordIds(page), issues: page.coverage.unavailable }).toEqual({ ids: [item.id], issues: [] }); expect(page.hits[0]).toMatchObject({ page: { items: [{ item: { content } }] } })
  expect(read).toHaveBeenCalledTimes(3); expect(read.mock.calls[1]![0].cursor).toBeTypeOf('string')
  expect(read.mock.calls[1]![0].query).toBe(f.input.query); expect(page.budgetBytes).toBeGreaterThan(4096)
  expect(parseAgentMuxSearchPage(page, read.mock.calls[2]![0])).toEqual(page)
  await f.noControls()
})

it('does not publish a native replacement or confuse its source with captured work', async () => {
  const f = await fixture(), original = await f.owner.sources({ ...f.input, source: 'native' }, {})
  const owner: AgentMuxSearchOwner = { ...f.owner, sources: async () => original,
    history: async (input, context) => ({ ...await f.owner.history(input, context), nativeSource: { providerId: 'claude', nativeSessionId: 'replacement-native' } }) }
  const reader = createAgentMuxSearchReader(owner), page = await reader.read({ ...f.input, source: 'native' }, {})
  expect(page.hits).toEqual([]); expect(page.coverage.unavailable).toMatchObject([{ source: 'native', code: 'AGENTMUX_SEARCH_SOURCE_CHANGED' }])
  expect(page.coverage.complete).toBe(false); reader.dispose(); await f.noControls()
})

it('cancels only the original source reader and rejects its late result', async () => {
  const f = await fixture(), controller = new AbortController(), original = f.owner.history
  let release!: () => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  f.owner.history = async (input, context) => { entered(); await new Promise<void>(resolve => { release = resolve }); const { signal: _signal, ...remaining } = context; return await original(input, remaining) }
  const pending = f.reader.read(f.input, { signal: controller.signal })
  await ready; controller.abort(new Error('Only this reader closed')); release()
  await expect(pending).rejects.toThrow('Only this reader closed')
  await f.noControls()
})

it('retains exact route/source Hosts per Session and rejects forged result scope or false complete coverage', async () => {
  const f = await fixture(), stored = (await f.store.readMetadata(f.session.agentSessionId))!
  await f.store.compareAndSwap(stored, { ...stored, hostId: 'original-execution-host' })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: stored.agentSessionId, item: assistant(f.captured(10, 'assistant needle')) })
  const page = await f.reader.read(f.input, {})
  expect(page.hits[0]).toMatchObject({ reference: { hostId: 'local', sourceHostId: 'original-execution-host', agentSessionId: stored.agentSessionId, source: 'captured' } })
  for (const mutate of [
    (copy: AgentMuxSearchPage) => { copy.scope.hostId = 'another-route' },
    (copy: AgentMuxSearchPage) => { copy.coverage.complete = true },
    (copy: AgentMuxSearchPage) => { copy.hits.push(copy.hits[0]!) },
    (copy: AgentMuxSearchPage) => { if (copy.hits[0]?.kind === 'history') copy.hits[0].reference.agentSessionId = 'another-session' }
  ]) { const forged = structuredClone(page); mutate(forged); expect(() => parseAgentMuxSearchPage(forged, f.input)).toThrow() }
  expect(() => parseAgentMuxSearchInput({ ...f.input, hostId: undefined })).toThrow()
  await f.noControls()
})

it('recovers a zero-hit metadata envelope at a legal minimum budget and rejects array enums', async () => {
  const f = await fixture(), input: AgentMuxSearchInput = { mode: 'metadata', query: 'x'.repeat(4096), maxBytes: 4096 }
  const read = vi.fn((value: AgentMuxSearchInput) => f.reader.read(value, {}))
  const page = await readAgentMuxSearch(input, read)
  expect(read).toHaveBeenCalledTimes(2); expect(page.hits).toEqual([]); expect(page.coverage.complete).toBe(true)
  expect(page.budgetBytes).toBeGreaterThan(4096)
  for (const forged of [{ mode: ['metadata'], query: '' }, { mode: 'history', query: '', source: ['native'] }]) expect(() => parseAgentMuxSearchInput(forged)).toThrow()
  await f.noControls()
})
