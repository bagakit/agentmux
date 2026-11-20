import { folderSpaceFacts } from '@agentmux/core/space-folder'
import { parseFocusTaskReference, type AgentMuxFocusScope, type AgentMuxFocusTaskReference } from '@agentmux/core/focus-control'
import type { WorkspaceRecord } from '../../../shared/contracts'
import type { FocusScanLane } from './focus-collection-lanes'

/** The same original resources name both the visible group and its public read. */
export function focusGroupReadScope(lane: FocusScanLane, resources: readonly WorkspaceRecord[]): AgentMuxFocusScope | null {
  if (lane.collection) return { kind: 'collection', hostId: lane.hostId,
    categorySpaceIds: lane.collection.confirmed ? [...new Set(lane.collection.categories.map(category => category.spaceId))].sort() : [] }
  if (lane.projectSpaceId) return { kind: 'project', hostId: lane.hostId, projectSpaceId: lane.projectSpaceId }
  const candidates = resources.filter(resource => resource.hostId === lane.hostId &&
    (resource.id === lane.projectWorkspaceId || resource.id === lane.workspaceId ||
      (resource.repoPath ?? resource.path) === lane.path))
  const identities = new Set(candidates.map(resource => folderSpaceFacts(resource).space.spaceId))
  if (identities.size !== 1) return null
  return { kind: 'project', hostId: lane.hostId, projectSpaceId: identities.values().next().value! }
}

/** Displayed references are complete and Host-qualified; no card facts or status filter is captured. */
export function focusGroupTaskReference(lane: FocusScanLane, resources: readonly WorkspaceRecord[]): AgentMuxFocusTaskReference {
  const scope = focusGroupReadScope(lane, resources)
  if (!scope) throw new Error('The original Focus project identity is unconfirmed. Keep this group and choose its exact project before preparing a task.')
  return parseFocusTaskReference({ scope, selection: { kind: 'members', references: lane.contextRefs.map(reference => ({
    hostId: reference.hostId, contextId: reference.id
  })) } })
}
