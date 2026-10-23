import { AgentMuxError, spatialCatalog, type AgentMuxSpatialStateStore, type AgentProviderId } from '@agentmux/core'
import type { AgentLearningTarget } from '@agentmux/core/agent-learning'
import { ScratchTopics, readMoteResourceConfiguration } from './mote-resources.js'
import { directoryIdentity, homeZoneId, SCRATCH_WORKSPACE_ID } from './mote-model.js'

/** Reads original config, spatial bindings and directories; no copied resource catalog or knowledge Store. */
export function createAgentLearningResources(options: {
  configurationPath: string; spatial: AgentMuxSpatialStateStore; topics?: ScratchTopics
}) {
  const topics = options.topics ?? new ScratchTopics()
  const invalid = (): never => { throw new AgentMuxError('The selected original Mote or Topic resource is unconfirmed. Refresh this exact target; existing files and Agents are kept.', 'LEARNING_TARGET_UNCONFIRMED') }
  async function read(target: AgentLearningTarget) {
    const [configuration, graph] = await Promise.all([readMoteResourceConfiguration(options.configurationPath, target.expectedResource), options.spatial.read()])
    const catalog = graph ? spatialCatalog(graph.graph) : null, workspace = configuration.workspace
    const spaces = catalog?.spaces.filter(space => space.spaceId === target.spaceId), zones = catalog?.zones.filter(zone => zone.zoneId === target.zoneId)
    const space = spaces?.length === 1 ? spaces[0] : null, zone = zones?.length === 1 ? zones[0] : null
    if (!workspace || workspace.id !== SCRATCH_WORKSPACE_ID || workspace.hostId !== 'local' ||
      workspace.hostId !== target.expectedResource.hostId || workspace.path !== target.expectedResource.workspacePath ||
      !zone || zone.kind !== 'home' || zone.hostId !== workspace.hostId ||
      zone.workspaceId !== workspace.id || !zone.directoryPath) return invalid()
    // A Topic is content in its original Zone, displayed in an existing Category Space.
    // Its content identity is not a second, direct Space. Motes retain their own Space.
    const origin = graph?.graph.resources['zone:' + zone.zoneId]
    const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
    const contentId = target.spaceId
    if (zone.zoneId !== homeZoneId(contentId) || (target.kind === 'mote'
      ? !space || space.kind !== 'mote' || space.topicId !== target.topicId || space.hostId !== workspace.hostId || !space.directoryPath ||
        !catalog?.bindings.some(binding => binding.spaceId === space.spaceId && binding.zoneId === zone.zoneId)
      : !record(origin) || origin.contentKind !== 'topic' || origin.topicId !== target.topicId || origin.workspaceId !== workspace.id || origin.spaceId !== contentId)) return invalid()
    const original = await topics.readForDirectory(workspace, zone.directoryPath)
    if (!original || original.id !== target.topicId || !original.identityDirectoryPath || !original.physicalDirectoryPath ||
      directoryIdentity(workspace.hostId, original.identityDirectoryPath) !== contentId ||
      !original.confirmedDirectoryPaths?.includes(zone.directoryPath) ||
      target.kind === 'mote' && !original.confirmedDirectoryPaths.includes(space!.directoryPath!)) return invalid()
    const snapshot = await topics.read(workspace, original.id)
    if (!snapshot || snapshot.kind !== target.kind || snapshot.identityDirectoryPath !== original.identityDirectoryPath || snapshot.physicalDirectoryPath !== original.physicalDirectoryPath) return invalid()
    return { workspace, original }
  }
  return async (target: AgentLearningTarget, input?: { providerId: AgentProviderId; sessionId: string }) => {
    const { workspace, original } = await read(target)
    if (!input) return { workspacePath: original.physicalDirectoryPath! }
    const prepared = await topics.prepareAgent(workspace, target.topicId, input)
    if (prepared.snapshot.id !== original.id || prepared.snapshot.kind !== target.kind ||
      prepared.snapshot.identityDirectoryPath !== original.identityDirectoryPath || prepared.absolutePath !== original.physicalDirectoryPath) return invalid()
    // Preparation can await file reads. Reconfirm the same resource before handing its context to Core.
    const current = await read(target)
    if (current.original.identityDirectoryPath !== original.identityDirectoryPath || current.original.physicalDirectoryPath !== original.physicalDirectoryPath) return invalid()
    return { workspacePath: prepared.absolutePath, agentMuxNote: prepared.prompt, optionalContext: prepared.optionalContext }
  }
}
