import { expect, it } from 'vitest'
import { collaborationEnvelope, collaborationVisiblePath } from '../src/renderer/src/lib/collaboration-map-geometry'
import { collaborationCameraDuration, collaborationMapLod, collaborationOverviewScale, collaborationVisibleHull } from '../src/renderer/src/lib/collaboration-map-lod'
import { routeCollaborationLayout, type CollaborationLayoutBox, type CollaborationPath } from '../src/renderer/src/lib/collaboration-layout-engine'

const member = (id: string, x: number, y: number, width = 250, height = 94): CollaborationLayoutBox =>
  ({ kind: 'agent', id, areaId: 'area', x, y, width, height, folded: false })

it('encloses complete member corners and the exact heading without a rectangular frame', () => {
  const area: Extract<CollaborationLayoutBox, { kind: 'area' }> = { kind: 'area', id: 'area', areaId: 'area', folded: false,
    x: 100, y: 200, width: 640, height: 440, heading: { x: 140, y: 8, width: 184, height: 40 } }
  const members = [member('a', 130, 280), member('b', 420, 440), member('closed', 500, 590, 14, 14)]
  const path = collaborationEnvelope(area, members)
  // Sample the actual drawn quadratic boundary, rather than testing a second hull implementation.
  const commands = [...path.matchAll(/([MLQ]) ([\d. -]+)/g)]
  let previous = { x: 0, y: 0 }
  const outline = commands.flatMap(([, command, coordinates]) => {
    const n = coordinates!.trim().split(/\s+/).map(Number)
    if (command !== 'Q') { previous = { x: n[0]!, y: n[1]! }; return [previous] }
    const from = previous, control = { x: n[0]!, y: n[1]! }, to = { x: n[2]!, y: n[3]! }
    previous = to
    return Array.from({ length: 20 }, (_, index) => {
      const t = (index + 1) / 20
      return { x: (1-t)**2*from.x + 2*(1-t)*t*control.x + t*t*to.x, y: (1-t)**2*from.y + 2*(1-t)*t*control.y + t*t*to.y }
    })
  })
  const inside = (x: number, y: number) => {
    let count = 0
    for (let index = 0; index < outline.length; index++) {
      const a = outline[index]!, b = outline[(index + 1) % outline.length]!
      if ((a.y > y) !== (b.y > y) && x < (b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x) count++
    }
    return count % 2 === 1
  }
  for (const box of [area.heading, ...members.map(box => ({ ...box, x: box.x-area.x, y: box.y-area.y }))]) {
    for (const [x, y] of [[box.x, box.y], [box.x+box.width, box.y], [box.x+box.width, box.y+box.height], [box.x, box.y+box.height]])
      expect(inside(x!, y!), `${x},${y}`).toBe(true)
  }
  expect(inside(600, 30)).toBe(false)
  expect(inside(30, 400)).toBe(false)
  expect(collaborationEnvelope(area, [...members].reverse())).toBe(path)
  expect(path).not.toMatch(/NaN|Infinity/)
})

it('joins visible overview points to the original directed route without moving its obstacle detour', () => {
  const source = member('from', 0, 0), target = member('to', 500, 200)
  const points = [{ x: 250, y: 20 }, { x: 310, y: 20 }, { x: 420, y: 240 }, { x: 500, y: 240 }]
  const route: CollaborationPath = { id: 'message', points, path: 'M 250 20 C 310 20 420 240 500 240',
    sourceHandle: 'out', targetHandle: 'in', labelX: 375, labelY: 140, bounds: { x: 250, y: 20, width: 250, height: 220 } }
  const original = structuredClone(route)
  const path = collaborationVisiblePath(route, source, target, .25, 14, 6)
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
  expect(numbers.slice(6, 14)).toEqual(points.flatMap(point => [point.x, point.y]))
  expect(Math.hypot(numbers[0]!-125, numbers[1]!-47)).toBeCloseTo(56)
  expect(Math.hypot(numbers.at(-2)!-625, numbers.at(-1)!-247)).toBeCloseTo(24)
  expect(route).toEqual(original)
  expect(collaborationOverviewScale(member('closed', 0, 0, 14, 14), .05)).toBe(1)
})


it('clips original short creation ports at overview circles without reversing their terminal tangents', async () => {
  const source = member('from', 0, 0, 248, 94), target = member('to', 0, 500, 248, 94)
  for (const obstructed of [false, true]) {
    const obstacle = member('obstacle', 20, 220, 248, 94)
    const [route] = await routeCollaborationLayout([source, target, ...(obstructed ? [obstacle] : [])], [{ id: 'created', kind: 'creation', source: 'from', target: 'to' }])
    expect(route).toBeDefined()
    expect(route!.sourceHandle).toBe('creation-out-bottom'); expect(route!.targetHandle).toBe('creation-in-top')
    const original = structuredClone(route!), zoom = .2, radius = 14 / zoom
    if (obstructed) expect(route!.points.length).toBeGreaterThan(7)
    const path = collaborationVisiblePath(route!, source, target, zoom, 14, 14)
    const numbers = path.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g)!.map(Number)
    const points = numbers.flatMap((value, index) => index % 2 ? [] : [{ x: value, y: numbers[index + 1]! }])
    expect(points.length).toBeGreaterThanOrEqual(4); expect((points.length - 1) % 3).toBe(0)
    const center = (box: CollaborationLayoutBox) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
    const from = center(source), to = center(target), start = points[0]!, end = points.at(-1)!
    expect(Math.hypot(start.x - from.x, start.y - from.y)).toBeCloseTo(radius, 5)
    expect(Math.hypot(end.x - to.x, end.y - to.y)).toBeCloseTo(radius, 5)
    expect((points[1]!.x - start.x) * (start.x - from.x) + (points[1]!.y - start.y) * (start.y - from.y)).toBeGreaterThan(0)
    expect((end.x - points.at(-2)!.x) * (end.x - to.x) + (end.y - points.at(-2)!.y) * (end.y - to.y)).toBeLessThan(0)
    for (let index = 0; index < points.length - 1; index += 3) for (let sample = 0; sample <= 20; sample++) {
      const t = sample / 20, u = 1 - t, [a, b, c, d] = points.slice(index, index + 4)
      const x = u ** 3 * a!.x + 3 * u ** 2 * t * b!.x + 3 * u * t ** 2 * c!.x + t ** 3 * d!.x
      const y = u ** 3 * a!.y + 3 * u ** 2 * t * b!.y + 3 * u * t ** 2 * c!.y + t ** 3 * d!.y
      expect(Math.hypot(x - from.x, y - from.y)).toBeGreaterThanOrEqual(radius - 1e-5)
      expect(Math.hypot(x - to.x, y - to.y)).toBeGreaterThanOrEqual(radius - 1e-5)
    }
    if (obstructed) {
      const middle = original.points.slice(6, -6)
      expect(middle.length).toBeGreaterThan(0)
      expect(middle.every(point => points.some(value => value.x === point.x && value.y === point.y))).toBe(true)
    }
    expect(route).toEqual(original)
  }
  // Disjoint original cards may have overlapping screen-size avatars at a
  // distant zoom. Their completely covered route has no visible ink to add.
  const adjacent = { ...target, y: 122 }
  const [covered] = await routeCollaborationLayout([source, adjacent], [{ id: 'covered', kind: 'creation', source: 'from', target: 'to' }])
  const retained = structuredClone(covered!)
  expect(collaborationVisiblePath(covered!, source, adjacent, .05, 14, 14)).toBe('')
  expect(covered).toEqual(retained)
})

