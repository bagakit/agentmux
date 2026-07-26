/**
 * Pure window-geometry projections. No Electron or fs import so the derivation can be asserted
 * directly — the window itself is unavailable in the test harness.
 *
 * Why this exists: the window used to open at a fixed 1480×940 every launch, discarding wherever the
 * user had last sized and placed it. These functions turn a persisted record into constructor options
 * and back, so a restart reopens the window where it was left instead of snapping to the literal.
 */

export type WindowGeometry = {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

/**
 * First-launch fallback only. Once a window has been sized these are never consulted again: the
 * persisted record wins. Reverting the constructor to consult this literal instead of the persisted
 * geometry is exactly the regression the round-trip test guards. Kept module-private — nothing
 * outside this file should reach for the default rather than the persisted geometry.
 */
const DEFAULT_WINDOW_WIDTH = 1480
const DEFAULT_WINDOW_HEIGHT = 940

// Mirror the BrowserWindow minWidth/minHeight so a corrupt or absurd stored size can never open an
// unusable window. A record that violates these is rejected wholesale rather than clamped, because a
// too-small persisted size is more likely corruption than intent.
const MIN_WIDTH = 980
const MIN_HEIGHT = 660

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Validate a record read back from disk. Persisted geometry is untrusted JSON: a NaN, a negative
 * size, or a below-minimum size must fall back to the default rather than open a broken window.
 * Position is optional (a window that has never moved has none) and is only carried when both
 * coordinates are finite.
 */
export function parseStoredGeometry(raw: unknown): WindowGeometry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (!isFiniteNumber(record.width) || !isFiniteNumber(record.height)) return null
  if (record.width < MIN_WIDTH || record.height < MIN_HEIGHT) return null
  const geometry: WindowGeometry = {
    width: record.width,
    height: record.height,
    maximized: record.maximized === true
  }
  if (isFiniteNumber(record.x) && isFiniteNumber(record.y)) {
    geometry.x = record.x
    geometry.y = record.y
  }
  return geometry
}

/**
 * Constructor size/position for a new window. With no persisted record (first launch, or a record
 * rejected by parseStoredGeometry) this is the default size and the OS picks the position; with one,
 * the window opens at the persisted size and, when known, the persisted position. A maximized record
 * still carries its normal bounds here so the caller maximizes on top of a sane restore size.
 */
export function windowConstructorGeometry(
  persisted: WindowGeometry | null
): { width: number; height: number; x?: number; y?: number } {
  if (!persisted) return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT }
  const geometry: { width: number; height: number; x?: number; y?: number } = {
    width: persisted.width,
    height: persisted.height
  }
  if (persisted.x !== undefined && persisted.y !== undefined) {
    geometry.x = persisted.x
    geometry.y = persisted.y
  }
  return geometry
}

/** A display's usable area (menu bar / taskbar excluded). Kept structural so this module stays free
 * of any Electron import and the clamp below can be asserted with plain rectangles. */
export type VisibleArea = { x: number; y: number; width: number; height: number }

// The window must present at least this much of itself inside some visible area, or its title bar is
// unreachable. 48px is enough to grab and drag it back regardless of platform chrome height.
const MIN_VISIBLE_EXTENT = 48

function overlapExtent(start: number, length: number, areaStart: number, areaLength: number): number {
  return Math.max(0, Math.min(start + length, areaStart + areaLength) - Math.max(start, areaStart))
}

function clampOrigin(origin: number, extent: number, areaStart: number, areaLength: number): number {
  // A window larger than the work area can only start at its edge; otherwise keep the saved origin
  // but pull it inside so the whole window lands on the reachable display.
  const maxStart = areaStart + areaLength - extent
  if (maxStart <= areaStart) return areaStart
  return Math.min(Math.max(origin, areaStart), maxStart)
}

/**
 * Re-home a persisted window that would open where the user can never reach it. A monitor that was
 * unplugged, a resolution change, or a profile carried between machines can leave the saved position
 * on coordinates no live display covers. If the window still shows at least a grabbable strip on some
 * visible area it is left exactly as saved (spanning two monitors is legitimate); only when it is
 * effectively off-screen is its origin clamped into the primary visible area. Size and the maximized
 * flag are never touched — this corrects position, not the shape the user chose.
 *
 * `visibleAreas[0]` is treated as primary (the caller passes the primary display first). A window with
 * no saved position, or a call with no displays, is returned unchanged: the OS then places it.
 */
export function clampGeometryToVisibleArea(
  geometry: WindowGeometry,
  visibleAreas: readonly VisibleArea[]
): WindowGeometry {
  if (geometry.x === undefined || geometry.y === undefined) return geometry
  if (visibleAreas.length === 0) return geometry
  const savedX = geometry.x
  const savedY = geometry.y
  const reachable = visibleAreas.some((area) => (
    overlapExtent(savedX, geometry.width, area.x, area.width) >= MIN_VISIBLE_EXTENT &&
    overlapExtent(savedY, geometry.height, area.y, area.height) >= MIN_VISIBLE_EXTENT
  ))
  if (reachable) return geometry
  const primary = visibleAreas[0]!
  return {
    ...geometry,
    x: clampOrigin(savedX, geometry.width, primary.x, primary.width),
    y: clampOrigin(savedY, geometry.height, primary.y, primary.height)
  }
}

/**
 * Project a live window into a persistable record. When maximized we store the *normal* bounds (the
 * size the window returns to on unmaximize) plus the maximized flag — storing the maximized bounds
 * would lose the restore size and make every unmaximize snap to full-screen dimensions.
 */
export function geometryFromWindowState(state: {
  bounds: { width: number; height: number; x: number; y: number }
  normalBounds: { width: number; height: number; x: number; y: number }
  maximized: boolean
}): WindowGeometry {
  const source = state.maximized ? state.normalBounds : state.bounds
  return {
    width: source.width,
    height: source.height,
    x: source.x,
    y: source.y,
    maximized: state.maximized
  }
}
