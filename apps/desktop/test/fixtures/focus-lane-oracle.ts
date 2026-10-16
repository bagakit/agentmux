import type { FocusLaneCounts, FocusLaneLayout, FocusLaneMetrics } from '../../src/renderer/src/lib/focus-lane-layout'

export function layoutCost(counts: FocusLaneCounts, layout: FocusLaneLayout, m: FocusLaneMetrics): number {
  const rows = [...new Set(layout.rowByBucket.filter(row => row >= 0))]
  return rows.reduce((sum, row) => {
    const tracks = Math.max(...counts.map((count, index) => layout.rowByBucket[index] === row ? Math.ceil(count / layout.columns[index]!) : 0))
    return sum + 24 + tracks * 52 + (tracks - 1) * m.cardGap
  }, Math.max(0, rows.length - 1) * m.gap)
}

/** Independent exhaustive oracle: enumerate every row break and column vector,
 * rather than sharing the product's binary-search row allocation. */
export function oracleCost(counts: FocusLaneCounts, m: FocusLaneMetrics): number {
  const members = counts.flatMap((count, index) => count ? [index] : [])
  let best = Infinity
  function rowCost(indices: number[]) {
    let minimum = Infinity
    function choose(at: number, columns: number[]) {
      if (at < indices.length) {
        for (let value = 1; value <= counts[indices[at]!]!; value++) choose(at + 1, [...columns, value])
        return
      }
      const used = columns.reduce((sum, value) => sum + value, 0)
      const required = used * 180 + (used - indices.length) * m.cardGap + (indices.length - 1) * m.gap
      if (required > m.width - m.padding && !(indices.length === 1 && used === 1)) return
      const tracks = Math.max(...indices.map((index, i) => Math.ceil(counts[index]! / columns[i]!)))
      minimum = Math.min(minimum, 24 + tracks * 52 + (tracks - 1) * m.cardGap)
    }
    choose(0, [])
    return minimum
  }
  function split(at: number, rows: number[][]) {
    if (at === members.length) {
      best = Math.min(best, rows.reduce((sum, row) => sum + rowCost(row), Math.max(0, rows.length - 1) * m.gap))
      return
    }
    if (rows.length) split(at + 1, [...rows.slice(0, -1), [...rows.at(-1)!, members[at]!]])
    split(at + 1, [...rows, [members[at]!]])
  }
  split(0, [])
  return best
}

