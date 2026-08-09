import { describe, expect, it } from 'vitest'
import { resolvePaneColumnEdgeZone } from '../src/renderer/src/lib/tab-drop-zone'

const pane = { left: 0, top: 0, width: 1000, height: 800 }

describe('tab drop zones', () => {
  it('keeps tab-strip drags as reorder gestures, including at an edge', () => {
    expect(resolvePaneColumnEdgeZone(pane, { x: 20, y: 18 })).toBeNull()
  })

  it('splits only when the pointer reaches a body edge', () => {
    expect(resolvePaneColumnEdgeZone(pane, { x: 20, y: 300 })).toBe('left')
    expect(resolvePaneColumnEdgeZone(pane, { x: 500, y: 300 })).toBeNull()
    expect(resolvePaneColumnEdgeZone(pane, { x: 500, y: 760 })).toBe('down')
  })
})
