/** One screen target budget for both timeline consumers; glyphs remain 16px. */
export const TIMELINE_MARKER_SIZE = 24

export type TimelineMarker<T> = { fraction: number; member: T }
export type TimelineMarkerGroup<T> = { fraction: number; members: T[] }

/** Disposable screen geometry. Fractions and member records are never rewritten. */
export function layoutTimelineMarkers<T>(markers: readonly TimelineMarker<T>[], width: number): TimelineMarkerGroup<T>[] {
  if (!Number.isFinite(width) || width <= 0) return markers.map(mark => ({ fraction: mark.fraction, members: [mark.member] }))
  const half = Math.min(TIMELINE_MARKER_SIZE / 2, width / 2)
  const positioned = markers.map((mark, index) => ({ ...mark, index, center: Math.max(half, Math.min(width - half, mark.fraction * width)) }))
    .sort((a, b) => a.center - b.center || a.index - b.index)
  const groups: { center: number; entries: typeof positioned }[] = []
  for (const mark of positioned) {
    const before = groups.at(-1)
    // A count occupies the same box as one avatar and keeps the first box's
    // anchor. Merging cannot widen it or pull the next free avatar into a chain.
    if (before && mark.center - before.center < TIMELINE_MARKER_SIZE) before.entries.push(mark)
    else groups.push({ center: mark.center, entries: [mark] })
  }
  return groups.map(group => ({ fraction: group.center / width,
    members: group.entries.sort((a, b) => a.index - b.index).map(entry => entry.member) }))
}
