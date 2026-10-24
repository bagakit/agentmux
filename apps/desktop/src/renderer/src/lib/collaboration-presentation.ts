import type { CollaborationArea, CollaborationRelation } from './agent-collaboration'
import { collaborationVisibleOwners } from './collaboration-hierarchy'

export const collaborationAreaNode = (id: string) => JSON.stringify(['area', id])
export const collaborationAgentNode = (area: string, id: string) => JSON.stringify([area, id])
export type CollaborationConnection = { id: string; source: string; target: string; relations: CollaborationRelation[] }

/** Original message evidence is already source-qualified by the projector. Lifecycle events
 * and a Dispatch referring to that same message never increase its communication strength. */
export function collaborationConnectionStrength(connection: CollaborationConnection): number {
  const messages = new Set(connection.relations.flatMap(relation => relation.evidence.flatMap(evidence => evidence.kind === 'communication' ? [evidence.id] : [])))
  return Math.max(1, messages.size)
}

/** One original relationship has one visible path, even with overlapping areas. */
export function collaborationConnections(areas: readonly CollaborationArea[], relations: readonly CollaborationRelation[], folded: ReadonlySet<string>) {
  const placements = new Map<string, CollaborationArea[]>()
  for (const area of areas) for (const member of area.members) {
    const existing = placements.get(member) ?? []
    existing.push(area); placements.set(member, existing)
  }
  const connections = new Map<string, CollaborationConnection>(), internal = new Map<string, CollaborationRelation[]>()
  const owners = collaborationVisibleOwners(areas, folded)
  const endpoint = (area: CollaborationArea, member: string) => {
    const owner = owners.get(area.id) ?? area.id
    return folded.has(owner) ? collaborationAreaNode(owner) : collaborationAgentNode(area.id, member)
  }
  for (const relation of relations) {
    const sources = placements.get(relation.source) ?? [], targets = placements.get(relation.target) ?? []
    const shared = sources.find(area => targets.includes(area)), from = shared ?? sources[0], to = shared ?? targets[0]
    if (!from || !to) continue
    const source = endpoint(from, relation.source), target = endpoint(to, relation.target)
    if (source === target) {
      const owner = owners.get(from.id) ?? from.id, values = internal.get(owner) ?? []
      values.push(relation); internal.set(owner, values)
      continue
    }
    const id = JSON.stringify([relation.kind, source, target]), held = connections.get(id) ?? { id, source, target, relations: [] }
    held.relations.push(relation); connections.set(id, held)
  }
  return { connections: [...connections.values()], internal }
}
