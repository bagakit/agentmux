import { getThemeCatalog, isBuiltinThemeId, themeIdSchema, themeValueSchema, serializeThemeFile } from '@agentmux/client-ui/theme'
import type { AppConfig } from '../shared/contracts.js'
import { configValuesEqual } from '../shared/config-edit.js'

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: 'INVALID_SETTING_VALUE' })
}

/** Validate only authored changes. An unsupported saved record must not block unrelated settings. */
export function validateThemeConfigEdit(previous: unknown, next: AppConfig): void {
  const before = record(record(previous).appearance)
  const oldThemes = record(before.customThemes)
  const themes = next.appearance.customThemes ?? {}
  for (const [id, value] of Object.entries(themes)) {
    if (Object.hasOwn(oldThemes, id) && configValuesEqual(oldThemes[id], value)) continue
    if (!themeIdSchema.safeParse(id).success || isBuiltinThemeId(id)) invalid(`Theme “${id}” cannot be authored here. Save an editable theme with a custom. identity.`)
    const parsed = themeValueSchema.safeParse(value)
    if (!parsed.success) invalid(`Invalid theme “${id}”: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'theme'}: ${issue.message}`).join('; ')}`)
    try { serializeThemeFile({ id, ...parsed.data }) }
    catch (cause) { invalid(cause instanceof Error ? cause.message : `Theme “${id}” cannot be serialized. Saved themes are unchanged.`) }
  }
  const selected = next.appearance.themeId
  // Unavailable unchanged selections are retained and diagnosed by the catalog, not guessed healthy.
  const selectedRecordChanged = selected !== undefined && !configValuesEqual(oldThemes[selected], themes[selected])
  if (selected !== before.themeId || selectedRecordChanged) {
    if (selected !== undefined && !getThemeCatalog(themes).items.some(item => item.id === selected)) invalid(`Theme “${selected}” is unavailable. Choose an available theme; saved preferences are unchanged.`)
  }
}
