import { expect, it } from 'vitest'
import { interpolateCollaborationGeometry, type CollaborationGeometryFrame } from '../src/renderer/src/lib/collaboration-map-transition'
import type { CollaborationLayoutBox, CollaborationLayoutPoint, CollaborationPath } from '../src/renderer/src/lib/collaboration-layout-engine'

const box = (id: string, x: number, y: number): CollaborationLayoutBox => ({ id, areaId: 'region', kind: 'agent', folded: false, x, y, width: 100, height: 60 })
const path = (points: readonly CollaborationLayoutPoint[]): CollaborationPath => ({ id: 'original-relation', points,
  path: 'M ' + points[0]!.x + ' ' + points[0]!.y + ' ' + Array.from({ length: (points.length - 1) / 3 }, (_, index) => 'C ' + points.slice(index * 3 + 1, index * 3 + 4).flatMap(point => [point.x, point.y]).join(' ')).join(' '),
  sourceHandle: 'message-out', targetHandle: 'message-in', labelX: 200, labelY: 100, bounds: { x: 100, y: 30, width: 300, height: 200 } })
const at = (points: readonly CollaborationLayoutPoint[], t: number) => {
  const count = (points.length - 1) / 3, segment = Math.min(count - 1, Math.floor(t * count)), local = t * count - segment, u = 1 - local
  const [a, b, c, d] = points.slice(segment * 3, segment * 3 + 4)
  return { x: u ** 3 * a!.x + 3 * u ** 2 * local * b!.x + 3 * u * local ** 2 * c!.x + local ** 3 * d!.x,
    y: u ** 3 * a!.y + 3 * u ** 2 * local * b!.y + 3 * u * local ** 2 * c!.y + local ** 3 * d!.y }
}

it('keeps one bounded geometry progress for complete cubics, exact headings and unchanged distant objects', () => {
  const distant = box('unrelated', 9000, 8000), source = box('source', 0, 0), target = box('target', 400, 0)
  const region: CollaborationLayoutBox = { id: 'region', areaId: 'region', kind: 'area', folded: false, x: -24, y: -64, width: 550, height: 180,
    heading: { x: 24, y: 0, width: 184, height: 40 } }
  const oldPath = path([{ x: 100, y: 30 }, { x: 200, y: 230 }, { x: 300, y: 230 }, { x: 400, y: 30 }])
  const newPath = path([{ x: 120, y: 50 }, { x: 180, y: 150 }, { x: 220, y: 180 }, { x: 260, y: 180 }, { x: 300, y: 180 }, { x: 360, y: 150 }, { x: 420, y: 50 }])
  const from: CollaborationGeometryFrame = { boxes: new Map([source, target, region, distant].map(value => [value.id, value])), paths: new Map([[oldPath.id, oldPath]]) }
  const nextRegion = { ...region, x: -14, y: -54, width: 570, heading: { ...region.heading, x: 34, y: 10 } }
  const to: CollaborationGeometryFrame = { boxes: new Map([box('source', 20, 20), box('target', 420, 20), nextRegion, distant].map(value => [value.id, value])), paths: new Map([[newPath.id, newPath]]) }
  const original = structuredClone({ from, to }), before = interpolateCollaborationGeometry(from, to, 0), middle = interpolateCollaborationGeometry(from, to, .5)
  expect(middle.boxes.get('source')).toMatchObject({ x: 10, y: 10 }); expect(middle.boxes.get('unrelated')).toBe(distant)
  const heading = middle.boxes.get('region') as typeof region
  expect(heading.x + heading.heading.x).toBe(10); expect(heading.y + heading.heading.y).toBe(-54)
  for (const t of [0, .1, .25, .5, .75, .9, 1]) {
    const a = at(oldPath.points, t), b = at(newPath.points, t), start = at(before.paths.get(oldPath.id)!.points, t), mid = at(middle.paths.get(oldPath.id)!.points, t)
    expect(start.x).toBeCloseTo(a.x, 9); expect(start.y).toBeCloseTo(a.y, 9)
    expect(mid.x).toBeCloseTo((a.x + b.x) / 2, 9); expect(mid.y).toBeCloseTo((a.y + b.y) / 2, 9)
  }
  expect(middle.paths.get(oldPath.id)!.points.length).toBeGreaterThan(4)
  expect(interpolateCollaborationGeometry(from, to, 1)).toBe(to)
  expect({ from, to }).toEqual(original)
})
