/**
 * Whether a pointer gesture that ended over a link should be treated as a click on that link.
 *
 * xterm's web-links addon fires its activate handler on any mouse-up over a URL, so dragging a
 * selection that happens to cross a link would otherwise raise the open menu instead of selecting
 * text. A real click stays put and leaves no selection behind.
 */
export const TERMINAL_LINK_DRAG_SLOP_PX = 4

export function isTerminalLinkClick(input: {
  /** Where the gesture began, or null when no press was seen (e.g. a synthetic activation). */
  origin: { x: number; y: number } | null
  release: { x: number; y: number }
  hasSelection: boolean
}): boolean {
  if (input.hasSelection) return false
  if (!input.origin) return true
  return (
    Math.abs(input.release.x - input.origin.x) <= TERMINAL_LINK_DRAG_SLOP_PX &&
    Math.abs(input.release.y - input.origin.y) <= TERMINAL_LINK_DRAG_SLOP_PX
  )
}
