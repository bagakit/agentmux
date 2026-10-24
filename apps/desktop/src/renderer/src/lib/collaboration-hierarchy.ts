import type { CollaborationArea } from './agent-collaboration'

/** Build once per original topology, then let activity and camera frames use lookups. */
export function createCollaborationHierarchy(areas: readonly CollaborationArea[]) {
  const byId = new Map(areas.map(area => [area.id, area])), children = new Map<string, CollaborationArea[]>()
  for (const area of areas) if (area.parentId && byId.has(area.parentId)) {
    const list = children.get(area.parentId) ?? []; list.push(area); children.set(area.parentId, list)
  }
  const ancestors = new Map<string, readonly string[]>(), depth = new Map<string, number>()
  for (const area of areas) {
    const chain: string[] = [], seen = new Set([area.id])
    let parent = area.parentId
    while (parent && byId.has(parent) && !seen.has(parent)) { seen.add(parent); chain.push(parent); parent = byId.get(parent)?.parentId }
    ancestors.set(area.id, chain); depth.set(area.id, chain.length)
  }
  const sets = new Map(areas.map(area => [area.id, new Set(area.members)]))
  for (const area of [...areas].sort((a, b) => depth.get(b.id)! - depth.get(a.id)!)) {
    if (area.parentId && sets.has(area.parentId)) for (const member of sets.get(area.id)!) sets.get(area.parentId)!.add(member)
  }
  const members = new Map([...sets].map(([id, values]) => [id, [...values]] as const))
  return { ancestors, depth, members, children }
}

/** Disposable presentation ancestry. It never creates or changes a spatial binding. */
export function collaborationAreaAncestors(areas: readonly CollaborationArea[], id: string): string[] {
  const byId = new Map(areas.map(area => [area.id, area])), ancestors: string[] = [], seen = new Set([id])
  let parent = byId.get(id)?.parentId
  while (parent && byId.has(parent) && !seen.has(parent)) {
    seen.add(parent); ancestors.push(parent); parent = byId.get(parent)?.parentId
  }
  return ancestors
}

export const collaborationAreaDepth = (areas: readonly CollaborationArea[], id: string) => collaborationAreaAncestors(areas, id).length

/** A subtree census counts original Host/Session identities once, never occurrences. */
export function collaborationAreaMembers(areas: readonly CollaborationArea[], id: string): string[] {
  const children = new Map<string, CollaborationArea[]>(), byId = new Map(areas.map(area => [area.id, area]))
  for (const area of areas) if (area.parentId) { const list = children.get(area.parentId) ?? []; list.push(area); children.set(area.parentId, list) }
  const members = new Set<string>(), seen = new Set<string>(), pending = [id]
  while (pending.length) {
    const next = pending.pop()!
    if (seen.has(next)) continue
    seen.add(next)
    for (const member of byId.get(next)?.members ?? []) members.add(member)
    for (const child of children.get(next) ?? []) pending.push(child.id)
  }
  return [...members]
}

export function collaborationVisibleOwners(areas: readonly CollaborationArea[], folded: ReadonlySet<string>): ReadonlyMap<string, string> {
  const byId = new Map(areas.map(area => [area.id, area])), owners = new Map<string, string>()
  function owner(id: string, seen = new Set<string>()): string {
    const held = owners.get(id)
    if (held) return held
    if (seen.has(id)) return id
    seen.add(id)
    const parent = byId.get(id)?.parentId, ancestor = parent && byId.has(parent) ? owner(parent, seen) : null
    const value = ancestor && folded.has(ancestor) ? ancestor : id
    owners.set(id, value); return value
  }
  for (const area of areas) owner(area.id)
  return owners
}

/** Folding changes this projection only; the original area/member topology stays intact. */
export function collaborationVisibleAreas(areas: readonly CollaborationArea[], folded: ReadonlySet<string>): CollaborationArea[] {
  const owners = collaborationVisibleOwners(areas, folded), hierarchy = createCollaborationHierarchy(areas)
  return areas.flatMap(area => owners.get(area.id) !== area.id ? []
    : [folded.has(area.id) ? { ...area, members: hierarchy.members.get(area.id)! } : area])
    .sort((a, b) => hierarchy.depth.get(a.id)! - hierarchy.depth.get(b.id)! || a.id.localeCompare(b.id))
}
