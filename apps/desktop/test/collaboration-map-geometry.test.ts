import { expect, it } from 'vitest'
import { collaborationEnvelope, collaborationOverviewPath, collaborationOverviewScale } from '../src/renderer/src/lib/collaboration-map-geometry'
import type { CollaborationLayoutBox, CollaborationPath } from '../src/renderer/src/lib/collaboration-layout-engine'

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
  const path = collaborationOverviewPath(route, source, target, .25)
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
  expect(numbers.slice(6, 14)).toEqual(points.flatMap(point => [point.x, point.y]))
  expect(Math.hypot(numbers[0]!-125, numbers[1]!-47)).toBeCloseTo(24)
  expect(Math.hypot(numbers.at(-2)!-625, numbers.at(-1)!-247)).toBeCloseTo(24)
  expect(route).toEqual(original)
  expect(collaborationOverviewScale(member('closed', 0, 0, 14, 14), .05)).toBe(1)
})
