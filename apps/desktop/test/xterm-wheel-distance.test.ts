// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { StandardWheelEvent } from '../node_modules/@xterm/xterm/src/browser/scrollable/mouseEvent'

// Exercise the installed, patched owner used by TerminalView. Chromium can deliver
// real pixel deltas alongside a constant legacy wheelDelta; that value is not distance.
function wheel(fields: Record<string, unknown>) {
  return new StandardWheelEvent({ type: 'wheel', deltaMode: 0, DOM_DELTA_LINE: 1,
    deltaX: 0, deltaY: 0, view: { devicePixelRatio: 2 }, ...fields } as any)
}
describe('xterm wheel distance owner', () => {
  it('retains standard pixel distance despite a fixed legacy notch', () => {
    expect([-20, -100, -1100].map(deltaY => wheel({ deltaY, wheelDeltaY: 120 }).deltaY))
      .toEqual([0.5, 2.5, 27.5])
  })
  it('uses standard direction instead of the contradictory legacy sign', () => {
    expect(wheel({ deltaY: 100, wheelDeltaY: 120 }).deltaY).toBe(-2.5)
  })
  it('retains fractional horizontal distance independently of the zero vertical axis', () => {
    expect(wheel({ deltaX: 0.5, wheelDeltaX: -120, wheelDeltaY: 0 }).deltaX).toBe(-0.0125)
  })
  it('retains line units when a modern event also carries a legacy notch', () => {
    expect(wheel({ deltaMode: 1, deltaY: -7, wheelDeltaY: 120 }).deltaY).toBe(7)
  })
  it('keeps non-wheel legacy-only events on the legacy route', () => {
    expect(wheel({ type: 'mousewheel', deltaY: undefined, wheelDeltaY: 240 }).deltaY).toBe(2)
  })
  it('keeps a zero standard axis with a legacy notch', () => {
    expect(wheel({ deltaY: 0, wheelDeltaY: 240 }).deltaY).toBe(2)
  })
  it('keeps the generic legacy fallback for an older event', () => {
    expect(wheel({ type: 'mousewheel', deltaY: undefined, deltaX: undefined, wheelDelta: 120 }).deltaY).toBe(1)
  })
})
