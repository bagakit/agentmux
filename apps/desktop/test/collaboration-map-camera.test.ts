import { expect, it } from 'vitest'
import { collaborationSubjectKey, type CollaborationAgent, type CollaborationArea } from '../src/renderer/src/lib/agent-collaboration'
import { collaborationAgentNode, collaborationAreaNode } from '../src/renderer/src/lib/collaboration-presentation'
import { collaborationCameraTarget } from '../src/renderer/src/lib/collaboration-map-camera'
import type { CollaborationLayoutBox } from '../src/renderer/src/lib/collaboration-layout-engine'

const agent = (hostId: string, tier: CollaborationAgent['tier']): CollaborationAgent => {
  const subject = { hostId, agentSessionId: 'same-session' }
  return { id: collaborationSubjectKey(subject), subject, sessionId: subject.agentSessionId, tier }
}
function nestedWorld() {
  const local = agent('local', 'idle'), remote = agent('remote', 'active')
  const agents = new Map([local, remote].map(value => [value.id, value]))
  const areas: CollaborationArea[] = [
    { id: 'elsewhere', name: 'Other original occurrence', kind: 'topic', members: [remote.id] },
    { id: 'root', name: 'Original parent', kind: 'project', members: [] },
    { id: 'middle', name: 'Original middle', kind: 'category', parentId: 'root', members: [] },
    { id: 'leaf', name: 'Original leaf', kind: 'topic', parentId: 'middle', members: [local.id, remote.id] },
  ]
  const region = (areaId: string, x: number, y: number, width = 6000, height = 4000): CollaborationLayoutBox => ({
    kind: 'area', id: collaborationAreaNode(areaId), areaId: collaborationAreaNode(areaId), folded: false,
    x, y, width, height, heading: { x: 24, y: 16, width: 180, height: 40 },
  })
  const occurrence = (areaId: string, member: CollaborationAgent, x: number, y: number): CollaborationLayoutBox => ({
    kind: 'agent', id: collaborationAgentNode(areaId, member.id), areaId: collaborationAreaNode(areaId), folded: false,
    x, y, width: 250, height: 94,
  })
  const boxes = [region('elsewhere', -9000, -7000, 500, 300), region('root', 0, 0), region('middle', 100, 100, 5600, 3600),
    region('leaf', 200, 200, 5200, 3200), occurrence('elsewhere', remote, -8900, -6900),
    occurrence('leaf', local, 400, 500), occurrence('leaf', remote, 4700, 2800)]
  return { local, remote, agents, areas, geometry: new Map(boxes.map(box => [box.id, box])) }
}
const viewport = { width: 600, height: 400 }

it('reads a real active descendant of a three-level large parent without inventing a parent or other Host occurrence', () => {
  const { areas, agents, geometry, remote } = nestedWorld(), originalAreas = structuredClone(areas), originalGeometry = structuredClone(geometry)
  const target = collaborationCameraTarget(geometry, areas, agents, viewport, { token: {}, areaIds: ['root'] })
  const anchor = geometry.get(collaborationAgentNode('leaf', remote.id))!
  expect(target).toEqual({ x: anchor.x + 125, y: anchor.y + 47, zoom: .85, anchor: anchor.id })
  expect(target?.anchor).not.toBe(collaborationAgentNode('elsewhere', remote.id))
  expect(geometry.has(collaborationAgentNode('root', remote.id))).toBe(false)
  expect(areas).toEqual(originalAreas); expect(geometry).toEqual(originalGeometry)
})

it('initial reading ranks real subtree activity and distinct members instead of empty direct parent membership', () => {
  const { areas, agents, geometry, remote } = nestedWorld()
  // The unrelated occurrence has the same active identity, while the parent
  // also contains a second original identity at three levels of depth.
  const target = collaborationCameraTarget(geometry, areas, agents, viewport)
  expect(target?.anchor).toBe(collaborationAgentNode('leaf', remote.id))
  expect(target?.zoom).toBe(.85)
})

it('keeps an explicitly folded parent on its original summary rather than an absent descendant', () => {
  const { areas, agents, geometry } = nestedWorld(), id = collaborationAreaNode('root'), box = geometry.get(id)!
  geometry.set(id, { ...box, folded: true })
  for (const [key, value] of geometry) if (value.kind === 'agent' && value.areaId !== collaborationAreaNode('elsewhere')) geometry.delete(key)
  expect(collaborationCameraTarget(geometry, areas, agents, viewport, { token: {}, areaIds: ['root'] }))
    .toEqual({ x: box.x + box.width / 2, y: box.y + box.height / 2, zoom: .7 })
})

it('centers the original empty parent even when it has empty descendants and a large hull', () => {
  const { areas, agents, geometry } = nestedWorld()
  const empty = areas.map(area => ({ ...area, members: [] })), box = geometry.get(collaborationAreaNode('root'))!
  expect(collaborationCameraTarget(geometry, empty, agents, viewport, { token: {}, areaIds: ['root'] }))
    .toEqual({ x: box.x + box.width / 2, y: box.y + box.height / 2, zoom: .7 })
})

it('reads an existing folded descendant summary when every member occurrence in a large parent is folded away', () => {
  const { areas, agents, geometry, local, remote } = nestedWorld()
  const visibleAreas = areas.filter(area => area.id !== 'leaf').map(area => area.id === 'middle' ? { ...area, members: [local.id, remote.id] } : area)
  const id = collaborationAreaNode('middle'), box = geometry.get(id)!
  geometry.set(id, { ...box, folded: true, width: 280, height: 100 })
  geometry.delete(collaborationAreaNode('leaf'))
  geometry.delete(collaborationAgentNode('leaf', local.id)); geometry.delete(collaborationAgentNode('leaf', remote.id))
  // A visible folded summary outside the requested subtree must never win.
  const elsewhereId = collaborationAreaNode('elsewhere')
  geometry.set(elsewhereId, { ...geometry.get(elsewhereId)!, folded: true })
  const original = structuredClone(geometry)
  expect(collaborationCameraTarget(geometry, visibleAreas, agents, viewport, { token: {}, areaIds: ['root'] }))
    .toEqual({ x: box.x + 140, y: box.y + 50, zoom: .85, anchor: id })
  expect(geometry).toEqual(original)
  expect(geometry.get(id)?.folded).toBe(true)
  expect(geometry.has(collaborationAgentNode('root', remote.id))).toBe(false)
})

it('retains explicit Agent locate identity and its original first exact occurrence', () => {
  const { areas, agents, geometry, local, remote } = nestedWorld()
  for (const [member, owner] of [[local, 'leaf'], [remote, 'elsewhere']] as const) {
    const box = geometry.get(collaborationAgentNode(owner, member.id))!
    expect(collaborationCameraTarget(geometry, areas, agents, viewport, { token: {}, agentId: member.id }))
      .toEqual({ x: box.x + 125, y: box.y + 47, zoom: 1, anchor: box.id })
  }
  expect(collaborationCameraTarget(geometry, areas, agents, viewport, { token: {}, agentId: 'unconfirmed' })).toBeNull()
})
