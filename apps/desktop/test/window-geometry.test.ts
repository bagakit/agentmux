import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  clampGeometryToVisibleArea,
  geometryFromWindowState,
  parseStoredGeometry,
  windowConstructorGeometry,
  type VisibleArea,
  type WindowGeometry
} from '../src/main/window-geometry.js'

/**
 * Window geometry persistence. The window used to open at a fixed 1480×940 every launch; these pure
 * projections turn the last window state into constructor options and back so a restart reopens where
 * the user left it. The wiring in index.ts is thin; the derivation lives here where it can be asserted
 * without a live BrowserWindow (unavailable in this harness).
 *
 * Mutation intent: reverting windowConstructorGeometry to emit the literal 1480×940 instead of the
 * persisted size must fail the round-trip test below.
 */

describe('parseStoredGeometry: persisted geometry is untrusted JSON', () => {
  it('accepts a well-formed record including position and maximized flag', () => {
    expect(parseStoredGeometry({ width: 1200, height: 800, x: 40, y: 60, maximized: true })).toEqual({
      width: 1200,
      height: 800,
      x: 40,
      y: 60,
      maximized: true
    })
  })

  it('rejects a below-minimum size rather than opening an unusable window', () => {
    expect(parseStoredGeometry({ width: 200, height: 150, maximized: false })).toBeNull()
  })

  it('rejects NaN / non-finite dimensions', () => {
    expect(parseStoredGeometry({ width: Number.NaN, height: 800, maximized: false })).toBeNull()
    expect(parseStoredGeometry({ width: 1200, height: Number.POSITIVE_INFINITY, maximized: false })).toBeNull()
  })

  it('rejects a non-object payload', () => {
    expect(parseStoredGeometry(null)).toBeNull()
    expect(parseStoredGeometry('1200x800')).toBeNull()
  })

  it('keeps size but drops a partial position (a never-moved window has none)', () => {
    expect(parseStoredGeometry({ width: 1200, height: 800, x: 40, maximized: false })).toEqual({
      width: 1200,
      height: 800,
      maximized: false
    })
  })
})

describe('windowConstructorGeometry: the persisted size replaces the fixed literal', () => {
  it('falls back to the default size only when there is no persisted record', () => {
    // First launch: the historical default (1480×940), and no position — the OS places the window.
    expect(windowConstructorGeometry(null)).toEqual({ width: 1480, height: 940 })
  })

  it('opens at the persisted size and position, not the default literal', () => {
    const persisted: WindowGeometry = { width: 1024, height: 720, x: 12, y: 34, maximized: false }
    const geometry = windowConstructorGeometry(persisted)
    // The load-bearing regression guard: a restored window must carry the persisted width/height,
    // never the 1480×940 the code used to hardcode.
    expect(geometry).toEqual({ width: 1024, height: 720, x: 12, y: 34 })
    expect(geometry.width).not.toBe(1480)
    expect(geometry.height).not.toBe(940)
  })

  it('omits position when the persisted record has none', () => {
    const persisted: WindowGeometry = { width: 1024, height: 720, maximized: false }
    expect(windowConstructorGeometry(persisted)).toEqual({ width: 1024, height: 720 })
  })
})

describe('geometryFromWindowState: capture the size the user chose', () => {
  it('stores live bounds when the window is not maximized', () => {
    expect(geometryFromWindowState({
      bounds: { width: 1300, height: 900, x: 5, y: 7 },
      normalBounds: { width: 1300, height: 900, x: 5, y: 7 },
      maximized: false
    })).toEqual({ width: 1300, height: 900, x: 5, y: 7, maximized: false })
  })

  it('stores the NORMAL bounds when maximized, so unmaximize returns to the chosen size', () => {
    // If capture used the maximized bounds instead, the restore size would be lost and every
    // unmaximize after a restart would snap to full-screen dimensions.
    expect(geometryFromWindowState({
      bounds: { width: 2560, height: 1440, x: 0, y: 0 },
      normalBounds: { width: 1300, height: 900, x: 5, y: 7 },
      maximized: true
    })).toEqual({ width: 1300, height: 900, x: 5, y: 7, maximized: true })
  })
})

