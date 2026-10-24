import type { AppConfig } from '../../../shared/contracts.js'
import { resolveFocusRecentActivityHours } from '../../../shared/focus-preferences.js'
import { FOCUS_MAP_BOUNDARIES, FOCUS_MAP_LEVEL_COUNTS, FOCUS_MAP_FORMS, FOCUS_MAP_INFORMATION, focusMapPreset,
  focusMapPreferencesIssue, resolveFocusMapPreferences, type FocusMapPreferences, type FocusMapLodLevel, type FocusMapLevelCount } from '../../../shared/focus-map-preferences.js'
import { enumSetting, invalid, type ScalarSetting } from '../scalar-setting.js'

function write(config: AppConfig, map: FocusMapPreferences): AppConfig {
  return { ...config, focus: { recentActivityHours: resolveFocusRecentActivityHours(config.focus?.recentActivityHours), ...config.focus, map } }
}

/** Active stages contribute real scalar fields, while count remains a projection. */
export function focusMapSettings(config: AppConfig): readonly ScalarSetting[] {
  const profile = resolveFocusMapPreferences(config.focus?.map)
  return [
    enumSetting('focus.map.boundary', FOCUS_MAP_BOUNDARIES, 'bezier',
      current => resolveFocusMapPreferences(current.focus?.map).boundary,
      (current, boundary) => write(current, { ...resolveFocusMapPreferences(current.focus?.map), boundary })),
    {
      key: 'focus.map.levels.count',
      entry(current) { return { key: this.key, kind: 'number', value: resolveFocusMapPreferences(current.focus?.map).levels.length, default: 3, enum: [...FOCUS_MAP_LEVEL_COUNTS] } },
      apply(current, value) {
        if (!FOCUS_MAP_LEVEL_COUNTS.some(count => String(count) === value)) throw invalid(this.key, value)
        const map = resolveFocusMapPreferences(current.focus?.map), count = Number(value) as FocusMapLevelCount
        return map.levels.length === count ? current : write(current, { ...map, levels: focusMapPreset(count) })
      }
    },
    ...profile.levels.flatMap((_level, index) => (['form', 'information', ...(index ? ['from', 'to'] as const : [])] as const).map(field => ({
      key: `focus.map.levels.${index + 1}.${field}`,
      entry(current: AppConfig) {
        const map = resolveFocusMapPreferences(current.focus?.map), levels = map.levels, level = levels[index]!
        const defaults = focusMapPreset(levels.length as FocusMapLevelCount)[index]!
        // The existing wire enum describes this field's finite domain and must
        // include its preset default. Cross-stage compatibility is checked by
        // apply against the whole queued profile, not by shrinking wire metadata.
        return field === 'form' ? { key: this.key, kind: 'string' as const, value: level.form, default: defaults.form, enum: [...FOCUS_MAP_FORMS] }
          : field === 'information' ? { key: this.key, kind: 'string' as const, value: level.information, default: defaults.information, enum: [...FOCUS_MAP_INFORMATION] }
          : { key: this.key, kind: 'number' as const, value: level[field], default: defaults[field] }
      },
      apply(current: AppConfig, value: string): AppConfig {
        const map = resolveFocusMapPreferences(current.focus?.map), level = map.levels[index]
        if (!level) throw invalid(this.key, value)
        const next = field === 'from' || field === 'to' ? /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? Number(value) : Number.NaN : value
        if (level[field] === next) return current
        const levels = map.levels.map((item, at) => at === index ? { ...item, [field]: next } as FocusMapLodLevel : item)
        const changed = { ...map, levels }
        const issue = focusMapPreferencesIssue(changed)
        if (issue) throw Object.assign(invalid(this.key, value), { message: `${issue} Run amux settings inspect focus.map for current choices.` })
        return write(current, changed)
      }
    })))
  ]
}
