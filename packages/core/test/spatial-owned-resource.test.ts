import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore, type AgentMuxSpatialGraph } from '../src/spatial-state.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { createWorkspaceLayout } from '../src/spatial-layout.js'
import { fixturePath } from './helpers/fixture-values.js'

const writes = vi.hoisted(() => ({ path: '', phase: '' as '' | 'before-replace' | 'after-replace', calls: [] as { path: string; directorySync: boolean }[] }))
vi.mock('../src/durable-write.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/durable-write.js')>()
  return { ...actual, durableWriteFile: async (...args: Parameters<typeof actual.durableWriteFile>) => {
    const [path, , options] = args
    writes.calls.push({ path, directorySync: options?.requireDirectorySync === true })
    if (path === writes.path && writes.phase === 'before-replace') throw new actual.DurableWriteError(path, writes.phase, new Error('Original write did not replace'))
    await actual.durableWriteFile(...args)
    if (path === writes.path && writes.phase === 'after-replace') throw new actual.DurableWriteError(path, writes.phase, new Error('Original directory ACK unavailable'))
  } }
})
const directories: string[] = []
beforeEach(() => { writes.path = ''; writes.phase = ''; writes.calls.length = 0 })
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const key = 'owned:original-resource', value = { tabId: 'original-tab', regionId: 'original-region', sessionId: 'original-session', hostId: 'original-host' }
function graph(): AgentMuxSpatialGraph {
  return { spaces: [], zones: [], bindings: [],
    tabs: [{ tabId: 'original-tab', workspaceId: 'original-workspace', zoneId: null, name: null, regionIds: ['original-region'] }],
    regions: [{ tabId: 'original-tab', regionId: 'original-region', kind: 'agent', agentSessionId: 'original-session', runId: 'original-run', execution: { hostId: 'original-host', cwd: fixturePath('owned-resource') } }],
    layouts: { original: createWorkspaceLayout('original-group', ['original-tab']) },
    tabLayouts: { 'original-tab': { root: { type: 'leaf', regionId: 'original-region' }, activeRegionId: 'original-region' } },
    resources: { 'region:original-region': { phase: 'attached', draft: 'Unsent original input' } } }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-owned-resource-')); directories.push(directory)
  return new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
}
describe('Core original owned spatial resource SDK', () => {
  it('requires an existing graph and rejects bootstrap forgery without creating another owner', async () => {
    const store = await fixture()
    await expect(store.commitOwnedResource({ key, expectedRevision: 0, value })).rejects.toMatchObject({ code: 'SPATIAL_STATE_ABSENT' })
    await expect(store.commit({ expectedRevision: 0, graph: { ...graph(), resources: { [key]: value } } })).rejects.toMatchObject({ code: 'SPATIAL_RESOURCE_AUTHORITY_CONFLICT' })
    expect(await store.read()).toBeNull()
  })
  it('writes only the exact metadata through the original durable graph and checks the original revision', async () => {
    const store = await fixture(), initial = await store.commit({ expectedRevision: 0, graph: graph() })
    const receipt = await store.commitOwnedResource({ key, expectedRevision: initial.revision, value })
    expect(receipt).toMatchObject({ key, diskDurability: 'confirmed', state: { revision: 2 } })
    expect(receipt.state.graph).toEqual({ ...initial.graph, resources: { ...initial.graph.resources, [key]: value } })
    expect(await new AgentMuxSpatialStateStore(store.path).read()).toEqual(receipt.state)
    await expect(store.commitOwnedResource({ key, expectedRevision: initial.revision, value: { hostId: 'another-host' } })).rejects.toMatchObject({ code: 'SPATIAL_STATE_CONFLICT' })
    expect(await store.read()).toEqual(receipt.state)
    for (const invalidKey of ['not-owned', 'owned:', 'owned:original\0resource'])
      await expect(store.commitOwnedResource({ key: invalidKey, expectedRevision: 2, value })).rejects.toMatchObject({ code: 'SPATIAL_STATE_INVALID' })
    await expect(store.commitOwnedResource({ key, expectedRevision: 2, value: { invalid: undefined } as never })).rejects.toMatchObject({ code: 'SPATIAL_STATE_INVALID' })
    expect(await store.read()).toEqual(receipt.state)
  })
  it('serializes competing SDK contributions on the same original revision', async () => {
    const store = await fixture(); await store.commit({ expectedRevision: 0, graph: graph() })
    const results = await Promise.allSettled([store, new AgentMuxSpatialStateStore(store.path)].map((owner, index) =>
      owner.commitOwnedResource({ key: key + ':' + index, expectedRevision: 1, value })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'SPATIAL_STATE_CONFLICT' } })
    const stored = (await store.read())!
    expect(stored.revision).toBe(2)
    expect(Object.keys(stored.graph.resources).filter(key => key.startsWith('owned:'))).toHaveLength(1)
    expect(stored.graph.regions).toEqual(graph().regions)
  })
  it('preserves omitted owned values and refuses replacement or new authority through the actual public graph SDK', async () => {
    const store = await fixture(); await store.commit({ expectedRevision: 0, graph: graph() })
    await store.commitOwnedResource({ key, expectedRevision: 1, value })
    const service = new AgentMuxRpcService({ spatialState: store, coreClients: () => [] })
    const layout = graph(); layout.resources['region:original-region'] = { phase: 'attached', draft: 'Later unsent input' }
    const saved = await service.call('space.commit', { expectedRevision: 2, graph: layout })
    expect(saved.state.graph.resources[key]).toEqual(value)
    expect(saved.state.graph.resources['region:original-region']).toEqual(layout.resources['region:original-region'])
    const echoed = structuredClone(saved.state.graph)
    echoed.resources[key] = { hostId: value.hostId, sessionId: value.sessionId, regionId: value.regionId, tabId: value.tabId }
    const equal = await service.call('space.commit', { expectedRevision: 3, graph: echoed })
    for (const resources of [{ ...equal.state.graph.resources, [key]: { ...value, sessionId: 'replacement-session' } },
      { ...equal.state.graph.resources, 'owned:forged-resource': null }]) {
      await expect(service.call('space.commit', { expectedRevision: 4, graph: { ...equal.state.graph, resources } })).rejects.toMatchObject({ code: 'SPATIAL_RESOURCE_AUTHORITY_CONFLICT' })
      expect((await service.call('space.state', {})).state).toEqual(equal.state)
    }
    expect((await store.read())!.graph.regions).toEqual(graph().regions)
  })
  it('does not acknowledge a pre-replace failure and permits the same exact revision to retry', async () => {
    const store = await fixture(), initial = await store.commit({ expectedRevision: 0, graph: graph() })
    writes.path = store.path; writes.phase = 'before-replace'
    await expect(store.commitOwnedResource({ key, expectedRevision: 1, value })).rejects.toMatchObject({ path: store.path, phase: 'before-replace' })
    expect(await store.read()).toEqual(initial)
    writes.phase = ''
    expect(await store.commitOwnedResource({ key, expectedRevision: 1, value })).toMatchObject({ diskDurability: 'confirmed', state: { revision: 2 } })
  })
  it('requires a new producer durable ACK for an equal value, including after a lost directory ACK and reopen', async () => {
    const store = await fixture(); await store.commit({ expectedRevision: 0, graph: graph() })
    const first = await store.commitOwnedResource({ key, expectedRevision: 1, value })
    writes.path = store.path; writes.phase = 'after-replace'; writes.calls.length = 0
    await expect(store.commitOwnedResource({ key, expectedRevision: first.state.revision, value })).rejects.toMatchObject({ path: store.path, phase: 'after-replace' })
    const observed = await new AgentMuxSpatialStateStore(store.path).read()
    expect(observed!.revision).toBe(first.state.revision + 1)
    expect(observed!.graph.resources[key]).toEqual(value)
    expect(writes.calls).toEqual([{ path: store.path + '.previous', directorySync: true }, { path: store.path, directorySync: true }])
    writes.phase = ''; writes.calls.length = 0
    const confirmed = await new AgentMuxSpatialStateStore(store.path).commitOwnedResource({ key, expectedRevision: observed!.revision, value })
    expect(confirmed).toMatchObject({ key, diskDurability: 'confirmed', state: { revision: observed!.revision + 1 } })
    expect(writes.calls).toEqual([{ path: store.path + '.previous', directorySync: true }, { path: store.path, directorySync: true }])
    expect(JSON.parse(await readFile(store.path, 'utf8'))).toEqual(confirmed.state)
    expect(confirmed.state.graph).toEqual(first.state.graph)
  })
})
