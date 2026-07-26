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
