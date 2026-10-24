/** Corner roles shared by avatar projections; overlapping clusters cover the right-hand band. */
export type PresenceMarkCorner = 'top-left' | 'bottom-left' | 'top-right' | 'bottom-right'

export const PRESENCE_MARK_CORNERS = {
  /** Attention must remain visible before decorative marks. */
  status: 'top-left',
  /** A merged-provider count uses the other visible corner. */
  count: 'bottom-left',
  badge: 'top-right',
  monogram: 'bottom-right'
} as const satisfies Record<string, PresenceMarkCorner>
