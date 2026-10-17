import { expect, it } from 'vitest'
import { collaborationAgentNode, collaborationAreaNode, collaborationConnections } from '../src/renderer/src/lib/collaboration-presentation'
import { visibleCollaboration, type CollaborationArea, type CollaborationRelation } from '../src/renderer/src/lib/agent-collaboration'
const areas: CollaborationArea[] = [
  { id: 'mote', name: 'Mote', kind: 'mote', members: ['a', 'b'] },
  { id: 'topic', name: 'Topic', kind: 'topic', members: ['a', 'b', 'c'] },
  { id: 'project', name: 'Project', kind: 'project', members: ['d'] }
]
const relation = (id: string, source: string, target: string, kind: CollaborationRelation['kind'] = 'communication'): CollaborationRelation => ({ id, source, target, kind, evidence: [] })
const records = [relation('message-ab', 'a', 'b'), relation('spawn-ab', 'a', 'b', 'creation'), relation('message-ac', 'a', 'c'), relation('message-dc', 'd', 'c')]
it('projects each original relation once when the same Agents participate in several areas', () => {
  const result = collaborationConnections(areas, records, new Set())
  expect(result.connections.flatMap(value => value.relations)).toEqual(records)
  expect(result.connections.find(value => value.relations.includes(records[0]!))).toMatchObject({ source: collaborationAgentNode('mote', 'a'), target: collaborationAgentNode('mote', 'b') })
  expect(result.connections.find(value => value.relations.includes(records[2]!))).toMatchObject({ source: collaborationAgentNode('topic', 'a'), target: collaborationAgentNode('topic', 'c') })
  expect(result.internal.size).toBe(0)
})
it('retains folded internal originals and original cross-area direction without inventing duplicate relationships', () => {
  const result = collaborationConnections(areas, records, new Set(['mote', 'topic', 'project']))
  expect(result.internal.get('mote')).toEqual(records.slice(0, 2)); expect(result.internal.get('topic')).toEqual([records[2]])
  expect(result.connections).toHaveLength(1)
  expect(result.connections[0]).toMatchObject({ source: collaborationAreaNode('project'), target: collaborationAreaNode('topic'), relations: [records[3]] })
  expect([...result.internal.values()].flat().concat(result.connections.flatMap(value => value.relations))).toHaveLength(records.length)
})
it('applies kind filtering before folding so internal counts and grouped originals obey the same visible set', () => {
  const filtered = visibleCollaboration(records, new Set(['a', 'b', 'c', 'd']), new Set(['creation']))
  const result = collaborationConnections(areas, filtered, new Set(['mote']))
  expect(result.internal.get('mote')).toEqual([records[1]]); expect(result.connections).toEqual([])
  const expanded = collaborationConnections(areas, filtered, new Set())
  expect(expanded.connections.flatMap(value => value.relations)).toEqual([records[1]])
})
