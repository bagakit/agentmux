import type { SpaceObjectImageTarget } from '../../../shared/object-avatars'
import { type MoteAvatarTarget } from '../../../shared/mote-avatars'
import type { ScratchTopicSnapshot, WorkspaceRecord } from '../../../shared/contracts'
import type { TopicCategory } from '@agentmux/core/control'
import { PMO_TEAMS_TOPIC_ID, scratchTopicIdentityPath } from '../../../shared/scratch-topics'
import type { WorkspaceProject } from './workspace-projects'
import { directoryIdentity, originalTopicAddress, type SpaceZoneBindings } from '../../../shared/space-addresses'

/** One bounded, named source for the picker, renderer and persisted-value validation. */
import { SPACE_ICON_CATALOG, type SpaceIconId } from '@agentmux/client-ui/space-icon-catalog'
export { SPACE_ICON_CATALOG, type SpaceIconId } from '@agentmux/client-ui/space-icon-catalog'
export { isSpaceIconId, isSpaceObjectIdentityKey, restoreSpaceIconOverrides, requireSpaceIconSelection } from '../../../shared/space-object-appearance'
export type { SpaceIconChoice, SpaceIconOverrides } from '../../../shared/space-object-appearance'
export type SpaceIconTarget = { key: string; name: string; kind: 'folder' | 'category' | 'topic' | 'mote'; avatarTarget?: MoteAvatarTarget; imageTarget?: SpaceObjectImageTarget }

/** Host and durable directory, never a display name, classification, Session or worktree id. */
export function spaceObjectIdentityKey(hostId: string, directoryPath: string): string {
  return directoryIdentity(hostId, directoryPath)
}

export function folderSpaceIconTarget(project: Pick<WorkspaceProject, 'hostId' | 'repoPath' | 'name'>): SpaceIconTarget {
  return { key: spaceObjectIdentityKey(project.hostId, project.repoPath), name: project.name, kind: 'folder' }
}

/** The classification owns its appearance; its members' content keys stay independent. */
export function categorySpaceIconTarget(category: Pick<TopicCategory, 'categoryId' | 'spaceId' | 'title'>): SpaceIconTarget {
  return { key: category.spaceId, name: category.title, kind: 'category', imageTarget: { kind: 'category', categoryId: category.categoryId, objectKey: category.spaceId } }
}

export function topicSpaceIconTarget(
  workspace: Pick<WorkspaceRecord, 'hostId' | 'path'> & { id?: string },
  topic: Pick<ScratchTopicSnapshot, 'id' | 'directoryPath' | 'title' | 'soul' | 'identityDirectoryPath' | 'readError'>,
  bindings: SpaceZoneBindings = {}
): SpaceIconTarget | null {
  const address = originalTopicAddress({ ...workspace, id: workspace.id ?? '' }, topic, bindings)
  if (!address) return null
  const key = address.spaceId
  return {
    key,
    name: topic.id === PMO_TEAMS_TOPIC_ID ? 'Mote' : topic.title,
    kind: topic.id === PMO_TEAMS_TOPIC_ID || topic.soul ? 'mote' : 'topic',
    ...(workspace.id ? topic.id === PMO_TEAMS_TOPIC_ID || topic.soul
      ? { avatarTarget: { workspaceId: workspace.id, topicId: topic.id, objectKey: key } }
      : { imageTarget: { kind: 'topic' as const, workspaceId: workspace.id, topicId: topic.id, objectKey: key } } : {})
  }
}
