import { screen } from 'electron'
import type { VisibleArea } from './window-geometry.js'

/**
 * Snapshot the work area (menu bar / taskbar excluded) of every live display, primary first. This is
 * the one place the Electron `screen` module is touched for geometry recovery; the actual re-homing
 * decision lives in the pure `clampGeometryToVisibleArea`, which takes these rectangles so it can be
 * asserted without a display server. Primary-first ordering matters: the clamp re-homes an off-screen
 * window into `visibleAreas[0]`.
 */
export function liveVisibleAreas(): VisibleArea[] {
  const primary = screen.getPrimaryDisplay()
  const others = screen.getAllDisplays().filter((display) => display.id !== primary.id)
  return [primary, ...others].map((display) => ({
    x: display.workArea.x,
    y: display.workArea.y,
    width: display.workArea.width,
    height: display.workArea.height
  }))
}
