import { join } from 'node:path'
import type { AgentMuxRpcSnapshot, AgentMuxRpcSnapshotParams, AgentMuxRpcTopic } from '@agentmux/core'
import type { AppConfig } from '../shared/contracts.js'
import { directoryIdentity, spatialSources } from '../shared/space-addresses.js'
import { SCRATCH_WORKSPACE_ID } from '../shared/scratch-topics.js'
import type { ScratchTopics } from './scratch-topics.js'

/** Read the original config and filesystem owners; observation never ensures or writes a Topic. */
export async function observeClientRpcSnapshot(config: AppConfig, scratchTopics: Pick<ScratchTopics, 'list'>,
  params: AgentMuxRpcSnapshotParams): Promise<Partial<AgentMuxRpcSnapshot>> {
  const wanted = (source: NonNullable<AgentMuxRpcSnapshotParams['include']>[number]) => !params.include || params.include.includes(source)
  const result: Partial<AgentMuxRpcSnapshot> = { unavailable: [] }
  if (wanted('workspaces')) result.workspaces = config.workspaces.filter(workspace =>
    (!params.workspaceId || workspace.id === params.workspaceId) && (!params.projectId ||
      workspace.id !== SCRATCH_WORKSPACE_ID && directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path) === params.projectId))
    .map(workspace => ({ workspaceId: workspace.id, hostId: workspace.hostId, name: workspace.name,
      projectId: workspace.id === SCRATCH_WORKSPACE_ID ? null : directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path),
      path: workspace.path, kind: workspace.kind, repoPath: workspace.repoPath ?? null, branch: workspace.branch ?? null }))
  if (!wanted('topics') && !wanted('motes')) return result
  const workspace = config.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  if (!workspace) {
    for (const source of ['topics', 'motes'] as const) if (wanted(source)) result.unavailable!.push({ source,
      code: 'TOPIC_WORKSPACE_UNAVAILABLE', message: 'The original Topics filesystem Workspace is not configured.',
      recovery: 'Configure the original Topics Workspace, then read this source again.' })
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
    const spaces = spatialSources(config, snapshots).spaces
    const topics: AgentMuxRpcTopic[] = snapshots.filter(snapshot => !params.topicId || snapshot.id === params.topicId).map(snapshot => {
      const matches = spaces.filter(space => space.topicId === snapshot.id)
      const space = matches.length === 1 ? matches[0]! : undefined
      if (snapshot.readError) for (const source of ['topics', 'motes'] as const) if (wanted(source)) result.unavailable!.push({ source, code: 'TOPIC_FILESYSTEM_UNAVAILABLE',
        message: `${snapshot.id}: ${snapshot.readError}`, recovery: 'Read this exact Topic again after its original files are available.' })
      return { ...snapshot, topicId: snapshot.id, workspaceId: workspace.id, hostId: workspace.hostId,
        path: join(workspace.path, snapshot.directoryPath), spaceId: space?.spaceId ?? null,
        kind: snapshot.readError ? 'unknown' : space?.kind === 'mote' ? 'mote' : space?.kind === 'topic' ? 'topic' : 'unknown' }
    })
    if (wanted('topics')) result.topics = topics
    if (wanted('motes')) result.motes = topics.filter(topic => topic.kind === 'mote')
  } catch (error) {
    for (const source of ['topics', 'motes'] as const) if (wanted(source)) result.unavailable!.push({ source,
      code: 'TOPIC_FILESYSTEM_UNAVAILABLE', message: error instanceof Error ? error.message : String(error),
      recovery: 'Restore the original Topics filesystem owner, then read this source again.' })
  }
  return result
}