it('keeps actual endpoint ink continuous through both former LOD thresholds without moving the world', () => {
  const source = member('source', 100, 200), target = member('target', 700, 450)
  const route: CollaborationPath = { id: 'continuous', points: [{ x: 350, y: 247 }, { x: 400, y: 247 }, { x: 650, y: 497 }, { x: 700, y: 497 }],
    path: 'M 350 247 C 400 247 650 497 700 497', sourceHandle: 'out', targetHandle: 'in', labelX: 525, labelY: 372,
    bounds: { x: 350, y: 247, width: 350, height: 250 } }
  const original = structuredClone({ source, target, route })
  const endpoints = (zoom: number) => {
    const numbers = collaborationVisiblePath(route, source, target, zoom, 14, 14).match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)!.map(Number)
    return [{ x: numbers[0]!, y: numbers[1]! }, { x: numbers.at(-2)!, y: numbers.at(-1)! }]
  }
  for (const zoom of [.32, .44, .45, .46, .58, .62, .69, .7, .71, .82]) {
    const ends = endpoints(zoom)
    for (const [index, box] of [source, target].entries()) {
      const hull = collaborationVisibleHull(box, zoom), endpoint = ends[index]!
      // This route leaves horizontally: its real ink must meet the rendered side.
      expect(endpoint.x).toBeCloseTo(index ? hull.x : hull.x + hull.width, 5)
      expect(endpoint.y).toBeCloseTo(box.y + box.height / 2, 5)
      expect(hull.x + hull.width / 2).toBe(box.x + box.width / 2)
      expect(hull.y + hull.height / 2).toBe(box.y + box.height / 2)
    }
    const before = endpoints(zoom - 1e-5), after = endpoints(zoom + 1e-5)
    expect(Math.hypot(before[0]!.x - after[0]!.x, before[0]!.y - after[0]!.y)).toBeLessThan(.02)
  }
  expect(collaborationMapLod(.69).detail).toBeGreaterThan(0)
  expect(collaborationMapLod(.71).detail).toBeLessThan(1)
  expect(collaborationMapLod(.69).detail).toBeLessThan(collaborationMapLod(.71).detail)
  expect(collaborationVisiblePath(route, source, target, 1, 14, 14)).toBe(route.path)
  expect({ source, target, route }).toEqual(original)
  expect(collaborationCameraDuration(false)).toBe(0)
  expect(collaborationCameraDuration(true, true)).toBe(0)
  expect(collaborationCameraDuration(true)).toBeGreaterThanOrEqual(200)
})
