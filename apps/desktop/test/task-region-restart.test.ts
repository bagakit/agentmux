import { describe, expect, it } from 'vitest'
import { sessionRegionProjectionPolicy } from '../src/renderer/src/lib/session-region-projection.js'

describe('Task Session Region recovery policy', () => {
  it('keeps the Region observable while recovery controls stay disabled', () => {
    expect(sessionRegionProjectionPolicy(true)).toEqual({ readOnly: true, interactiveResize: false, acceptsInput: false, allowsRecovery: false })
  })
})
