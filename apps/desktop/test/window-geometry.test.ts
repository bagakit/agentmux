import { describe, expect, it } from 'vitest'
import {
  geometryFromWindowState,
  parseStoredGeometry,
  windowConstructorGeometry,
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
