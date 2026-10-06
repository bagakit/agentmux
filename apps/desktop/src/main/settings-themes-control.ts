import { DEFAULT_THEME_ID, getThemeCatalog, getSemanticIconCatalog, isBuiltinThemeId, themeIdSchema, themeValueSchema, themeDocumentSchema, themeValue, serializeThemeFile } from '@agentmux/client-ui/theme'
import type { AgentMuxControlSettingsResourceFields as Fields, AgentMuxControlSettingsResourceRequest as Request,
  AgentMuxControlSettingsResourceResult as Result } from '@agentmux/core'
import { ConfigConflict, configValuesEqual } from '../shared/config-edit.js'
import type { AppConfig } from '../shared/contracts.js'
import type { ConfigOwner } from './config-owner.js'

function fail(code: 'INVALID_SETTING_VALUE' | 'SETTING_RESOURCE_NOT_FOUND' | 'SETTING_RESOURCE_EXISTS' | 'SETTING_IDENTITY_IMMUTABLE', message: string): never {
  throw Object.assign(new Error(message), { code })
}
function value(raw: unknown, id: string): Fields {
  if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'id')) {
    const document = themeDocumentSchema.safeParse(raw)
    if (!document.success) fail('INVALID_SETTING_VALUE', `Invalid theme document: ${document.error.issues.map(issue => issue.message).join('; ')}`)
    if (document.data.id !== id) fail('SETTING_IDENTITY_IMMUTABLE', 'Theme file identity must match the exact resource ID. Saved themes are unchanged.')
    serializeThemeFile(document.data)
    return themeValue(document.data) as Fields
  }
  const parsed = themeValueSchema.safeParse(raw)
  if (!parsed.success) fail('INVALID_SETTING_VALUE', `Invalid theme: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'theme'}: ${issue.message}`).join('; ')}`)
  return parsed.data as Fields
}
function matchesExpected(raw: unknown, expected: unknown, id: string): boolean {
  const document = themeDocumentSchema.safeParse(expected)
  if (document.success && document.data.id === id) expected = themeValue(document.data)
  if (configValuesEqual(raw, expected)) return true
  const parsed = themeValueSchema.safeParse(raw)
  return parsed.success && configValuesEqual(parsed.data, expected)
}
function item(config: AppConfig, id: string) {
  const catalog = getThemeCatalog(config.appearance.customThemes)
  const found = catalog.items.find(candidate => candidate.id === id)
  if (found) return { ...found, value: found.value as Fields }
  if (catalog.issues.some(issue => issue.id === id)) fail('INVALID_SETTING_VALUE', `Theme “${id}” is unavailable or unsupported. Its original data is retained. Inspect the theme catalog, then replace it with a valid theme or explicitly delete this exact record with its raw expected value.`)
  return fail('SETTING_RESOURCE_NOT_FOUND', `Theme “${id}” does not exist.`)
}

/** The resource protocol carries plain JSON; the Main client owner alone interprets the theme schema. */
export async function executeSettingsThemesControl(request: Request, owner: ConfigOwner): Promise<Result> {
  if (request.operation === 'settings.resource.list') {
    const catalog = getThemeCatalog(owner.current.appearance.customThemes)
    return { operation: request.operation, resource: 'themes', partial: true,
      items: catalog.items.map(candidate => ({ ...candidate, value: candidate.value as Fields })), issues: catalog.issues,
      iconCatalog: getSemanticIconCatalog() }
  }
  if (request.operation === 'settings.resource.get') {
    if (request.id === undefined) fail('INVALID_SETTING_VALUE', 'A theme lookup requires its exact ID.')
    const found = item(owner.current, request.id)
    const document = themeDocumentSchema.parse({ id: found.id, ...found.value })
    serializeThemeFile(document)
    return { operation: request.operation, resource: 'themes', item: { ...found, document: document as Fields } }
  }
  const id = request.id
  if (isBuiltinThemeId(id) && !(request.operation === 'settings.resource.remove' &&
      Object.hasOwn(owner.current.appearance.customThemes ?? {}, id))) fail('SETTING_IDENTITY_IMMUTABLE', `Built-in theme “${id}” is read-only. Save an editable copy with a custom. identity.`)
  // Even unsupported old IDs can be explicitly removed; the expected raw record prevents a stale deletion.
  if (request.operation !== 'settings.resource.remove' && !themeIdSchema.safeParse(id).success) fail('INVALID_SETTING_VALUE', `Invalid custom theme identity: ${id}`)
  let changed = false
  const saved = await owner.update(current => {
    const themes = current.appearance.customThemes ?? {}
    const exists = Object.hasOwn(themes, id), original = themes[id]
    if (request.operation === 'settings.resource.add') {
      if (exists) fail('SETTING_RESOURCE_EXISTS', `Theme “${id}” already exists. Explicitly replace it with expected data, or save a copy with another identity.`)
      const parsed = value(request.value, id)
      changed = true
      return { ...current, appearance: { ...current.appearance, customThemes: { ...themes, [id]: parsed } } }
    }
    if (!exists) fail('SETTING_RESOURCE_NOT_FOUND', `Theme “${id}” does not exist; update never adds an identity.`)
    if (!Object.hasOwn(request, 'expected')) fail('INVALID_SETTING_VALUE', 'Theme update or deletion requires the original expected record. Saved themes are unchanged.')
    if (request.operation === 'settings.resource.remove') {
      if (!matchesExpected(original, request.expected, id)) throw new ConfigConflict(`appearance.customThemes.${id}`)
      const customThemes = { ...themes }
      delete customThemes[id]
      changed = true
      return { ...current, appearance: { ...current.appearance, customThemes,
        ...(current.appearance.themeId === id ? { themeId: DEFAULT_THEME_ID } : {}) } }
    }
    // Whole records are intentional here: palette variants and icon assets must not become a synthetic merge.
    if (!matchesExpected(original, request.expected, id)) throw new ConfigConflict(`appearance.customThemes.${id}`)
    const baseline = original !== null && typeof original === 'object' && !Array.isArray(original) ? original : {}
    const complete = Object.hasOwn(request.changes, 'id') || themeValueSchema.safeParse(request.changes).success
    const parsed = value(complete ? request.changes : { ...baseline, ...request.changes }, id)
    changed = !configValuesEqual(original, parsed)
    return changed ? { ...current, appearance: { ...current.appearance, customThemes: { ...themes, [id]: parsed } } } : current
  })
  return request.operation === 'settings.resource.remove'
    ? { operation: request.operation, resource: 'themes', id, removed: true }
    : { operation: request.operation, resource: 'themes', item: item(saved, id), changed }
}
