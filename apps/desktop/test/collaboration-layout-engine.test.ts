import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Graph, Subgraph } from '@viz-js/viz'
import { writeFileSync } from 'node:fs'
import { arrangeCollaboration, reconcileCollaborationLayout, routeCollaborationLayout, handleCollaborationLayoutRequest, collaborationLayoutStructureKey, type CollaborationLayoutBox, type CollaborationLayoutInput, type CollaborationLayoutConnection, type CollaborationLayoutResponse } from '../src/renderer/src/lib/collaboration-layout-engine'

const measurements = vi.hoisted(() => [] as { engine: string; nodes: string[]; edges: { source: string; target: string }[]; ms: number }[])
const captures = vi.hoisted(() => [] as unknown[])
vi.mock('@viz-js/viz', async importOriginal => {
  const actual = await importOriginal<typeof import('@viz-js/viz')>()
  return { ...actual, instance: async () => {
    const viz = await actual.instance(), render = viz.renderJSON.bind(viz)
    viz.renderJSON = (input, options) => {
      const started = performance.now()
      try {
        const result = render(input, options)
        if (process.env.AGENTMUX_COLLABORATION_LAYOUT_PROBE) captures.push({ input, options, result })
        return result
      }
      finally {
        const parts = (graph: Graph | Subgraph): (Graph | Subgraph)[] => [graph, ...(graph.subgraphs ?? []).flatMap(parts)]
        const actual = typeof input === 'string' ? [] : parts(input)
        measurements.push({ engine: options?.engine ?? '', nodes: actual.flatMap(graph => (graph.nodes ?? []).map(node => node.name)),
          edges: actual.flatMap(graph => (graph.edges ?? []).map(edge => ({ source: edge.tail, target: edge.head }))), ms: performance.now() - started })
      }
    }
    return viz
  } }
})
beforeEach(() => { measurements.length = 0; captures.length = 0 })

const box = (id: string, x: number, y: number, width = 250, height = 94, areaId = 'area'): Extract<CollaborationLayoutBox, { kind: 'agent' }> => ({ id, areaId, kind: 'agent', x, y, width, height, folded: false })
async function successfulRoutes(boxes: readonly CollaborationLayoutBox[], connections: readonly CollaborationLayoutConnection[]) {
  const errors: string[] = [], paths = await routeCollaborationLayout(boxes, connections, { onError: (_id, error) => errors.push(String(error)) })
  expect(errors).toEqual([]); return paths
}
const edge = (id: string, source: string, target: string, kind: CollaborationLayoutConnection['kind'] = 'communication') => ({ id, source, target, kind })
function contains(a: CollaborationLayoutBox, b: CollaborationLayoutBox) {
  return b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height
}
function intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}
const distance = (a: CollaborationLayoutBox, b: CollaborationLayoutBox) => Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2)
const heading = (id: string, x = 0, y = -120, areaId = id): CollaborationLayoutBox => ({ id, areaId, kind: 'area', folded: false,
  x: x - 24, y: y - 24, width: 1600, height: 300, heading: { x: 24, y: 24, width: 184, height: 40 } })
