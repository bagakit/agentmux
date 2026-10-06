import { expect, it } from 'vitest'
import { getThemeCatalog, GRAPHITE_THEME, getSemanticIconCatalog, parseThemeFile, serializeThemeFile } from '../src/theme/index.js'
import { iconShapes } from '../src/theme/icon-assets.js'
import { ICON_GLYPHS, SEMANTIC_ICON_CATALOG, type SemanticIconId } from '../src/theme/icon-catalog.js'

const meanings: SemanticIconId[] = ['status.working', 'status.streaming', 'status.browser-running', 'object.activity']
it('the same four meanings are recognizable by different default geometry in every built-in theme', () => {
  const themes = getThemeCatalog().items.filter(theme => theme.readonly)
  expect(themes.length).toBeGreaterThanOrEqual(3)
  for (const theme of themes) {
    const drawings = meanings.map(meaning => iconShapes(meaning, theme.value.icons))
    expect(new Set(drawings.map(drawing => JSON.stringify(drawing))).size, theme.id).toBe(meanings.length)
    for (const drawing of drawings) {
      expect(drawing.length, theme.id).toBeGreaterThan(0)
      expect(drawing, theme.id).not.toEqual(ICON_GLYPHS.activity)
    }
    expect(iconShapes('status.working', theme.value.icons), theme.id).not.toEqual(iconShapes('status.running', theme.value.icons))
  }
  expect(Object.values(SEMANTIC_ICON_CATALOG).some(entry => entry.glyph === 'activity')).toBe(false)
})
it('discovers the authored drawings from the same metadata used by public theme discovery and settings', () => {
  const metadata = getSemanticIconCatalog()
  for (const meaning of meanings) {
    const icon = metadata.icons.find(icon => icon.id === meaning)!
    expect(icon, meaning).toBeDefined()
    expect(metadata.glyphs).toContain(icon.defaultGlyph)
    expect(iconShapes(meaning)).toEqual(ICON_GLYPHS[icon.defaultGlyph])
  }
})
it('retains a user-explicit legacy drawing and independent streaming paths through a complete theme file', () => {
  const document = { ...structuredClone(GRAPHITE_THEME), id: 'custom.original-icons', icons: {
    'status.working': { kind: 'glyph' as const, glyph: 'activity' as const },
    'status.streaming': { kind: 'paths' as const, paths: [{ d: 'M4 4H20V20H4Z' }] }
  } }
  const imported = parseThemeFile(serializeThemeFile(document))
  expect(imported.icons).toEqual(document.icons)
  expect(iconShapes('status.working', imported.icons)).toEqual(ICON_GLYPHS.activity)
  expect(iconShapes('status.streaming', imported.icons)).not.toEqual(iconShapes('status.streaming'))
  expect(iconShapes('status.browser-running', imported.icons)).toEqual(iconShapes('status.browser-running'))
})
