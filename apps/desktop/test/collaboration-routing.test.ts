import { expect, it } from 'vitest'
import { collaborationGeometry, createCollaborationGeometrySelector, type CollaborationBox, type CollaborationPoint } from '../src/renderer/src/lib/collaboration-geometry'
import { routeCollaboration } from '../src/renderer/src/lib/collaboration-routing'
import type { CollaborationArea } from '../src/renderer/src/lib/agent-collaboration'
import { collaborationAgentNode, collaborationAreaNode } from '../src/renderer/src/lib/collaboration-presentation'
const areas: CollaborationArea[] = [
  { id: 'first', name: 'Project', kind: 'project', members: Array.from({ length: 8 }, (_, i) => `a-${i}`) },
  { id: 'second', name: 'Topic', kind: 'topic', members: Array.from({ length: 5 }, (_, i) => `b-${i}`) },
  { id: 'third', name: 'Mote', kind: 'mote', members: ['c-0', 'c-1', 'c-2'] },
  { id: 'last', name: 'References', kind: 'unplaced', members: ['d-0'] }
]
const kinds = ['communication', 'creation', 'supervision'] as const
function sample(path: string) {
  const tokens = path.match(/[MLQ]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!, result: CollaborationPoint[] = []
  let at = { x: 0, y: 0 }, index = 0
  const number = () => Number(tokens[index++])
  while (index < tokens.length) {
    const op = tokens[index++]!
    if (op === 'M') { at = { x: number(), y: number() }; result.push(at); continue }
    const start = at, control = { x: number(), y: number() }, end = op === 'Q' ? { x: number(), y: number() } : control
    const steps = Math.max(8, Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / 2))
    for (let step = 1; step <= steps; step++) {
      const t = step / steps
      result.push(op === 'Q' ? { x: (1-t)**2*start.x+2*(1-t)*t*control.x+t*t*end.x, y: (1-t)**2*start.y+2*(1-t)*t*control.y+t*t*end.y } : { x: start.x+t*(end.x-start.x), y: start.y+t*(end.y-start.y) })
    }
    at = end
  }
  return result
}
function obstacles(boxes: ReadonlyMap<string, CollaborationBox>) {
  return [...boxes.values()].map(box => box.kind === 'area' && !box.folded ? { ...box, height: 40 } : box)
}
function collisions(points: readonly CollaborationPoint[], boxes: ReturnType<typeof obstacles>) {
  return boxes.filter(box => points.some(point => point.x > box.x + .1 && point.x < box.x + box.width - .1 && point.y > box.y + .1 && point.y < box.y + box.height - .1)).map(box => box.id)
}

it('routes actual SVG around every card and heading for same-column, reciprocal, cross-area and uneven districts', () => {
  const boxes = collaborationGeometry(areas, new Set()), cards = [...boxes.values()].filter(box => box.kind === 'agent'), blocked = obstacles(boxes)
  let inspected = 0
  for (const from of cards) for (const to of cards) if (from.id !== to.id) for (const kind of kinds) {
    const route = routeCollaboration(boxes, { id: `${kind}:${from.id}:${to.id}`, source: from.id, target: to.id, kind })
    expect(collisions(sample(route.path), blocked), `${kind}: ${from.id} → ${to.id}`).toEqual([])
    expect(route.points.length).toBeLessThanOrEqual(9); inspected++
  }
  expect(inspected).toBeGreaterThan(600)
})

