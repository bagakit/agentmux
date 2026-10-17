import type { FocusReplyLines } from '../../../shared/focus-preferences'

export type FocusLaneCounts = readonly [number, number, number, number]
export type FocusLaneMetrics = { width: number; padding: number; gap: number; cardGap: number; replyLines?: FocusReplyLines }
export type FocusLaneLayout = {
  columns: readonly number[]; widths: readonly number[]
  /** Logical row and leading CSS-pixel offset; empty buckets have row -1. */
  rowByBucket: readonly number[]; columnStart: readonly number[]
  maxRows: number; slots: number
}
type PreviousLayout = Pick<FocusLaneLayout, 'columns' | 'rowByBucket'>

/** Shared comparison/placeholder budget. Real service cards may be taller. */
export function focusCardTrackHeight(lines: FocusReplyLines = 2): number { return 24 + lines * 14 }
const GROUP_HEADING = 24
const MIN_CARD_WIDTH = 180
const MAX_CARD_WIDTH = 320

/** One bounded plan owns rows and columns; zero states live only in the title. */
export function allocateFocusLaneColumns(counts: FocusLaneCounts, metrics: FocusLaneMetrics, previous?: PreviousLayout): FocusLaneLayout {
  const indices = counts.flatMap((count, index) => count > 0 ? [index] : [])
  const empty = () => counts.map(() => 0)
  const contentWidth = Math.max(1, metrics.width - metrics.padding)
  const capacity = (groups: number) => Math.max(0, Math.floor((contentWidth - Math.max(0, groups - 1) * metrics.gap + groups * metrics.cardGap) / (MIN_CARD_WIDTH + metrics.cardGap)))
  const slots = metrics.width > 0 && indices.length ? capacity(indices.length) : 0
  if (!indices.length || metrics.width <= 0) {
    // Unknown width is not a zero-width card. Real measurement replaces this
    // readable fallback before normal visible bodies are created.
    return { columns: counts.map(count => count > 0 ? 1 : 0), widths: counts.map(count => count > 0 ? MIN_CARD_WIDTH : 0),
      rowByBucket: counts.map((count, index) => count > 0 ? indices.indexOf(index) : -1),
      columnStart: empty(), maxRows: Math.max(0, ...counts), slots }
  }
  type Candidate = FocusLaneLayout & { cost: number; rowCount: number }
  let best: Candidate | undefined
  // Four ordered states have at most eight contiguous partitions. The renderer
  // consumes this placement directly; CSS makes no second wrapping choice.
  for (let breaks = 0; breaks < 1 << (indices.length - 1); breaks += 1) {
    const rows: number[][] = [[]]
    indices.forEach((index, position) => {
      rows[rows.length - 1]!.push(index)
      if (position < indices.length - 1 && breaks & (1 << position)) rows.push([])
    })
    const columns = empty(), widths = empty(), rowByBucket = counts.map(() => -1), columnStart = empty()
    let valid = true, cost = Math.max(0, rows.length - 1) * metrics.gap, maxRows = 0
    for (const [row, members] of rows.entries()) {
      const rowSlots = capacity(members.length)
      if (rowSlots < members.length && members.length > 1) { valid = false; break }
      const budget = Math.max(1, rowSlots)
      let low = 1, high = Math.max(...members.map(index => counts[index]!))
      while (low < high) {
        const height = Math.floor((low + high) / 2)
        if (members.reduce((sum, index) => sum + Math.ceil(counts[index]! / height), 0) <= budget) high = height
        else low = height + 1
      }
      const stillOptimal = previous?.columns.length === 4
        && members.every(index => Number.isInteger(previous.columns[index]) && previous.columns[index]! >= 1 && previous.columns[index]! <= counts[index]!)
        && members.reduce((sum, index) => sum + previous.columns[index]!, 0) <= budget
        && Math.max(...members.map(index => Math.ceil(counts[index]! / previous.columns[index]!))) === low
      for (const index of members) columns[index] = stillOptimal ? previous!.columns[index]! : Math.ceil(counts[index]! / low)
      const used = members.reduce((sum, index) => sum + columns[index]!, 0)
      const available = contentWidth - (members.length - 1) * metrics.gap
      const cardWidth = Math.min(MAX_CARD_WIDTH, Math.max(1, (available + members.length * metrics.cardGap) / used - metrics.cardGap))
      let start = 0
      for (const index of members) {
        widths[index] = columns[index]! * cardWidth + (columns[index]! - 1) * metrics.cardGap
        rowByBucket[index] = row; columnStart[index] = start
        start += widths[index]! + metrics.gap
      }
      maxRows = Math.max(maxRows, low)
      cost += GROUP_HEADING + low * focusCardTrackHeight(metrics.replyLines) + Math.max(0, low - 1) * metrics.cardGap
    }
    if (!valid) continue
    const keepsRows = (placement: readonly number[]) => previous?.rowByBucket.length === 4
      && placement.every((row, index) => row === previous.rowByBucket[index])
    if (!best || cost < best.cost || cost === best.cost && (rows.length < best.rowCount
      || rows.length === best.rowCount && keepsRows(rowByBucket) && !keepsRows(best.rowByBucket))) {
      best = { columns, widths, rowByBucket, columnStart, maxRows, slots, cost, rowCount: rows.length }
    }
  }
  // A positive measured width admits every real state on its own row.
  const { cost: _cost, rowCount: _rowCount, ...layout } = best!
  return layout
}
