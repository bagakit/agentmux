import { expect, it } from 'vitest'
import { ICON_GLYPHS, SEMANTIC_ICON_CATALOG, SEMANTIC_ICON_IDS } from '../src/theme/icon-catalog.js'
import { createSemanticIconElement, getSemanticIconCatalog, iconShapes, semanticIconHref, updateIconSprite, removeIconSprite } from '../src/theme/icons.js'
import { GRAPHITE_THEME } from '../src/theme/catalog.js'
import { parseThemeFile, serializeThemeFile, type ThemeIconAsset } from '../src/theme/schema.js'

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

it('discovers preview independently and projects its theme choices without changing reveal or inspect', () => {
  expect(getSemanticIconCatalog().icons.find(icon => icon.id === 'action.preview')).toMatchObject({ label: 'View preview', groupId: 'action', defaultGlyph: 'eye' })
  expect(iconShapes('action.preview')).toBe(ICON_GLYPHS.eye)
  const node = createSemanticIconElement('action.preview', document, { size: 12 })
  document.body.append(node)
  const id = semanticIconHref('action.preview').slice(1)
  const related = ['action.reveal', 'action.inspect'] as const
  try {
    for (const mode of ['dark', 'light'] as const) {
      const color = GRAPHITE_THEME.variants[mode].colors.text
      updateIconSprite(document, GRAPHITE_THEME, color)
      const original = document.getElementById(id)!.innerHTML
      const peers = related.map(id => document.getElementById(semanticIconHref(id).slice(1))!.innerHTML)
      expect(node.tagName.toLowerCase()).toBe('svg'); expect(node.getAttribute('data-icon-animation')).toBeNull()
      expect(node.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.preview'))
      const choices: ThemeIconAsset[] = [{ kind: 'glyph', glyph: 'x' }, { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] }]
      for (const choice of choices) {
        const theme = { ...GRAPHITE_THEME, icons: { ...GRAPHITE_THEME.icons, 'action.preview': choice } }
        expect(parseThemeFile(serializeThemeFile(theme)).icons['action.preview']).toEqual(choice)
        updateIconSprite(document, theme, color)
        expect(document.getElementById(id)!.innerHTML).not.toBe(original)
        expect(node.isConnected).toBe(true)
        expect(related.map(id => document.getElementById(semanticIconHref(id).slice(1))!.innerHTML)).toEqual(peers)
      }
      updateIconSprite(document, GRAPHITE_THEME, color)
      expect(document.getElementById(id)!.innerHTML).toBe(original)
    }
  } finally { node.remove(); removeIconSprite(document) }
})
