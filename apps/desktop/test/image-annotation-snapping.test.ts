import { describe, expect, it } from 'vitest'
import { pointFeatures, rectFeatures, snap, snapLines, SNAP_DISTANCE } from '@agentmux/client-ui/image-annotation'

// A 2x display: 6 screen points are 12 image pixels.
const THRESHOLD = SNAP_DISTANCE * 2
const WINDOW = { x: 100, y: 50, width: 400, height: 300 }

describe('capture snapping model', () => {
  it('snaps within 6 screen points and leaves anything farther exactly where it is', () => {
    expect(SNAP_DISTANCE, 'the contract distance in screen points').toBe(6)
    const lines = snapLines([WINDOW], null, [])
    expect(snap(pointFeatures({ x: 112, y: 200 }), lines, THRESHOLD), 'a point 12 px from the left edge lands on it').toEqual({ dx: -12, dy: 0, guides: { x: [100], y: [] } })
    expect(snap(pointFeatures({ x: 113, y: 200 }), lines, THRESHOLD), 'a point 13 px away stays put').toEqual({ dx: 0, dy: 0, guides: { x: [], y: [] } })
    expect(snap(pointFeatures({ x: 495, y: 356 }), lines, THRESHOLD), 'both axes snap on their own').toEqual({ dx: 5, dy: -6, guides: { x: [500], y: [350] } })
  })

  it('moves the nearest feature onto the nearest line, the first of equal distances winning', () => {
    const lines = { x: [100, 110], y: [] }
    expect(snap(pointFeatures({ x: 107, y: 0 }), lines, THRESHOLD).dx, 'the nearer line wins').toBe(3)
    expect(snap(pointFeatures({ x: 105, y: 0 }), lines, THRESHOLD).dx, 'a tie keeps the first line').toBe(-5)
    // A moved 40 px wide rect at 203: its right edge is 3 from 246 and its left 7 from 196.
    const moved = rectFeatures({ x: 203, y: 0, width: 40, height: 10 }, null)
    expect(snap(moved, { x: [196, 246], y: [] }, THRESHOLD), 'the edge closest to any line decides the shift').toEqual({ dx: 3, dy: 0, guides: { x: [246], y: [] } })
  })

  it('offers marks their edges and centre, and windows and the selection their edges only', () => {
    const mark = { x: 600, y: 400, width: 100, height: 60 }, selection = { x: 20, y: 30, width: 40, height: 50 }
    expect(snapLines([WINDOW], selection, [mark]), 'every candidate line in image pixels').toEqual({ x: [100, 500, 20, 60, 600, 650, 700], y: [50, 350, 30, 80, 400, 430, 460] })
    expect(snap(pointFeatures({ x: 655, y: 0 }), snapLines([], null, [mark]), THRESHOLD), 'a mark centre is a line').toEqual({ dx: -5, dy: 0, guides: { x: [650], y: [] } })
    expect(snap(pointFeatures({ x: 300, y: 205 }), snapLines([WINDOW], null, []), THRESHOLD).dy, 'a window centre is not a line').toBe(0)
    // A moved rect's centre lands on a mark's centre; every line a shifted feature lies on is a guide.
    const aligned = rectFeatures({ x: 603, y: 0, width: 100, height: 10 }, null)
    expect(snap(aligned, snapLines([], null, [mark]), THRESHOLD), 'an equal-width rect lands on both edges and the centre').toEqual({ dx: -3, dy: 0, guides: { x: [600, 650, 700], y: [] } })
  })

  it('snaps a resized rect only by the edges its handle moves', () => {
    const rect = { x: 105, y: 45, width: 390, height: 302 }, lines = snapLines([WINDOW], null, [])
    expect(rectFeatures(rect, 'e'), 'an east handle moves only the right edge').toEqual({ x: [495], y: [] })
    expect(rectFeatures(rect, 'nw'), 'a corner moves one edge per axis').toEqual({ x: [105], y: [45] })
    expect(snap(rectFeatures(rect, 'n'), lines, THRESHOLD), 'the fixed edges do not snap').toEqual({ dx: 0, dy: 5, guides: { x: [], y: [50] } })
  })

  it('snaps nothing with no lines or no features, which is what holding Command leaves', () => {
    expect(snap(pointFeatures({ x: 101, y: 51 }), { x: [], y: [] }, THRESHOLD)).toEqual({ dx: 0, dy: 0, guides: { x: [], y: [] } })
    expect(snap({ x: [], y: [] }, snapLines([WINDOW], null, []), THRESHOLD)).toEqual({ dx: 0, dy: 0, guides: { x: [], y: [] } })
    expect(snap(pointFeatures({ x: 100, y: 200 }), snapLines([WINDOW], null, []), THRESHOLD), 'a point already on a line still shows its guide').toEqual({ dx: 0, dy: 0, guides: { x: [100], y: [] } })
  })
})
