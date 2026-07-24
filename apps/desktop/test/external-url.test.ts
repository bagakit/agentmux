import { describe, expect, it } from 'vitest'
import { normalizeExternalUrl } from '../src/main/external-url.js'

describe('Main-owned external URL boundary', () => {
  it('allows only browser HTTP protocols', () => {
    expect(normalizeExternalUrl('https://example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeExternalUrl('http://localhost:3000/')).toBe('http://localhost:3000/')
  })

  it.each([
    'file:///tmp/secret',
    'javascript:alert(1)',
    'data:text/html,unsafe'
  ])('rejects %s', (url) => {
    expect(() => normalizeExternalUrl(url)).toThrow('protocol is not allowed')
  })
})
