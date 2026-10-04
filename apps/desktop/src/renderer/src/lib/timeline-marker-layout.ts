/** One horizontal target budget for both consumers; glyphs remain 16px. */
export const TIMELINE_MARKER_SIZE = 20
export const TIMELINE_MARKER_HEIGHT = 24
export const TIMELINE_MARKER_MAX_OFFSET = TIMELINE_MARKER_SIZE / 2

export type TimelineMarker<T> = { fraction: number; member: T }
export type TimelineMarkerGroup<T> = { fraction: number; anchorFraction: number; members: T[] }

/** Disposable screen geometry. Fractions and member records are never rewritten. */
export function layoutTimelineMarkers<T>(markers: readonly TimelineMarker<T>[], width: number): TimelineMarkerGroup<T>[] {
  if (!Number.isFinite(width) || width <= 0 || markers.some(mark => !Number.isFinite(mark.fraction))) {
    return markers.map(mark => ({ fraction: mark.fraction, anchorFraction: mark.fraction, members: [mark.member] }))
  }
  const half = Math.min(TIMELINE_MARKER_SIZE / 2, width / 2)
  const positioned = markers.map((mark, index) => ({ ...mark, index, raw: Math.max(0, Math.min(width, mark.fraction * width)),
    center: Math.max(half, Math.min(width - half, mark.fraction * width)) }))
    .sort((a, b) => a.center - b.center || a.index - b.index)
  type Group = { entries: typeof positioned }
  const blocks: typeof positioned[] = []
  for (const mark of positioned) {
    const block = blocks.at(-1)
    // Even maximal local movement cannot collide across this empty gap.
    if (block && mark.center - block.at(-1)!.center < TIMELINE_MARKER_SIZE + 2 * TIMELINE_MARKER_MAX_OFFSET) block.push(mark)
    else blocks.push([mark])
  }
  const output: TimelineMarkerGroup<T>[] = []
  for (const block of blocks) {
    const groups: Group[] = block.map(mark => ({ entries: [mark] }))
    let centers = groups.map(group => group.entries[0]!.center)
    if (centers.some((center, index) => index > 0 && center - centers[index - 1]! < TIMELINE_MARKER_SIZE)) {
      // Earliest ordered placement is a feasibility proof, not the final pose.
      // A failed deadline means that this local prefix cannot hold every box.
      for (;;) {
        centers = []
        let failed = -1
        for (let index = 0; index < groups.length; index++) {
          const anchor = groups[index]!.entries[0]!
          const left = Math.max(half, anchor.raw - TIMELINE_MARKER_MAX_OFFSET)
          const right = Math.min(width - half, anchor.raw + TIMELINE_MARKER_MAX_OFFSET)
          const center = Math.max(left, index ? centers[index - 1]! + TIMELINE_MARKER_SIZE : left)
          if (center > right) { failed = index; break }
          centers.push(center)
        }
        if (failed < 0) break
        // Merge only the closest pair in the constrained prefix. Ties keep an
        // earlier original avatar visible; free neighbours are never swallowed
        // merely because they belong to the same connected density block.
        let pair = Math.max(0, failed - 1), distance = Infinity
        for (let index = 0; index < failed; index++) {
          const gap = groups[index + 1]!.entries[0]!.center - groups[index]!.entries[0]!.center
          if (gap <= distance) { distance = gap; pair = index }
        }
        groups.splice(pair, 2, { entries: [...groups[pair]!.entries, ...groups[pair + 1]!.entries] })
      }
      // Centre the feasible local arrangement near its actual event anchors.
      // No global spreading and no added timestamp or source-order changes.
      const shifts = groups.map((group, index) => group.entries[0]!.center - centers[index]!).sort((a, b) => a - b)
      const middle = Math.floor(shifts.length / 2)
      const preferred = shifts.length % 2 ? shifts[middle]! : (shifts[middle - 1]! + shifts[middle]!) / 2
      const slack = Math.min(...groups.map((group, index) => Math.min(width - half, group.entries[0]!.raw + TIMELINE_MARKER_MAX_OFFSET) - centers[index]!))
      const shift = Math.max(0, Math.min(slack, preferred))
      centers = centers.map(center => center + shift)
    }
    groups.forEach((group, index) => output.push({ fraction: centers[index]! / width,
      anchorFraction: group.entries[0]!.fraction,
      members: group.entries.sort((a, b) => a.index - b.index).map(entry => entry.member) }))
  }
  return output
}
