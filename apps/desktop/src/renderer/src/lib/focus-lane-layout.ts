export type FocusLaneCounts = readonly [number, number, number, number]
export type FocusLaneMetrics = { width: number; padding: number; gap: number; cardGap: number }
export type FocusLaneLayout = { columns: readonly number[]; widths: readonly number[]; maxRows: number; slots: number }

/** Only content uses card slots; zero states and offline entries live in the title. */
export function allocateFocusLaneColumns(counts: FocusLaneCounts, metrics: FocusLaneMetrics, previous?: readonly number[]): FocusLaneLayout {
  const nonempty = counts.filter(count => count > 0).length
  const available = metrics.width - metrics.padding - Math.max(0, nonempty - 1) * metrics.gap
  const slots = Math.max(0, Math.floor((available + nonempty * metrics.cardGap) / (180 + metrics.cardGap)))
  let columns: readonly number[] = counts.map(count => count ? 1 : 0)
  let maxRows = Math.max(0, ...counts)
  if (nonempty && slots >= nonempty) {
    let low = 1, high = maxRows
    while (low < high) {
      const rows = Math.floor((low + high) / 2)
      if (counts.reduce((sum, count) => sum + Math.ceil(count / rows), 0) <= slots) high = rows
      else low = rows + 1
    }
    maxRows = low
    const stillOptimal = previous?.length === 4
      && previous.every((column, index) => counts[index]! ? column >= 1 && column <= counts[index]! : column === 0)
      && previous.reduce((sum, column) => sum + column, 0) <= slots
      && Math.max(...counts.map((count, index) => count ? Math.ceil(count / previous[index]!) : 0)) === maxRows
    columns = stillOptimal ? previous! : counts.map(count => Math.ceil(count / maxRows))
  }
  const used = columns.reduce((sum, column) => sum + column, 0)
  const cardWidth = slots >= nonempty && used
    ? Math.min(320, Math.max(180, (available + nonempty * metrics.cardGap) / used - metrics.cardGap))
    : 180
  const widths = columns.map(column => column ? column * cardWidth + (column - 1) * metrics.cardGap : 0)
  // Flex wraps whole state groups. Budget each resulting row independently,
  // rather than leaving every group at the minimum width after wrapping.
  if (metrics.width > 0 && nonempty && slots < nonempty) {
    const perRow = Math.max(1, slots)
    const indices = counts.flatMap((count, index) => count ? [index] : [])
    for (let start = 0; start < indices.length; start += perRow) {
      const row = indices.slice(start, start + perRow)
      const width = Math.min(320, Math.max(0, (metrics.width - metrics.padding - (row.length - 1) * metrics.gap) / row.length))
      for (const index of row) widths[index] = width
    }
  }
  return { columns, widths, maxRows, slots }
}
