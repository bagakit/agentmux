import { expect, it } from 'vitest'
import { ICON_GLYPHS, SEMANTIC_ICON_CATALOG, SEMANTIC_ICON_IDS } from '../src/theme/icon-catalog.js'
import { semanticIconHref } from '../src/theme/icons.js'

it('every declared product meaning has actual default geometry and a collision-free SVG identity', () => {
  expect(SEMANTIC_ICON_IDS.length).toBeGreaterThan(300)
  const hrefs = new Set<string>()
  for (const meaning of SEMANTIC_ICON_IDS) {
    expect(ICON_GLYPHS[SEMANTIC_ICON_CATALOG[meaning].glyph].length, meaning).toBeGreaterThan(0)
    hrefs.add(semanticIconHref(meaning))
  }
  expect(hrefs.size).toBe(SEMANTIC_ICON_IDS.length)
})

