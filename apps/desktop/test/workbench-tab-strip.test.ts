import { describe, expect, it } from 'vitest'
import { getWorkbenchTabStripState } from '../src/renderer/src/lib/workbench-tab-strip'

describe('workbench tab strip overflow', () => {
  it('does not expose navigation when every tab fits', () => {
    expect(getWorkbenchTabStripState({
      scrollLeft: 0,
      scrollWidth: 500,
      clientWidth: 500
    })).toEqual({
      hasOverflow: false,
      canScrollStart: false,
      canScrollEnd: false
    })
  })

  it('exposes only the direction that still has hidden tabs at each edge', () => {
    expect(getWorkbenchTabStripState({
      scrollLeft: 0,
      scrollWidth: 760,
      clientWidth: 320
    })).toEqual({
      hasOverflow: true,
      canScrollStart: false,
      canScrollEnd: true
    })

    expect(getWorkbenchTabStripState({
      scrollLeft: 440,
      scrollWidth: 760,
      clientWidth: 320
    })).toEqual({
      hasOverflow: true,
      canScrollStart: true,
      canScrollEnd: false
    })
  })

  it('tolerates fractional layout measurements at the scroll boundary', () => {
    expect(getWorkbenchTabStripState({
      scrollLeft: 439.6,
      scrollWidth: 760,
      clientWidth: 320
    })).toEqual({
      hasOverflow: true,
      canScrollStart: true,
      canScrollEnd: false
    })
  })
})
