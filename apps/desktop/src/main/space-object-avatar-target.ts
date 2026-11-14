import { AgentMuxError } from '@agentmux/core'
import type { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { homeZoneId } from '@agentmux/core/space-identity'
import { categoriesFromSpatial } from '@agentmux/host/topic-categories'
import type { TopicKnowledgeOwner } from '@agentmux/host/topic-knowledge'
import type { ConfigOwner } from './config-owner.js'
import type { SpaceObjectImageTarget } from '@agentmux/core/object-avatar'
import type { SpaceObjectAvatarLocation } from './space-object-avatar.js'

/** Resolve identities from original content/spatial owners, never a caller's path or objectKey alone.
 * Retained remote identity permits ordinary icon edits without inventing a writable local asset path. */
export function createSpaceObjectAvatarResolver(config: ConfigOwner,
  topics: Pick<TopicKnowledgeOwner, 'categoryAppearanceDirectory' | 'topicAppearanceDirectory'>,
  spatial: Pick<AgentMuxSpatialStateStore, 'read'>) {
  return async (target: SpaceObjectImageTarget): Promise<SpaceObjectAvatarLocation> => {
    const graph = (await spatial.read())?.graph
    if (target.kind === 'category') {
      const categories = graph ? categoriesFromSpatial(graph).filter(category => category.categoryId === target.categoryId) : []
      if (categories.length) {
        const exact = categories.filter(category => category.spaceId === target.objectKey)
        if (exact.length !== 1) throw new AgentMuxError('The Category target and its original content key differ. Refresh that same Category.', 'AVATAR_TARGET_CHANGED')
        return { hostId: exact[0]!.hostId, directoryPath: exact[0]!.directoryPath }
      }
      return await topics.categoryAppearanceDirectory(target.categoryId, target.objectKey)
    }
    const workspace = config.current.workspaces.find(value => value.id === target.workspaceId)
    if (!workspace) throw new AgentMuxError('The original Topic workspace is unavailable. Its current appearance is retained.', 'AVATAR_TARGET_CHANGED')
    const matches = graph?.zones.flatMap(zone => {
      const record = graph.resources['zone:' + zone.zoneId]
      return zone.zoneId === homeZoneId(target.objectKey) && zone.workspaceId === workspace.id && record && typeof record === 'object' && !Array.isArray(record) && record.topicId === target.topicId
        ? [{ zone, record }] : []
    }) ?? []
    if (matches.length) {
      const original = matches[0]!
      if (matches.length !== 1 || original.record.contentKind !== 'topic' || original.record.workspaceId !== workspace.id ||
        original.record.spaceId !== target.objectKey || original.zone.hostId !== workspace.hostId || !original.zone.directoryPath)
        throw new AgentMuxError('The original ordinary Topic identity contradicts this avatar target. Its saved choice and work remain available.', 'AVATAR_TARGET_CHANGED')
      return { hostId: workspace.hostId, directoryPath: original.zone.directoryPath }
    }
    if (workspace.hostId === 'local') return { hostId: workspace.hostId, directoryPath: await topics.topicAppearanceDirectory(workspace.id, target.topicId, target.objectKey) }
    throw new AgentMuxError('This remote Topic has no confirmed original content identity here. Refresh its original spatial owner; its saved choice and other work remain available.', 'AVATAR_TARGET_UNCONFIRMED')
  }
}
