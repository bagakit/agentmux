import { expect, it } from 'vitest'
import { ICON_GLYPHS, SEMANTIC_ICON_CATALOG, SEMANTIC_ICON_IDS } from '../src/theme/icon-catalog.js'
import { getSemanticIconCatalog, semanticIconHref, updateIconSprite, removeIconSprite } from '../src/theme/icons.js'
import { GRAPHITE_THEME } from '../src/theme/catalog.js'

it('every declared product meaning has actual default geometry and a collision-free SVG identity', () => {
  expect(SEMANTIC_ICON_IDS.length).toBeGreaterThan(300)
  const hrefs = new Set<string>()
  for (const meaning of SEMANTIC_ICON_IDS) {
    expect(ICON_GLYPHS[SEMANTIC_ICON_CATALOG[meaning].glyph].length, meaning).toBeGreaterThan(0)
    hrefs.add(semanticIconHref(meaning))
  }
  expect(hrefs.size).toBe(SEMANTIC_ICON_IDS.length)
})

it('discovers Automation as an object and applies its theme glyph to the retained sprite identity', () => {
  expect(getSemanticIconCatalog().icons.find(icon => icon.id === 'object.automation')).toMatchObject({ label: 'Automation', groupId: 'object', defaultGlyph: 'zap' })
  const id = semanticIconHref('object.automation').slice(1)
  try {
    updateIconSprite(document, GRAPHITE_THEME, '#ffffff')
    const original = document.getElementById(id)!.innerHTML
    expect(document.getElementById(id)!.querySelectorAll('path,rect').length).toBeGreaterThan(0)
    updateIconSprite(document, { ...GRAPHITE_THEME, icons: { ...GRAPHITE_THEME.icons, 'object.automation': { kind: 'glyph', glyph: 'x' } } }, '#ffffff')
    expect(document.getElementById(id)!.innerHTML).not.toBe(original)
    updateIconSprite(document, GRAPHITE_THEME, '#ffffff')
    expect(document.getElementById(id)!.innerHTML).toBe(original)
  } finally { removeIconSprite(document) }
})
