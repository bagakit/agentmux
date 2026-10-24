import type { CollaborationAgent, CollaborationArea } from './agent-collaboration'
import type { CollaborationLayoutBox } from './collaboration-layout-engine'
import { createCollaborationHierarchy } from './collaboration-hierarchy'
import { collaborationAgentNode, collaborationAreaNode } from './collaboration-presentation'

export const COLLABORATION_OVERVIEW_ZOOM = .45
export const COLLABORATION_READING_ZOOM = .7

export type CollaborationLocate = { token: object; agentId?: string; areaIds?: readonly string[] }

/** A reading destination in the existing world, never a filter or a second spatial identity. */
export function collaborationCameraTarget(
  geometry: ReadonlyMap<string, CollaborationLayoutBox>, areas: readonly CollaborationArea[],
  agents: ReadonlyMap<string, CollaborationAgent>, viewport: { width: number; height: number },
  locate?: CollaborationLocate,
) {
  const occurrence = (area: CollaborationArea, id: string) => geometry.get(collaborationAgentNode(area.id, id))
  if (locate?.agentId) {
    for (const area of areas) {
      if (!area.members.includes(locate.agentId)) continue
      const box = occurrence(area, locate.agentId)
      if (box) return { x: box.x + box.width / 2, y: box.y + box.height / 2, zoom: 1, anchor: box.id }
    }
    return null
  }
  // This census belongs to an explicit reading destination, never a camera frame.
  const hierarchy = createCollaborationHierarchy(areas)
  const members = (area: CollaborationArea) => hierarchy.members.get(area.id)!
  const requested = locate?.areaIds?.length ? new Set(locate.areaIds) : null
  const candidates = areas.filter(area => (!requested || requested.has(area.id)) && geometry.has(collaborationAreaNode(area.id)))
  // Only already-known tiers participate. Unknown activity is not evidence that an Agent is idle or closed.
  const activeCount = (area: CollaborationArea) => members(area).reduce((count, id) => count + Number(agents.get(id)?.tier === 'active'), 0)
  let area: CollaborationArea | undefined, bestActive = -1
  for (const candidate of candidates) {
    const active = activeCount(candidate)
    if (!area || active > bestActive || active === bestActive && members(candidate).length > members(area).length) {
      area = candidate; bestActive = active
    }
  }
  if (!area) return null
  const box = geometry.get(collaborationAreaNode(area.id))!
  const zoom = Math.min(.95, (viewport.width - 96) / box.width, (viewport.height - 112) / box.height)
  if (zoom >= COLLABORATION_READING_ZOOM || !members(area).length || box.folded) {
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, zoom: Math.max(COLLABORATION_READING_ZOOM, zoom) }
  }
  // A large region's geometric center may be empty. Center a real readable occurrence instead.
  // Resolve an existing occurrence in this subtree; inherited membership does
  // not create a synthetic Agent occurrence on its parent or another Host.
  const subtreeId = area.id
  const descendants = areas.filter(owner => owner.id === subtreeId || hierarchy.ancestors.get(owner.id)!.includes(subtreeId))
  const occurrences = descendants.flatMap(owner => owner.members.flatMap(id => {
    const box = occurrence(owner, id)
    return box ? [{ id, box }] : []
  }))
  const foldedSummary = descendants.map(owner => geometry.get(collaborationAreaNode(owner.id))).find(box => box?.folded)
  const anchor = (occurrences.find(({ id }) => agents.get(id)?.tier === 'active') ?? occurrences[0])?.box ?? foldedSummary
  return anchor ? { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2, zoom: .85, anchor: anchor.id } : null
}
