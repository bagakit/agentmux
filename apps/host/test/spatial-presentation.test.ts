import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spatialCatalog, nameTargetKey, AGENTMUX_DISPLAY_LABEL_RESOURCE, type AgentMuxSpatialGraph } from '../../../packages/core/src/spatial-graph.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { createHostSpatialPresentation } from '../src/spatial-presentation.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('the original scoped directory reads each selected Session once and no unrelated history', async () => {
  const f = await rpcOwnerFixture(['selected-agent', 'unrelated-agent', 'unplaced-agent']); cleanup.push(f.close)
  const configurationPath = join(f.root, 'config.json')
  await writeFile(configurationPath, JSON.stringify({ workspaces: [{ id: 'work', hostId: 'local', name: 'Original Workspace', path: f.root, kind: 'folder' }], executors: { codex: { providerId: 'codex', label: 'Original Codex' } }, appearance: {} }))
  const graph: AgentMuxSpatialGraph = { spaces: [{ spaceId: 'original-space', kind: 'folder', name: 'Original Workspace', hostId: 'local', directoryPath: f.root, projectId: 'original-project' }],
    zones: [{ zoneId: 'original-zone', workspaceId: 'work', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }], bindings: [{ zoneId: 'original-zone', spaceId: 'original-space' }],
    tabs: [{ tabId: 'selected-tab', workspaceId: 'work', zoneId: 'original-zone', name: 'Original Tab', regionIds: ['selected-region', 'selected-copy'] },
      { tabId: 'unrelated-tab', workspaceId: 'work', zoneId: 'original-zone', name: 'Other Tab', regionIds: ['unrelated-region'] }],
    regions: ['selected-region', 'selected-copy', 'unrelated-region'].map(regionId => ({ regionId, tabId: regionId.startsWith('selected') ? 'selected-tab' : 'unrelated-tab', kind: 'agent',
      agentSessionId: regionId.startsWith('selected') ? 'selected-agent' : 'unrelated-agent', runId: 'retained-run', execution: { hostId: 'local', cwd: f.root } })), layouts: {}, tabLayouts: {}, resources: {} }
  const read = vi.spyOn(f.client, 'sessionTimeline')
  const original = await createHostSpatialPresentation({ configurationPath, clients: f.coreClients })({ graph, catalog: spatialCatalog(graph, { tabId: 'selected-tab' }), target: { tabId: 'selected-tab' } }, {})
  expect(original.agentPresentation).toMatchObject([{ agentSessionId: 'selected-agent', name: 'Original Codex · Original Workspace', providerId: 'codex', presenceUnknown: false }])
  expect(read.mock.calls.map(call => call[0])).toEqual(['selected-agent'])
  read.mockClear()
  const complete = await createHostSpatialPresentation({ configurationPath, clients: f.coreClients })({ graph, catalog: spatialCatalog(graph), target: {} }, {})
  expect(complete.agentPresentation?.map(row => row.agentSessionId).sort()).toEqual(['selected-agent', 'unplaced-agent', 'unrelated-agent'])
  expect(read.mock.calls.map(call => call[0]).sort()).toEqual(['selected-agent', 'unplaced-agent', 'unrelated-agent'])
  const remoteGraph = { ...graph, regions: graph.regions.map(region => ({ ...region, execution: { hostId: 'unavailable-remote', cwd: f.root } })) }
  read.mockClear()
  const remote = await createHostSpatialPresentation({ configurationPath, clients: f.coreClients })({ graph: remoteGraph, catalog: spatialCatalog(remoteGraph, { tabId: 'selected-tab' }), target: { tabId: 'selected-tab' } }, {})
  expect(remote.agentPresentation).toMatchObject([{ agentSessionId: 'selected-agent', providerId: '', presenceUnknown: true }])
  expect(read).not.toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('a foreign locator keeps the unique Source project name and manual name without changing its real cwd', async () => {
  const f = await rpcOwnerFixture(['foreign-agent']); cleanup.push(f.close)
  const configurationPath = join(f.root, 'config.json'), leaf = 'a'.repeat(64), locator = '/remote/state/agent-workspaces/' + leaf
  await writeFile(configurationPath, JSON.stringify({ workspaces: [{ id: 'source-workspace', hostId: 'local', name: 'Configured Source resource', path: '/b/source', kind: 'folder' }], executors: { codex: { providerId: 'codex', label: 'Original Codex' } }, appearance: {} }))
  const readSession = f.client.readAgentSession.bind(f.client), statusAgent = f.client.statusAgent.bind(f.client)
  vi.spyOn(f.client, 'readAgentSession').mockImplementation(async agentSessionId => {
    const session = await readSession(agentSessionId)
    return session ? { ...session, workspacePath: locator } : session
  })
  vi.spyOn(f.client, 'statusAgent').mockImplementation(async agentSessionId => {
    const status = await statusAgent(agentSessionId)
    return { ...status, session: { ...status.session, workspacePath: locator } }
  })
  const graph: AgentMuxSpatialGraph = {
    spaces: [{ spaceId: 'source-topic', kind: 'topic', name: 'Original Source Project', hostId: 'local', directoryPath: '/b/source-topic', projectId: null, topicId: 'source-topic' }],
    zones: [{ zoneId: 'source-zone', workspaceId: 'source-workspace', kind: 'home', hostId: 'local', directoryPath: '/b/source-topic', branch: null }],
    bindings: [{ zoneId: 'source-zone', spaceId: 'source-topic' }],
    tabs: [{ tabId: 'source-tab', workspaceId: 'source-workspace', zoneId: 'source-zone', name: 'Source Tab', regionIds: ['foreign-region'] }],
    regions: [{ regionId: 'foreign-region', tabId: 'source-tab', kind: 'agent', agentSessionId: 'foreign-agent', runId: 'run-foreign-agent', execution: { hostId: 'D-in-B', runtimeId: 'runtime-d', cwd: locator } }],
    layouts: {}, tabLayouts: {}, resources: { 'zone:source-zone': { spaceId: 'source-topic', workspaceId: 'source-workspace', topicId: 'source-topic', contentKind: 'topic' } }
  }
  const present = () => createHostSpatialPresentation({ configurationPath, clients: () => [{ hostId: 'D-in-B', client: f.client }] as never })({ graph, catalog: spatialCatalog(graph), target: {} }, {})
  const original = await present()
  expect(original.agentPresentation).toMatchObject([{ agentSessionId: 'foreign-agent', name: 'Original Codex · Original Source Project', project: 'Original Source Project', projectGroup: { name: 'Original Source Project' } }])
  expect(original.agentPresentation?.[0]?.name).not.toContain(leaf)
  expect(graph.regions[0]!.execution).toMatchObject({ cwd: locator })
  const target = { kind: 'agent-session', id: 'foreign-agent' } as const
  graph.resources[AGENTMUX_DISPLAY_LABEL_RESOURCE] = { schemaVersion: 1, history: 'complete', records: [], labels: {
    [nameTargetKey(target)]: { target, value: 'Manually named Source Agent', source: 'manual', nameRevision: 1, operationId: 'manual-source-name' }
  } }
  const renamed = await present()
  expect(renamed.agentPresentation).toMatchObject([{ agentSessionId: 'foreign-agent', name: 'Manually named Source Agent', project: 'Original Source Project', projectGroup: { name: 'Original Source Project' } }])
  expect(graph.regions[0]!.execution).toMatchObject({ cwd: locator })
})
