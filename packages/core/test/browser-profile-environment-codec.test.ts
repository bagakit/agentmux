import { afterEach, expect, it, vi } from 'vitest'
import { parseBrowserProfileEnvironment } from '../src/browser-profile-control.js'

afterEach(() => vi.unstubAllGlobals())

it('validates native environment text without a Node Buffer in browser callers', () => {
  vi.stubGlobal('Buffer', undefined)
  expect(parseBrowserProfileEnvironment({ timeZone: 'Europe/Paris', locale: 'fr-FR', userAgent: 'Profile/1.0' }))
    .toEqual({ timeZone: 'Europe/Paris', locale: 'fr-FR', userAgent: 'Profile/1.0' })
  expect(() => parseBrowserProfileEnvironment({ userAgent: 'a'.repeat(4097) })).toThrow('User agent is invalid')
})

it('preserves the original UTF-8 byte boundary, including multibyte client-hint brands', () => {
  vi.stubGlobal('Buffer', undefined)
  const metadata = { platform: '', platformVersion: '', architecture: '', model: '', mobile: false }
  const brand = '界'.repeat(170) + 'ab'
  expect(parseBrowserProfileEnvironment({ userAgentMetadata: { ...metadata, brands: [{ brand, version: '' }] } })
    .userAgentMetadata?.brands?.[0]?.brand).toBe(brand)
  expect(() => parseBrowserProfileEnvironment({ userAgentMetadata: { ...metadata, brands: [{ brand: brand + 'c', version: '' }] } }))
    .toThrow('Brand is invalid')
})
