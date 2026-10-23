import { AgentMuxError, spatialCatalog, type AgentMuxSpatialStateStore } from '@agentmux/core'
import { MoteConnectionOperations, type ConnectionServices } from '@agentmux/connectors'
import { FileResourceOwner } from './file-resource.js'
import { OrdinaryWorkspaceFiles } from './ordinary-files.js'
import { MoteConnectionPreferences } from './mote-connection-preferences.js'
import { MoteConnectionTargetOwner } from './mote-connection-target.js'
import { ScratchTopics, readMoteResourceConfiguration } from './mote-resources.js'

/** The existing Mote workflow shares the Host's original graph, files and connection journal. */
export function createHostMoteConnections(options: {
  configurationPath: string
  spatial: AgentMuxSpatialStateStore
  connections: Pick<ConnectionServices, 'openDatabase' | 'connections'>
}) {
  const topics = new ScratchTopics()
  const catalog = async () => {
    const original = await options.spatial.read()
    return original ? spatialCatalog(original.graph) : null
  }
  const workspace = async (id: string) => {
    const original = (await readMoteResourceConfiguration(options.configurationPath, { workspaceId: id })).workspace
    if (original && original.hostId !== 'local') throw new AgentMuxError(
      'The original Mote files belong to another Host. Retain their exact resource and use that owning Host; no files or configuration were copied.',
      'MOTE_CONNECTION_SOURCE_UNCONFIRMED')
    return original ?? undefined
  }
  const topicForDirectory: ConstructorParameters<typeof MoteConnectionTargetOwner>[0]['topicForDirectory'] =
    (original, directory) => topics.readForDirectory(original, directory)
  // This ordinary owner is internal to MOTE.md preferences. Public Files retain
  // their original richer Note/history owner; no ordinary writer intercepts it.
  const files = new FileResourceOwner({ catalog, workspace, topicForDirectory, files: new OrdinaryWorkspaceFiles() })
  const preferences = new MoteConnectionPreferences({ files, catalog,
    connections: () => options.connections.connections.list() })
  const targets = new MoteConnectionTargetOwner({ catalog, workspace, topicForDirectory })
  const parent = new MoteConnectionOperations({ connections: options.connections, preferences,
    assertTarget: target => targets.assertTarget(target) })
  return { moteConnections: parent, motePreferences: preferences, close: () => parent.close() }
}
