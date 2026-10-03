import { fixtureFileUrl as _hygiene_fixtureFileUrl } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { resolveBrowserAddress } from '../src/shared/browser-address'
import { api } from '../src/renderer/src/lib/api'

const searches = [
  ['skyvern', 'https://www.google.com/search?q=skyvern'],
  ['天气', 'https://www.google.com/search?q=%E5%A4%A9%E6%B0%94'],
  ['42', 'https://www.google.com/search?q=42'],
  ['3.14', 'https://www.google.com/search?q=3.14'],
  ['42.0', 'https://www.google.com/search?q=42.0'],
  ['-3.14', 'https://www.google.com/search?q=-3.14'],
  ['1.5e3', 'https://www.google.com/search?q=1.5e3'],
  ['2026', 'https://www.google.com/search?q=2026'],
  ['agent runtime docs', 'https://www.google.com/search?q=agent%20runtime%20docs'],
  ['c++', 'https://www.google.com/search?q=c%2B%2B'],
  ['fish&chips', 'https://www.google.com/search?q=fish%26chips'],
  ['why?', 'https://www.google.com/search?q=why%3F'],
  ['#agents', 'https://www.google.com/search?q=%23agents'],
  ['hello@example.com', 'https://www.google.com/search?q=hello%40example.com'],
  [' read example.com ', 'https://www.google.com/search?q=read%20example.com']
] as const
const addresses = [
  ['', 'about:blank'], ['  ', 'about:blank'], ['about:blank', 'about:blank'],
  ['example.com', 'https://example.com/'],
  ['example.com:8443/a?q=x#y', 'https://example.com:8443/a?q=x#y'],
  ['example.com/hello world?q=a b', 'https://example.com/hello%20world?q=a%20b'],
  ['https://example.test/a?q=x#y', 'https://example.test/a?q=x#y'],
  ['http://intranet/a', 'http://intranet/a'],
  ['localhost:3000', 'http://localhost:3000/'],
  ['localhost?q=a', 'http://localhost/?q=a'],
  ['127.0.0.1:4173/a', 'http://127.0.0.1:4173/a'],
  ['[::1]:3000/a', 'http://[::1]:3000/a'],
  ['[2001:db8::1]:8080/a', 'https://[2001:db8::1]:8080/a'],
  ['192.168.1.2:8443/a', 'https://192.168.1.2:8443/a'],
  ['例子.测试/a', 'https://xn--fsqu00a.xn--0zwm56d/a'],
  [_hygiene_fixtureFileUrl("tmp/browser%20page.html"), _hygiene_fixtureFileUrl("tmp/browser%20page.html")],
  ['mailto:hello@example.com', 'mailto:hello@example.com'],
  ['javascript:123', 'javascript:123']
] as const

describe('Browser address search', () => {
  it.each(searches)('searches ordinary text %s without losing its meaning', (input, expected) => {
    expect(resolveBrowserAddress(input)).toBe(expected)
  })
  it.each(addresses)('preserves address meaning for %s', (input, expected) => {
    expect(resolveBrowserAddress(input)).toBe(expected)
  })
  it.each(['192.168.1.999', '[2001:db8::1]:99999', 'example.com:99999'])('refuses malformed address %s without turning it into a query', (input) => {
    expect(() => resolveBrowserAddress(input)).toThrow('Invalid URL')
  })
  it('uses the same address resolution in actual Preview create and navigate', async () => {
    const browser = await api.browser.create('address-search-preview', '天气', null)
    try {
      expect(browser.url).toBe('https://www.google.com/search?q=%E5%A4%A9%E6%B0%94')
      const searched = await api.browser.navigate(browser.id, 'skyvern')
      expect(searched.url).toBe('https://www.google.com/search?q=skyvern')
      expect(searched.id).toBe(browser.id)
      expect(searched.profileId).toBe(browser.profileId)
      expect((await api.browser.navigate(browser.id, 'example.com:8443/a')).url).toBe('https://example.com:8443/a')
      expect((await api.browser.navigate(browser.id, 'localhost:3000')).url).toBe('http://localhost:3000/')
    } finally { await api.browser.close(browser.id) }
  })
})
