import { noteContentSummary, type NoteSource } from '@agentmux/client-ui/note/note-knowledge'
import type { NotebookPage } from '@agentmux/core/notebook-catalog'
import type { NotebookGraph, NoteContentMetadata } from '@agentmux/core'
import type { NotebookGraphSnapshot } from '../../../shared/notebook-observation'
import type { NoteCanvasScope } from './note-canvas-state'

export type CanvasReference = NotebookGraph['references'][number]
export type CanvasRelationship = { id: string; kind: 'hierarchy' | 'reference' | 'embed' | 'link'; source: string; target: string; sourceKind: 'page' | 'block'; targetKind: 'page' | 'block'; references: CanvasReference[] }
export type CanvasAttachedRelationship = CanvasRelationship & { aggregateId: string; sourceBlockId?: string; targetBlockId?: string }
export type CanvasSharedPlacement = 'area-member' | 'bridge'
export type CanvasNote = {
  id: string
  kind?: 'shared-block'
  hostNoteIds?: readonly string[]
  hostNoteId?: string
  sharedPlacement?: CanvasSharedPlacement
  page?: NotebookPage
  observation?: NoteContentMetadata
  title: string
  notebook: string
  root: boolean
  context: boolean
  neighbors: number
  incoming: number
  outgoing: number
  unbound: CanvasReference[]
}
export type CanvasProjection = { notes: CanvasNote[]; relationships: CanvasRelationship[]; unbound: CanvasReference[] }
export type CanvasFocusTarget =
  | { kind: 'note'; noteId: string }
  | { kind: 'block'; noteId: string; blockId: string }
  | { kind: 'relationship'; relationshipId: string; occurrences?: readonly string[] }
export type CanvasFocusNeighborhood = {
  active: boolean
  noteIds: ReadonlySet<string>
  blockIdsByNote: ReadonlyMap<string, ReadonlySet<string>>
  relationshipIds: ReadonlySet<string>
}
const key = (kind: string, from: string, to: string, targetKind: string) => JSON.stringify([kind, from, to, targetKind])

/** Only the scan owner can confirm a shared file's globally unique identity. */
export function canvasSharedObservation(snapshot: NotebookGraphSnapshot, noteId: string) {
  const candidates = snapshot.graph.observations.filter(value => value.noteId === noteId)
  const value = candidates.length === 1 ? candidates[0] : undefined
  return !snapshot.graph.duplicateNoteIds.includes(noteId) && value?.status === 'read' && value.kind === 'shared-block' && value.fileIdentity === 'confirmed' ? value : undefined
}

export function canvasNoteTitle(item: CanvasNote, source?: NoteSource): string {
  if (item.kind !== 'shared-block' || !source) return item.title
  const text = source.note.title?.trim() || noteContentSummary(source.note)
  return text ? text.length > 72 ? text.slice(0, 71) + '…' : text : 'Shared block'
}

