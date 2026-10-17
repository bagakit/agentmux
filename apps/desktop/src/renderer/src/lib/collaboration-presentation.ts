import type { CollaborationArea, CollaborationRelation } from './agent-collaboration'

export const collaborationAreaNode = (id: string) => JSON.stringify(['area', id])
export const collaborationAgentNode = (area: string, id: string) => JSON.stringify([area, id])
export type CollaborationConnection = { id: string; source: string; target: string; relations: CollaborationRelation[] }

/** One original relationship has one visible path, even with overlapping areas. */
export function collaborationConnections(areas: readonly CollaborationArea[], relations: readonly CollaborationRelation[], folded: ReadonlySet<string>) {
  const placements = new Map<string, CollaborationArea[]>()
  for (const area of areas) for (const member of area.members) {
    const existing = placements.get(member) ?? []
    existing.push(area); placements.set(member, existing)
  }
  const connections = new Map<string, CollaborationConnection>(), internal = new Map<string, CollaborationRelation[]>()
  const endpoint = (area: CollaborationArea, member: string) => folded.has(area.id) ? collaborationAreaNode(area.id) : collaborationAgentNode(area.id, member)
  for (const relation of relations) {
    const sources = placements.get(relation.source) ?? [], targets = placements.get(relation.target) ?? []
    const shared = sources.find(area => targets.includes(area)), from = shared ?? sources[0], to = shared ?? targets[0]
    if (!from || !to) continue
    const source = endpoint(from, relation.source), target = endpoint(to, relation.target)
    if (source === target) {
      const values = internal.get(from.id) ?? []
      values.push(relation); internal.set(from.id, values)
      continue
    }
    const id = JSON.stringify([relation.kind, source, target]), held = connections.get(id) ?? { id, source, target, relations: [] }
    held.relations.push(relation); connections.set(id, held)
  }
  return { connections: [...connections.values()], internal }
}
