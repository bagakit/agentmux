export type WorkbenchTabStripMetrics = {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}

export type WorkbenchTabStripState = {
  hasOverflow: boolean
  canScrollStart: boolean
  canScrollEnd: boolean
}

const SCROLL_EDGE_TOLERANCE = 1

export function getWorkbenchTabStripState({
  scrollLeft,
  scrollWidth,
  clientWidth
}: WorkbenchTabStripMetrics): WorkbenchTabStripState {
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth)
  const hasOverflow = maxScrollLeft > SCROLL_EDGE_TOLERANCE
  return {
    hasOverflow,
    canScrollStart: hasOverflow && scrollLeft > SCROLL_EDGE_TOLERANCE,
    canScrollEnd: hasOverflow && scrollLeft < maxScrollLeft - SCROLL_EDGE_TOLERANCE
  }
}

export function sameWorkbenchTabStripState(
  left: WorkbenchTabStripState,
  right: WorkbenchTabStripState
): boolean {
  return left.hasOverflow === right.hasOverflow &&
    left.canScrollStart === right.canScrollStart &&
    left.canScrollEnd === right.canScrollEnd
}
