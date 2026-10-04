import { APP_APPEARANCE_DEFAULT, TERMINAL_FONT_SIZE_DEFAULT, PROJECT_RAIL_DENSITY_DEFAULT, MOTE_DIRECTORY_VIEW_DEFAULT, type AppConfig, type GoalsCommonActionsConfig } from './contracts'
import { DEFAULT_NOTIFICATION_MODE_ID, DEFAULT_NOTIFICATION_SOUND } from './notification-presentation'
import { DEFAULT_PERFORMANCE_PREFERENCES, DEFAULT_MOBILE_CONNECTION_PREFERENCES } from './toolkit-preferences'
import { resolveUserProfile, type UserProfile } from './user-profile'
import { resolveFocusRecentActivityHours, resolveFocusLinkDestination } from './focus-preferences'
import { resolveGoalsCommonActions, resolveGoalsPreferences, type GoalsPreferences } from './goals-preferences'
import { resolveNotesPreferences, type NotesPreferences } from './notes-preferences'

export function configValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => configValuesEqual(value, b[index]))
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && configValuesEqual(left[key], right[key]))
}

function effective(path: string, value: unknown): unknown {
  if (path === 'profile') return resolveUserProfile(value as Partial<UserProfile> | undefined)
  if (path === 'focus') return value ?? { recentActivityHours: resolveFocusRecentActivityHours(undefined) }
  if (path === 'focus.recentActivityHours') return resolveFocusRecentActivityHours(value)
  if (path === 'focus.linkDestination') return resolveFocusLinkDestination(value)
  if (path === 'notes') return resolveNotesPreferences(value as NotesPreferences | undefined)
  if (path === 'notes.fontSize') return value ?? resolveNotesPreferences(undefined).fontSize
  if (path === 'notes.contentWidth') return value ?? resolveNotesPreferences(undefined).contentWidth
  if (path === 'goals') return resolveGoalsPreferences(value as GoalsPreferences | undefined)
  if (path === 'goals.defaultView') return value ?? resolveGoalsPreferences(undefined).defaultView
  if (path === 'goals.showFinished') return value ?? resolveGoalsPreferences(undefined).showFinished
  if (path === 'projectRailDensity') return value ?? PROJECT_RAIL_DENSITY_DEFAULT
  if (path === 'moteDirectoryView') return value ?? MOTE_DIRECTORY_VIEW_DEFAULT
  if (path === 'goalsCommonActions') return resolveGoalsCommonActions(value as GoalsCommonActionsConfig | undefined)
  if (path === 'toolkit') return value ?? { performance: DEFAULT_PERFORMANCE_PREFERENCES, mobileConnection: DEFAULT_MOBILE_CONNECTION_PREFERENCES }
  if (path === 'toolkit.performance') return value ?? DEFAULT_PERFORMANCE_PREFERENCES
  if (path === 'toolkit.performance.enabled') return value ?? DEFAULT_PERFORMANCE_PREFERENCES.enabled
  if (path === 'toolkit.performance.statusBar') return value ?? DEFAULT_PERFORMANCE_PREFERENCES.statusBar
  if (path === 'toolkit.mobileConnection') return value ?? DEFAULT_MOBILE_CONNECTION_PREFERENCES
  if (path === 'toolkit.mobileConnection.enabled') return value ?? DEFAULT_MOBILE_CONNECTION_PREFERENCES.enabled
  if (path === 'toolkit.mobileConnection.statusBar') return value ?? DEFAULT_MOBILE_CONNECTION_PREFERENCES.statusBar
  if (path === 'toolkit.tools') return value ?? []
  if (path === 'copyPathsAsAbsolute' || path === 'browser.agentAutomation') return value ?? false
  if (path === 'appearance.appAppearance') return value ?? APP_APPEARANCE_DEFAULT
  if (path === 'appearance.terminalFontSize') return value ?? TERMINAL_FONT_SIZE_DEFAULT
  if (path === 'notifications.mode') return value ?? DEFAULT_NOTIFICATION_MODE_ID
  if (path === 'notifications.sound') return value ?? DEFAULT_NOTIFICATION_SOUND
  return value
}

export class ConfigConflict extends Error {
  readonly code = 'CONFIG_CONFLICT'
  constructor(readonly field: string) {
    super(`“${field}” changed since you started editing. Your draft is kept. Review the current setting before saving again.`)
  }
}

/** Apply only authored differences; this is an internal edit, never a public path setter. */
export function applyConfigEdit(current: AppConfig, before: AppConfig, after: AppConfig): AppConfig {
  function merge(actual: unknown, expected: unknown, requested: unknown, path: string): unknown {
    if (configValuesEqual(effective(path, expected), effective(path, requested))) return actual
    if (configValuesEqual(effective(path, actual), effective(path, requested))) return actual
    // Optional domains still merge authored fields/identities after a concurrent first edit.
    if (path === 'notes' || path === 'goals') {
      // Compare effective defaults without persisting fields the user did not edit.
      actual = actual ?? {}; expected = effective(path, expected); requested = effective(path, requested)
    } else if (path === 'profile' || path === 'focus' || path === 'goalsCommonActions' || path === 'toolkit' || path === 'toolkit.performance' || path === 'toolkit.mobileConnection' || path === 'toolkit.tools') {
      actual = effective(path, actual); expected = effective(path, expected); requested = effective(path, requested)
    }
    // Environment is one literal launch value, never a merge of independently authored keys.
    if (/^executors\.[^.]+\.env$/.test(path)) {
      if (!configValuesEqual(actual, expected)) throw new ConfigConflict(path)
      return requested
    }
    if (Array.isArray(expected) && Array.isArray(requested) && Array.isArray(actual) &&
        (path === 'workspaces' || path === 'hosts' || path === 'composerShortcuts' || path === 'toolkit.tools')) {
      type RecordWithId = { id: string }
      const old = new Map((expected as RecordWithId[]).map((record) => [record.id, record]))
      const next = new Map((requested as RecordWithId[]).map((record) => [record.id, record]))
      const live = new Map((actual as RecordWithId[]).map((record) => [record.id, record]))
      const merged = new Map(live)
      for (const id of new Set([...old.keys(), ...next.keys()])) {
        const value = merge(live.get(id), old.get(id), next.get(id), `${path}.${id}`)
        if (value === undefined) merged.delete(id)
        else merged.set(id, value as RecordWithId)
      }
      return [...merged.values()]
    }
    if (actual && expected && requested && !Array.isArray(actual) && !Array.isArray(expected) && !Array.isArray(requested) &&
        typeof actual === 'object' && typeof expected === 'object' && typeof requested === 'object') {
      const live = actual as Record<string, unknown>, old = expected as Record<string, unknown>, next = requested as Record<string, unknown>
      const result = { ...live }
      for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) {
        const own = (record: Record<string, unknown>) => Object.hasOwn(record, key) ? record[key] : undefined
        const value = merge(own(live), own(old), own(next), path ? `${path}.${key}` : key)
        if (value === undefined) delete result[key]
        else Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true })
      }
      return result
    }
    if (!configValuesEqual(effective(path, actual), effective(path, expected))) throw new ConfigConflict(path)
    return requested
  }
  return merge(current, before, after, '') as AppConfig
}