/** A projection of the original observation. It neither reads files nor infers new links. */
export function projectNoteCanvas(snapshot: NotebookGraphSnapshot, scope: NoteCanvasScope, expanded: readonly string[], seedNoteIds?: readonly string[]): CanvasProjection {
  const { catalog, graph } = snapshot
  const relationships = new Map<string, CanvasRelationship>()
  const adjacent = new Map<string, Set<string>>()
  function add(kind: CanvasRelationship['kind'], source: string, target: string, reference?: CanvasReference) {
    const sourceKind = reference ? 'block' : 'page', targetKind = reference?.target.kind === 'block' ? 'block' : 'page'
    const id = key(kind, source, target, targetKind)
    let edge = relationships.get(id)
    if (!edge) { edge = { id, kind, source, target, sourceKind, targetKind, references: [] }; relationships.set(id, edge) }
    if (reference) edge.references.push(reference)
    for (const [a, b] of [[source, target], [target, source]] as const) {
      if (!adjacent.has(a)) adjacent.set(a, new Set())
      if (a !== b) adjacent.get(a)!.add(b)
    }
  }
  for (const edge of graph.hierarchy) add('hierarchy', edge.parentNoteId, edge.noteId)
  const unbound = new Map<string, CanvasReference[]>()
  for (const reference of graph.references) {
    if (reference.target.kind === 'unbound') {
      const held = unbound.get(reference.source.noteId) ?? []
      held.push(reference); unbound.set(reference.source.noteId, held)
    } else add(reference.mode, reference.source.noteId, reference.target.noteId, reference)
  }
  const seeds = new Set(scope.kind === 'note' ? [scope.noteId] : seedNoteIds ?? Object.values(catalog.pages).filter(page => page.notebookId === scope.notebookId && !page.archivedAt).map(page => page.noteId))
  const visible = new Set(seeds), queue = [...seeds], expansion = new Set(expanded)
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!
    if (!expansion.has(id)) continue
    for (const next of adjacent.get(id) ?? []) if (!visible.has(next)) { visible.add(next); queue.push(next) }
  }
  const observations = new Map<string, NoteContentMetadata>(), repeated = new Set<string>()
  for (const value of graph.observations) {
    if (observations.has(value.noteId)) repeated.add(value.noteId)
    else observations.set(value.noteId, value)
  }
  for (const id of repeated) observations.delete(id)
  const duplicateNoteIds = new Set(graph.duplicateNoteIds)
  // A host's directly embedded shared files stay visible even when ordinary neighbors are collapsed.
  // One pass over the pre-existing visible hosts avoids recursively expanding an entire include graph.
  const hosts = new Set(visible)
  for (const reference of graph.references) {
    if (reference.mode !== 'embed' || reference.target.kind !== 'page' || !hosts.has(reference.source.noteId)) continue
    const original = observations.get(reference.target.noteId)
    if (original?.status === 'read' && original.kind === 'shared-block' && original.fileIdentity === 'confirmed' && !duplicateNoteIds.has(original.noteId)) visible.add(original.noteId)
  }
  const incoming = new Map<string, number>(), outgoing = new Map<string, number>()
  for (const reference of graph.references) {
    outgoing.set(reference.source.noteId, (outgoing.get(reference.source.noteId) ?? 0) + 1)
    if (reference.target.kind !== 'unbound') incoming.set(reference.target.noteId, (incoming.get(reference.target.noteId) ?? 0) + 1)
  }
  const isShared = (id: string) => {
    const observation = observations.get(id)
    return observation?.status === 'read' && observation.kind === 'shared-block'
  }
  const embedHosts = new Map<string, string[]>()
  for (const reference of graph.references) {
    if (reference.mode !== 'embed' || reference.target.kind !== 'page') continue
    const hostId = reference.source.noteId, targetId = reference.target.noteId
    if (!visible.has(hostId) || !visible.has(targetId) || hostId === targetId || isShared(hostId)) continue
    const list = embedHosts.get(targetId) ?? []
    if (!list.includes(hostId)) { list.push(hostId); embedHosts.set(targetId, list) }
  }
  const notes = [...visible].map(id => {
    const page = catalog.pages[id], observation = observations.get(id)
    const shared = isShared(id)
    const hostNoteIds = shared ? (embedHosts.get(id) ?? []) : undefined
    const hostNoteId = shared && hostNoteIds?.length === 1 ? hostNoteIds[0]! : undefined
    const sharedPlacement: CanvasSharedPlacement | undefined = shared ? (hostNoteId ? 'area-member' : 'bridge') : undefined
    return {
      id,
      ...(shared ? { kind: 'shared-block' as const, ...(hostNoteIds ? { hostNoteIds } : {}), ...(hostNoteId ? { hostNoteId } : {}), ...(sharedPlacement ? { sharedPlacement } : {}) } : {}),
      ...(page ? { page } : {}),
      ...(observation ? { observation } : {}),
      title: page?.title ?? (shared ? 'Shared block' : 'Uncatalogued note'),
      notebook: shared ? 'Shared block' : page ? catalog.notebooks[page.notebookId]?.name ?? 'Original notebook' : 'Outside this directory',
      root: scope.kind === 'note' && id === scope.noteId,
      context: !seeds.has(id),
      neighbors: adjacent.get(id)?.size ?? 0,
      incoming: incoming.get(id) ?? 0,
      outgoing: outgoing.get(id) ?? 0,
      unbound: unbound.get(id) ?? [],
    }
  })
  return { notes, relationships: [...relationships.values()].filter(edge => visible.has(edge.source) && visible.has(edge.target)), unbound: [...unbound.values()].flat().filter(reference => visible.has(reference.source.noteId)) }
}

