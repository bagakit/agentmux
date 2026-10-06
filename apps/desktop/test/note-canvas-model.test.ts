import { fixtureEpoch as _tailRefreshFixtureEpoch, fixturePath as _tailRefreshFixturePath } from "../../../test/fixture-values.mjs"
import { expect, it } from 'vitest'
import { emptyNotebookState } from '@agentmux/core/notebook-catalog'
import type { NotebookGraphSnapshot } from '../src/shared/notebook-observation'
import { projectNoteCanvas, initialCanvasPositions, attachNoteCanvasRelationships } from '../src/renderer/src/lib/note-canvas-model'
import { arrangeNoteCanvas } from '../src/renderer/src/lib/note-canvas-layout-engine'

function fixture(): NotebookGraphSnapshot {
  const catalog = emptyNotebookState()
  for (const id of ['root', 'left', 'shared', 'right', 'closed']) catalog.pages[id] = { noteId: id, notebookId: id === 'closed' ? 'other' : 'default', title: id, parentNoteId: null, createdAt: _tailRefreshFixtureEpoch(0, 0, 1), updatedAt: _tailRefreshFixtureEpoch(0, 0, 1), sources: [], topics: [], resource: { hostId: 'local', workspaceId: 'notes', workspacePath: _tailRefreshFixturePath("notes"), path: id + '.note.md' } }
  const reference = (from: string, to: string, suffix = '') => ({ source: { noteId: from, blockId: from + suffix }, sourceResource: catalog.pages[from]!.resource, target: { kind: 'block' as const, noteId: to, blockId: to + suffix }, occurrence: { kind: 'stored' as const, referenceId: from + to + suffix }, mode: 'reference' as const, resolution: to === 'outside' ? 'unknown' as const : 'resolved' as const })
  return { catalog, graph: { catalogRevision: 0, scope: { kind: 'catalog' }, scannedScope: 'catalog', completeness: 'partial', duplicateNoteIds: [], observations: [], hierarchy: [{ parentNoteId: 'root', noteId: 'left' }], references: [reference('root', 'right'), reference('left', 'shared'), reference('right', 'shared'), reference('shared', 'root'), reference('closed', 'root'), reference('root', 'outside'), reference('root', 'root'), reference('root', 'right', 'second')] } }
}
it('projects one-hop incoming, outgoing, hierarchy, external and cyclic context without inventing resources', () => {
  const graph = projectNoteCanvas(fixture(), { kind: 'note', noteId: 'root' }, ['root'])
  expect(new Set(graph.notes.map(note => note.id))).toEqual(new Set(['root', 'left', 'right', 'shared', 'closed', 'outside']))
  expect(graph.notes.find(note => note.id === 'outside')).toMatchObject({ title: 'Uncatalogued note', context: true })
  expect(graph.notes.find(note => note.id === 'outside')!.page).toBeUndefined()
  expect(graph.relationships.find(edge => edge.source === 'root' && edge.target === 'right')!.references.map(reference => reference.source.blockId)).toEqual(['root', 'rootsecond'])
  expect(graph.relationships.some(edge => edge.source === 'root' && edge.target === 'root')).toBe(true)
})
it('projects page and block links as real edges, retaining unbound occurrences only on their original source', () => {
  const f = fixture(), resource = f.catalog.pages.root!.resource
  f.graph.references.push(
    { source: { noteId: 'root', blockId: 'words' }, sourceResource: resource, target: { kind: 'page', noteId: 'right' }, occurrence: { kind: 'stored', referenceId: 'page-link' }, mode: 'link', resolution: 'resolved' },
    { source: { noteId: 'root', blockId: 'words' }, sourceResource: resource, target: { kind: 'block', noteId: 'right', blockId: 'heading' }, occurrence: { kind: 'stored', referenceId: 'heading-link' }, mode: 'link', resolution: 'resolved' },
    { source: { noteId: 'root', blockId: 'words' }, sourceResource: resource, target: { kind: 'unbound', text: 'Still undecided #Heading' }, occurrence: { kind: 'text', revision: 'original-revision', from: 3, to: 33 }, mode: 'link', resolution: 'unbound' },
  )
  const result = projectNoteCanvas(f, { kind: 'note', noteId: 'root' }, ['root'])
  expect(result.relationships.filter(edge => edge.source === 'root' && edge.target === 'right').map(edge => [edge.kind, edge.sourceKind, edge.targetKind])).toEqual([['reference', 'block', 'block'], ['link', 'block', 'page'], ['link', 'block', 'block']])
  expect(result.relationships.filter(edge => edge.kind === 'link').map(edge => edge.references.map(ref => ref.target))).toEqual([[{ kind: 'page', noteId: 'right' }], [{ kind: 'block', noteId: 'right', blockId: 'heading' }]])
  expect(new Set(result.relationships.map(edge => edge.id)).size).toBe(result.relationships.length)
  expect(result.relationships.find(edge => edge.kind === 'hierarchy')).toMatchObject({ sourceKind: 'page', targetKind: 'page', references: [] })
  expect(result.relationships.flatMap(edge => edge.references)).toHaveLength(f.graph.references.length - 1)
  expect(result.notes.find(note => note.id === 'root')).toMatchObject({ incoming: 3, outgoing: 7 })
  expect(result.unbound).toHaveLength(1)
  expect(result.notes.find(note => note.id === 'root')?.unbound).toEqual(result.unbound)
  expect(result.notes.every(note => note.id !== 'Still undecided #Heading')).toBe(true)
  expect(projectNoteCanvas(f, { kind: 'note', noteId: 'right' }, []).unbound).toEqual([])
})
it('collapses only unreachable context, keeping shared nodes and cycles reached by another expanded path', () => {
  const f = fixture(); f.graph.references = f.graph.references.filter(edge => edge.source.noteId !== 'shared')
  const scope = { kind: 'note', noteId: 'root' } as const
  expect(projectNoteCanvas(f, scope, ['root', 'left', 'right']).notes.some(note => note.id === 'shared')).toBe(true)
  expect(projectNoteCanvas(f, scope, ['root', 'right']).notes.some(note => note.id === 'shared')).toBe(true)
  expect(projectNoteCanvas(f, scope, ['root']).notes.some(note => note.id === 'shared')).toBe(false)
  expect(projectNoteCanvas(f, scope, []).notes.map(note => note.id)).toEqual(['root'])
})
it('attaches confirmed visible endpoints without losing bundled occurrences or granting an unknown target a block port', () => {
  const snapshot = fixture(), projection = projectNoteCanvas(snapshot, { kind: 'note', noteId: 'root' }, ['root'])
  const ports = new Map([['root', new Set(['root', 'rootsecond'])], ['right', new Set(['right'])], ['outside', new Set(['outside'])]])
  const attached = attachNoteCanvasRelationships(projection.relationships, ports)
  const right = attached.filter(edge => edge.source === 'root' && edge.target === 'right')
  expect(right.map(edge => [edge.sourceBlockId, edge.targetBlockId, edge.references.length])).toEqual([['root', 'right', 1], ['rootsecond', undefined, 1]])
  expect(attached.find(edge => edge.target === 'outside')).toMatchObject({ sourceBlockId: 'root' })
  expect(attached.find(edge => edge.target === 'outside')?.targetBlockId).toBeUndefined()
  expect(attached.find(edge => edge.kind === 'hierarchy')?.sourceBlockId).toBeUndefined()
  expect(attached.flatMap(edge => edge.references)).toEqual(projection.relationships.flatMap(edge => edge.references))
  expect(new Set(attached.map(edge => edge.id)).size).toBe(attached.length)
  expect(attachNoteCanvasRelationships(projection.relationships, new Map()).map(({ aggregateId, ...edge }) => edge)).toEqual(projection.relationships)
})
it('respects Notebook search/archive seeds until a deliberate relationship expansion crosses the boundary', () => {
  const f = fixture(), scope = { kind: 'notebook', notebookId: 'default' } as const
  expect(projectNoteCanvas(f, scope, [], ['left']).notes.map(note => note.id)).toEqual(['left'])
  expect(new Set(projectNoteCanvas(f, scope, ['left'], ['left']).notes.map(note => note.id))).toEqual(new Set(['left', 'root', 'shared']))
  expect(projectNoteCanvas(f, scope, [], []).notes).toEqual([])
})
it('retains every original held position, including temporarily hidden identities', () => {
  const held = { root: { x: -123.5, y: 443 }, hidden: { x: 900, y: 90 } }
  const positions = initialCanvasPositions(['root', 'new'], held)
  expect(positions.root).toEqual(held.root); expect(positions.hidden).toEqual(held.hidden)
  expect(positions.new!.y).toBeGreaterThan(held.root.y)
  expect(held).not.toHaveProperty('new')
})
it('uses the existing Graphviz engine for real non-overlapping sized Note coordinates, including cycles', async () => {
  const nodes = [{ id: 'note-with-"quotes', width: 288, height: 420 }, { id: 'other', width: 288, height: 154 }, { id: 'single', width: 288, height: 154 }]
  const result = await arrangeNoteCanvas({ nodes, edges: [{ source: nodes[0]!.id, target: 'other' }, { source: 'other', target: nodes[0]!.id }, { source: 'other', target: 'other' }] })
  expect(Object.keys(result).sort()).toEqual(nodes.map(node => node.id).sort())
  for (const a of nodes) for (const b of nodes) if (a !== b) { const p = result[a.id]!, q = result[b.id]!; expect(p.x + a.width <= q.x || q.x + b.width <= p.x || p.y + a.height <= q.y || q.y + b.height <= p.y).toBe(true) }
})
