import { APP_APPEARANCE_DEFAULT, TERMINAL_FONT_SIZE_DEFAULT, type AppConfig } from './contracts'
import { DEFAULT_NOTIFICATION_MODE_ID, DEFAULT_NOTIFICATION_SOUND } from './notification-presentation'

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => equal(value, b[index]))
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
}

function effective(path: string, value: unknown): unknown {
  if (path === 'copyPathsAsAbsolute') return value ?? false
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
    if (equal(effective(path, expected), effective(path, requested))) return actual
    if (equal(effective(path, actual), effective(path, requested))) return actual
    if (Array.isArray(expected) && Array.isArray(requested) && Array.isArray(actual) &&
        (path === 'workspaces' || path === 'hosts' || path === 'composerShortcuts')) {
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
        const value = merge(live[key], old[key], next[key], path ? `${path}.${key}` : key)
        if (value === undefined) delete result[key]
        else result[key] = value
      }
      return result
    }
    if (!equal(effective(path, actual), effective(path, expected))) throw new ConfigConflict(path)
    return requested
  }
  return merge(current, before, after, '') as AppConfig
}
