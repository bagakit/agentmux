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
function launcherGraph(): AgentMuxSpatialGraph {
  const initial = graph()
  initial.regions[0] = { tabId: 'original-tab', regionId: 'original-region', kind: 'launcher', agentSessionId: null, runId: null, execution: null }
  initial.tabs.push({ tabId: 'untouched-tab', workspaceId: 'original-workspace', zoneId: null, name: 'Original name', regionIds: ['untouched-region'] })
  initial.regions.push({ tabId: 'untouched-tab', regionId: 'untouched-region', kind: 'agent', agentSessionId: 'untouched-session', runId: 'untouched-run', execution: { hostId: 'another-host', cwd: fixturePath('untouched-resource') } })
  initial.layouts.original = createWorkspaceLayout('original-group', ['original-tab', 'untouched-tab'])
  initial.tabLayouts['untouched-tab'] = { root: { type: 'leaf', regionId: 'untouched-region' }, activeRegionId: 'untouched-region' }
  initial.resources['region:untouched-region'] = { draft: 'Keep the other original input' }
  return initial
}
function attachment(): NonNullable<Parameters<AgentMuxSpatialStateStore['commitOwnedResource']>[0]['agentRegion']> {
  return { tabId: 'original-tab', regionId: 'original-region', agentSessionId: 'original-session', runId: 'original-run',
    execution: { hostId: 'original-host', cwd: fixturePath('owned-resource') }, resource: { phase: 'attached', source: 'Original producer receipt' } }
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
  it('atomically contributes only the exact existing Launcher attachment and owned value through the original graph SDK', async () => {
    const store = await fixture(), initial = await store.commit({ expectedRevision: 0, graph: launcherGraph() }), agentRegion = attachment()
    const receipt = await store.commitOwnedResource({ key, expectedRevision: initial.revision, value, agentRegion })
    const { resource, ...region } = agentRegion
    const expected = structuredClone(initial.graph)
    expected.regions[0] = { ...region, kind: 'agent' }
    expected.resources['region:' + region.regionId] = resource
    expected.resources[key] = value
    expect(receipt).toMatchObject({ key, diskDurability: 'confirmed', state: { revision: initial.revision + 1, graph: expected } })
    expect(receipt.state.graph).toEqual(expected)
    const reader = new AgentMuxRpcService({ spatialState: new AgentMuxSpatialStateStore(store.path), coreClients: () => [] })
    expect((await reader.call('space.state', {})).state).toEqual(receipt.state)
    expect(receipt.state.graph.resources['core:agent-open']).toBeUndefined()
    await expect(store.commitOwnedResource({ key, expectedRevision: initial.revision, value, agentRegion })).rejects.toMatchObject({ code: 'SPATIAL_STATE_CONFLICT' })
    expect(await store.read()).toEqual(receipt.state)
  })
  it('accepts only an unchanged Agent identity and execution location, including a pending original position', async () => {
    const store = await fixture(); await store.commit({ expectedRevision: 0, graph: graph() })
    const agentRegion = attachment(), first = await store.commitOwnedResource({ key, expectedRevision: 1, value, agentRegion })
    const replay = await store.commitOwnedResource({ key, expectedRevision: 2, value, agentRegion })
    expect(replay.diskDurability).toBe('confirmed')
    expect(replay.state.graph).toEqual(first.state.graph)
    const pendingStore = await fixture(), pending = graph(); pending.regions[0]!.execution = null; pending.regions[0]!.runId = null
    await pendingStore.commit({ expectedRevision: 0, graph: pending })
    const settled = await pendingStore.commitOwnedResource({ key, expectedRevision: 1, value, agentRegion })
    expect(settled.state.graph.regions[0]).toEqual({ tabId: agentRegion.tabId, regionId: agentRegion.regionId, kind: 'agent',
      agentSessionId: agentRegion.agentSessionId, runId: agentRegion.runId, execution: agentRegion.execution })
  })
  it('does not treat old Launcher execution metadata as the authority for an explicit producer-confirmed Workspace', async () => {
    const store = await fixture(), source = launcherGraph(), agentRegion = attachment()
    source.regions[0]!.execution = { hostId: 'previous-launcher-host', cwd: fixturePath('previous-launcher-directory') }
    const initial = await store.commit({ expectedRevision: 0, graph: source })
    const contribution = store.commitOwnedResource({ key, expectedRevision: initial.revision, value, agentRegion })
    await expect(contribution).resolves.toMatchObject({ diskDurability: 'confirmed', state: { revision: initial.revision + 1 } })
    const { resource, ...region } = agentRegion, expected = structuredClone(initial.graph)
    expected.regions[0] = { ...region, kind: 'agent' }
    expected.resources['region:' + region.regionId] = resource; expected.resources[key] = value
    expect((await contribution).state.graph).toEqual(expected)
    expect((await new AgentMuxSpatialStateStore(store.path).read())!.graph).toEqual(expected)
  })
  it('retains the newer Run and unsent input when an original same-Session creation receipt arrives late', async () => {
    const store = await fixture(), current = graph(); current.regions[0]!.runId = 'newer-run'
    const initial = await store.commit({ expectedRevision: 0, graph: current }); writes.calls.length = 0
    await expect(store.commitOwnedResource({ key, expectedRevision: initial.revision, value, agentRegion: attachment() })).rejects.toMatchObject({ code: 'SPATIAL_RESOURCE_TARGET_CONFLICT' })
    expect(await new AgentMuxSpatialStateStore(store.path).read()).toEqual(initial)
    expect(writes.calls).toEqual([])
  })
  it('refuses the wrong Tab membership, another occupant, Host or cwd without editing any original fact', async () => {
    const agentRegion = attachment()
    for (const mutate of [
      (g: AgentMuxSpatialGraph) => { g.tabs[0]!.regionIds = []; delete g.tabLayouts['original-tab'] },
      (g: AgentMuxSpatialGraph) => { g.regions[0]!.tabId = 'another-tab' },
      (g: AgentMuxSpatialGraph) => { g.regions[0]!.agentSessionId = 'another-session' },
      (g: AgentMuxSpatialGraph) => { g.regions[0]!.execution!.hostId = 'another-host' },
      (g: AgentMuxSpatialGraph) => { g.regions[0]!.execution!.cwd = fixturePath('another-directory') },
      (g: AgentMuxSpatialGraph) => { g.regions[0]!.kind = 'file'; g.regions[0]!.agentSessionId = null },
      (g: AgentMuxSpatialGraph) => { g.regions[0]!.kind = 'launcher' },
      (g: AgentMuxSpatialGraph) => { g.tabs = [] }
    ]) {
      const store = await fixture(), source = graph(); mutate(source)
      const initial = await store.commit({ expectedRevision: 0, graph: source }); writes.calls.length = 0
      await expect(store.commitOwnedResource({ key, expectedRevision: 1, value, agentRegion })).rejects.toMatchObject({ code: 'SPATIAL_RESOURCE_TARGET_CONFLICT' })
      expect(await store.read()).toEqual(initial)
      expect(writes.calls).toEqual([])
    }
    const store = await fixture(), initial = await store.commit({ expectedRevision: 0, graph: launcherGraph() })
    for (const [contribution, code] of [
      [{ ...agentRegion, regionId: 'missing-region' }, 'SPATIAL_RESOURCE_TARGET_CONFLICT'],
      [{ ...agentRegion, tabId: 'untouched-tab' }, 'SPATIAL_RESOURCE_TARGET_CONFLICT'],
      [{ ...agentRegion, agentSessionId: null }, 'SPATIAL_STATE_INVALID'],
      [{ ...agentRegion, runId: null }, 'SPATIAL_STATE_INVALID'],
      [{ ...agentRegion, execution: null }, 'SPATIAL_STATE_INVALID'],
      [{ ...agentRegion, resource: { invalid: undefined } }, 'SPATIAL_STATE_INVALID'],
      [null, 'SPATIAL_STATE_INVALID']
    ] as const) {
      await expect(store.commitOwnedResource({ key, expectedRevision: 1, value, agentRegion: contribution as never })).rejects.toMatchObject({
        code
      })
      expect(await store.read()).toEqual(initial)
    }
  })
  it('keeps Region and owned metadata together across replacement failures and a reopened producer confirmation', async () => {
    const store = await fixture(), initial = await store.commit({ expectedRevision: 0, graph: launcherGraph() }), agentRegion = attachment()
    writes.path = store.path; writes.phase = 'before-replace'
    await expect(store.commitOwnedResource({ key, expectedRevision: 1, value, agentRegion })).rejects.toMatchObject({ phase: 'before-replace' })
    expect(await new AgentMuxSpatialStateStore(store.path).read()).toEqual(initial)
    writes.phase = 'after-replace'; writes.calls.length = 0
    await expect(store.commitOwnedResource({ key, expectedRevision: 1, value, agentRegion })).rejects.toMatchObject({ phase: 'after-replace' })
    const reopened = new AgentMuxSpatialStateStore(store.path), observed = (await reopened.read())!
    const { resource, ...region } = agentRegion
    expect(observed.revision).toBe(2)
    expect(observed.graph.regions[0]).toEqual({ ...region, kind: 'agent' })
    expect(observed.graph.resources['region:' + region.regionId]).toEqual(resource)
    expect(observed.graph.resources[key]).toEqual(value)
    expect(JSON.parse(await readFile(store.path + '.previous', 'utf8'))).toEqual(initial)
    expect(writes.calls).toEqual([{ path: store.path + '.previous', directorySync: true }, { path: store.path, directorySync: true }])
    writes.phase = ''; writes.calls.length = 0
    const confirmed = await reopened.commitOwnedResource({ key, expectedRevision: observed.revision, value, agentRegion })
    expect(confirmed).toMatchObject({ diskDurability: 'confirmed', state: { revision: 3 } })
    expect(confirmed.state.graph).toEqual(observed.graph)
    expect(writes.calls).toEqual([{ path: store.path + '.previous', directorySync: true }, { path: store.path, directorySync: true }])
  })
})