/** Compute the 1-hop neighborhood around a focused Note area, Block node, or Relationship edge. */
export function noteCanvasFocusNeighborhood(
  projection: CanvasProjection,
  relationships: readonly CanvasAttachedRelationship[],
  target: CanvasFocusTarget | null,
): CanvasFocusNeighborhood {
  const noteIds = new Set<string>(), blockIdsByNote = new Map<string, Set<string>>(), relationshipIds = new Set<string>()
  if (!target) return { active: false, noteIds, blockIdsByNote, relationshipIds }
  const addBlock = (noteId: string, blockId?: string) => {
    if (!blockId) return
    const set = blockIdsByNote.get(noteId) ?? new Set<string>()
    set.add(blockId); blockIdsByNote.set(noteId, set)
  }
  const includeCluster = (noteId: string) => {
    noteIds.add(noteId)
    const item = projection.notes.find(note => note.id === noteId)
    if (item?.hostNoteId) noteIds.add(item.hostNoteId)
    for (const member of projection.notes) if (member.hostNoteId === noteId) noteIds.add(member.id)
  }
  if (target.kind === 'note') {
    includeCluster(target.noteId)
    for (const edge of relationships) {
      if (edge.source !== target.noteId && edge.target !== target.noteId) continue
      relationshipIds.add(edge.id)
      includeCluster(edge.source); includeCluster(edge.target)
      addBlock(edge.source, edge.sourceBlockId); addBlock(edge.target, edge.targetBlockId)
    }
  } else if (target.kind === 'block') {
    includeCluster(target.noteId); addBlock(target.noteId, target.blockId)
    for (const edge of relationships) {
      const touches = edge.source === target.noteId && edge.sourceBlockId === target.blockId
        || edge.target === target.noteId && edge.targetBlockId === target.blockId
        || edge.references.some(ref => ref.source.noteId === target.noteId && ref.source.blockId === target.blockId
          || ref.resolution === 'resolved' && ref.target.kind === 'block' && ref.target.noteId === target.noteId && ref.target.blockId === target.blockId)
      if (!touches) continue
      relationshipIds.add(edge.id)
      includeCluster(edge.source); includeCluster(edge.target)
      addBlock(edge.source, edge.sourceBlockId); addBlock(edge.target, edge.targetBlockId)
      for (const ref of edge.references) {
        if (ref.source.noteId === target.noteId && ref.source.blockId === target.blockId) {
          if (ref.resolution === 'resolved' && ref.target.kind === 'block') addBlock(ref.target.noteId, ref.target.blockId)
        }
        if (ref.resolution === 'resolved' && ref.target.kind === 'block' && ref.target.noteId === target.noteId && ref.target.blockId === target.blockId) {
          addBlock(ref.source.noteId, ref.source.blockId)
        }
      }
    }
  } else {
    for (const edge of relationships) {
      if (edge.id !== target.relationshipId && edge.aggregateId !== target.relationshipId) continue
      relationshipIds.add(edge.id)
      includeCluster(edge.source); includeCluster(edge.target)
      addBlock(edge.source, edge.sourceBlockId); addBlock(edge.target, edge.targetBlockId)
    }
  }
  return { active: noteIds.size > 0 || relationshipIds.size > 0, noteIds, blockIdsByNote, relationshipIds }
}

/** Split only the displayed bundles whose original blocks have confirmed, currently visible ports. */
export function attachNoteCanvasRelationships(relationships: readonly CanvasRelationship[], visibleBlocks: ReadonlyMap<string, ReadonlySet<string>>): CanvasAttachedRelationship[] {
  return relationships.flatMap(relationship => {
    if (!relationship.references.length) return [{ ...relationship, aggregateId: relationship.id }]
    const groups = new Map<string, CanvasAttachedRelationship>()
    for (const reference of relationship.references) {
      const sourceBlockId = visibleBlocks.get(reference.source.noteId)?.has(reference.source.blockId) ? reference.source.blockId : undefined
      const targetBlockId = reference.resolution === 'resolved' && reference.target.kind === 'block' && visibleBlocks.get(reference.target.noteId)?.has(reference.target.blockId) ? reference.target.blockId : undefined
      const id = sourceBlockId || targetBlockId ? JSON.stringify([relationship.id, sourceBlockId ?? null, targetBlockId ?? null]) : relationship.id
      let group = groups.get(id)
      if (!group) { group = { ...relationship, id, aggregateId: relationship.id, ...(sourceBlockId ? { sourceBlockId } : {}), ...(targetBlockId ? { targetBlockId } : {}), references: [] }; groups.set(id, group) }
      group.references.push(reference)
    }
    return [...groups.values()]
  })
}

export const noteCanvasBlockHandle = (blockId: string, direction: 'in' | 'out', side: 'left' | 'right') => JSON.stringify(['block', blockId, direction, side])

/** New nodes get provisional usable positions while the background layout is pending. */
export function initialCanvasPositions(ids: readonly string[], held: Record<string, { x: number; y: number }>): Record<string, { x: number; y: number }> {
  const positions = { ...held }
  const bottom = Math.max(-240, ...Object.values(held).map(point => point.y)) + 240
  ids.forEach((id, index) => { if (!positions[id]) positions[id] = { x: index % 3 * 340, y: bottom + Math.floor(index / 3) * 240 } })
  return positions
}
