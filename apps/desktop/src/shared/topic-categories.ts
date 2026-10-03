import type { TopicCategory, AgentMuxSpaceFact } from '@agentmux/core/control'
import type { AgentMuxSpatialGraph, SpatialJson } from '@agentmux/core/spatial-graph'
import type { ScratchTopicSnapshot, WorkspaceRecord } from './contracts'
import { PMO_TEAMS_TOPIC_ID, scratchTopicIdentityPath } from './scratch-topics'
import { directoryIdentity, homeZoneId, type SpaceZoneBindings } from './space-addresses'

export const UNCLASSIFIED_TOPIC_CATEGORY_ID = '00000000-0000-4000-8000-000000000000'
export function isKnowledgeTopic(topic: ScratchTopicSnapshot): boolean {
  return topic.id !== PMO_TEAMS_TOPIC_ID && topic.soul === undefined && topic.moteArchive === undefined
}
/** A temporary Host metadata gap does not erase a confirmed original Mote identity. */
export function isKnowledgeTopicInBindings(topic: ScratchTopicSnapshot, bindings: SpaceZoneBindings): boolean {
  return isKnowledgeTopic(topic) && !Object.values(bindings).some(binding => binding.topicId === topic.id && binding.contentKind === 'mote')
}
export function topicContentSpaceId(workspace: WorkspaceRecord, topic: Pick<ScratchTopicSnapshot, 'directoryPath' | 'identityDirectoryPath'>): string {
  return directoryIdentity(workspace.hostId, scratchTopicIdentityPath(workspace, topic))
}
export function topicContentZoneId(workspace: WorkspaceRecord, topic: Pick<ScratchTopicSnapshot, 'directoryPath' | 'identityDirectoryPath'>): string {
  return homeZoneId(topicContentSpaceId(workspace, topic))
}
export function categorySpaceFact(category: TopicCategory): AgentMuxSpaceFact {
  return { spaceId: category.spaceId, kind: 'container', name: category.title, hostId: category.hostId,
    directoryPath: category.directoryPath, projectId: null, ...(category.readError ? { issue: category.readError } : {}) }
}
export function categoryResource(category: TopicCategory): SpatialJson {
  return JSON.parse(JSON.stringify({ kind: 'topic-category', ...category })) as SpatialJson
}
/** Descriptions cached by the Host; membership remains exclusively graph.bindings. */
export function categoriesFromSpatial(graph: AgentMuxSpatialGraph): TopicCategory[] {
  return graph.spaces.flatMap(space => {
    const data = graph.resources['space:' + space.spaceId]
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.kind !== 'topic-category' ||
      typeof data.categoryId !== 'string' || data.spaceId !== space.spaceId || typeof data.title !== 'string' ||
      typeof data.hostId !== 'string' || typeof data.directoryPath !== 'string') return []
    return [{ categoryId: data.categoryId, spaceId: space.spaceId, hostId: data.hostId,
      directoryPath: data.directoryPath, title: data.title, revision: typeof data.revision === 'string' ? data.revision : null,
      ...(typeof data.readError === 'string' ? { readError: data.readError } : {}) }]
  })
}
