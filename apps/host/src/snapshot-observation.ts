import { spatialCatalog, type AgentMuxSpatialStateStore, type AgentMuxRpcServiceOptions, type AgentMuxRpcSnapshot, type AgentMuxRpcTopic } from '@agentmux/core'
import { readPresentationConfiguration } from './presentation-configuration.js'
import { directoryIdentity } from './mote-model.js'
import { ScratchTopics } from './mote-resources.js'
import { SCRATCH_WORKSPACE_ID, scratchTopicPhysicalPath } from './mote-topic-model.js'
/** Original configuration/filesystem observation; no Topic ensure and no second metadata store. */
export function createHostSnapshotObservation(configurationPath: string | undefined, spatial: AgentMuxSpatialStateStore): NonNullable<AgentMuxRpcServiceOptions['snapshot']> {
  const topics = new ScratchTopics()
  return async params => {
    const wanted = (source: 'workspaces' | 'topics' | 'motes') => !params.include || params.include.includes(source)
    const result: Partial<AgentMuxRpcSnapshot> = { unavailable: [] }
    if (!wanted('workspaces') && !wanted('topics') && !wanted('motes')) return result
    if (!configurationPath) throw new Error('The original configuration metadata is unavailable. Original spatial positions and Agent input remain available.')
    const configuration = await readPresentationConfiguration(configurationPath)
    if (wanted('workspaces')) result.workspaces = configuration.workspaces.filter(workspace => (!params.workspaceId || params.workspaceId === workspace.id)
      && (!params.projectId || workspace.id !== SCRATCH_WORKSPACE_ID && directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path) === params.projectId)).map(workspace => ({
      workspaceId: workspace.id, hostId: workspace.hostId, name: workspace.name, path: workspace.path, kind: workspace.kind ?? 'folder', repoPath: workspace.repoPath ?? null, branch: workspace.branch ?? null,
      projectId: workspace.id === SCRATCH_WORKSPACE_ID ? null : directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path) }))
    if (!wanted('topics') && !wanted('motes')) return result
    const workspace = configuration.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
    if (!workspace) {
      for (const source of ['topics', 'motes'] as const) if (wanted(source)) result.unavailable!.push({ source, code: 'TOPIC_WORKSPACE_UNAVAILABLE',
        message: 'The original Topics Workspace is unconfirmed. Existing spatial references remain available.', recovery: 'Restore the original Workspace metadata and read this source again.' })
      return result
    }
    if (params.projectId || params.workspaceId && params.workspaceId !== workspace.id) {
      if (wanted('topics')) result.topics = []
      if (wanted('motes')) result.motes = []
      return result
    }
    const state = await spatial.readForLayout(), catalog = state ? spatialCatalog(state.graph) : null
    const snapshots = params.topicId ? [await topics.read(workspace, params.topicId)].filter(value => value !== null) : await topics.list(workspace)
    const values: AgentMuxRpcTopic[] = snapshots.map(topic => ({ id: topic.id, topicId: topic.id, workspaceId: workspace.id, hostId: workspace.hostId,
      path: scratchTopicPhysicalPath(workspace, topic), directoryPath: topic.directoryPath, topicPath: topic.topicPath, title: topic.title, summary: topic.summary, collaborators: topic.collaborators,
      spaceId: catalog?.spaces.find(space => space.topicId === topic.id)?.spaceId ?? null, kind: topic.readError ? 'unknown' : topic.kind ?? 'unknown',
      ...(topic.readError === undefined ? {} : { readError: topic.readError }), ...(topic.soul ? { soul: topic.soul } : {}), ...(topic.wiki ? { wiki: topic.wiki } : {}), ...(topic.moteArchive ? { moteArchive: topic.moteArchive } : {}) }))
    if (wanted('topics')) result.topics = values
    if (wanted('motes')) result.motes = values.filter(topic => topic.kind === 'mote')
    return result
  }
}
