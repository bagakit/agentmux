import { SCRATCH_WORKSPACE_ID, scratchTopicIdFromDirectoryName } from '@agentmux/host/mote-model'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import { topicContentZoneId } from '@agentmux/host/topic-categories'

/** The reserved first component addresses an object. The Host verifies its actual directory before IO. */
export function topicFileDirectory(workspaceId: string, path: string): string | null {
  if (workspaceId !== SCRATCH_WORKSPACE_ID) return null
  const firstSlash = path.indexOf('/')
  const directory = firstSlash < 0 ? path : path.slice(0, firstSlash)
  return scratchTopicIdFromDirectoryName(directory) ? directory : null
}

export function topicFilesTarget(workspace: WorkspaceRecord, topic: ScratchTopicSnapshot) {
  return { zoneId: topicContentZoneId(workspace, topic),
    expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path } }
}
