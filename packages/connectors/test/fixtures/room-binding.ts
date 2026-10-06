import { join } from 'node:path'
import { historyReaderFixture, core } from '../../../core/test/fixtures/session-history-reader.js'
import { AgentMuxSpatialStateStore } from '../../../core/src/spatial-state.js'
import { createWorkspaceLayout } from '../../../core/src/spatial-layout.js'
import type { AgentMuxSpatialGraph } from '../../../core/src/spatial-graph.js'
import type { ConnectionConfig, RoomBindingBindInput } from '../../../core/src/connections.js'
import { ConnectionHost } from '../../src/connection-host.js'
import { RoomBindingHost } from '../../src/room-binding.js'

export const config: ConnectionConfig = { connectionId: 'sample-connection', adapterId: 'sample', application: { domain: 'chat.example', appId: 'original-app' }, label: 'Team', enabled: true, credentialRef: 'host-credential' }
export const context = { actor: { kind: 'user' as const, id: 'fixture-user' } }
export async function roomBindingFixture(native = true) {
  const original = await historyReaderFixture(native, true)
  const spatial = new AgentMuxSpatialStateStore(join(original.root, 'spatial.json'))
  const graph: AgentMuxSpatialGraph = {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: original.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: original.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['original-region', 'other-region'] }],
    regions: ['original-region', 'other-region'].map(regionId => ({ regionId, tabId: 'tab', kind: 'agent', agentSessionId: original.session.agentSessionId, runId: null, execution: { hostId: 'local', cwd: original.root } })),
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'leaf', regionId: 'original-region' }, second: { type: 'leaf', regionId: 'other-region' } }, activeRegionId: 'original-region' } }, resources: {}
  }
  await spatial.commit({ expectedRevision: 0, graph })
  const connections = new ConnectionHost({ databasePath: join(original.root, 'connections.sqlite'), secrets: { resolve: async () => 'private-fixture-credential' }, adapters: [{ adapterId: 'sample', test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }) }] })
  await connections.configure({ operationId: 'configure', expectedRevision: null, connection: config })
  const checkpoint = async (ref: { hostId: string; agentSessionId: string }) => {
    if (ref.hostId !== 'local') throw new Error('Exact Host required')
    return { ...ref, checkpoint: await original.client.conversationCheckpoint(ref.agentSessionId) }
  }
  const bindings = new RoomBindingHost({ connections, spatial, checkpoint }); connections.bindings = bindings
  const input: RoomBindingBindInput = { operationId: 'bind-original', bindingId: 'original-binding', connectionId: config.connectionId, expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: original.session.agentSessionId, regionAnchor: { regionId: 'original-region' }, externalConversationId: 'original-group', scope: { input: 'mentions-and-replies', publication: 'future-native-user-facing' }, expectedSource: { providerId: 'claude', nativeSessionId: 'original-native' } }
  return { ...original, graph, spatial, connections, bindings, checkpoint, input,
    async change(change: (graph: AgentMuxSpatialGraph) => void) { const state = (await spatial.read())!; change(state.graph); return await spatial.commit({ expectedRevision: state.revision, graph: state.graph }) },
    async close() { connections.close(); await original.close() }
  }
}
export { core }
