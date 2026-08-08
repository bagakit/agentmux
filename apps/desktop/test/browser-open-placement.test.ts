import { describe, expect, it } from 'vitest'
import { OPEN_DESTINATIONS, openDestinationNeedsRegion } from '../src/renderer/src/lib/open-destination'
describe('browser open placement', () => {
  it('keeps Tab as a view destination and directional choices as Region destinations', () => {
    expect(openDestinationNeedsRegion('tab')).toBe(false)
    expect(OPEN_DESTINATIONS.filter(openDestinationNeedsRegion)).toEqual(['left','right','up','down'])
  })
})
