import type { AgentMuxRpcServiceOptions, AgentMuxRpcSnapshot, AgentMuxRpcSnapshotParams, AgentMuxRpcTopic } from '@agentmux/core'
import type { WorkspaceRecord } from './content-types.js'
import { readPresentationConfiguration } from './presentation-configuration.js'
import { directoryIdentity } from './mote-model.js'
import { ScratchTopics } from './mote-resources.js'
import { SCRATCH_WORKSPACE_ID, scratchTopicPhysicalPath } from './mote-topic-model.js'
import { isKnowledgeTopic, knownTopicContentSpaceId } from './topic-categories.js'

/** Read the original config and filesystem owners; observation never ensures or writes a Topic. */
export async function observeClientRpcSnapshot(configuration: { workspaces: readonly (WorkspaceRecord & { name: string })[] },
  scratchTopics: Pick<ScratchTopics, 'list'>, params: AgentMuxRpcSnapshotParams): Promise<Partial<AgentMuxRpcSnapshot>> {
  const wanted = (source: NonNullable<AgentMuxRpcSnapshotParams['include']>[number]) => !params.include || params.include.includes(source)
  const result: Partial<AgentMuxRpcSnapshot> = { unavailable: [] }
  const unavailable = (code: string, message: string, recovery: string) => {
    for (const source of ['topics', 'motes'] as const) if (wanted(source)) result.unavailable!.push({ source, code, message, recovery })
  }
  if (wanted('workspaces')) result.workspaces = configuration.workspaces.filter(workspace =>
    (!params.workspaceId || workspace.id === params.workspaceId) && (!params.projectId ||
      workspace.id !== SCRATCH_WORKSPACE_ID && directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path) === params.projectId))
    .map(workspace => ({ workspaceId: workspace.id, hostId: workspace.hostId, name: workspace.name,
      projectId: workspace.id === SCRATCH_WORKSPACE_ID ? null : directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path),
      path: workspace.path, kind: workspace.kind ?? 'folder', repoPath: workspace.repoPath ?? null, branch: workspace.branch ?? null }))
  if (!wanted('topics') && !wanted('motes')) return result
  const workspace = configuration.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  if (!workspace) {
    unavailable('TOPIC_WORKSPACE_UNAVAILABLE', 'The original Topics filesystem Workspace is not configured.',
      'Configure the original Topics Workspace, then read this source again.')
    return result
  }
  // Topics are independent of Project membership. No Project relation is inferred from a cwd or display binding.
  if (params.workspaceId && params.workspaceId !== workspace.id || params.projectId) {
    if (wanted('topics')) result.topics = []
    if (wanted('motes')) result.motes = []
    return result
  }
  try {
    const snapshots = await scratchTopics.list(workspace)
    for (const message of snapshots.issues ?? []) unavailable('TOPIC_FILESYSTEM_UNAVAILABLE', message, 'Inspect the original directory record and retry its original repair.')
    const contentIds = snapshots.map(snapshot => knownTopicContentSpaceId(workspace, snapshot))
    // One content identity claimed by two Topics identifies neither of them.
    const claims = new Map<string, number>()
    for (const spaceId of contentIds) if (spaceId !== null) claims.set(spaceId, (claims.get(spaceId) ?? 0) + 1)
    const topics: AgentMuxRpcTopic[] = snapshots.flatMap((snapshot, index) => {
      if (params.topicId && snapshot.id !== params.topicId) return []
      const spaceId = contentIds[index] ?? null
      if (snapshot.readError) unavailable('TOPIC_FILESYSTEM_UNAVAILABLE', `${snapshot.id}: ${snapshot.readError}`,
        'Read this exact Topic again after its original files are available.')
      return [{ id: snapshot.id, topicId: snapshot.id, workspaceId: workspace.id, hostId: workspace.hostId,
        directoryPath: snapshot.directoryPath, topicPath: snapshot.topicPath, title: snapshot.title,
        summary: snapshot.summary, collaborators: snapshot.collaborators,
        ...(snapshot.readError !== undefined ? { readError: snapshot.readError } : {}),
        ...(snapshot.soul !== undefined ? { soul: snapshot.soul } : {}),
        ...(snapshot.wiki !== undefined ? { wiki: snapshot.wiki } : {}),
        ...(snapshot.moteArchive !== undefined ? { moteArchive: snapshot.moteArchive } : {}),
        path: scratchTopicPhysicalPath(workspace, snapshot), spaceId: spaceId !== null && claims.get(spaceId) === 1 ? spaceId : null,
        kind: !isKnowledgeTopic(snapshot) ? 'mote' : snapshot.readError ? 'unknown' : 'topic' }]
    })
    if (wanted('topics')) result.topics = topics
    if (wanted('motes')) result.motes = topics.filter(topic => topic.kind === 'mote')
  } catch (error) {
    unavailable('TOPIC_FILESYSTEM_UNAVAILABLE', error instanceof Error ? error.message : String(error),
      'Restore the original Topics filesystem owner, then read this source again.')
  }
  return result
}

/** The Host serves the same projection from its own configuration file and Topic owner. */
export function createHostSnapshotObservation(configurationPath: string | undefined): NonNullable<AgentMuxRpcServiceOptions['snapshot']> {
  const topics = new ScratchTopics()
  return async params => {
    if (params.include && !params.include.some(source => source === 'workspaces' || source === 'topics' || source === 'motes')) return { unavailable: [] }
    if (!configurationPath) throw new Error('The original configuration metadata is unavailable. Original spatial positions and Agent input remain available.')
    return observeClientRpcSnapshot(await readPresentationConfiguration(configurationPath), topics, params)
  }
}
