import { expect, it } from 'vitest'
import { allocateFocusLaneColumns, type FocusLaneLayout, type FocusLaneMetrics } from '../src/renderer/src/lib/focus-lane-layout'

import { layoutCost, oracleCost } from './fixtures/focus-lane-oracle'

const metrics = (width: number): FocusLaneMetrics => ({ width, padding: 4, gap: 2, cardGap: 2 })
it('matches every legal bounded row/column choice and exact per-row geometry', () => {
  let checked = 0
  for (const a of [0, 1, 3]) for (const b of [0, 1, 3]) for (const c of [0, 1, 3]) for (const d of [0, 1, 3]) {
    const counts = [a, b, c, d] as const
    for (const width of [176, 363.5, 500, 659, 728, 730, 1000.5, 1336]) {
      const m = metrics(width), actual = allocateFocusLaneColumns(counts, m)
      expect(layoutCost(counts, actual, m), JSON.stringify({ counts, width })).toBe(oracleCost(counts, m))
      let lastRow = -1
      for (let index = 0; index < 4; index++) {
        if (!counts[index]) { expect([actual.columns[index], actual.widths[index], actual.rowByBucket[index]]).toEqual([0, 0, -1]); continue }
        expect(actual.rowByBucket[index]).toBeGreaterThanOrEqual(lastRow)
        expect(actual.rowByBucket[index]! - lastRow).toBeLessThanOrEqual(1)
        lastRow = actual.rowByBucket[index]!
        expect(actual.columns[index]).toBeGreaterThan(0)
        expect(actual.columns[index]).toBeLessThanOrEqual(counts[index]!)
        const cardWidth = (actual.widths[index]! - (actual.columns[index]! - 1) * m.cardGap) / actual.columns[index]!
        expect(cardWidth).toBeGreaterThanOrEqual(Math.min(180, width - m.padding) - 1e-8)
        expect(cardWidth).toBeLessThanOrEqual(320)
        expect(actual.columnStart[index]! + actual.widths[index]!).toBeLessThanOrEqual(width - m.padding + 1e-8)
        const previous = [...Array(index).keys()].filter(i => counts[i]! > 0 && actual.rowByBucket[i] === actual.rowByBucket[index]).at(-1) ?? -1
        expect(actual.columnStart[index]).toBeCloseTo(previous < 0 ? 0 : actual.columnStart[previous]! + actual.widths[previous]! + m.gap)
      }
      checked++
    }
  }
  expect(checked).toBe(648)
})

it('uses multiple last-row columns without widening into a taller forced single row', () => {
  const counts = [1, 3, 5, 12] as const
  let previous: FocusLaneLayout | undefined, oldCost = Infinity
  for (const width of [659, 728, 729, 729.5, 730, 730.5, 1000.5, 1336]) {
    const m = metrics(width), layout = allocateFocusLaneColumns(counts, m, previous)
    const cost = layoutCost(counts, layout, m)
    expect(cost).toBe(oracleCost(counts, m))
    expect(cost).toBeLessThanOrEqual(oldCost)
    expect(layout.columns[3]).toBeGreaterThan(1)
    previous = layout; oldCost = cost
  }
  const small = allocateFocusLaneColumns([0, 1, 8, 2], metrics(500))
  expect(small.columns[3]).toBe(2)
  expect(small.widths[3]).toBe(496)
})

it('keeps equal-cost original placement/columns, and unknown width remains readable', () => {
  const first = allocateFocusLaneColumns([0, 13, 5, 1], metrics(1458))
  const next = allocateFocusLaneColumns([0, 12, 5, 1], metrics(1458), first)
  expect(next.rowByBucket).toEqual(first.rowByBucket)
  expect(next.columns).toEqual(first.columns)
  expect(allocateFocusLaneColumns([0, 5, 0, 0], metrics(500), { columns: [0, 1.8, 0, 0], rowByBucket: [-1, 0, -1, -1] }).columns).toEqual([0, 2, 0, 0])
  const unknown = allocateFocusLaneColumns([1, 1, 1, 1], metrics(0))
  expect(unknown.widths).toEqual([180, 180, 180, 180])
  expect(unknown.rowByBucket).toEqual([0, 1, 2, 3])
  const empty = allocateFocusLaneColumns([0, 0, 0, 0], metrics(1000))
  expect(empty.rowByBucket).toEqual([-1, -1, -1, -1])
})
