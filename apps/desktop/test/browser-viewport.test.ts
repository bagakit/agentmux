import { describe, expect, it } from 'vitest'
import {
  BROWSER_VIEWPORT_MAX_DIMENSION, browserViewportSize, browserViewportsEqual,
  cloneBrowserViewport, isBrowserViewport
} from '../src/shared/browser-viewport'

describe('Browser viewport dimensions at the native protocol boundary', () => {
  it('resolves existing presets and preserves custom screen type and dimensions', () => {
    expect(browserViewportSize('responsive')).toBeNull()
    expect(browserViewportSize('mobile')).toEqual({ width: 390, height: 844, screenPosition: 'mobile' })
    expect(browserViewportSize('tablet')).toEqual({ width: 768, height: 1024, screenPosition: 'mobile' })
    expect(browserViewportSize('desktop')).toEqual({ width: 1280, height: 800, screenPosition: 'desktop' })
    const request = { width: 1512, height: 982, screenPosition: 'desktop' as const }
    const owned = cloneBrowserViewport(request)
    expect(owned).not.toBe(request)
    expect(Object.isFrozen(owned)).toBe(true)
    request.width = 999
    expect(browserViewportSize(owned)).toEqual({ width: 1512, height: 982, screenPosition: 'desktop' })
    expect(browserViewportsEqual(owned, { width: 1512, height: 982, screenPosition: 'desktop' })).toBe(true)
    expect(browserViewportsEqual(owned, { width: 1512, height: 982, screenPosition: 'mobile' })).toBe(false)
    expect(browserViewportsEqual('desktop', owned)).toBe(false)
  })

  it('accepts positive signed-int dimensions independently of screenshot limits', () => {
    for (const width of [1, 16_385, BROWSER_VIEWPORT_MAX_DIMENSION]) {
      expect(isBrowserViewport({ width, height: 400, screenPosition: 'mobile' })).toBe(true)
    }
    for (const width of [0, -1, 0.5, NaN, Infinity, BROWSER_VIEWPORT_MAX_DIMENSION + 1, '390', undefined]) {
      expect(isBrowserViewport({ width, height: 400, screenPosition: 'mobile' })).toBe(false)
    }
    for (const value of [null, [], {}, 'watch', 'toString', { width: 390, height: 844 },
      { width: 390, height: 844, screenPosition: 'tablet' }]) expect(isBrowserViewport(value)).toBe(false)
  })
})
