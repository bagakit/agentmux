import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Graph, Subgraph } from '@viz-js/viz'
import { writeFileSync } from 'node:fs'
import { arrangeCollaboration, routeCollaborationLayout, handleCollaborationLayoutRequest, type CollaborationLayoutBox, type CollaborationLayoutInput, type CollaborationLayoutConnection, type CollaborationLayoutResponse } from '../src/renderer/src/lib/collaboration-layout-engine'

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
describe('finite collaboration Worker engine', () => {
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
    expect(paths[0]!.points[0]).toEqual({ x: 184, y: 32 / 12 })
    expect(measurements.some(item => item.engine === 'nop2')).toBe(true)
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
    expect(paths[0]!.points[0]).toEqual({ x: 208, y: 24 + 40 / 12 })
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
      expect(route.points[0]).toEqual({ x: source.x + (reverse ? 0 : source.width), y: source.y + (kind * 2 + .5) / 6 * source.height })
      expect(route.points.at(-1)).toEqual({ x: target.x + (reverse ? target.width : 0), y: target.y + (kind * 2 + 1.5) / 6 * target.height })
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
      expect(measurements).toHaveLength(count)
      expect(measurements.every(item => item.engine === 'nop2' && item.nodes.length === 4)).toBe(true)
      console.info(JSON.stringify({ candidate: 'actual-local-wasm', unrelatedMembers: count, requestedConnections: count, elapsedMS: performance.now() - started, wasmMS: measurements.reduce((sum, item) => sum + item.ms, 0), maxWasmNodes: Math.max(...measurements.map(item => item.nodes.length)) }))
    }
  })

  it('does not submit unrelated fixed world members for one newly observed connection', async () => {
    const boxes = [box('a', 0, 0), box('b', 320, 0), ...Array.from({ length: 480 }, (_, index) => box(`unrelated-${index}`, 10000 + index % 20 * 300, 10000 + Math.floor(index / 20) * 130))]
    const routes = await successfulRoutes(boxes, [edge('new-edge', 'a', 'b')])
    expect(routes).toHaveLength(1)
    expect(measurements).toHaveLength(1)
    expect(measurements[0]!.nodes.sort()).toEqual(['__source_port__', '__target_port__', 'a', 'b'])
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
      console.info(JSON.stringify({ candidate: 'actual-force-sparse', members: count, requestedConnections: connections.length, layoutMS, routeMS: performance.now() - routing, failures: errors, maxWasmNodes: Math.max(...measurements.map(item => item.nodes.length)), wasmMS: measurements.reduce((sum, item) => sum + item.ms, 0) }))
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
      await receive()({ data: { id: 'old', type: 'route', boxes: [box('a', 0, 0), box('b', 320, 0)], connections: Array.from({ length: 16 }, (_, index) => edge(`edge-${index}`, 'a', 'b')) } })
      await replacement
      expect(responses.filter(response => response.id === 'old').map(response => response.type)).toEqual(['paths'])
      expect(responses.flatMap(response => response.id === 'old' && response.type === 'paths' ? Object.keys(response.paths) : [])).toHaveLength(8)
      expect(responses.filter(response => response.id === 'replacement')).toEqual([{ id: 'replacement', type: 'complete' }])
      expect(measurements).toHaveLength(8)
    } finally { vi.unstubAllGlobals() }
  })

})
