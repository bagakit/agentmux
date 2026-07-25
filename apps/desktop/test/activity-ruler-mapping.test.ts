import { describe, expect, it } from 'vitest'
import {
  createRulerScale,
  describeReadout,
  formatOffset,
  rulerBand,
  stepRulerSelection,
  type RulerReadout
} from '../src/renderer/src/lib/activity-ruler.js'

describe('activity ruler mapping', () => {
  it('places events at their real elapsed fraction on a temporal axis', () => {
    // 1000, 3000, 5000 → the middle event sits exactly halfway along a 200px track.
    const scale = createRulerScale([1_000, 3_000, 5_000], 200)
    expect(scale.axis).toBe('temporal')
    expect(scale.fractionOf(0)).toBe(0)
    expect(scale.fractionOf(1)).toBeCloseTo(0.5, 10)
    expect(scale.fractionOf(2)).toBe(1)
    expect(scale.positionOf(1)).toBeCloseTo(100, 10)
  })

  it('round-trips position → data → position onto the same pixel', () => {
    // Uneven gaps so a bug that mixed ordinal and temporal math would land on a different pixel.
    const scale = createRulerScale([0, 250, 1_000, 4_000], 400)
    for (let i = 0; i < scale.count; i += 1) {
      const pixel = scale.positionOf(i)
      const readout = scale.readoutAt(pixel)
      expect(readout).not.toBeNull()
      // The position we came from maps back to the same event, and thus the same pixel.
      expect(readout!.index).toBe(i)
      expect(scale.positionOf(readout!.index)).toBeCloseTo(pixel, 6)
    }
  })

  it('snaps a click between two events to the nearer real event, never an interpolated instant', () => {
    const scale = createRulerScale([0, 100, 900, 1_000], 100)
    // Fractions: 0, .1, .9, 1. A point at .12 is closest to event 1 (.10), not event 2 (.90).
    const near = scale.readoutAtFraction(0.12)
    expect(near!.index).toBe(1)
    // Exactly between event 1 (.10) and event 2 (.90) is .50; both are .40 away → deterministic lower.
    const midpoint = scale.readoutAtFraction(0.5)
    expect(midpoint!.index).toBe(1)
    // A temporal readout reports a real recorded moment — the event's own timestamp, not a blend.
    expect(near).toMatchObject<Partial<RulerReadout>>({ axis: 'temporal' })
    if (near!.axis === 'temporal') expect(near!.at).toBe(100)
  })

  it('collapses to an ordinal axis with NO moment when every event shares one instant', () => {
    const scale = createRulerScale([7, 7, 7], 300)
    expect(scale.axis).toBe('ordinal')
    // Ordinal spacing is even, so the ticks do not stack on the left edge.
    expect(scale.fractionOf(0)).toBe(0)
    expect(scale.fractionOf(1)).toBeCloseTo(0.5, 10)
    expect(scale.fractionOf(2)).toBe(1)

    const readout = scale.readoutAtFraction(0.5)
    expect(readout!.axis).toBe('ordinal')
    // The honesty contract, enforced by the type: an ordinal readout has no `at` to render a time
    // from. Reading it off the object proves no moment leaked in under a zero-span axis.
    expect((readout as { at?: number }).at).toBeUndefined()
  })

  it('describes a zero-span readout as an ordinal only — no clock time, no offset', () => {
    const scale = createRulerScale([7, 7, 7], 300)
    const text = describeReadout(scale.readoutOf(1), scale.count)
    expect(text.axis).toBe('ordinal')
    expect(text.summary).toBe('Event 2 of 3')
    // If a moment or offset ever appeared here it would be fabricated precision.
    expect((text as { at?: number }).at).toBeUndefined()
    expect((text as { offsetText?: string }).offsetText).toBeUndefined()
  })

  it('describes a spanning readout with both a moment and a labelled offset from start', () => {
    const scale = createRulerScale([1_000, 3_500], 200)
    const text = describeReadout(scale.readoutOf(1), scale.count)
    expect(text.axis).toBe('temporal')
    if (text.axis === 'temporal') {
      expect(text.at).toBe(3_500) // the event's absolute recorded moment
      expect(text.offsetMs).toBe(2_500) // relative to the first event (the origin)
      expect(text.offsetText).toBe('+2.5s') // the offset register says it is relative to start
      expect(text.summary).toContain('from start')
    }
  })

  it('does not throw on empty, single-event, or zero-width inputs', () => {
    const empty = createRulerScale([], 100)
    expect(empty.count).toBe(0)
    expect(empty.readoutAt(50)).toBeNull()
    expect(empty.readoutAtFraction(0.5)).toBeNull()
    expect(() => empty.positionOf(0)).not.toThrow()

    const single = createRulerScale([42], 100)
    expect(single.axis).toBe('ordinal') // one event has no spread
    expect(single.fractionOf(0)).toBe(0)
    expect(single.readoutAtFraction(0.9)!.index).toBe(0)

    const zeroWidth = createRulerScale([0, 1_000, 2_000], 0)
    expect(zeroWidth.positionOf(2)).toBe(0) // nothing divides by width
    expect(() => zeroWidth.readoutAt(0)).not.toThrow()
    expect(zeroWidth.readoutAt(0)!.index).toBe(0)
  })

  it('clamps out-of-range indices and non-finite inputs instead of throwing', () => {
    const scale = createRulerScale([0, 1_000], 100)
    expect(scale.fractionOf(-5)).toBe(0)
    expect(scale.fractionOf(99)).toBe(1)
    expect(scale.readoutAtFraction(Number.NaN)!.index).toBe(0)
    expect(scale.readoutAtFraction(5)!.index).toBe(1) // past the end clamps to last
  })

  describe('keyboard selection', () => {
    it('enters on the first event going forward and the last going backward', () => {
      expect(stepRulerSelection(null, 'ArrowRight', 4)).toBe(0)
      expect(stepRulerSelection(null, 'Home', 4)).toBe(0)
      expect(stepRulerSelection(null, 'ArrowLeft', 4)).toBe(3)
      expect(stepRulerSelection(null, 'End', 4)).toBe(3)
    })

    it('steps by one and clamps at the ends', () => {
      expect(stepRulerSelection(1, 'ArrowRight', 4)).toBe(2)
      expect(stepRulerSelection(1, 'ArrowLeft', 4)).toBe(0)
      expect(stepRulerSelection(0, 'ArrowLeft', 4)).toBe(0) // no wrap past the start
      expect(stepRulerSelection(3, 'ArrowRight', 4)).toBe(3) // no wrap past the end
      expect(stepRulerSelection(2, 'Home', 4)).toBe(0)
      expect(stepRulerSelection(2, 'End', 4)).toBe(3)
    })

    it('ignores unrelated keys and refuses to select when there are no events', () => {
      expect(stepRulerSelection(2, 'a', 4)).toBe(2)
      expect(stepRulerSelection(null, 'ArrowRight', 0)).toBeNull()
    })
  })

  describe('visible range band', () => {
    it('derives the band edges from the first and last visible events', () => {
      const scale = createRulerScale([0, 1_000, 2_000, 3_000, 4_000], 100)
      const band = rulerBand(scale, { from: 1, to: 3 })
      expect(band).not.toBeNull()
      expect(band!.startOrdinal).toBe(2)
      expect(band!.endOrdinal).toBe(4)
      expect(band!.startFraction).toBeCloseTo(0.25, 10)
      expect(band!.endFraction).toBeCloseTo(0.75, 10)
    })

    it('shows no band when everything is visible — no full-width fake frame', () => {
      const scale = createRulerScale([0, 1_000, 2_000, 3_000], 100)
      expect(rulerBand(scale, { from: 0, to: 3 })).toBeNull()
    })

    it('shows no band when nothing is visible or the log is too short to have a range', () => {
      const scale = createRulerScale([0, 1_000, 2_000], 100)
      expect(rulerBand(scale, null)).toBeNull()
      const lone = createRulerScale([0], 100)
      expect(rulerBand(lone, { from: 0, to: 0 })).toBeNull()
    })

    it('stays meaningful on an ordinal axis — it frames which events, not a time span', () => {
      const scale = createRulerScale([5, 5, 5, 5], 100)
      const band = rulerBand(scale, { from: 1, to: 2 })
      expect(band).not.toBeNull()
      expect(band!.startOrdinal).toBe(2)
      expect(band!.endOrdinal).toBe(3)
      // Ordinal fractions are evenly spaced, so the band still lands on real tick positions.
      expect(band!.startFraction).toBeCloseTo(1 / 3, 10)
      expect(band!.endFraction).toBeCloseTo(2 / 3, 10)
    })
  })

  it('formats offsets in ms, seconds, and minutes with a leading sign', () => {
    expect(formatOffset(400, 0)).toBe('+400ms')
    expect(formatOffset(2_500, 0)).toBe('+2.5s')
    expect(formatOffset(125_000, 0)).toBe('+2m05s')
    expect(formatOffset(0, 5_000)).toBe('+0ms') // never negative
  })
})
