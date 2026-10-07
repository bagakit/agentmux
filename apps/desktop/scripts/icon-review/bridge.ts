import { getSemanticIconCatalog } from '../../../../packages/client-ui/src/theme/icon-catalog-metadata.js'
import { ICON_GLYPHS, type SemanticIconId } from '../../../../packages/client-ui/src/theme/icon-catalog.js'
import { createSemanticIconElement } from '../../../../packages/client-ui/src/theme/icon-sprite.js'
import { getThemeCatalog, GRAPHITE_THEME } from '../../../../packages/client-ui/src/theme/catalog.js'
import { mountThemeRuntime, updateObservedTheme } from '../../../../packages/client-ui/src/theme/runtime.js'
import { parseThemeFile, serializeThemeFile, type ThemeDocument, type ThemeMode, type ThemeIconAsset } from '../../../../packages/client-ui/src/theme/schema.js'

export const catalog = getSemanticIconCatalog()
export const glyphs = ICON_GLYPHS
export const themes = getThemeCatalog().items.filter(item => item.readonly).map(item => ({ id: item.id, ...item.value }))
export { parseThemeFile, serializeThemeFile }

/** The same native projection used by editors; the root owns all geometry. */
export function semanticMarkup(name: SemanticIconId, size = 24, className = '') {
  return createSemanticIconElement(name, document, { size, className }).outerHTML
}
export function startThemeRuntime() {
  return mountThemeRuntime(window, { appAppearance: 'light' })
}
export function buildTheme(themeId: string, icons: Partial<Record<SemanticIconId, ThemeIconAsset>>, imported?: ThemeDocument): ThemeDocument {
  const base = structuredClone(imported?.id === themeId ? imported : themes.find(theme => theme.id === themeId) ?? GRAPHITE_THEME)
  // Built-ins remain read-only. A file exported for Settings is a custom resource.
  if (!base.id.startsWith('custom.')) {
    base.id = 'custom.icon-review'
    base.name = `${base.name} · 图标草稿`.slice(0,80)
  }
  base.icons = { ...base.icons, ...icons }
  return parseThemeFile(serializeThemeFile(base))
}
export function projectTheme(theme: ThemeDocument, mode: ThemeMode) {
  const result = updateObservedTheme(theme, mode)
  if (!result.applied) throw new Error(result.reason)
}