it('keeps original role ports, arrow direction and reciprocal lanes at exact fixed card boundaries', () => {
  const boxes = collaborationGeometry(areas, new Set()), source = collaborationAgentNode('first', 'a-0'), target = collaborationAgentNode('first', 'a-2')
  const paths = new Set<string>(), verticalLanes = new Set<number>()
  for (const [index, kind] of kinds.entries()) for (const [from, to] of [[source, target], [target, source]]) {
    const route = routeCollaboration(boxes, { id: kind+from, source: from!, target: to!, kind })
    expect(route.sourceHandle).toBe(`${kind}-out-right`); expect(route.targetHandle).toBe(`${kind}-in-right`)
    // Independently specified original role fractions; a shared wrong port helper cannot satisfy this oracle.
    const sourceBox = boxes.get(from!)!, targetBox = boxes.get(to!)!
    expect(route.points[0]!.x).toBe(sourceBox.x + 250)
    expect(route.points[0]!.y).toBeCloseTo(sourceBox.y + (index * 2 + .5) / 6 * 94)
    expect(route.points.at(-1)!.x).toBe(targetBox.x + 250)
    expect(route.points.at(-1)!.y).toBeCloseTo(targetBox.y + (index * 2 + 1.5) / 6 * 94)
    expect(route.points[1]!.x).toBeGreaterThan(route.points[0]!.x)
    expect(route.points.at(-2)!.x).toBeGreaterThan(route.points.at(-1)!.x)
    const vertical = route.points.find((point, at) => at > 0 && point.x === route.points[at - 1]!.x && point.y !== route.points[at - 1]!.y)
    expect(vertical).toBeDefined(); verticalLanes.add(vertical!.x)
    paths.add(route.path)
  }
  expect(paths.size).toBe(6)
  expect(verticalLanes.size).toBe(6)
})

it('preserves safe original endpoints and paths when either district is folded', () => {
  const boxes = collaborationGeometry(areas, new Set(['first', 'last'])), blocked = obstacles(boxes)
  const endpoints = [...boxes.values()].filter(box => box.kind === 'agent' || box.folded)
  let inspected = 0
  for (const from of endpoints) for (const to of endpoints) if (from.id !== to.id) for (const kind of kinds) {
    const route = routeCollaboration(boxes, { id: kind+from.id+to.id, source: from.id, target: to.id, kind })
    expect(collisions(sample(route.path), blocked), `${from.id} → ${to.id}`).toEqual([]); inspected++
  }
  expect(inspected).toBeGreaterThan(100)
  expect(boxes.get(collaborationAreaNode('first'))!.height).toBe(48)
})

it('reads exactly the two endpoints regardless of unrelated world size', () => {
  const large = [{ ...areas[0]!, members: Array.from({ length: 2000 }, (_, i) => `a-${i}`) }, ...areas.slice(1)]
  const boxes = collaborationGeometry(large, new Set()), source = collaborationAgentNode('first', 'a-0'), target = collaborationAgentNode('second', 'b-1')
  let lookups = 0, scanned = 0
  const watched = new Proxy(boxes, { get(map, key) {
    if (key === 'get') return (id: string) => { lookups++; return map.get(id) }
    if (key === 'values') return () => { scanned++; return map.values() }
    const value = Reflect.get(map, key, map); return typeof value === 'function' ? value.bind(map) : value
  } })
  const route = routeCollaboration(watched, { id: 'original', source, target, kind: 'communication' })
  expect(route.path).toContain('Q'); expect(lookups).toBe(2); expect(scanned).toBe(0)
})

it('bounds include a corridor detour even when both endpoint cards lie outside that viewport', () => {
  const boxes = collaborationGeometry(areas, new Set()), source = collaborationAgentNode('first', 'a-0'), target = collaborationAgentNode('third', 'c-0')
  const route = routeCollaboration(boxes, { id: 'detour', source, target, kind: 'communication' })
  expect(Math.max(boxes.get(source)!.x + 250, boxes.get(target)!.x + 250)).toBeLessThan(580)
  expect(route.bounds.x + route.bounds.width).toBeGreaterThan(600)
  expect(sample(route.path).every(point => point.x >= route.bounds.x && point.x <= route.bounds.x+route.bounds.width && point.y >= route.bounds.y && point.y <= route.bounds.y+route.bounds.height)).toBe(true)
})

it('reuses exact world geometry through metadata clones and only recalculates for actual membership or folding', () => {
  const select = createCollaborationGeometrySelector(), initial = select(areas, new Set())
  expect(initial.size).toBeGreaterThan(10)
  expect(select(areas.map(area => ({ ...area, name: area.name+' updated', members: [...area.members] })), new Set())).toBe(initial)
  const changed = select([{ ...areas[0]!, members: [...areas[0]!.members, 'new-agent'] }, ...areas.slice(1)], new Set())
  expect(changed).not.toBe(initial); expect(changed.has(collaborationAgentNode('first', 'new-agent'))).toBe(true)
  expect(select(areas, new Set(['first']))).not.toBe(changed)
})
