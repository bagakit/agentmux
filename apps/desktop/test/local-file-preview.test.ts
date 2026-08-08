import { fixtureFileUrl as _hygiene_fixtureFileUrl, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import { normalizeBrowserUrl, assertAllowedBrowserUrl } from '../src/main/browser-view-manager'
describe('local Browser preview URLs', () => {
  it('accepts absolute local files and rejects active content protocols', () => {
    expect(normalizeBrowserUrl(_hygiene_fixturePath("tmp/index.html"))).toBe(_hygiene_fixtureFileUrl("tmp/index.html"))
    expect(assertAllowedBrowserUrl(_hygiene_fixtureFileUrl("tmp/image.png"))).toBe(_hygiene_fixtureFileUrl("tmp/image.png"))
    expect(() => assertAllowedBrowserUrl('javascript:alert(1)')).toThrow()
  })
})
