import { describe, expect, it } from 'vitest'
import { sessionRegionProjectionPolicy } from '../src/renderer/src/lib/session-region-projection.js'

describe('session region projection policy', () => {
  it('closes every mutating path for task observation Regions', () => {
    expect(sessionRegionProjectionPolicy(true)).toEqual({
      readOnly: true,
      interactiveResize: false,
      acceptsInput: false,
      allowsRecovery: false
    })
  })

  it('preserves normal workbench control for non-projection Regions', () => {
    expect(sessionRegionProjectionPolicy(false)).toEqual({
      readOnly: false,
      interactiveResize: true,
      acceptsInput: true,
      allowsRecovery: true
    })
  })
})
