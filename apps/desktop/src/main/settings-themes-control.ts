import { DEFAULT_THEME_ID, getThemeCatalog, isBuiltinThemeId, themeIdSchema, themeValueSchema } from '@agentmux/client-ui/theme'
import type { AgentMuxControlSettingsResourceFields as Fields, AgentMuxControlSettingsResourceRequest as Request,
  AgentMuxControlSettingsResourceResult as Result } from '@agentmux/core'
import { ConfigConflict, configValuesEqual } from '../shared/config-edit.js'
import type { AppConfig } from '../shared/contracts.js'
import type { ConfigOwner } from './config-owner.js'

function fail(code: 'INVALID_SETTING_VALUE' | 'SETTING_RESOURCE_NOT_FOUND' | 'SETTING_RESOURCE_EXISTS' | 'SETTING_IDENTITY_IMMUTABLE', message: string): never {
  throw Object.assign(new Error(message), { code })
}
function value(raw: unknown): Fields {
  const parsed = themeValueSchema.safeParse(raw)
  if (!parsed.success) fail('INVALID_SETTING_VALUE', `Invalid theme: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'theme'}: ${issue.message}`).join('; ')}`)
  return parsed.data as Fields
}
function matchesExpected(raw: unknown, expected: unknown): boolean {
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
      items: catalog.items.map(candidate => ({ ...candidate, value: candidate.value as Fields })), issues: catalog.issues }
  }
  if (request.operation === 'settings.resource.get') {
    if (request.id === undefined) fail('INVALID_SETTING_VALUE', 'A theme lookup requires its exact ID.')
    return { operation: request.operation, resource: 'themes', item: item(owner.current, request.id) }
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
      const parsed = value(request.value)
      changed = true
      return { ...current, appearance: { ...current.appearance, customThemes: { ...themes, [id]: parsed } } }
    }
    if (!exists) fail('SETTING_RESOURCE_NOT_FOUND', `Theme “${id}” does not exist; update never adds an identity.`)
    if (!Object.hasOwn(request, 'expected')) fail('INVALID_SETTING_VALUE', 'Theme update or deletion requires the original expected record. Saved themes are unchanged.')
    if (request.operation === 'settings.resource.remove') {
      if (!matchesExpected(original, request.expected)) throw new ConfigConflict(`appearance.customThemes.${id}`)
      const customThemes = { ...themes }
      delete customThemes[id]
      changed = true
      return { ...current, appearance: { ...current.appearance, customThemes,
        ...(current.appearance.themeId === id ? { themeId: DEFAULT_THEME_ID } : {}) } }
    }
    if (Object.hasOwn(request.changes, 'id')) fail('SETTING_IDENTITY_IMMUTABLE', 'Theme identity belongs in the envelope, never in editable data.')
    // Whole records are intentional here: palette variants and icon assets must not become a synthetic merge.
    if (!matchesExpected(original, request.expected)) throw new ConfigConflict(`appearance.customThemes.${id}`)
    const baseline = original !== null && typeof original === 'object' && !Array.isArray(original) ? original : {}
    const parsed = value({ ...baseline, ...request.changes })
    changed = !configValuesEqual(original, parsed)
    return changed ? { ...current, appearance: { ...current.appearance, customThemes: { ...themes, [id]: parsed } } } : current
  })
  return request.operation === 'settings.resource.remove'
    ? { operation: request.operation, resource: 'themes', id, removed: true }
    : { operation: request.operation, resource: 'themes', item: item(saved, id), changed }
}
