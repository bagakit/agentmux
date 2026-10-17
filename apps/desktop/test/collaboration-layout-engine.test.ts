import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { arrangeCollaboration, routeCollaborationLayout, handleCollaborationLayoutRequest, type CollaborationLayoutBox, type CollaborationLayoutInput, type CollaborationLayoutConnection, type CollaborationLayoutResponse } from '../src/renderer/src/lib/collaboration-layout-engine'

const measurements = vi.hoisted(() => [] as { engine: string; nodes: string[]; ms: number }[])
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
      finally { measurements.push({ engine: options?.engine ?? '', nodes: typeof input === 'string' ? [] : (input.nodes ?? []).map(node => node.name), ms: performance.now() - started }) }
    }
    return viz
  } }
})
beforeEach(() => { measurements.length = 0; captures.length = 0 })

const box = (id: string, x: number, y: number, width = 250, height = 94, areaId = 'area'): CollaborationLayoutBox => ({ id, areaId, kind: 'agent', x, y, width, height, folded: false })
async function successfulRoutes(boxes: readonly CollaborationLayoutBox[], connections: readonly CollaborationLayoutConnection[]) {
  const errors: string[] = [], paths = await routeCollaborationLayout(boxes, connections, { onError: (_id, error) => errors.push(String(error)) })
  expect(errors).toEqual([]); return paths
}
const edge = (id: string, source: string, target: string, kind: CollaborationLayoutConnection['kind'] = 'communication') => ({ id, source, target, kind })
function contains(a: CollaborationLayoutBox, b: CollaborationLayoutBox) {
  return b.x >= a.x && b.y >= a.y + 40 && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height
}
function intersects(a: CollaborationLayoutBox, b: CollaborationLayoutBox) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}
describe('finite collaboration Worker engine', () => {
  it('places every original mixed member and isolated area without overlap, with room for real headings', async () => {
    const nodes = [...Array.from({ length: 96 }, (_, index) => ({ id: `node-${index}`, areaId: `area-${index % 4}`, width: index % 3 ? 160 : 250, height: index % 3 ? 44 : 94 })), { id: 'isolated-member', areaId: 'isolated-area', width: 14, height: 14 }]
    const input: CollaborationLayoutInput = { areas: [...Array.from({ length: 4 }, (_, index) => ({ id: `area-${index}`, name: 'Original area', members: nodes.filter(node => node.areaId === `area-${index}`).map(node => node.id), folded: false })), { id: 'isolated-area', name: 'Original isolated area', members: ['isolated-member'], folded: false }], nodes, connections: nodes.slice(1, 40).map((node, index) => edge(`edge-${index}`, nodes[index]!.id, node.id)) }
    const boxes = await arrangeCollaboration(input), areas = boxes.filter(box => box.kind === 'area'), agents = boxes.filter(box => box.kind === 'agent')
    expect(agents.map(box => box.id).sort()).toEqual(nodes.map(node => node.id).sort()); expect(areas).toHaveLength(5)
    for (const agent of agents) {
      expect(contains(areas.find(area => area.id === agent.areaId)!, agent), agent.id).toBe(true)
      expect([agent.width, agent.height]).toEqual([nodes.find(node => node.id === agent.id)!.width, nodes.find(node => node.id === agent.id)!.height])
    }
    for (const group of [areas, ...areas.map(area => agents.filter(agent => agent.areaId === area.id))])
      for (const [index, first] of group.entries()) for (const second of group.slice(index + 1)) expect(intersects(first, second), `${first.id}/${second.id}`).toBe(false)
    const folded = await arrangeCollaboration({ ...input, areas: input.areas.map((area, index) => ({ ...area, folded: index === 2 })) })
    expect(folded.filter(box => box.areaId === 'area-2')).toEqual([expect.objectContaining({ id: 'area-2', kind: 'area', folded: true })])
  })

  it('routes real curves around same-row cards, mixed obstacles and headings with distinct role and reciprocal ports', async () => {
    const boxes = [box('a', 0, 0), box('b', 310, 0), box('c', 620, 0), box('d', 310, -150, 160, 44),
      { ...box('area-heading', 220, -90, 300, 400), kind: 'area' as const }]
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
            const obstacle = original.kind === 'area' ? { ...original, height: 40 } : original
            expect(x > obstacle.x + .25 && x < obstacle.x + obstacle.width - .25 && y > obstacle.y + .25 && y < obstacle.y + obstacle.height - .25, `${route.id}/${obstacle.id}`).toBe(false)
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
