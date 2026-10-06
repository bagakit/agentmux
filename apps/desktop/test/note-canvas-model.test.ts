import { fixtureEpoch as _tailRefreshFixtureEpoch, fixturePath as _tailRefreshFixturePath } from "../../../test/fixture-values.mjs"
import { expect, it } from 'vitest'
import { emptyNotebookState } from '@agentmux/core/notebook-catalog'
import type { NotebookGraphSnapshot } from '../src/shared/notebook-observation'
import { projectNoteCanvas, initialCanvasPositions } from '../src/renderer/src/lib/note-canvas-model'
import { arrangeNoteCanvas } from '../src/renderer/src/lib/note-canvas-layout-engine'

function fixture(): NotebookGraphSnapshot {
  const catalog = emptyNotebookState()
  for (const id of ['root', 'left', 'shared', 'right', 'closed']) catalog.pages[id] = { noteId: id, notebookId: id === 'closed' ? 'other' : 'default', title: id, parentNoteId: null, createdAt: _tailRefreshFixtureEpoch(0, 0, 1), updatedAt: _tailRefreshFixtureEpoch(0, 0, 1), sources: [], topics: [], resource: { hostId: 'local', workspaceId: 'notes', workspacePath: _tailRefreshFixturePath("notes"), path: id + '.note.json' } }
  const reference = (from: string, to: string, suffix = '') => ({ source: { noteId: from, blockId: from + suffix }, sourceResource: catalog.pages[from]!.resource, target: { noteId: to, blockId: to + suffix }, referenceId: from + to + suffix, mode: 'reference' as const, resolution: to === 'outside' ? 'unknown' as const : 'resolved' as const })
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
it('collapses only unreachable context, keeping shared nodes and cycles reached by another expanded path', () => {
  const f = fixture(); f.graph.references = f.graph.references.filter(edge => edge.source.noteId !== 'shared')
  const scope = { kind: 'note', noteId: 'root' } as const
  expect(projectNoteCanvas(f, scope, ['root', 'left', 'right']).notes.some(note => note.id === 'shared')).toBe(true)
  expect(projectNoteCanvas(f, scope, ['root', 'right']).notes.some(note => note.id === 'shared')).toBe(true)
  expect(projectNoteCanvas(f, scope, ['root']).notes.some(note => note.id === 'shared')).toBe(false)
  expect(projectNoteCanvas(f, scope, []).notes.map(note => note.id)).toEqual(['root'])
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
