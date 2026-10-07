import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore, AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { createAgentMuxSearchObservationOwner } from '../src/search-observation.js'
import { createAgentMuxSearchReader } from '../src/search-reader.js'
import { createHistoryQueryFixture, createHostedHistoryFixture } from './helpers/session-history-query.js'
import type { AgentSessionHistoryDescriptor } from '../src/types.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it('reads an exact original source through the SDK without loading unrelated catalogues', async () => {
  const f = await createHistoryQueryFixture(cleanups)
  const { nativeHandle: _native, ...unrelated } = f.session
  await f.store.compareAndSwap(null, { ...unrelated, agentSessionId: 'unrelated-session', run: { runId: 'unrelated-run' } })
  const global = await f.client.sessionHistorySources()
  expect(global.map(source => source.agentSessionId)).toEqual([f.session.agentSessionId, 'unrelated-session'])
  const directory = [vi.spyOn(f.store, 'loadMetadata'), vi.spyOn(f.store, 'loadRetiredAgentSessions'), vi.spyOn(f.store, 'loadReopenCorrelations')]
  for (const read of directory) read.mockRejectedValue(new Error('Unrelated directory must not gate an exact source'))
  const exact = vi.spyOn(f.store, 'readHistorySource')
  const selected = await f.client.sessionHistorySources({ agentSessionId: f.session.agentSessionId }).then(values => ({ values }), error => ({ error }))
  expect(selected).toEqual({ values: [global[0]] })
  expect(await f.client.sessionHistorySources({ agentSessionId: 'missing-source' })).toEqual([])
  expect(exact.mock.calls.map(call => call[0])).toEqual([f.session.agentSessionId, 'missing-source'])
  expect(directory.map(read => read.mock.calls.length)).toEqual([0, 0, 0])
  await f.noControls()
})

it('keeps exact original sources through the Unix Hosted SDK without reading another catalogue', async () => {
  const f = await createHostedHistoryFixture()
  cleanups.push(() => f.dispose())
  const expected = await f.ownerClient.sessionHistorySources({ agentSessionId: f.session.agentSessionId })
  const directory = [vi.spyOn(f.store, 'loadMetadata'), vi.spyOn(f.store, 'loadRetiredAgentSessions'), vi.spyOn(f.store, 'loadReopenCorrelations')]
  for (const read of directory) read.mockRejectedValue(new Error('Hosted exact source cannot load unrelated catalogues'))
  await expect(f.client.sessionHistorySources({ agentSessionId: f.session.agentSessionId })).resolves.toEqual(expected)
  expect(directory.map(read => read.mock.calls.length)).toEqual([0, 0, 0]); await f.noControls()
})

it('ends the original SDK source consumer promptly and passes cancellation to its exact Store read', async () => {
  const store = new AgentMuxMemoryAgentSessionStore(), client = new AgentMuxClient({ store })
  cleanups.push(() => client.dispose())
  let entered!: () => void, release!: () => void, received: AbortSignal | undefined
  const ready = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<AgentSessionHistoryDescriptor | null>(resolve => { release = () => resolve(null) })
  const exact = vi.spyOn(store, 'readHistorySource').mockImplementation((_id, signal) => { received = signal; entered(); return blocked })
  const controller = new AbortController(), reason = new Error('Only this source consumer closed')
  const pending = client.sessionHistorySources({ agentSessionId: 'exact-session', signal: controller.signal })
  let settled = false
  const observed = pending.then(value => { settled = true; return { value } }, error => { settled = true; return { error } })
  try {
    await ready; expect(received).toBe(controller.signal); controller.abort(reason)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(settled).toBe(true); expect(await observed).toEqual({ error: reason }); expect(exact).toHaveBeenCalledOnce()
  } finally { release(); await observed }
})

it('cancels an exact FileStore read waiting on its write turn without starting a late database read', async () => {
  const f = await createHistoryQueryFixture(cleanups), reader = new AgentMuxFileAgentSessionStore(f.storePath)
  let release!: () => void
  const internal = reader as unknown as { tail: Promise<void>; withReadDatabase(...args: unknown[]): Promise<unknown> }
  internal.tail = new Promise<void>(resolve => { release = resolve })
  const database = vi.spyOn(internal, 'withReadDatabase'), controller = new AbortController(), reason = new Error('Original reader closed before its turn')
  const pending = reader.readHistorySource(f.session.agentSessionId, controller.signal), rejected = expect(pending).rejects.toBe(reason)
  controller.abort(reason); await rejected; release(); await new Promise<void>(resolve => setImmediate(resolve))
  expect(database).not.toHaveBeenCalled(); await f.noControls()
})

it('cancels source discovery during a shared Host opening and starts no late source read', async () => {
  const f = await createHistoryQueryFixture(cleanups), sources = vi.spyOn(f.client, 'sessionHistorySources')
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<[{ hostId: string; client: AgentMuxClient }]>(resolve => { release = () => resolve([{ hostId: 'local', client: f.client }]) })
  const owner = createAgentMuxSearchObservationOwner({ clients: () => { entered(); return blocked },
    catalog: async () => ({ spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }), snapshot: async () => ({}), projects: async () => [],
    history: (input, context) => f.client.readAgentSessionHistory(input, context) })
  const reader = createAgentMuxSearchReader(owner), controller = new AbortController(), reason = new Error('This search opening closed')
  const pending = reader.read({ mode: 'history', query: 'needle', hostId: 'local', agentSessionId: f.session.agentSessionId }, { signal: controller.signal })
  const rejected = expect(pending).rejects.toBe(reason)
  try { await ready; controller.abort(reason); await rejected; release(); await new Promise<void>(resolve => setImmediate(resolve)); expect(sources).not.toHaveBeenCalled(); await f.noControls() }
  finally { release(); reader.dispose() }
})

it('ends metadata consumption while another original read port remains pending', async () => {
  const f = await createHistoryQueryFixture(cleanups)
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const catalog = { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] }
  const blocked = new Promise<typeof catalog>(resolve => { release = () => resolve(catalog) })
  const owner = createAgentMuxSearchObservationOwner({ clients: async () => [{ hostId: 'local', client: f.client }],
    catalog: () => { entered(); return blocked }, snapshot: async () => ({}), projects: async () => [],
    history: (input, context) => f.client.readAgentSessionHistory(input, context) })
  const reader = createAgentMuxSearchReader(owner), controller = new AbortController(), reason = new Error('Only this metadata consumer closed')
  const pending = reader.read({ mode: 'metadata', query: 'original' }, { signal: controller.signal }), rejected = expect(pending).rejects.toBe(reason)
  try { await ready; controller.abort(reason); await rejected; await f.noControls() }
  finally { release(); reader.dispose() }
})
