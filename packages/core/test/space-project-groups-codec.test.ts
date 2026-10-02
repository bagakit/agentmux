import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRpcControlResult } from '../src/rpc-business-codec.js'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES } from '../src/control.js'
import { parseAgentMuxSpatialGraph, spatialCatalog as coreCatalog } from '../src/spatial-graph.js'
import type { AgentMuxSpaceCatalog, AgentMuxProjectGroupFact } from '../src/space-control.js'
import { spatialCatalog as desktopCatalog, type SpatialWorkbench } from '../../../apps/desktop/src/renderer/src/lib/space-agent-control'
import { createWorkbenchTab } from '../../../apps/desktop/src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '../src/spatial-layout.js'
import { directoryIdentity } from '../../../apps/desktop/src/shared/space-addresses'
import type { AppConfig } from '../../../apps/desktop/src/shared/contracts'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const groups: AgentMuxProjectGroupFact[] = [{ groupId: 'original-project-group', name: 'Original projects',
  projectIds: [directoryIdentity('host-a', fixturePath("original/a")), directoryIdentity('host-b', fixturePath("original/b"))] },
  { groupId: 'review-purpose-group', name: 'Review purpose', projectIds: [directoryIdentity('host-a', fixturePath("original/a")), directoryIdentity('host-b', fixturePath("original/b"))] }]
function fixture(projectGroups?: AgentMuxProjectGroupFact[]): SpatialWorkbench {
  const config: AppConfig = { version: 9, hosts: [{ id: 'host-a', label: 'First', kind: 'ssh', hostname: 'first.invalid' }, { id: 'host-b', label: 'Second', kind: 'ssh', hostname: 'second.invalid' }], executors: {},
    workspaces: [{ id: 'a', name: 'First', hostId: 'host-a', path: fixturePath("original/a"), kind: 'folder' }, { id: 'b', name: 'Second', hostId: 'host-b', path: fixturePath("original/b"), kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'launcher', workspaceId: 'a' })
  return { config, ...(projectGroups === undefined ? {} : { projectGroups }), sessions: [], tabs: { [tab.id]: tab },
    layouts: { a: createWorkspaceLayout('original-display-group', [tab.id]) }, spaceZoneBindings: {}, spatialRequests: {} }
}
function graph(state: SpatialWorkbench) {
  const { locations: _locations, ...facts } = desktopCatalog(state, [])
  return parseAgentMuxSpatialGraph({ ...facts, layouts: state.layouts, tabLayouts: Object.fromEntries(Object.values(state.tabs).map(tab => [tab.id, tab.layout])), resources: {} })
}
function read(catalog: AgentMuxSpaceCatalog, operation: 'space.ls' | 'space.inspect' | 'space.bind' | 'space.unbind' = 'space.ls') {
  const body = operation === 'space.bind' || operation === 'space.unbind' ? { catalog, operationId: 'original-binding', outcome: 'unchanged',
    binding: { kind: 'zone-space', zoneId: catalog.zones[0]!.zoneId, spaceId: catalog.spaces[0]!.spaceId },
    save: { layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'confirmed', reason: null }, issues: [] } : { catalog }
  return parseRpcControlResult(operation, body).catalog as AgentMuxSpaceCatalog
}

describe('existing project groups use the original public spatial catalog codec', () => {
  it.each([{ projectGroups: [] }, { projectGroups: groups }])('preserves actual Desktop and Core producer facts including empty groups (%j)', ({ projectGroups }) => {
    const state = fixture(projectGroups), desktop = desktopCatalog(state, []), core = coreCatalog(graph(state))
    expect(desktop.regions).toHaveLength(1); expect(core.regions).toEqual(desktop.regions)
    for (const catalog of [desktop, core]) for (const operation of ['space.ls', 'space.inspect', 'space.bind', 'space.unbind'] as const) {
      expect(() => read(catalog, operation)).not.toThrow()
      expect(read(catalog, operation).projectGroups).toEqual(projectGroups)
      expect(Object.hasOwn(read(catalog, operation), 'projectGroups')).toBe(true)
      expect(read(catalog, operation).regions).toEqual(catalog.regions)
    }
  })
  it('preserves overlapping project groups through actual Desktop and Core public catalogs', () => {
    const state = fixture(groups)
    for (const catalog of [desktopCatalog(state, []), coreCatalog(graph(state))]) {
      for (const operation of ['space.ls', 'space.inspect', 'space.bind', 'space.unbind'] as const) {
        expect(() => read(catalog, operation)).not.toThrow()
        expect(read(catalog, operation).projectGroups).toEqual(groups)
      }
    }
  })
  it('keeps absent optional facts distinct and preserves exact unknown Project references', () => {
    const absent = read(desktopCatalog(fixture(), [])); expect(Object.hasOwn(absent, 'projectGroups')).toBe(false)
    const retained = [{ ...groups[0]!, projectIds: ['unknown-project-a', 'unknown-project-b'] }]
    expect(read(desktopCatalog(fixture(retained), [])).projectGroups).toEqual(retained)
  })
  it.each([
    [{ ...groups[0]!, extra: true }], [{ ...groups[0]!, groupId: 'self' }], [{ ...groups[0]!, name: ' ' }],
    [{ ...groups[0]!, projectIds: ['only-one'] }], [{ ...groups[0]!, projectIds: ['repeat', 'repeat'] }],
    [groups[0]!, { ...groups[0]! }],
    [{ ...groups[0]!, projectIds: ['valid', 'bad\nproject'] }]
  ].map(projectGroups => ({ projectGroups })))('rejects malformed or duplicate record identities without pruning facts (%j)', ({ projectGroups }) => {
    const catalog = desktopCatalog(fixture(groups), []), original = structuredClone(catalog)
    expect(() => read({ ...catalog, projectGroups } as AgentMuxSpaceCatalog)).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    expect(catalog).toEqual(original)
  })
  it('bounds arrays and exact IDs under the existing message budget', () => {
    const catalog = desktopCatalog(fixture(groups), [])
    for (const projectGroups of [Array.from({ length: 4097 }, (_, index) => ({ groupId: 'g' + index, name: 'n', projectIds: ['a' + index, 'b' + index] })),
      [{ ...groups[0]!, projectIds: Array.from({ length: 4097 }, (_, index) => 'p' + index) }], [{ ...groups[0]!, groupId: 'x'.repeat(513) }],
      [{ ...groups[0]!, projectIds: ['x'.repeat(16385), 'valid'] }], [{ ...groups[0]!, name: 'x'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES + 1) }]]) {
      expect(() => read({ ...catalog, projectGroups })).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    }
  })
})

