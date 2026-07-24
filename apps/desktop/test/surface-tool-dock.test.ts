import { describe, expect, it } from 'vitest'
import {
  clampSidebarResizeWidth,
  getNextSidebarResizeWidth,
  getRenderedSidebarWidthCssValue
} from '../src/renderer/src/hooks/useSidebarResize.js'
import {
  TOOL_DOCK_MAX_WIDTH,
  TOOL_DOCK_MIN_WIDTH,
  clampToolDockWidth
} from '../src/renderer/src/lib/surface-tool-dock.js'

describe('Orca-adapted shared surface tool dock resize', () => {
  it('clamps the persisted panel width to the density budget', () => {
    expect(clampToolDockWidth(120)).toBe(TOOL_DOCK_MIN_WIDTH)
    expect(clampToolDockWidth(318)).toBe(318)
    expect(clampToolDockWidth(900)).toBe(TOOL_DOCK_MAX_WIDTH)
  })

  it('moves a left-side dock with the pointer and respects both limits', () => {
    expect(getNextSidebarResizeWidth({
      clientX: 340,
      startX: 300,
      startWidth: 300,
      deltaSign: 1,
      minWidth: 236,
      maxWidth: 440
    })).toBe(340)
    expect(getNextSidebarResizeWidth({
      clientX: 40,
      startX: 300,
      startWidth: 300,
      deltaSign: 1,
      minWidth: 236,
      maxWidth: 440
    })).toBe(236)
    expect(clampSidebarResizeWidth(900, 236, 440)).toBe(440)
  })

  it('collapses without keeping an invisible interactive width', () => {
    expect(getRenderedSidebarWidthCssValue(true, 300, 0)).toBe('300px')
    expect(getRenderedSidebarWidthCssValue(false, 300, 0)).toBe('0px')
  })
})
