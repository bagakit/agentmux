import { describe, expect, it } from 'vitest'
import { regionFocusExpression } from '../src/renderer/src/lib/region-focus'

describe('browser region focus expression', () => {
  it('marks only the active region when there are multiple candidates', () => {
    expect(regionFocusExpression('r1', 'r1', 2)).toEqual({ className: 'workbench-region--active', nativeViewYieldsToRing: true })
    expect(regionFocusExpression('r1', 'r2', 2)).toEqual({ className: '', nativeViewYieldsToRing: false })
  })
  it('does not draw a focus ring for a single region', () => {
    expect(regionFocusExpression('r1', 'r1', 1)).toEqual({ className: '', nativeViewYieldsToRing: false })
  })
})