describe('geometry round-trip: capture then reopen preserves what the user chose', () => {
  it('a captured window reopens at its own size, not the default', () => {
    const captured = geometryFromWindowState({
      bounds: { width: 1111, height: 777, x: 20, y: 30 },
      normalBounds: { width: 1111, height: 777, x: 20, y: 30 },
      maximized: false
    })
    const reparsed = parseStoredGeometry(JSON.parse(JSON.stringify(captured)))
    expect(reparsed).toEqual(captured)
    expect(windowConstructorGeometry(reparsed)).toEqual({ width: 1111, height: 777, x: 20, y: 30 })
  })
})

describe('clampGeometryToVisibleArea: an off-screen window is re-homed, not lost', () => {
  const primary: VisibleArea = { x: 0, y: 0, width: 1920, height: 1080 }
  const secondary: VisibleArea = { x: 1920, y: 0, width: 1920, height: 1080 }

  it('leaves a window fully inside a display exactly as saved', () => {
    const geometry: WindowGeometry = { width: 1200, height: 800, x: 100, y: 100, maximized: false }
    expect(clampGeometryToVisibleArea(geometry, [primary])).toEqual(geometry)
  })

  it('re-homes a window on a monitor that is no longer connected', () => {
    // Saved on the second monitor; only the primary remains this launch. The origin must land inside
    // the primary work area — never stay at x:2200 where nothing is drawn.
    const geometry: WindowGeometry = { width: 1200, height: 800, x: 2200, y: 150, maximized: false }
    const clamped = clampGeometryToVisibleArea(geometry, [primary])
    expect(clamped.x).toBeGreaterThanOrEqual(primary.x)
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(primary.x + primary.width)
    expect(clamped.y).toBe(150)
    // Size and maximized are the user's choice and must survive the re-home untouched.
    expect(clamped.width).toBe(1200)
    expect(clamped.height).toBe(800)
  })

  it('keeps a window that still shows a grabbable strip on a live display (spanning is legitimate)', () => {
    // Straddling the seam between two monitors is a deliberate layout, not corruption: leave it.
    const geometry: WindowGeometry = { width: 1200, height: 800, x: 1400, y: 100, maximized: false }
    expect(clampGeometryToVisibleArea(geometry, [primary, secondary])).toEqual(geometry)
  })

  it('re-homes a window whose title bar sits above the top of every display', () => {
    // A negative Y deep enough that the draggable title strip is off-screen: unreachable, so re-home.
    const geometry: WindowGeometry = { width: 1200, height: 800, x: 100, y: -900, maximized: false }
    const clamped = clampGeometryToVisibleArea(geometry, [primary])
    expect(clamped.y).toBeGreaterThanOrEqual(primary.y)
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(primary.y + primary.height)
  })

  it('returns a window with no saved position unchanged (the OS will place it)', () => {
    const geometry: WindowGeometry = { width: 1200, height: 800, maximized: false }
    expect(clampGeometryToVisibleArea(geometry, [primary])).toEqual(geometry)
  })

  it('returns geometry unchanged when no displays are reported', () => {
    const geometry: WindowGeometry = { width: 1200, height: 800, x: 2200, y: 150, maximized: false }
    expect(clampGeometryToVisibleArea(geometry, [])).toEqual(geometry)
  })
})

describe('window-visible-area.ts wiring: work areas come from the live screen, primary first', () => {
  // This module touches Electron's `screen`, which needs a display server the test harness lacks, so
  // it cannot be executed here — the pure clamp above is the behavioral coverage. Scan the source for
  // the load-bearing shape: work areas (not full bounds) and primary-first ordering, which the clamp
  // relies on to re-home into the primary display.
  const here = dirname(fileURLToPath(import.meta.url))
  const visibleAreaPath = join(here, '../src/main/window-visible-area.ts')

  it('reads workArea (menu bar / taskbar excluded), not the full display bounds', async () => {
    const source = await readFile(visibleAreaPath, 'utf8')
    expect(source).toContain('screen.getPrimaryDisplay()')
    expect(source).toContain('screen.getAllDisplays()')
    expect(source).toContain('display.workArea.x')
    expect(source).toContain('display.workArea.width')
  })

  it('orders the primary display first so an off-screen window re-homes onto it', async () => {
    const source = await readFile(visibleAreaPath, 'utf8')
    expect(source).toContain('[primary, ...others]')
  })
})