function adaptiveAddition() {
  const input: CollaborationLayoutInput = { areas: [{ id: 'work', name: 'Work', members: ['reading', 'peer'], folded: false }, { id: 'elsewhere', name: 'Other occurrence', members: ['same-session-elsewhere'], folded: false }],
    nodes: [{ id: 'reading', areaId: 'work', width: 154, height: 38 }, { id: 'peer', areaId: 'work', width: 154, height: 38 }, { id: 'same-session-elsewhere', areaId: 'elsewhere', width: 154, height: 38 }],
    connections: [{ ...edge('original', 'reading', 'peer'), strength: 8 }] }
  const boxes = [heading('work'), box('reading', 0, 0, 154, 38, 'work'), box('peer', 900, 0, 154, 38, 'work'), heading('elsewhere', 5000), box('same-session-elsewhere', 5000, 0, 154, 38, 'elsewhere')]
  const next: CollaborationLayoutInput = { ...input, areas: input.areas.map(area => area.id === 'work' ? { ...area, members: [...area.members, 'new'] } : area),
    nodes: [...input.nodes, { id: 'new', areaId: 'work', width: 154, height: 38 }],
    connections: [...input.connections, { ...edge('new-reading', 'new', 'reading'), strength: 8 }, { ...edge('new-peer', 'new', 'peer'), strength: 8 }] }
  return { input, boxes, next }
}
describe('finite collaboration Worker engine', () => {
  it('adapts a real force-arranged neighborhood to a new strong member and an internal deletion', async () => {
    const input: CollaborationLayoutInput = { areas: [{ id: 'work', name: 'Original work', members: Array.from({ length: 12 }, (_, index) => 'member-' + index), folded: false },
      { id: 'control', name: 'Unrelated control', members: ['control-member'], folded: false }],
      nodes: [...Array.from({ length: 12 }, (_, index) => ({ id: 'member-' + index, areaId: 'work', width: 154, height: 38 })), { id: 'control-member', areaId: 'control', width: 154, height: 38 }],
      connections: Array.from({ length: 11 }, (_, index) => edge('chain-' + index, 'member-' + index, 'member-' + (index + 1))) }
    const original = await arrangeCollaboration(input), before = new Map(original.map(box => [box.id, box])), reading = before.get('member-0')!
    const farthest = original.filter(box => box.kind === 'agent' && box.areaId === 'work' && box.id !== reading.id).sort((a, b) => distance(b, reading) - distance(a, reading) || a.id.localeCompare(b.id))[0]!
    const added: CollaborationLayoutInput = { ...input, areas: input.areas.map(area => area.id === 'work' ? { ...area, members: [...area.members, 'new-member'] } : area),
      nodes: [...input.nodes, { id: 'new-member', areaId: 'work', width: 154, height: 38 }], connections: [...input.connections,
        { ...edge('new-reader', 'new-member', reading.id), strength: 32 }, { ...edge('new-far', 'new-member', farthest.id), strength: 32 }] }
    const after = new Map(reconcileCollaborationLayout(added, original, reading.id, input).map(box => [box.id, box]))
    expect(distance(after.get(farthest.id)!, farthest)).toBeGreaterThan(1)
    const newLength = distance(after.get('new-member')!, after.get(reading.id)!) + distance(after.get('new-member')!, after.get(farthest.id)!)
    expect(newLength).toBeLessThan(distance(reading, farthest) * .95)
    for (const id of [reading.id, 'control', 'control-member']) expect(after.get(id)).toEqual(before.get(id))
    const internal = input.nodes.filter(node => node.areaId === 'work' && node.id !== reading.id && node.id !== farthest.id)
      .map(node => after.get(node.id)!).sort((a, b) => distance(a, after.get('new-member')!) - distance(b, after.get('new-member')!))[0]!
    const removed = { ...added, areas: added.areas.map(area => ({ ...area, members: area.members.filter(id => id !== internal.id) })),
      nodes: added.nodes.filter(node => node.id !== internal.id), connections: added.connections.filter(edge => edge.source !== internal.id && edge.target !== internal.id) }
    const survivors = new Map(reconcileCollaborationLayout(removed, [...after.values()], reading.id, added).map(box => [box.id, box]))
    // Freeze the two surrounding survivors before the deletion; their summed
    // radius measures the local hole without requiring an identity swap into its exact old slot.
    const surrounding = removed.nodes.filter(node => node.areaId === 'work' && node.id !== reading.id).map(node => after.get(node.id)!)
      .sort((a, b) => distance(a, internal) - distance(b, internal) || a.id.localeCompare(b.id)).slice(0, 2).map(box => box.id)
    const hole = (values: ReadonlyMap<string, CollaborationLayoutBox>) => surrounding.reduce((sum, id) => sum + distance(values.get(id)!, internal), 0)
    const moved = removed.nodes.filter(node => node.areaId === 'work' && node.id !== reading.id).map(node => distance(survivors.get(node.id)!, after.get(node.id)!))
    expect(Math.max(...moved)).toBeGreaterThan(1)
    expect(hole(survivors)).toBeLessThan(hole(after) * .95)
    expect(survivors.get(reading.id)).toEqual(reading)
    for (const id of ['control', 'control-member']) expect(survivors.get(id)).toEqual(before.get(id))
    await successfulRoutes([...survivors.values()], removed.connections)
    console.info(JSON.stringify({ candidate: 'real-force-adaptive', farthest: farthest.id, initialDistance: distance(reading, farthest), addedLength: newLength,
      deleted: internal.id, holeBefore: hole(after), holeAfter: hole(survivors), survivorMaxMovement: Math.max(...moved) }))
  })

  it('moves an old noncolliding neighbor on related addition and improves the independently bounded weighted distance', async () => {
    const { input, boxes, next } = adaptiveAddition(), before = new Map(boxes.map(box => [box.id, box]))
    const initialNew = box('new', 450, 47, 154, 38, 'work')
    for (const member of boxes.filter(box => box.kind === 'agent')) expect(intersects(initialNew, member)).toBe(false)
    const responses: CollaborationLayoutResponse[] = []
    await handleCollaborationLayoutRequest({ id: 'adaptive-add', type: 'reconcile', input: next, previousStructure: input, boxes, paths: [], anchor: 'reading' }, response => responses.push(response))
    const result = responses.find(response => response.type === 'boxes')!; if (result.type !== 'boxes') throw Error('Original Worker boxes required')
    const after = new Map(result.boxes.map(box => [box.id, box])), peer = after.get('peer')!
    expect(distance(peer, before.get('peer')!)).toBeGreaterThan(16)
    expect(distance(peer, before.get('peer')!)).toBeLessThanOrEqual(396 + 1e-6)
    // With the two old endpoints fixed 900px apart, these three equal springs
    // have a 7*(900+900) lower bound for every possible placement of the new node.
    const weighted = next.connections.reduce((sum, edge) => sum + 7 * distance(after.get(edge.source)!, after.get(edge.target)!), 0)
    expect(weighted).toBeLessThan(7 * 1800 * .85)
    expect(after.get('reading')).toEqual(before.get('reading'))
    for (const id of ['elsewhere', 'same-session-elsewhere']) expect(after.get(id)).toEqual(before.get(id))
    const bodies = result.boxes.map(box => box.kind === 'area' ? { ...box, x: box.x + box.heading.x, y: box.y + box.heading.y, width: box.heading.width, height: box.heading.height } : box)
    for (const [index, first] of bodies.entries()) for (const second of bodies.slice(index + 1))
      expect(intersects({ x: first.x - 28 + 1e-6, y: first.y - 28 + 1e-6, width: first.width + 56 - 2e-6, height: first.height + 56 - 2e-6 }, second), first.id + '/' + second.id).toBe(false)
    expect(result.work!.nodes).toBe(2); expect(result.work!.passes).toBeLessThanOrEqual(4)
    expect(result.work!.candidates).toBeGreaterThan(0); expect(result.work!.candidates).toBeLessThanOrEqual(2 * 4 * 48)
    expect(responses.filter(response => response.type === 'error')).toEqual([])
    expect(responses.filter(response => response.type === 'paths').flatMap(response => Object.keys(response.paths)).sort()).toEqual(next.connections.map(edge => edge.id).sort())
    const reordered = { ...next, areas: [...next.areas].reverse(), nodes: [...next.nodes].reverse(), connections: [...next.connections].reverse() }
    expect(reconcileCollaborationLayout(reordered, boxes, 'reading', input)).toEqual(result.boxes)
    console.info(JSON.stringify({ candidate: 'adaptive-addition', oldNeighborMovement: distance(peer, before.get('peer')!), weighted, fixedEndpointLowerBound: 12600, work: result.work }))
  })

  it.each(['remove', 'shrink'] as const)('reclaims an internal %s gap by moving a surviving neighbor rather than only shrinking its outline', async change => {
    const input: CollaborationLayoutInput = { areas: [{ id: 'work', name: 'Work', members: ['reading', 'middle', 'peer'], folded: false }],
      nodes: [{ id: 'reading', areaId: 'work', width: 154, height: 38 }, { id: 'middle', areaId: 'work', width: 500, height: 94 }, { id: 'peer', areaId: 'work', width: 154, height: 38 }], connections: [edge('survivors', 'reading', 'peer')] }
    const boxes = [heading('work'), box('reading', 0, 0, 154, 38, 'work'), box('middle', 500, 0, 500, 94, 'work'), box('peer', 1200, 0, 154, 38, 'work')]
    const next: CollaborationLayoutInput = { ...input, areas: input.areas.map(area => change === 'remove' ? { ...area, members: area.members.filter(id => id !== 'middle') } : area),
      nodes: change === 'remove' ? input.nodes.filter(node => node.id !== 'middle') : input.nodes.map(node => node.id === 'middle' ? { ...node, width: 154, height: 38 } : node) }
    const after = new Map(reconcileCollaborationLayout(next, boxes, 'reading', input).map(box => [box.id, box]))
    expect(distance(after.get('peer')!, boxes[3]!)).toBeGreaterThan(40)
    expect(distance(after.get('reading')!, after.get('peer')!)).toBeLessThan(1200 * .9)
    expect(distance(after.get('peer')!, boxes[3]!)).toBeLessThanOrEqual(396 + 1e-6)
    expect(after.get('reading')).toEqual(boxes[1])
    expect([...after.keys()].sort()).toEqual(['work', ...next.nodes.map(node => node.id)].sort())
    for (const node of next.nodes) expect(contains(after.get('work')!, after.get(node.id)!)).toBe(true)
    await successfulRoutes([...after.values()], next.connections)
    console.info(JSON.stringify({ candidate: 'adaptive-' + change, survivingMovement: distance(after.get('peer')!, boxes[3]!), originalSpan: 1200, finalSpan: distance(after.get('reading')!, after.get('peer')!) }))
  })

  it('settles real reparent and membership changes through three levels without moving the exact reading occurrence or an unrelated region', async () => {
    const input: CollaborationLayoutInput = { areas: [{ id: 'root', name: 'Original ancestor', members: [], folded: false },
      { id: 'middle', name: 'Original middle', parentId: 'root', members: [], folded: false }, { id: 'leaf', name: 'Original leaf', parentId: 'middle', members: ['reading', 'moved'], folded: false },
      { id: 'target', name: 'Target parent', members: ['peer'], folded: false }, { id: 'control', name: 'Unrelated', members: ['other-occurrence'], folded: false }],
      nodes: [['reading', 'leaf'], ['moved', 'leaf'], ['peer', 'target'], ['other-occurrence', 'control']].map(([id, areaId]) => ({ id: id!, areaId: areaId!, width: 154, height: 38 })),
      connections: [edge('local', 'reading', 'moved'), edge('target-neighbor', 'moved', 'peer')] }
    const boxes = await arrangeCollaboration(input), before = new Map(boxes.map(box => [box.id, box]))
    const next: CollaborationLayoutInput = { ...input, areas: input.areas.map(area => area.id === 'middle' ? { ...area, parentId: 'target' } : area.id === 'leaf' ? { ...area, members: ['reading'] } : area.id === 'target' ? { ...area, members: ['peer', 'moved'] } : area),
      nodes: input.nodes.map(node => node.id === 'moved' ? { ...node, areaId: 'target' } : node) }
    const after = new Map(reconcileCollaborationLayout(next, boxes, 'reading', input).map(box => [box.id, box]))
    expect(after.size).toBe(next.areas.length + next.nodes.length)
    expect(after.get('reading')).toEqual(before.get('reading'))
    for (const id of ['control', 'other-occurrence']) expect(after.get(id)).toEqual(before.get(id))
    for (const area of next.areas) if (area.parentId) expect(contains(after.get(area.parentId)!, after.get(area.id)!)).toBe(true)
    for (const node of next.nodes) expect(contains(after.get(node.areaId)!, after.get(node.id)!)).toBe(true)
    expect(after.get('moved')!.areaId).toBe('target')
    expect(contains(after.get('root')!, after.get('middle')!)).toBe(false)
    await successfulRoutes([...after.values()], next.connections)
    const readerMoved = { ...next, areas: next.areas.map(area => area.id === 'leaf' ? { ...area, members: [] } : area.id === 'target' ? { ...area, members: [...area.members, 'reading'] } : area),
      nodes: next.nodes.map(node => node.id === 'reading' ? { ...node, areaId: 'target' } : node) }
    const movedReader = new Map(reconcileCollaborationLayout(readerMoved, [...after.values()], 'reading', next).map(box => [box.id, box]))
    expect(movedReader.get('reading')).toEqual({ ...before.get('reading'), areaId: 'target' })
    for (const id of ['control', 'other-occurrence']) expect(movedReader.get(id)).toEqual(before.get(id))
    for (const node of readerMoved.nodes) expect(contains(movedReader.get(node.areaId)!, movedReader.get(node.id)!)).toBe(true)
  })

  it('keeps repeated structural inputs and evidence-only changes exactly settled without spending a placement budget', async () => {
    const { input, boxes, next } = adaptiveAddition(), settled = reconcileCollaborationLayout(next, boxes, 'reading', input)
    const metadata = { ...next, areas: next.areas.map(area => ({ ...area, name: area.name + ' renamed' })), connections: [...next.connections.map(edge => ({ ...edge, strength: 128 })), edge('new-evidence', 'peer', 'reading')] }
    expect(collaborationLayoutStructureKey(metadata)).toBe(collaborationLayoutStructureKey(next))
    for (let index = 0; index < 5; index++) {
      const work = { areas: 0, nodes: 0, passes: 0, candidates: 0 }
      expect(reconcileCollaborationLayout(metadata, settled, index % 2 ? 'peer' : 'reading', next, undefined, work)).toEqual(settled)
      expect(work).toEqual({ areas: 0, nodes: 0, passes: 0, candidates: 0 })
    }
  })

  it('treats a true child contour as a whole obstacle while a direct parent member adapts', () => {
    const input: CollaborationLayoutInput = { areas: [{ id: 'root', name: 'Parent', members: ['parent-member'], folded: false },
      { id: 'child', name: 'Child', parentId: 'root', members: ['reading', 'child-peer'], folded: false }],
      nodes: [{ id: 'parent-member', areaId: 'root', width: 154, height: 38 }, { id: 'reading', areaId: 'child', width: 154, height: 38 }, { id: 'child-peer', areaId: 'child', width: 154, height: 38 }],
      connections: [{ ...edge('across-parent', 'parent-member', 'reading'), strength: 32 }] }
    const child = { ...heading('child', 500), width: 1000, height: 450 }, boxes = [{ ...heading('root'), width: 2300, height: 700 }, child,
      box('parent-member', 0, 0, 154, 38, 'root'), box('reading', 700, 0, 154, 38, 'child'), box('child-peer', 1300, 200, 154, 38, 'child')]
    const next = { ...input, nodes: input.nodes.map(node => node.id === 'parent-member' ? { ...node, width: 160 } : node) }
    const after = new Map(reconcileCollaborationLayout(next, boxes, 'reading', input).map(box => [box.id, box]))
    expect(after.get('parent-member')!.x).toBeGreaterThan(1)
    expect(intersects(after.get('parent-member')!, after.get('child')!)).toBe(false)
    for (const id of ['child', 'reading', 'child-peer']) expect(after.get(id)).toEqual(boxes.find(box => box.id === id))
    expect(contains(after.get('root')!, after.get('child')!)).toBe(true)
  })

  it('keeps the full port corridor when a locally improving candidate could otherwise fit inside half the clearance', async () => {
    const input: CollaborationLayoutInput = { areas: [{ id: 'work', name: 'Original work', members: ['reading', 'peer'], folded: false }],
      nodes: [{ id: 'reading', areaId: 'work', width: 154, height: 38 }, { id: 'peer', areaId: 'work', width: 154, height: 38 }],
      connections: [{ ...edge('original', 'reading', 'peer'), strength: 2 }] }
    const boxes = [heading('work'), box('reading', 0, 0, 154, 38, 'work'), box('peer', 250, 0, 154, 38, 'work')]
    const next = { ...input, nodes: input.nodes.map(node => node.id === 'peer' ? { ...node, height: 40 } : node) }
    const after = new Map(reconcileCollaborationLayout(next, boxes, 'reading', input).map(box => [box.id, box]))
    expect(after.get('reading')).toEqual(boxes[1]); expect(after.get('peer')!.x).toBeLessThan(249)
    expect(after.get('peer')!.x - (after.get('reading')!.x + 154)).toBeGreaterThanOrEqual(28 - 1e-6)
    await successfulRoutes([...after.values()], next.connections)
  })

  it('cancels a structural neighborhood before publishing geometry or submitting any routing work', async () => {
    const { input, boxes, next } = adaptiveAddition(), controller = new AbortController(), responses: CollaborationLayoutResponse[] = []
    controller.abort(); measurements.length = 0
    await handleCollaborationLayoutRequest({ id: 'canceled-adaptive', type: 'reconcile', input: next, previousStructure: input, boxes, paths: [], anchor: 'reading' }, response => responses.push(response), controller.signal)
    expect(responses).toEqual([]); expect(measurements).toEqual([])
  })

  it('includes a genuine neighboring collision dependency while keeping a distant original region fixed', () => {
    const input: CollaborationLayoutInput = { areas: [{ id: 'reading-area', name: 'Reading', members: ['reading'], folded: false },
      { id: 'neighbor-area', name: 'Adjacent', members: ['neighbor'], folded: false }, { id: 'control', name: 'Distant', members: ['control-member'], folded: false }],
      nodes: [{ id: 'reading', areaId: 'reading-area', width: 154, height: 38 }, { id: 'neighbor', areaId: 'neighbor-area', width: 24, height: 24 }, { id: 'control-member', areaId: 'control', width: 154, height: 38 }], connections: [] }
    const boxes: CollaborationLayoutBox[] = [{ ...heading('reading-area'), width: 232, height: 206 },
      { id: 'neighbor-area', areaId: 'neighbor-area', kind: 'area', folded: false, x: 226, y: -144, width: 382, height: 192, heading: { x: 174, y: 24, width: 184, height: 40 } },
      box('reading', 0, 0, 154, 38, 'reading-area'), box('neighbor', 250, 0, 24, 24, 'neighbor-area'), heading('control', 5000), box('control-member', 5000, 0, 154, 38, 'control')]
    const next = { ...input, nodes: input.nodes.map(node => node.id === 'reading' ? { ...node, width: 500, height: 94 } : node) }, work = { areas: 0, nodes: 0, passes: 0, candidates: 0 }
    const after = new Map(reconcileCollaborationLayout(next, boxes, 'reading', input, undefined, work).map(box => [box.id, box]))
    expect([after.get('reading')!.x + 250, after.get('reading')!.y + 47]).toEqual([77, 19])
    expect(intersects(after.get('reading')!, after.get('neighbor')!)).toBe(false)
    expect(after.get('neighbor')).not.toEqual(boxes.find(box => box.id === 'neighbor'))
    expect(work.areas).toBe(2); expect(work.nodes).toBe(1)
    for (const id of ['control', 'control-member']) expect(after.get(id)).toEqual(boxes.find(box => box.id === id))
  })

  it('keeps local placement and reroute submission budgets unchanged when 240 unrelated original regions are added', async () => {
    const { input, boxes, next } = adaptiveAddition(), results: { work: unknown; submitted: string[] }[] = []
    for (const count of [0, 240]) {
      const extra = Array.from({ length: count }, (_, index) => {
        const id = 'unrelated-' + index, x = 15000 + index * 2000
        return { area: { id, name: id, members: [id + '-a', id + '-b'], folded: false },
          nodes: ['a', 'b'].map(suffix => ({ id: id + '-' + suffix, areaId: id, width: 154, height: 38 })),
          boxes: [heading(id, x), box(id + '-a', x, 0, 154, 38, id), box(id + '-b', x + 500, 0, 154, 38, id)], connection: edge(id + '-edge', id + '-a', id + '-b') }
      })
      const before = { ...input, areas: [...input.areas, ...extra.map(value => value.area)], nodes: [...input.nodes, ...extra.flatMap(value => value.nodes)], connections: [...input.connections, ...extra.map(value => value.connection)] }
      const after = { ...next, areas: [...next.areas, ...extra.map(value => value.area)], nodes: [...next.nodes, ...extra.flatMap(value => value.nodes)], connections: [...next.connections, ...extra.map(value => value.connection)] }
      const allBoxes = [...boxes, ...extra.flatMap(value => value.boxes)], paths = await successfulRoutes(allBoxes, before.connections), responses: CollaborationLayoutResponse[] = []
      measurements.length = 0
      await handleCollaborationLayoutRequest({ id: 'cost-' + count, type: 'reconcile', input: after, previousStructure: before, boxes: allBoxes, paths, anchor: 'reading' }, response => responses.push(response))
      const placement = responses.find(response => response.type === 'boxes')!; if (placement.type !== 'boxes') throw Error('Worker placement receipt required')
      for (const original of extra.flatMap(value => value.boxes)) expect(placement.boxes.find(box => box.id === original.id)).toEqual(original)
      const submitted = responses.filter(response => response.type === 'paths').flatMap(response => Object.keys(response.paths)).sort()
      expect(responses.filter(response => response.type === 'error')).toEqual([])
      expect(submitted).toEqual(next.connections.map(edge => edge.id).sort())
      expect(measurements.every(value => value.engine !== 'fdp')).toBe(true)
      results.push({ work: placement.work, submitted })
    }
    expect(results[1]).toEqual(results[0])
  })

  it('reserves physical port clearance in nested force packing so unchanged reconciliation keeps every member fixed', async () => {
    const nodes = Array.from({ length: 24 }, (_, index) => ({ id: 'member-' + String(index).padStart(2, '0'),
      areaId: index < 2 ? 'leaf' : 'root', width: 250, height: 94 }))
    const connections = [edge('neighbors', nodes[0]!.id, nodes[1]!.id), edge('across-ancestors', nodes[1]!.id, nodes[2]!.id)]
    const input: CollaborationLayoutInput = { nodes, connections, areas: [
      { id: 'root', name: 'Original parent', members: nodes.slice(2).map(node => node.id), folded: false },
      { id: 'middle', name: 'Original ancestor without direct members', members: [], folded: false, parentId: 'root' },
      { id: 'leaf', name: 'Original nested neighborhood', members: nodes.slice(0, 2).map(node => node.id), folded: false, parentId: 'middle' }
    ] }
    const boxes = await arrangeCollaboration(input), members = boxes.filter(box => box.kind === 'agent')
    for (let left = 0; left < members.length; left++) for (let right = left + 1; right < members.length; right++) {
      const a = members[left]!, b = members[right]!
      expect(intersects({ x: a.x - 14, y: a.y - 14, width: a.width + 28, height: a.height + 28 }, b),
        'Real cards need room for their 8px stems and the unchanged reconciliation clearance').toBe(false)
    }
    const settled = new Map(reconcileCollaborationLayout(input, boxes, null, input).map(box => [box.id, box]))
    for (const member of members) expect(settled.get(member.id)).toEqual(member)
    const paths = await successfulRoutes(boxes, connections)
    expect(paths.map(path => path.id).sort()).toEqual(connections.map(edge => edge.id).sort())
    // The unchanged original card bodies, not the padded force boxes, remain routing obstacles.
    for (const path of paths) for (let segment = 0; segment < path.points.length - 1; segment += 3) {
      const [a, b, c, d] = path.points.slice(segment, segment + 4)
      for (let index = 1; index < 80; index++) {
        const t = index / 80, u = 1 - t
        const x = u ** 3 * a!.x + 3 * u * u * t * b!.x + 3 * u * t * t * c!.x + t ** 3 * d!.x
        const y = u ** 3 * a!.y + 3 * u * u * t * b!.y + 3 * u * t * t * c!.y + t ** 3 * d!.y
        for (const body of members) expect(x > body.x + .25 && x < body.x + body.width - .25 && y > body.y + .25 && y < body.y + body.height - .25).toBe(false)
      }
    }
  })

  it('keeps the exact empty shelf headings fixed through unchanged reconciliation', async () => {
    const input: CollaborationLayoutInput = { nodes: [{ id: 'original-member', areaId: 'occupied', width: 250, height: 94 }], connections: [],
      areas: [{ id: 'occupied', name: 'Original occupied area', members: ['original-member'], folded: false },
        ...Array.from({ length: 24 }, (_, index) => ({ id: 'empty-' + String(index).padStart(2, '0'), name: 'Original empty place', members: [], folded: false }))] }
    const boxes = await arrangeCollaboration(input), settled = new Map(reconcileCollaborationLayout(input, boxes, null, input).map(box => [box.id, box]))
    const headings = boxes.filter(box => box.kind === 'area').map(box => ({ ...box, x: box.x + box.heading.x, y: box.y + box.heading.y, width: box.heading.width, height: box.heading.height }))
    for (const [index, first] of headings.entries()) for (const second of headings.slice(index + 1))
      expect(intersects({ x: first.x - 14, y: first.y - 14, width: first.width + 28, height: first.height + 28 }, second)).toBe(false)
    for (const box of boxes) {
      const after = settled.get(box.id)!
      if (box.kind === 'agent') expect(after).toEqual(box)
      else {
        expect(after.kind).toBe('area')
        if (after.kind === 'area') expect({ x: after.x + after.heading.x, y: after.y + after.heading.y, width: after.heading.width, height: after.heading.height })
          .toEqual({ x: box.x + box.heading.x, y: box.y + box.heading.y, width: box.heading.width, height: box.heading.height })
      }
    }
  })

  it('lets expanded cached members yield to current occupants of their former positions', () => {
    const area = (id: string, x: number, folded: boolean): CollaborationLayoutBox => ({ id, areaId: id, kind: 'area', folded, x, y: -100, width: 276, height: folded ? 54 : 200, heading: { x: 0, y: 0, width: 184, height: 40 } })
    const cached = [area('folded', 400, true), area('visible', 0, false), box('a', 0, 0, 24, 24, 'folded'), box('b', 0, 0, 24, 24, 'visible')]
    const input: CollaborationLayoutInput = { areas: [{ id: 'folded', name: 'Unfolded now', folded: false, members: ['a'] }, { id: 'visible', name: 'Still visible', folded: false, members: ['b'] }],
      nodes: [{ id: 'a', areaId: 'folded', width: 24, height: 24 }, { id: 'b', areaId: 'visible', width: 24, height: 24 }], connections: [] }
    const previousStructure = { ...input, areas: input.areas.map(area => area.id === 'folded' ? { ...area, folded: true } : area) }
    const result = reconcileCollaborationLayout(input, cached, null, previousStructure)
    expect(result.find(box => box.id === 'b')).toEqual(cached[3]); expect(intersects(result.find(box => box.id === 'a')!, cached[3]!)).toBe(false)
  })

  it('lets a newly discovered area title yield to established unrelated members', () => {
    const previous: CollaborationLayoutBox[] = [
      { id: 'work', areaId: 'work', kind: 'area', folded: false, x: -24, y: -124, width: 700, height: 200, heading: { x: 24, y: 24, width: 184, height: 40 } },
      box('a', 0, 0, 24, 24, 'work'), box('b', 600, 0, 24, 24, 'work')
    ]
    const input: CollaborationLayoutInput = { areas: [{ id: 'work', name: 'Work', members: ['a', 'b'], folded: false }, { id: 'new-area', name: 'New empty area', members: [], folded: false }],
      nodes: ['a', 'b'].map(id => ({ id, areaId: 'work', width: 24, height: 24 })), connections: [] }
    const result = reconcileCollaborationLayout(input, previous, 'b', { ...input, areas: input.areas.filter(area => area.id !== 'new-area') })
    expect(result.find(box => box.id === 'a')).toEqual(previous[1]); expect(result.find(box => box.id === 'b')).toEqual(previous[2])
    expect(intersects(result.find(box => box.id === 'new-area')!, previous[1]!)).toBe(false)
  })

  it('pins a growing actual reading occurrence while its related neighborhood can adjust', () => {
    const previous: CollaborationLayoutBox[] = [
      { id: 'work', areaId: 'work', kind: 'area', folded: false, x: -24, y: -144, width: 900, height: 240, heading: { x: 24, y: 24, width: 184, height: 40 } },
      box('reading', 0, 0, 154, 38, 'work'), box('neighbor', 190, 0, 24, 24, 'work'), box('unrelated', 600, 0, 24, 24, 'work')
    ]
    const input: CollaborationLayoutInput = { areas: [{ id: 'work', name: 'Work', members: ['reading', 'neighbor', 'unrelated'], folded: false }],
      nodes: [{ id: 'reading', areaId: 'work', width: 250, height: 94 }, ...['neighbor', 'unrelated'].map(id => ({ id, areaId: 'work', width: 24, height: 24 }))], connections: [] }
    const previousStructure = { ...input, nodes: input.nodes.map(node => node.id === 'reading' ? { ...node, width: 154, height: 38 } : node) }
    const result = reconcileCollaborationLayout(input, previous, 'reading', previousStructure), reading = result.find(box => box.id === 'reading')!, neighbor = result.find(box => box.id === 'neighbor')!
    expect([reading.x + reading.width / 2, reading.y + reading.height / 2]).toEqual([77, 19])
    expect(intersects(reading, neighbor)).toBe(false); expect(neighbor).not.toEqual(previous[2])
    for (const member of result.filter(box => box.kind === 'agent' && box.id !== 'reading')) expect(intersects(reading, member)).toBe(false)
  })


  it('locally settles new and resized members while retaining unrelated geometry and exact title positions', async () => {
    const input: CollaborationLayoutInput = {
      areas: [{ id: 'work', name: 'Work', members: ['a', 'b'], folded: false }, { id: 'other', name: 'Other', members: ['c'], folded: false }],
      nodes: [{ id: 'a', areaId: 'work', width: 154, height: 38 }, { id: 'b', areaId: 'work', width: 250, height: 94 }, { id: 'c', areaId: 'other', width: 24, height: 24 }],
      connections: [edge('a-b', 'a', 'b')]
    }
    const original = await arrangeCollaboration(input), before = new Map(original.map(box => [box.id, box]))
    measurements.length = 0
    const next = { ...input, areas: input.areas.map(area => area.id === 'work' ? { ...area, members: [...area.members, 'new'] } : area),
      nodes: [...input.nodes.map(node => node.id === 'a' ? { ...node, width: 250, height: 94 } : node), { id: 'new', areaId: 'work', width: 154, height: 38 }],
      connections: [...input.connections, edge('a-new', 'a', 'new')] }
    const boxes = reconcileCollaborationLayout(next, original, 'a', input), after = new Map(boxes.map(box => [box.id, box]))
    expect(measurements).toEqual([])
    expect(after.get('c')).toEqual(before.get('c'))
    const a = after.get('a')!, held = before.get('a')!
    expect([a.x + a.width / 2, a.y + a.height / 2]).toEqual([held.x + held.width / 2, held.y + held.height / 2])
    for (const id of ['work', 'other']) {
      const old = before.get(id)!, current = after.get(id)!
      if (old.kind !== 'area' || current.kind !== 'area') throw Error('Original area required')
      expect([current.x + current.heading.x, current.y + current.heading.y]).toEqual([old.x + old.heading.x, old.y + old.heading.y])
    }
    const obstacles = boxes.map(box => box.kind === 'area' ? { ...box, x: box.x + box.heading.x, y: box.y + box.heading.y, width: box.heading.width, height: box.heading.height } : box)
    for (const [index, first] of obstacles.entries()) for (const second of obstacles.slice(index + 1)) expect(intersects(first, second), first.id + '/' + second.id).toBe(false)
    const foldedInput = { ...next, areas: next.areas.map(area => area.id === 'work' ? { ...area, folded: true } : area) }
    const folded = reconcileCollaborationLayout(foldedInput, boxes, 'work', next)
    const retained = new Map([...boxes, ...folded].map(box => [box.id, box]))
    const unfolded = reconcileCollaborationLayout(next, [...retained.values()], 'work', foldedInput)
    expect(unfolded.find(box => box.id === 'c')).toEqual(after.get('c'))
    for (const id of ['a', 'b', 'new']) expect(contains(unfolded.find(box => box.id === 'work')!, unfolded.find(box => box.id === id)!)).toBe(true)
  })

  it('reroutes an old nonincident path blocked by a resized member and retains an unaffected original path', async () => {
    const boxes: CollaborationLayoutBox[] = [
      { id: 'area', areaId: 'area', kind: 'area', folded: false, x: -24, y: -120, width: 950, height: 900, heading: { x: 24, y: 24, width: 184, height: 40 } },
      { id: 'obstacles', areaId: 'obstacles', kind: 'area', folded: false, x: 376, y: 46, width: 232, height: 318, heading: { x: 24, y: 254, width: 184, height: 40 } },
      box('a', 0, 0), box('b', 650, 0), box('obstacle', 400, 70, 50, 10, 'obstacles'), box('d', 0, 600), box('e', 650, 600)
    ]
    const connections = [edge('a-b', 'a', 'b'), edge('d-e', 'd', 'e')], paths = await successfulRoutes(boxes, connections)
    const input: CollaborationLayoutInput = { areas: [{ id: 'area', name: 'Work', members: ['a', 'b', 'd', 'e'], folded: false }, { id: 'obstacles', name: 'Original child', parentId: 'area', members: ['obstacle'], folded: false }],
      nodes: boxes.filter(box => box.kind === 'agent').map(box => ({ id: box.id, areaId: box.areaId, width: box.width, height: box.id === 'obstacle' ? 180 : box.height })), connections }
    const responses: CollaborationLayoutResponse[] = []
    measurements.length = 0
    const previousStructure = { ...input, nodes: input.nodes.map(node => node.id === 'obstacle' ? { ...node, height: 10 } : node) }
    await handleCollaborationLayoutRequest({ id: 'local-update', type: 'reconcile', input, previousStructure, boxes, paths, anchor: 'a' }, response => responses.push(response))
    const placement = responses.find(response => response.type === 'boxes')!
    expect(placement.type).toBe('boxes'); if (placement.type !== 'boxes') throw Error('Updated original geometry required')
    for (const id of ['a', 'b', 'd', 'e']) expect(placement.boxes.find(box => box.id === id)).toEqual(boxes.find(box => box.id === id))
    expect(placement.retainedPaths).toEqual(['d-e'])
    expect(responses.filter(response => response.type === 'error')).toEqual([])
    expect(responses.filter(response => response.type === 'paths').flatMap(response => Object.keys(response.paths))).toEqual(['a-b'])
    expect(measurements.every(measurement => measurement.engine !== 'fdp')).toBe(true)
    expect(responses.at(-1)?.type).toBe('complete')
  })

  it.each(['remove', 'shrink'] as const)('releases a cleared %s obstacle detour through the original Worker while retaining unrelated paths', async change => {
    const area = (id: string, x: number, y: number, width: number, height: number): CollaborationLayoutBox => ({
      kind: 'area', id, areaId: id, x, y, width, height, folded: false, heading: { x: 24, y: 0, width: 184, height: 40 }
    })
    const boxes: CollaborationLayoutBox[] = [
      area('left', -24, -90, 300, 220), box('a', 0, 0, 250, 94, 'left'),
      area('right', 626, -90, 300, 220), box('b', 650, 0, 250, 94, 'right'),
      area('middle', 276, -180, 300, 375), box('obstacle', 300, -80, 250, 250, 'middle'),
      area('control', -24, 480, 950, 240), box('d', 0, 600, 250, 94, 'control'), box('e', 650, 600, 250, 94, 'control')
    ]
    const connections = [edge('a-b', 'a', 'b'), edge('d-e', 'd', 'e')], paths = await successfulRoutes(boxes, connections)
    const previousStructure = { areas: [
      { id: 'left', name: 'Left', members: ['a'], folded: false }, { id: 'right', name: 'Right', members: ['b'], folded: false },
      { id: 'middle', name: 'Obstacle', members: ['obstacle'], folded: false }, { id: 'control', name: 'Control', members: ['d', 'e'], folded: false }
    ], nodes: boxes.filter(box => box.kind === 'agent').map(({ id, areaId, width, height }) => ({ id, areaId, width, height })) }
    const input = { areas: previousStructure.areas.map(area => change === 'remove' && area.id === 'middle' ? { ...area, members: [] } : area),
      nodes: change === 'remove' ? previousStructure.nodes.filter(node => node.id !== 'obstacle')
        : previousStructure.nodes.map(node => node.id === 'obstacle' ? { ...node, width: 24, height: 24 } : node), connections }
    const responses: CollaborationLayoutResponse[] = []
    measurements.length = 0
    await handleCollaborationLayoutRequest({ id: 'cleared-' + change, type: 'reconcile', input, previousStructure, boxes, paths, anchor: 'a' }, response => responses.push(response))
    const placement = responses.find(response => response.type === 'boxes')!
    if (placement.type !== 'boxes') throw Error('Original Worker geometry required')
    for (const id of ['a', 'b', 'control', 'd', 'e']) expect(placement.boxes.find(box => box.id === id)).toEqual(boxes.find(box => box.id === id))
    expect(placement.retainedPaths).toEqual(['d-e'])
    const routed = responses.filter(response => response.type === 'paths').flatMap(response => Object.values(response.paths))
    expect(routed.map(path => path.id)).toEqual(['a-b'])
    // The old curve genuinely detours around the original body. Once cleared,
    // the unchanged endpoints have a direct original-router corridor.
    const controlLength = (path: typeof paths[number]) => path.points.slice(1).reduce((sum, point, index) =>
      sum + Math.hypot(point.x - path.points[index]!.x, point.y - path.points[index]!.y), 0)
    expect(paths.find(path => path.id === 'a-b')!.points.length).toBeGreaterThan(4)
    expect(routed[0]!.points).toHaveLength(4)
    expect(controlLength(routed[0]!)).toBeLessThan(controlLength(paths.find(path => path.id === 'a-b')!) * .9)
    expect(responses.filter(response => response.type === 'error')).toEqual([])
    expect(responses.at(-1)?.type).toBe('complete')
    expect(measurements).toEqual([])
  })

  it('keeps empty areas as heading-sized original places while retaining isolated closed members', async () => {
    const input: CollaborationLayoutInput = { areas: [
      { id: 'empty', name: 'Empty original area', members: [], folded: false },
      { id: 'closed', name: 'Closed members', members: ['point'], folded: false }
    ], nodes: [{ id: 'point', areaId: 'closed', width: 14, height: 14 }], connections: [] }
    const boxes = await arrangeCollaboration(input), empty = boxes.find(box => box.id === 'empty')!, closed = boxes.find(box => box.id === 'closed')!, point = boxes.find(box => box.id === 'point')!
    expect(empty).toEqual(expect.objectContaining({ kind: 'area', folded: false, width: 184, height: 32 }))
    expect(contains(closed, point)).toBe(true); expect(intersects(empty, closed)).toBe(false)
    const expanded = await arrangeCollaboration({ ...input, areas: input.areas.map(area => area.id === 'empty' ? { ...area, members: ['new'] } : area), nodes: [...input.nodes, { id: 'new', areaId: 'empty', width: 250, height: 94 }] })
    expect(contains(expanded.find(box => box.id === 'empty')!, expanded.find(box => box.id === 'new')!)).toBe(true)
  })

  it('keeps occupied geometry unchanged when empty original areas are added or reordered', async () => {
    const nodes = [{ id: 'active', areaId: 'work', width: 250, height: 94 }, { id: 'idle', areaId: 'work', width: 160, height: 44 },
      { id: 'closed', areaId: 'isolated', width: 14, height: 14 }, { id: 'folded-member', areaId: 'folded', width: 250, height: 94 }]
    const input: CollaborationLayoutInput = { nodes, areas: [
      { id: 'work', name: 'Original work', members: ['active', 'idle'], folded: false },
      { id: 'isolated', name: 'Original isolated', members: ['closed'], folded: false },
      { id: 'folded', name: 'Original folded', members: ['folded-member'], folded: true }
    ], connections: [edge('local', 'active', 'idle'), edge('cross', 'active', 'closed')] }
    const original = await arrangeCollaboration(input), originalIds = new Set(original.map(box => box.id))
    const empty = Array.from({ length: 24 }, (_, index) => ({ id: `empty-${String(index).padStart(2, '0')}`, name: 'Original empty place', members: [], folded: index === 0 }))
    const bottom = Math.max(...original.filter(box => box.kind === 'area').map(box => box.y + box.height))
    for (const additions of [empty, [...empty].reverse()]) {
      measurements.length = 0
      const boxes = await arrangeCollaboration({ ...input, areas: [additions[0]!, ...input.areas, ...additions.slice(1)] })
      expect(boxes.filter(box => originalIds.has(box.id))).toEqual(original)
      expect(measurements).toHaveLength(1)
      expect(measurements[0]!.engine).toBe('fdp')
      expect(measurements[0]!.nodes.toSorted()).toEqual(['active', 'idle', 'closed', 'folded'].sort())
      const shelves = boxes.filter(box => !originalIds.has(box.id))
      expect(shelves.map(box => box.id)).toEqual(empty.map(area => area.id))
      expect(shelves.every(box => box.kind === 'area' && box.y > bottom && box.folded === (box.id === 'empty-00'))).toBe(true)
      for (const [index, first] of shelves.entries()) for (const second of boxes.filter(box => box.kind === 'area' && box.id !== first.id))
        expect(intersects(first, second), `${index}/${first.id}/${second.id}`).toBe(false)
      expect(boxes.find(box => box.id === 'closed')).toEqual(original.find(box => box.id === 'closed'))
      expect(boxes.filter(box => box.areaId === 'folded')).toEqual([expect.objectContaining({ id: 'folded', kind: 'area', folded: true })])
    }
    const emptyInput = { areas: empty, nodes: [], connections: [] }
    measurements.length = 0
    const emptyBoxes = await arrangeCollaboration(emptyInput)
    expect(await arrangeCollaboration({ ...emptyInput, areas: [...empty].reverse() })).toEqual(emptyBoxes)
    expect(measurements).toEqual([])
    expect(emptyBoxes).toHaveLength(empty.length)
    expect(emptyBoxes.every(box => Number.isFinite(box.x) && Number.isFinite(box.y))).toBe(true)
    for (const [index, first] of emptyBoxes.entries()) for (const second of emptyBoxes.slice(index + 1)) expect(intersects(first, second)).toBe(false)
  })

  it('routes from the actual compact area header without inflating its original height', async () => {
    const compact = { ...box('empty', 0, 0, 184, 32), kind: 'area' as const, areaId: 'empty', heading: { x: 0, y: 0, width: 184, height: 32 } }
    const paths = await successfulRoutes([compact, box('target', 320, 0)], [edge('compact-target', 'empty', 'target')])
    expect(paths).toHaveLength(1)
    expect(paths[0]!.points[0]!.x).toBe(184)
    expect(paths[0]!.points[0]!.y).toBeCloseTo((.5 + Math.atan2(31, 353) / Math.PI * .8 + .1 * (1 - Math.exp(-Math.hypot(353, 31) / 512))) / 6 * 32, 10)
    expect(measurements).toEqual([])
    expect(paths[0]!.points).toHaveLength(4)
  })

  it('places every original mixed member and isolated area without overlap, with room for real headings', async () => {
    const nodes = [...Array.from({ length: 96 }, (_, index) => ({ id: `node-${index}`, areaId: `area-${index % 4}`, width: index % 3 ? 160 : 250, height: index % 3 ? 44 : 94 })), { id: 'isolated-member', areaId: 'isolated-area', width: 14, height: 14 }]
    const input: CollaborationLayoutInput = { areas: [...Array.from({ length: 4 }, (_, index) => ({ id: `area-${index}`, name: 'Original area', members: nodes.filter(node => node.areaId === `area-${index}`).map(node => node.id), folded: false })), { id: 'isolated-area', name: 'Original isolated area', members: ['isolated-member'], folded: false }], nodes, connections: nodes.slice(1, 40).map((node, index) => edge(`edge-${index}`, nodes[index]!.id, node.id)) }
    const boxes = await arrangeCollaboration(input), areas = boxes.filter(box => box.kind === 'area'), agents = boxes.filter(box => box.kind === 'agent')
    expect(agents.map(box => box.id).sort()).toEqual(nodes.map(node => node.id).sort()); expect(areas).toHaveLength(5)
    for (const agent of agents) {
      const area = areas.find(area => area.id === agent.areaId)!
      expect(contains(area, agent), agent.id).toBe(true)
      const heading = { ...area.heading, x: area.x + area.heading.x, y: area.y + area.heading.y }
      expect(intersects(heading, agent), 'Title overlaps original member ' + agent.id).toBe(false)
      expect(agent.y, 'Title clearance for ' + agent.id).toBeGreaterThanOrEqual(heading.y + heading.height + 20)
      expect([agent.width, agent.height]).toEqual([nodes.find(node => node.id === agent.id)!.width, nodes.find(node => node.id === agent.id)!.height])
    }
    for (const group of [areas, ...areas.map(area => agents.filter(agent => agent.areaId === area.id))])
      for (const [index, first] of group.entries()) for (const second of group.slice(index + 1)) expect(intersects(first, second), `${first.id}/${second.id}`).toBe(false)
    const folded = await arrangeCollaboration({ ...input, areas: input.areas.map((area, index) => ({ ...area, folded: index === 2 })) })
    expect(folded.filter(box => box.areaId === 'area-2')).toEqual([expect.objectContaining({ id: 'area-2', kind: 'area', folded: true })])
  })

  it('uses original same-area relations to form a closer neighborhood in the real force solve', async () => {
    const nodes = Array.from({ length: 12 }, (_, index) => ({ id: `member-${index}`, areaId: 'work', width: index < 4 ? 250 : 160, height: index < 4 ? 94 : 44 }))
    const connections = nodes.slice(1).map((node, index) => edge(`local-${index}`, nodes[index]!.id, node.id))
    const input: CollaborationLayoutInput = { areas: [{ id: 'work', name: 'Original work', folded: false, members: nodes.map(node => node.id) }], nodes, connections }
    const unrelated = await arrangeCollaboration({ ...input, connections: [] }), related = await arrangeCollaboration(input)
    const positions = (boxes: CollaborationLayoutBox[]) => {
      const origin = boxes.find(box => box.id === nodes[0]!.id)!
      return boxes.filter(box => box.kind === 'agent').map(box => [box.x - origin.x, box.y - origin.y])
    }
    const distances = (boxes: CollaborationLayoutBox[]) => {
      const byId = new Map(boxes.map(box => [box.id, box]))
      return connections.map(connection => {
        const from = byId.get(connection.source)!, to = byId.get(connection.target)!
        return Math.hypot(from.x + from.width / 2 - to.x - to.width / 2, from.y + from.height / 2 - to.y - to.height / 2)
      })
    }
    const before = distances(unrelated), after = distances(related), mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
    // Root-only internal edges produced exactly the unrelated geometry. This real chain must influence its owning area's solve.
    expect(positions(related)).not.toEqual(positions(unrelated))
    expect(mean(after)).toBeLessThan(mean(before) * .9)
    expect(measurements).toHaveLength(2)
    expect(measurements.every(measurement => measurement.engine === 'fdp' && measurement.nodes.length === nodes.length)).toBe(true)
    expect(measurements[1]!.edges).toHaveLength(connections.length)
    const area = related.find(box => box.kind === 'area')!, members = related.filter(box => box.kind === 'agent')
    const heading = { ...area.heading, x: area.x + area.heading.x, y: area.y + area.heading.y }
    expect(members.map(box => box.id).sort()).toEqual(nodes.map(node => node.id).sort())
    for (const [index, member] of members.entries()) {
      expect(contains(area, member)).toBe(true); expect(intersects(heading, member)).toBe(false)
      expect([member.width, member.height]).toEqual([nodes.find(node => node.id === member.id)!.width, nodes.find(node => node.id === member.id)!.height])
      for (const other of members.slice(index + 1)) expect(intersects(member, other), `${member.id}/${other.id}`).toBe(false)
    }
    console.info(JSON.stringify({ candidate: 'original-local-relations', members: members.length, connections: connections.length,
      before: { mean: mean(before), max: Math.max(...before) }, after: { mean: mean(after), max: Math.max(...after) } }))
  })

  it('jointly lays out exact cross-area endpoints in one real force solve', async () => {
    const nodes = ['a', 'b'].flatMap(areaId => Array.from({ length: 4 }, (_, index) => ({ id: areaId + index, areaId, width: 160, height: 44 })))
    const local = ['a', 'b'].flatMap(prefix => [0, 1, 2].map(index => edge(prefix + index, prefix + index, prefix + (index + 1))))
    const input: CollaborationLayoutInput = { nodes, areas: ['a', 'b'].map(id => ({ id, name: 'Original ' + id, folded: false, members: nodes.filter(node => node.areaId === id).map(node => node.id) })),
      connections: [...local, edge('cross', 'a0', 'b0')] }
    const original = await arrangeCollaboration(input)
    expect(measurements).toHaveLength(1); expect(measurements[0]!.engine).toBe('fdp')
    expect(measurements[0]!.nodes.toSorted()).toEqual(nodes.map(node => node.id).sort())
    expect(measurements[0]!.edges).toContainEqual({ source: 'a0', target: 'b0' })
    expect(measurements[0]!.edges).toHaveLength(local.length + 1)
    const changed = await arrangeCollaboration({ ...input, connections: [...local, edge('cross', 'a3', 'b3')] })
    const relative = (boxes: CollaborationLayoutBox[]) => {
      const origin = boxes.find(box => box.id === 'a0')!
      return boxes.filter(box => box.kind === 'agent' && box.areaId === 'a').map(box => [box.x - origin.x, box.y - origin.y])
    }
    expect(relative(changed)).not.toEqual(relative(original))
  })

  it('retains distinct original occurrences of a shared Session in all its original areas', async () => {
    const nodes = [
      { id: '["left","same-session"]', areaId: 'left', width: 250, height: 94 },
      { id: '["right","same-session"]', areaId: 'right', width: 250, height: 94 },
      { id: '["right","isolated"]', areaId: 'right', width: 14, height: 14 }
    ]
    const input: CollaborationLayoutInput = { nodes, areas: ['left', 'right'].map(id => ({ id, name: 'Original ' + id, folded: false, members: nodes.filter(node => node.areaId === id).map(node => node.id) })), connections: [] }
    const boxes = await arrangeCollaboration(input)
    expect(boxes.filter(box => box.kind === 'agent').map(box => box.id).sort()).toEqual(nodes.map(node => node.id).sort())
    for (const area of boxes.filter(box => box.kind === 'area')) {
      expect(contains(area, { ...area, ...area.heading, x: area.x + area.heading.x, y: area.y + area.heading.y })).toBe(true)
      for (const member of boxes.filter(box => box.kind === 'agent' && box.areaId === area.id)) expect(contains(area, member)).toBe(true)
    }
    expect(measurements).toHaveLength(1); expect(measurements[0]!.nodes).toHaveLength(nodes.length)
  })

  it('routes from the exact local title rectangle rather than the original area bounds', async () => {
    const area = { ...box('region', 0, 0, 1200, 900), kind: 'area' as const, heading: { x: 24, y: 24, width: 184, height: 40 } }
    const paths = await successfulRoutes([area, box('target', 650, 24)], [edge('title-target', 'region', 'target')])
    expect(paths).toHaveLength(1)
    expect(paths[0]!.points[0]!.x).toBe(208)
    expect(paths[0]!.points[0]!.y).toBeCloseTo(24 + (.5 + Math.atan2(27, 659) / Math.PI * .8 + .1 * (1 - Math.exp(-Math.hypot(659, 27) / 512))) / 6 * 40, 10)
    expect(paths[0]!.points.at(-1)!.x).toBe(650)
  })

  it('routes real curves around same-row cards, mixed obstacles and headings with distinct role and reciprocal ports', async () => {
    const boxes = [box('a', 0, 0), box('b', 310, 0), box('c', 620, 0), box('d', 310, -150, 160, 44),
      { ...box('area-heading', 220, -90, 300, 400), kind: 'area' as const, heading: { x: 24, y: 10, width: 184, height: 40 } }]
    const connections = (['communication', 'creation', 'supervision'] as const).flatMap(kind => [edge(`${kind}-forward`, 'a', 'c', kind), edge(`${kind}-reverse`, 'c', 'a', kind)])
    const routes = await successfulRoutes(boxes, connections)
    expect(routes).toHaveLength(6); expect(new Set(routes.map(route => route.path)).size).toBe(6)
    for (const route of routes) {
      const connection = connections.find(edge => edge.id === route.id)!, kind = ['communication', 'creation', 'supervision'].indexOf(connection.kind)
      const reverse = connection.source === 'c', source = boxes.find(box => box.id === connection.source)!, target = boxes.find(box => box.id === connection.target)!
      expect(route.points[0]).toEqual({ x: source.x + (reverse ? 0 : source.width), y: source.y + (kind * 2 + (reverse ? 1.5 : .5) + .1 * (1 - Math.exp(-620 / 512))) / 6 * source.height })
      expect(route.points.at(-1)).toEqual({ x: target.x + (reverse ? target.width : 0), y: target.y + (kind * 2 + (reverse ? 1.5 : .5) + .1 * (1 - Math.exp(-620 / 512))) / 6 * target.height })
      expect(route.path.replace(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/giu, '').replace(/[MC\s]/gu, '')).toBe('')
      const numbers = route.path.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/giu)!.map(Number)
      const controls = numbers.flatMap((number, index) => index % 2 ? [] : [{ x: number, y: numbers[index + 1]! }])
      expect(controls).toEqual(route.points)
      for (let segment = 0; segment < controls.length - 1; segment += 3) {
        const p = controls.slice(segment, segment + 4)
        for (let sample = 1; sample < 200; sample++) {
          const t = sample / 200, u = 1 - t
          const x = u ** 3 * p[0]!.x + 3 * u ** 2 * t * p[1]!.x + 3 * u * t ** 2 * p[2]!.x + t ** 3 * p[3]!.x
          const y = u ** 3 * p[0]!.y + 3 * u ** 2 * t * p[1]!.y + 3 * u * t ** 2 * p[2]!.y + t ** 3 * p[3]!.y
          for (const original of boxes) {
            const obstacle = original.kind === 'area' ? { ...original.heading, x: original.x + original.heading.x, y: original.y + original.heading.y } : original
            expect(x > obstacle.x + .25 && x < obstacle.x + obstacle.width - .25 && y > obstacle.y + .25 && y < obstacle.y + obstacle.height - .25, `${route.id}/${original.id}`).toBe(false)
          }
          expect(x).toBeGreaterThanOrEqual(route.bounds.x - 1e-9); expect(x).toBeLessThanOrEqual(route.bounds.x + route.bounds.width + 1e-9)
          expect(y).toBeGreaterThanOrEqual(route.bounds.y - 1e-9); expect(y).toBeLessThanOrEqual(route.bounds.y + route.bounds.height + 1e-9)
        }
      }
    }
  })

  it('separates reciprocal roles across facing top and bottom ports for vertical neighbors', async () => {
    const boxes = [box('lower', 0, 190), box('upper', 280, 0)]
    const connections = (['communication', 'creation', 'supervision'] as const).flatMap(kind => [
      edge(`${kind}-up`, 'lower', 'upper', kind), edge(`${kind}-down`, 'upper', 'lower', kind)])
    const routes = await successfulRoutes(boxes, connections)
    expect(routes).toHaveLength(6)
    const crossings: number[] = []
    for (const route of routes) {
      const up = route.id.endsWith('-up')
      expect(route.sourceHandle.endsWith(up ? '-top' : '-bottom')).toBe(true)
      expect(route.targetHandle.endsWith(up ? '-bottom' : '-top')).toBe(true)
      expect(route.points[0]!.y).toBe(up ? 190 : 94)
      expect(route.points.at(-1)!.y).toBe(up ? 94 : 190)
      let previous = route.points[0]!
      for (let segment = 0; segment < route.points.length - 1; segment += 3) {
        const p = route.points.slice(segment, segment + 4)
        for (let sample = 1; sample <= 100; sample++) {
          const t = sample / 100, u = 1 - t
          const point = { x: u**3*p[0]!.x + 3*u*u*t*p[1]!.x + 3*u*t*t*p[2]!.x + t**3*p[3]!.x,
            y: u**3*p[0]!.y + 3*u*u*t*p[1]!.y + 3*u*t*t*p[2]!.y + t**3*p[3]!.y }
          if ((previous.y < 142) !== (point.y < 142)) crossings.push(previous.x + (point.x - previous.x) * (142 - previous.y) / (point.y - previous.y))
          for (const obstacle of boxes) expect(point.x > obstacle.x + .25 && point.x < obstacle.x + obstacle.width - .25 && point.y > obstacle.y + .25 && point.y < obstacle.y + obstacle.height - .25).toBe(false)
          previous = point
        }
      }
    }
    // Six physically distinguishable paths through the gap, not six IDs on one trunk.
    expect(crossings).toHaveLength(6)
    crossings.sort((a, b) => a - b)
    for (let index = 1; index < crossings.length; index++) expect(crossings[index]! - crossings[index - 1]!).toBeGreaterThan(12)
  })

  it('publishes original boxes before paths and isolates a failed connection without discarding others', async () => {
    const responses: CollaborationLayoutResponse[] = [], input: CollaborationLayoutInput = { areas: [{ id: 'area', name: 'Original', members: ['a', 'b', 'isolated'], folded: false }], nodes: ['a', 'b', 'isolated'].map(id => ({ id, areaId: 'area', width: 250, height: 94 })), connections: [edge('bad', 'missing', 'b'), edge('good', 'a', 'b')] }
    await handleCollaborationLayoutRequest({ id: 'job', type: 'arrange', input }, response => responses.push(response))
    expect(responses[0]).toEqual(expect.objectContaining({ id: 'job', type: 'boxes' })); expect(responses.at(-1)).toEqual({ id: 'job', type: 'complete' })
    expect(responses.find(response => response.type === 'error')).toEqual(expect.objectContaining({ connectionId: 'bad' }))
    expect(responses.filter(response => response.type === 'paths').flatMap(response => Object.keys(response.paths))).toEqual(['good'])
  })

  it('expands a detour to include previously omitted obstacles rather than trusting the first local route', async () => {
    const boxes = [box('a', 0, 0), box('c', 620, 0), box('tall', 310, -100, 250, 300), box('outside', 310, -220, 250, 80)]
    const routes = await successfulRoutes(boxes, [edge('a-c', 'a', 'c')])
    expect(routes).toHaveLength(1)
    expect(measurements.filter(item => item.engine === 'nop2').length).toBeGreaterThan(1)
    expect(measurements[0]!.nodes).not.toContain('outside')
    expect(measurements.at(-1)!.nodes).toContain('outside')
  })

  it('keeps unrelated world members out of actual WASM inputs for 240 and 480 requested local connections', async () => {
    const local = [box('a', 0, 0), box('b', 320, 0)]
    const original = await routeCollaborationLayout(local, [edge('reference', 'a', 'b')])
    for (const count of [240, 480]) {
      measurements.length = 0
      const unrelated = Array.from({ length: count }, (_, index) => box(`unrelated-${index}`, 10000 + index % 20 * 300, 10000 + Math.floor(index / 20) * 130))
      const started = performance.now(), paths = await routeCollaborationLayout([...local, ...unrelated], Array.from({ length: count }, (_, index) => edge(`local-${index}`, 'a', 'b')))
      expect(paths).toHaveLength(count); expect(paths[0]!.path).toBe(original[0]!.path)
      expect(measurements).toEqual([])
      expect(paths.every(path => path.points.length === 4)).toBe(true)
      console.info(JSON.stringify({ candidate: 'actual-local-wasm', unrelatedMembers: count, requestedConnections: count, elapsedMS: performance.now() - started, wasmMS: measurements.reduce((sum, item) => sum + item.ms, 0), maxWasmNodes: Math.max(0, ...measurements.map(item => item.nodes.length)) }))
    }
  })

  it('does not submit unrelated fixed world members for one newly observed connection', async () => {
    const boxes = [box('a', 0, 0), box('b', 320, 0), ...Array.from({ length: 480 }, (_, index) => box(`unrelated-${index}`, 10000 + index % 20 * 300, 10000 + Math.floor(index / 20) * 130))]
    const routes = await successfulRoutes(boxes, [edge('new-edge', 'a', 'b')])
    expect(routes).toHaveLength(1)
    expect(measurements).toEqual([])
    expect(routes[0]!.points).toHaveLength(4)
  })

  it('routes sparse actual force layouts across original areas and all three node sizes', async () => {
    for (const count of [24, 96, 240, 480]) {
      const nodes = Array.from({ length: count }, (_, index) => ({ id: `member-${index}`, areaId: `area-${index % 4}`, width: [250, 160, 14][index % 3]!, height: [94, 44, 14][index % 3]! }))
      const areas = Array.from({ length: 4 }, (_, index) => ({ id: `area-${index}`, name: 'Original area', members: nodes.filter(node => node.areaId === `area-${index}`).map(node => node.id), folded: false }))
      const connections = nodes.filter((_, index) => index % 3 === 0).flatMap((node, index) => [edge(`local-${index}`, node.id, nodes[(index * 3 + 4) % count]!.id), edge(`cross-${index}`, node.id, nodes[(index * 3 + 1) % count]!.id, 'creation')])
      const started = performance.now(), boxes = await arrangeCollaboration({ nodes, areas, connections }), layoutMS = performance.now() - started
      measurements.length = 0
      const errors: { id: string; message: string }[] = [], routing = performance.now()
      const paths = await routeCollaborationLayout(boxes, connections, { onError: (id, error) => errors.push({ id, message: String(error) }) })
      console.info(JSON.stringify({ candidate: 'actual-force-sparse', members: count, requestedConnections: connections.length, layoutMS, routeMS: performance.now() - routing, failures: errors, maxWasmNodes: Math.max(0, ...measurements.map(item => item.nodes.length)), wasmMS: measurements.reduce((sum, item) => sum + item.ms, 0) }))
      if (process.env.AGENTMUX_COLLABORATION_LAYOUT_PROBE) writeFileSync(process.env.AGENTMUX_COLLABORATION_LAYOUT_PROBE, JSON.stringify({ boxes, connections, captures }))
      expect(errors).toEqual([]); expect(paths).toHaveLength(connections.length)
    }
  })

  it('does no additional heavy work after the original generation is canceled', async () => {
    const controller = new AbortController(), responses: CollaborationLayoutResponse[] = []
    await handleCollaborationLayoutRequest({ id: 'old', type: 'arrange', input: { areas: [{ id: 'area', name: 'Original', members: ['a', 'b'], folded: false }], nodes: ['a', 'b'].map(id => ({ id, areaId: 'area', width: 250, height: 94 })), connections: Array.from({ length: 20 }, (_, index) => edge(String(index), 'a', 'b')) } }, response => { responses.push(response); if (response.type === 'boxes') controller.abort() }, controller.signal)
    expect(responses.map(response => response.type)).toEqual(['boxes'])
    expect(measurements.every(item => item.engine !== 'nop2')).toBe(true)
    const alreadyAborted = new AbortController(); alreadyAborted.abort()
    await expect(arrangeCollaboration({ areas: [], nodes: [], connections: [] }, alreadyAborted.signal)).rejects.toThrow()
  })
  it('runs the real Worker receiver and suppresses every superseded generation receipt', async () => {
    const responses: CollaborationLayoutResponse[] = []
    const receive = () => (globalThis as unknown as { onmessage: (event: { data: import('../src/renderer/src/lib/collaboration-layout-engine').CollaborationLayoutRequest }) => Promise<void> }).onmessage
    let replacement: Promise<void> | undefined
    vi.stubGlobal('onmessage', null)
    vi.stubGlobal('postMessage', (response: CollaborationLayoutResponse) => {
      responses.push(response)
      if (response.id === 'old' && response.type === 'paths') replacement = receive()({ data: { id: 'replacement', type: 'route', boxes: [], connections: [] } })
    })
    try {
      await import('../src/renderer/src/lib/collaboration-layout.worker')
      await receive()({ data: { id: 'old', type: 'route', boxes: [box('a', 0, 0), box('b', 650, 0), box('obstacle', 300, -100, 250, 300)], connections: Array.from({ length: 16 }, (_, index) => edge(`edge-${index}`, 'a', 'b')) } })
      await replacement
      expect(responses.filter(response => response.id === 'old').map(response => response.type)).toEqual(['paths'])
      expect(responses.flatMap(response => response.id === 'old' && response.type === 'paths' ? Object.keys(response.paths) : [])).toHaveLength(8)
      expect(responses.filter(response => response.id === 'replacement')).toEqual([{ id: 'replacement', type: 'complete' }])
      expect(measurements).toHaveLength(8)
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps three real containment levels including an ancestor with no direct members and folds the exact subtree', async () => {
    const input: CollaborationLayoutInput = {
      areas: [
        { id: 'root', name: 'Root', members: [], folded: false },
        { id: 'middle', name: 'Middle', members: ['m'], parentId: 'root', folded: false },
        { id: 'leaf', name: 'Leaf', members: ['a', 'b', 'isolated'], parentId: 'middle', folded: false },
        { id: 'peer', name: 'Peer', members: ['p', 'q'], folded: false }
      ],
      nodes: [['m', 'middle'], ['a', 'leaf'], ['b', 'leaf'], ['isolated', 'leaf'], ['p', 'peer'], ['q', 'peer']].map(([id, areaId]) => ({ id: id!, areaId: areaId!, width: 154, height: 38 })),
      connections: [edge('local', 'a', 'b'), edge('inside-parent', 'm', 'a'), edge('external', 'a', 'p')]
    }
    const previousProbe = process.env.AGENTMUX_COLLABORATION_LAYOUT_PROBE
    process.env.AGENTMUX_COLLABORATION_LAYOUT_PROBE = 'capture-in-memory'
    let result: CollaborationLayoutBox[]
    try { result = await arrangeCollaboration(input) } finally {
      if (previousProbe === undefined) delete process.env.AGENTMUX_COLLABORATION_LAYOUT_PROBE
      else process.env.AGENTMUX_COLLABORATION_LAYOUT_PROBE = previousProbe
    }
    const byId = new Map(result!.map(box => [box.id, box]))
    expect(contains(byId.get('root')!, byId.get('middle')!)).toBe(true)
    expect(contains(byId.get('middle')!, byId.get('leaf')!)).toBe(true)
    expect(byId.get('root')!.height).toBeGreaterThan(byId.get('middle')!.height)
    for (const node of input.nodes) expect(contains(byId.get(node.areaId)!, byId.get(node.id)!)).toBe(true)
    const graph = (captures[0] as { input: Graph }).input
    const root = graph.subgraphs!.find(value => value.name === 'cluster_root')!
    const middle = root.subgraphs!.find(value => value.name === 'cluster_middle')!
    const leaf = middle.subgraphs!.find(value => value.name === 'cluster_leaf')!
    expect(leaf.edges).toHaveLength(1); expect(middle.edges).toHaveLength(1); expect(graph.edges).toHaveLength(1)
    expect(await arrangeCollaboration({ ...input, areas: [...input.areas].reverse(), nodes: [...input.nodes].reverse(), connections: [...input.connections].reverse() })).toEqual(result!)
    const folded = { ...input, areas: input.areas.map(area => area.id === 'middle' ? { ...area, folded: true } : area) }
    const fold = await arrangeCollaboration(folded), ids = fold.map(box => box.id)
    expect(ids.toSorted()).toEqual(['root', 'middle', 'peer', 'p', 'q'].toSorted())
    expect(contains(fold.find(box => box.id === 'root')!, fold.find(box => box.id === 'middle')!)).toBe(true)
    const restore = reconcileCollaborationLayout(input, [...result!, ...reconcileCollaborationLayout(folded, result!, 'middle', input)], 'a', folded)
    const restored = new Map(restore.map(box => [box.id, box]))
    expect(restored.get('a')).toEqual(byId.get('a'))
    expect(contains(restored.get('root')!, restored.get('middle')!)).toBe(true)
    expect(contains(restored.get('middle')!, restored.get('leaf')!)).toBe(true)
    expect(restored.get('q')).toEqual(byId.get('q'))
  })

  it('reduces the final distance of a strong communication pair without counting its dispatch overlay twice', async () => {
    const nodes = Array.from({ length: 24 }, (_, index) => ({ id: 'n' + String(index).padStart(2, '0'), areaId: 'work', width: 154, height: 38 }))
    const ring = nodes.flatMap((node, index) => nodes.slice(index + 1).filter(peer => node.id !== 'n00' || peer.id !== 'n12').map(peer => edge('local-' + node.id + '-' + peer.id, node.id, peer.id)))
    const input: CollaborationLayoutInput = { areas: [{ id: 'work', name: 'Work', members: nodes.map(node => node.id), folded: false }], nodes,
      connections: [...ring, { ...edge('heavy', 'n00', 'n12'), strength: 1 }] }
    const weak = await arrangeCollaboration(input)
    const strongInput = { ...input, connections: [...ring, { ...edge('heavy', 'n00', 'n12'), strength: 32 }] }
    process.env.AGENTMUX_COLLABORATION_LAYOUT_PROBE = 'capture-in-memory'
    const strong = await arrangeCollaboration(strongInput)
    const distance = (boxes: CollaborationLayoutBox[]) => { const a = boxes.find(box => box.id === 'n00')!, b = boxes.find(box => box.id === 'n12')!; return Math.hypot(a.x - b.x, a.y - b.y) }
    expect(distance(strong)).toBeLessThan(distance(weak) * .8)
    const overlay = await arrangeCollaboration({ ...strongInput, connections: [...strongInput.connections,
      { ...edge('dispatch-overlay', 'n00', 'n12', 'supervision'), strength: 32 }, edge('creation-overlay', 'n00', 'n12', 'creation')] })
    delete process.env.AGENTMUX_COLLABORATION_LAYOUT_PROBE
    expect((captures.at(-1) as { input: Graph }).input).toEqual((captures.at(-2) as { input: Graph }).input)
    expect(overlay).toEqual(strong)
    console.info(JSON.stringify({ candidate: 'weighted-compound-final-packing', weakDistance: distance(weak), strongDistance: distance(strong) }))
  })

  it('keeps an expanded nested subtree inside all original ancestors without moving the reading occurrence or an unrelated peer', async () => {
    const input: CollaborationLayoutInput = { areas: [
      { id: 'root', name: 'Root', members: [], folded: false }, { id: 'child', name: 'Child', parentId: 'root', members: ['a', 'b'], folded: false },
      { id: 'other', name: 'Other', members: ['p'], folded: false }
    ], nodes: [{ id: 'a', areaId: 'child', width: 154, height: 38 }, { id: 'b', areaId: 'child', width: 154, height: 38 }, { id: 'p', areaId: 'other', width: 154, height: 38 }], connections: [edge('a-b', 'a', 'b')] }
    const original = await arrangeCollaboration(input), before = new Map(original.map(box => [box.id, box]))
    const changed: CollaborationLayoutInput = { ...input, areas: input.areas.map(area => area.id === 'child' ? { ...area, members: [...area.members, 'new'] } : area),
      nodes: [...input.nodes.map(node => node.id === 'a' ? { ...node, width: 250, height: 94 } : node), { id: 'new', areaId: 'child', width: 154, height: 38 }] }
    const after = new Map(reconcileCollaborationLayout(changed, original, 'a', input).map(box => [box.id, box]))
    const a = after.get('a')!, old = before.get('a')!
    expect([a.x + a.width / 2, a.y + a.height / 2]).toEqual([old.x + old.width / 2, old.y + old.height / 2])
    expect(after.get('p')).toEqual(before.get('p'))
    expect(contains(after.get('root')!, after.get('child')!)).toBe(true)
    for (const id of ['a', 'b', 'new']) expect(contains(after.get('child')!, after.get(id)!)).toBe(true)
  })

  it('fans out one communication role in opposite bearing order and keeps existing ports independent of new batches', async () => {
    const hub = box('hub', 0, 0), peers = [-240, -120, 0, 120, 240].map((y, index) => box('peer-' + index, 600, y))
    const connections = peers.map(peer => edge('to-' + peer.id, hub.id, peer.id))
    const paths = await successfulRoutes([hub, ...peers], connections)
    const starts = paths.map(path => path.points[0]!)
    expect(new Set(starts.map(point => point.y)).size).toBe(peers.length)
    for (let index = 1; index < starts.length; index++) expect(starts[index]!.y).toBeGreaterThan(starts[index - 1]!.y)
    for (const connection of connections) {
      const [separate] = await successfulRoutes([hub, ...peers], [connection])
      expect(separate!.points[0]).toEqual(paths.find(path => path.id === connection.id)!.points[0])
    }
  })

  it('chooses a clear facing corridor before asking the library for an avoidable detour', async () => {
    const boxes = [box('source', 0, 0), box('target', 600, 100), box('barrier', 290, -160, 240, 240)]
    const paths = await successfulRoutes(boxes, [edge('corridor', 'source', 'target')])
    expect(paths).toHaveLength(1); expect(paths[0]!.points).toHaveLength(4)
    expect(paths[0]!.sourceHandle).toBe('communication-out-bottom')
    expect(paths[0]!.targetHandle).toBe('communication-in-top')
    expect(measurements).toEqual([])
  })

  it('refines completed rectangle packing without changing any original footprint or containment', async () => {
    const nodes = Array.from({ length: 18 }, (_, index) => ({ id: 'member-' + String(index).padStart(2, '0'), areaId: 'work', width: 154, height: 38 }))
    const order = nodes.flatMap((_, index) => index < nodes.length / 2 ? [nodes[index]!, nodes[nodes.length - 1 - index]!] : [])
    const connections = order.slice(1).map((node, index) => edge('link-' + index, order[index]!.id, node.id))
    const input: CollaborationLayoutInput = { areas: [{ id: 'work', name: 'Work', members: nodes.map(node => node.id), folded: false }], nodes, connections }
    const previousProbe = process.env.AGENTMUX_COLLABORATION_LAYOUT_PROBE
    process.env.AGENTMUX_COLLABORATION_LAYOUT_PROBE = 'capture-in-memory'
    let final: CollaborationLayoutBox[]
    try { final = await arrangeCollaboration(input) } finally {
      if (previousProbe === undefined) delete process.env.AGENTMUX_COLLABORATION_LAYOUT_PROBE
      else process.env.AGENTMUX_COLLABORATION_LAYOUT_PROBE = previousProbe
    }
    const result = (captures.at(-1) as { result: { objects: { name: string; pos?: string }[] } }).result
    const raw = new Map(result.objects.filter(object => object.pos).map(object => [object.name, object.pos!.split(',').map(Number)]))
    const current = new Map(final!.filter(box => box.kind === 'agent').map(box => [box.id, [box.x + box.width / 2, box.y + box.height / 2]]))
    const length = (positions: Map<string, number[]>) => connections.reduce((sum, edge) => {
      const a = positions.get(edge.source)!, b = positions.get(edge.target)!
      return sum + Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!)
    }, 0)
    expect(length(current)).toBeLessThan(length(raw) * .95)
    expect([...current.values()].map(value => JSON.stringify(value.map(number => Number(number.toFixed(6))))).sort()).toEqual([...raw.values()].map(value => JSON.stringify(value.map(number => Number(number.toFixed(6))))).sort())
    const area = final!.find(box => box.id === 'work')!
    for (const box of final!.filter(box => box.kind === 'agent')) expect(contains(area, box)).toBe(true)
    console.info(JSON.stringify({ candidate: 'same-footprint-communication-refinement', rawLength: length(raw), finalLength: length(current) }))
  })

  it('keeps collinear neighbors in distinct stable slots without requiring their whole world or arrival batch', async () => {
    const hub = box('hub', 0, 0), starts: number[] = []
    for (const x of [350, 650, 1200]) {
      const peer = box('peer-' + x, x, 0)
      const [path] = await successfulRoutes([hub, peer], [edge('to-' + x, hub.id, peer.id)])
      expect(path!.sourceHandle).toBe('communication-out-right')
      starts.push(path!.points[0]!.y)
    }
    expect(starts[1]).toBeGreaterThan(starts[0]!)
    expect(starts[2]).toBeGreaterThan(starts[1]!)
  })

  it('does not choose a visually clear corridor through an original endpoint body', async () => {
    const source = box('source', 0, 0), target = box('target', 500, 50)
    const [path] = await successfulRoutes([source, target, box('barrier', 300, -265, 180, 300)], [edge('overlapping-axis', source.id, target.id)])
    for (let segment = 0; segment < path!.points.length - 1; segment += 3) {
      const [a, b, c, d] = path!.points.slice(segment, segment + 4)
      for (let index = 1; index < 100; index++) {
        const t = index / 100, u = 1 - t
        const x = u ** 3 * a!.x + 3 * u * u * t * b!.x + 3 * u * t * t * c!.x + t ** 3 * d!.x
        const y = u ** 3 * a!.y + 3 * u * u * t * b!.y + 3 * u * t * t * c!.y + t ** 3 * d!.y
        for (const endpoint of [source, target]) expect(x > endpoint.x + .25 && x < endpoint.x + endpoint.width - .25 && y > endpoint.y + .25 && y < endpoint.y + endpoint.height - .25).toBe(false)
      }
    }
  })

})
