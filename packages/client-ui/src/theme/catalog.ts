import { themeIdSchema, themeValueSchema, BUILTIN_THEME_IDS, themeValue, type ThemeDocument, type ThemeValue, type ThemeMode, type AppAppearanceId } from './schema.js'

export const DEFAULT_THEME_ID = 'graphite' as const
export const GRAPHITE_THEME: ThemeDocument = {
  format: 'agentmux.theme', version: 1, id: 'graphite', name: 'Graphite / Mint', description: 'Quiet graphite and clear daylight, with mint actions.',
  iconStyle: { strokeWidth: 1.75, linecap: 'round', linejoin: 'round' }, icons: {},
  variants: {
    dark: { font: 'sans', radius: 9, elevation: 'soft', colors: {
      background: '#0c0e12', surface0: '#111419', surface1: '#171b21', surface2: '#1f242b', surface3: '#2a3138',
      line: '#313941', lineSoft: '#232a31', text: '#edf1ee', textMuted: '#b6bfb9', textSubtle: '#808a82',
      action: '#8de3ae', actionHover: '#5ec488', success: '#8de3ae', warning: '#ecc16a', danger: '#ef7773', info: '#82b3f2', special: '#b7a3ef',
      neutral1: '#3b403e', neutral2: '#56615b', neutral3: '#747d77', focus: '#6fbd8c'
    } },
    light: { font: 'sans', radius: 9, elevation: 'soft', colors: {
      background: '#f4f6f5', surface0: '#ffffff', surface1: '#eef1ef', surface2: '#e3e8e5', surface3: '#d7dfda',
      line: '#c6d0c9', lineSoft: '#dce3de', text: '#17201a', textMuted: '#46554b', textSubtle: '#626f66',
      action: '#267a48', actionHover: '#21683e', success: '#267a48', warning: '#916000', danger: '#b33b37', info: '#2869a7', special: '#6244b8',
      neutral1: '#c4cec7', neutral2: '#87958b', neutral3: '#5c6b61', focus: '#32794c'
    } }
  }
}
function freezeBuiltin(value: object): void {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freezeBuiltin(child)
  Object.freeze(value)
}
freezeBuiltin(GRAPHITE_THEME)
export const BUILTIN_THEMES: readonly ThemeDocument[] = Object.freeze([GRAPHITE_THEME])
export type ThemeCatalogItem = { id: string; value: ThemeValue; readonly: boolean }
export type ThemeIssue = { id: string; message: string }
export function isBuiltinThemeId(id: string): boolean { return (BUILTIN_THEME_IDS as readonly string[]).includes(id) }

/** Bad saved records remain with their owner; one bad record cannot reset other preferences. */
export function getThemeCatalog(customThemes: Record<string, unknown> = {}): { items: ThemeCatalogItem[]; issues: ThemeIssue[] } {
  const items: ThemeCatalogItem[] = BUILTIN_THEMES.map(document => ({ id: document.id, value: themeValue(document), readonly: true }))
  const issues: ThemeIssue[] = []
  for (const [id, raw] of Object.entries(customThemes)) {
    const parsed = themeValueSchema.safeParse(raw)
    if (!themeIdSchema.safeParse(id).success || !id.startsWith('custom.') || !parsed.success) {
      issues.push({ id, message: 'This saved theme is unavailable or unsupported. Its original data is retained; import a valid copy or explicitly remove this record.' })
      continue
    }
    items.push({ id, value: parsed.data, readonly: false })
  }
  return { items, issues }
}
export type ThemeSelection = { themeId?: string; appAppearance?: AppAppearanceId; customThemes?: Record<string, unknown> }
export function resolveThemeDocument(document: ThemeDocument, appearance: AppAppearanceId | undefined, prefersDark: boolean) {
  const mode: ThemeMode = appearance === 'light' ? 'light' : appearance === 'system' ? prefersDark ? 'dark' : 'light' : 'dark'
  const value = themeValue(document)
  return { id: document.id, value, mode, variant: value.variants[mode], issues: [] as ThemeIssue[] }
}
export function resolveTheme(selection: ThemeSelection = {}, prefersDark = true) {
  const catalog = getThemeCatalog(selection.customThemes)
  const requestedId = selection.themeId ?? DEFAULT_THEME_ID
  const item = catalog.items.find(theme => theme.id === requestedId) ?? catalog.items[0]!
  const resolved = resolveThemeDocument({ id: item.id, ...item.value }, selection.appAppearance, prefersDark)
  return { ...resolved, issues: requestedId === item.id ? catalog.issues : [...catalog.issues,
    { id: requestedId, message: 'Selected theme is unavailable. Graphite remains usable; choose or import a valid theme in Appearance.' }] }
}
export type ResolvedTheme = ReturnType<typeof resolveTheme>
