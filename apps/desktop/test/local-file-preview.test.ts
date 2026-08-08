import { describe, expect, it } from 'vitest'
import { normalizeBrowserUrl, assertAllowedBrowserUrl } from '../src/main/browser-view-manager'
describe('local Browser preview URLs', () => {
  it('accepts absolute local files and rejects active content protocols', () => {
    expect(normalizeBrowserUrl('/tmp/index.html')).toBe('file:///tmp/index.html')
    expect(assertAllowedBrowserUrl('file:///tmp/image.png')).toBe('file:///tmp/image.png')
    expect(() => assertAllowedBrowserUrl('javascript:alert(1)')).toThrow()
  })
})
