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

/**
 * Whether the modifier held during a link click should open the link in the system browser
 * immediately, skipping the destination menu. macOS uses Cmd; other platforms use Ctrl. On macOS
 * Ctrl+click is a right-click, so it is deliberately not a fast-path there.
 */
export function terminalLinkModifierOpensSystemBrowser(
  event: { metaKey: boolean; ctrlKey: boolean },
  isMac: boolean
): boolean {
  return isMac ? event.metaKey : event.ctrlKey
}

/** Upper bound on the preview's rendered height, used to decide whether it fits above the link. */
export const TERMINAL_LINK_PREVIEW_MAX_HEIGHT_PX = 34
export const TERMINAL_LINK_PREVIEW_MAX_WIDTH_PX = 360
/** Clear space kept between the preview and the link row, so the preview never covers the link. */
export const TERMINAL_LINK_PREVIEW_GAP_PX = 6

/**
 * Where to place the hover preview so it never covers the link and stays inside the terminal.
 *
 * The pointer sits somewhere inside the hovered cell; clearing a full `cellHeight` plus the gap
 * guarantees the preview clears the whole link row whatever the pointer's offset within the cell.
 * The preview is anchored above the link when there is room and flips below otherwise; the caller
 * grows an `above` preview upward from `top` (e.g. `transform: translateY(-100%)`) since its rendered
 * height is not known here.
 */
export function terminalLinkPreviewAnchor(input: {
  pointer: { x: number; y: number }
  cellHeight: number
  viewport: { left: number; top: number; right: number; bottom: number }
}): { left: number; top: number; placement: 'above' | 'below' } {
  const clearance = Math.max(0, input.cellHeight) + TERMINAL_LINK_PREVIEW_GAP_PX
  const fitsAbove =
    input.pointer.y - clearance - TERMINAL_LINK_PREVIEW_MAX_HEIGHT_PX >= input.viewport.top
  const placement: 'above' | 'below' = fitsAbove ? 'above' : 'below'
  const top = placement === 'above' ? input.pointer.y - clearance : input.pointer.y + clearance
  const maxLeft = input.viewport.right - TERMINAL_LINK_PREVIEW_MAX_WIDTH_PX
  const left = Math.max(input.viewport.left, Math.min(input.pointer.x, maxLeft))
  return { left, top, placement }
}
