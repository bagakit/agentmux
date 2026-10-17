import { beforeEach, expect, it, vi } from 'vitest'
import type { CollaborationBox, CollaborationConnection } from '../src/renderer/src/lib/collaboration-routing'

// Observe actual WASM work without replacing its input, output, or geometry.
const engine = vi.hoisted(() => ({ instances: 0, renders: 0, failures: 0, wait: undefined as Promise<void> | undefined }))
vi.mock('@viz-js/viz', async importOriginal => {
  const actual = await importOriginal<typeof import('@viz-js/viz')>()
  return { ...actual, instance: async () => {
    engine.instances++
    await engine.wait
    if (engine.failures > 0) { engine.failures--; throw Error('Routing engine unavailable') }
    const original = await actual.instance(), renderJSON = original.renderJSON.bind(original)
    return { ...original, renderJSON: (...args: Parameters<typeof original.renderJSON>) => { engine.renders++; return renderJSON(...args) } }
  } }
})
beforeEach(() => { vi.resetModules(); engine.instances = 0; engine.renders = 0; engine.failures = 0; engine.wait = undefined })
const load = () => import('../src/renderer/src/lib/collaboration-routing')

type Point = readonly [number, number]
const boxes: CollaborationBox[] = [
  { id: 'heading', x: 8, y: 5, width: 870, height: 28, heading: true },
  { id: 'first', x: 18, y: 44, width: 250, height: 94 },
  { id: 'middle', x: 318, y: 44, width: 250, height: 94 },
  { id: 'last', x: 618, y: 44, width: 250, height: 94 }
]
const kinds = ['communication', 'creation', 'supervision'] as const
const connections: CollaborationConnection[] = kinds.flatMap(kind => [
  { id: `${kind}:across`, source: 'first', target: 'last', kind },
  { id: `${kind}:reverse`, source: 'last', target: 'first', kind },
  { id: `${kind}:adjacent`, source: 'first', target: 'middle', kind }
])

/** Read the actual SVG curve; this checker does not choose or reconstruct a route. */
function curve(path: string): { points: Point[]; samples: Point[] } {
  const tokens = path.match(/[MC]|-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/gi) ?? []
  expect(tokens.shift()).toBe('M')
  const points: Point[] = [[Number(tokens.shift()), Number(tokens.shift())]], samples: Point[] = []
  while (tokens.length) {
    expect(tokens.shift()).toBe('C')
    const start = points.at(-1)!, controls = Array.from({ length: 3 }, () => [Number(tokens.shift()), Number(tokens.shift())] as const)
    points.push(...controls)
    for (let step = 0; step <= 200; step++) {
      const t = step / 200, u = 1 - t
      samples.push([0, 1].map(axis => u ** 3 * start[axis]! + 3 * u ** 2 * t * controls[0]![axis]! + 3 * u * t ** 2 * controls[1]![axis]! + t ** 3 * controls[2]![axis]!) as unknown as Point)
    }
  }
  expect(points.every(point => point.every(Number.isFinite))).toBe(true)
  return { points, samples }
}

it('routes actual WASM curves around every same-row card and heading in both directions, preserving role ports', async () => {
  const { routeCollaboration } = await load()
  const snapshot = structuredClone({ boxes, connections })
  const paths = await routeCollaboration(boxes, connections)
  expect(Object.keys(paths).sort()).toEqual(connections.map(connection => connection.id).sort())
  expect({ boxes, connections }).toEqual(snapshot)
  const endpoints = new Map<string, { start: Point; end: Point }>()
  for (const connection of connections) {
    const routed = paths[connection.id]!, { points, samples } = curve(routed.path)
    const source = boxes.find(box => box.id === connection.source)!, target = boxes.find(box => box.id === connection.target)!, forward = source.x < target.x
    const start = points[0]!, end = points.at(-1)!
    endpoints.set(connection.id, { start, end })
    expect(start[0], connection.id + ' original source edge').toBeCloseTo(source.x + (forward ? source.width : 0), 0)
    expect(end[0], connection.id + ' original target edge').toBeCloseTo(target.x + (forward ? 0 : target.width), 0)
    expect(start[1]).toBeGreaterThan(source.y)
    expect(start[1]).toBeLessThan(source.y + source.height)
    expect(end[1]).toBeGreaterThan(target.y)
    expect(end[1]).toBeLessThan(target.y + target.height)
    expect(Number.isFinite(routed.labelX) && Number.isFinite(routed.labelY)).toBe(true)
    for (const box of boxes) {
      const interior = samples.find(([x, y]) => x > box.x + .5 && x < box.x + box.width - .5 && y > box.y + .5 && y < box.y + box.height - .5)
      expect(interior, `${connection.id} crosses ${box.id} interior at ${interior?.join(',')}`).toBeUndefined()
    }
  }
  expect(new Set(Object.values(paths).map(path => path.path)).size).toBe(connections.length)
  for (const suffix of ['across', 'reverse', 'adjacent']) {
    const rows = kinds.map(kind => endpoints.get(`${kind}:${suffix}`)!)
    expect(rows[0]!.start[1]).toBeLessThan(rows[0]!.end[1])
    expect(rows[0]!.end[1]).toBeLessThan(rows[1]!.start[1])
    expect(rows[1]!.start[1]).toBeLessThan(rows[1]!.end[1])
    expect(rows[1]!.end[1]).toBeLessThan(rows[2]!.start[1])
    expect(rows[2]!.start[1]).toBeLessThan(rows[2]!.end[1])
  }
  expect(engine.instances).toBe(1)
  expect(engine.renders).toBe(1)
})

it('does not initialize the engine or invent edges for an empty graph', async () => {
  const { routeCollaboration } = await load()
  expect(await routeCollaboration(boxes, [])).toEqual({})
  expect(engine.instances).toBe(0)
  expect(engine.renders).toBe(0)
})

it('does not initialize the engine for a request already cancelled before it starts', async () => {
  const { routeCollaboration } = await load(), cancellation = new AbortController()
  cancellation.abort()
  await expect(routeCollaboration(boxes, connections, cancellation.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(engine.instances).toBe(0)
  expect(engine.renders).toBe(0)
})

it('does not render an obsolete request cancelled while the shared engine is loading', async () => {
  const { routeCollaboration } = await load()
  let release!: () => void
  engine.wait = new Promise<void>(resolve => { release = resolve })
  const cancellation = new AbortController()
  const pending = routeCollaboration(boxes, connections, cancellation.signal)
  await vi.waitFor(() => expect(engine.instances).toBe(1))
  cancellation.abort()
  release()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(engine.renders).toBe(0)
  const paths = await routeCollaboration(boxes, connections)
  expect(Object.keys(paths)).toHaveLength(connections.length)
  expect(engine.instances).toBe(1)
  expect(engine.renders).toBe(1)
})

it('allows a failed lazy engine initialization to be retried and then reuses the recovered engine', async () => {
  const { routeCollaboration } = await load()
  engine.failures = 1
  await expect(routeCollaboration(boxes, connections)).rejects.toThrow('Routing engine unavailable')
  expect(engine.renders).toBe(0)
  const first = await routeCollaboration(boxes, connections), second = await routeCollaboration(boxes, connections)
  expect(second).toEqual(first)
  expect(engine.instances).toBe(2)
  expect(engine.renders).toBe(2)
})