const directories: string[] = [], servers: { stop(): Promise<void> }[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
it('compiled public CLI reads the original populated Core spatial document with zero lifecycle clients', async () => {
  const { AgentMuxSpatialStateStore } = await import('../dist/spatial-state.js'), { AgentMuxControlServer } = await import('../dist/public-rpc-server.js')
  const root = await mkdtemp(join(tmpdir(), 'amx-project-groups-')); directories.push(root)
  const store = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const saved = await store.commit({ expectedRevision: 0, graph: graph(fixture(groups)) }), before = await readFile(store.path)
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], spatialState: store }); servers.push(server); await server.start()
  const actual = []
  for (const command of [['space', 'ls'], ['space', 'inspect', '--region', 'original-region']]) {
    const reply = await runCompiledObjectCli(command, objectCliEnvironment(root)); expect(reply.code, reply.stderr).toBe(0); expect(reply.stderr).toBe('')
    const result = JSON.parse(reply.stdout); expect(result.result.catalog.projectGroups).toEqual(groups); expect(result.result.catalog.regions).toContainEqual(expect.objectContaining({ regionId: 'original-region' }))
    actual.push({ command, code: reply.code, result })
  }
  expect(await readFile(store.path)).toEqual(before); expect((await store.read())!.revision).toBe(saved.revision)
  if (process.env.AGENTMUX_PROJECT_GROUPS_COMPILED_RECEIPT) await writeFile(process.env.AGENTMUX_PROJECT_GROUPS_COMPILED_RECEIPT, JSON.stringify({ actual, groups, originalRevision: saved.revision, originalDocumentUnchanged: true, coreClientCount: 0, userRuntimeTouched: false }, null, 2) + '\n')
})
