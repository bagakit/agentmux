import type { NotebookPage } from '@agentmux/core/notebook-catalog'
import type { NotebookGraph, NoteContentMetadata } from '@agentmux/core'
import type { NotebookGraphSnapshot } from '../../../shared/notebook-observation'
import type { NoteCanvasScope } from './note-canvas-state'

export type CanvasReference = NotebookGraph['references'][number]
export type CanvasRelationship = { id: string; kind: 'hierarchy' | 'reference' | 'embed' | 'link'; source: string; target: string; sourceKind: 'page' | 'block'; targetKind: 'page' | 'block'; references: CanvasReference[] }
export type CanvasAttachedRelationship = CanvasRelationship & { aggregateId: string; sourceBlockId?: string; targetBlockId?: string }
export type CanvasNote = { id: string; page?: NotebookPage; observation?: NoteContentMetadata; title: string; notebook: string; root: boolean; context: boolean; neighbors: number; incoming: number; outgoing: number; unbound: CanvasReference[] }
export type CanvasProjection = { notes: CanvasNote[]; relationships: CanvasRelationship[]; unbound: CanvasReference[] }
const key = (kind: string, from: string, to: string, targetKind: string) => JSON.stringify([kind, from, to, targetKind])

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
  const incoming = new Map<string, number>(), outgoing = new Map<string, number>()
  for (const reference of graph.references) {
    outgoing.set(reference.source.noteId, (outgoing.get(reference.source.noteId) ?? 0) + 1)
    if (reference.target.kind !== 'unbound') incoming.set(reference.target.noteId, (incoming.get(reference.target.noteId) ?? 0) + 1)
  }
  const observations = new Map(graph.observations.map(value => [value.noteId, value]))
  const notes = [...visible].map(id => {
    const page = catalog.pages[id], observation = observations.get(id)
    return { id, ...(page ? { page } : {}), ...(observation ? { observation } : {}), title: page?.title ?? 'Uncatalogued note',
      notebook: page ? catalog.notebooks[page.notebookId]?.name ?? 'Original notebook' : 'Outside this directory',
      root: scope.kind === 'note' && id === scope.noteId, context: !seeds.has(id), neighbors: adjacent.get(id)?.size ?? 0, incoming: incoming.get(id) ?? 0, outgoing: outgoing.get(id) ?? 0, unbound: unbound.get(id) ?? [] }
  })
  return { notes, relationships: [...relationships.values()].filter(edge => visible.has(edge.source) && visible.has(edge.target)), unbound: [...unbound.values()].flat().filter(reference => visible.has(reference.source.noteId)) }
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
