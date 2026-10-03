import { FOCUS_RECENT_ACTIVITY_HOURS, DEFAULT_FOCUS_RECENT_ACTIVITY_HOURS, resolveFocusRecentActivityHours, FOCUS_LINK_DESTINATIONS, DEFAULT_FOCUS_LINK_DESTINATION, resolveFocusLinkDestination } from '../../../shared/focus-preferences.js'
import type { AppConfig } from '../../../shared/contracts.js'
import { enumSetting, invalid, type ScalarSetting } from '../scalar-setting.js'

export const focusSettings = [
  {
    key: 'focus.recentActivityHours',
    entry(config: AppConfig) { return { key: this.key, kind: 'number' as const,
      value: resolveFocusRecentActivityHours(config.focus?.recentActivityHours),
      default: DEFAULT_FOCUS_RECENT_ACTIVITY_HOURS, enum: [...FOCUS_RECENT_ACTIVITY_HOURS] } },
    apply(config: AppConfig, value: string): AppConfig {
      const next = Number(value)
      if (!FOCUS_RECENT_ACTIVITY_HOURS.some(hours => String(hours) === value)) throw invalid(this.key, value)
      if (this.entry(config).value === next) return config
      return { ...config, focus: { ...config.focus, recentActivityHours: resolveFocusRecentActivityHours(next) } }
    }
  },
  enumSetting('focus.linkDestination', FOCUS_LINK_DESTINATIONS, DEFAULT_FOCUS_LINK_DESTINATION,
    config => resolveFocusLinkDestination(config.focus?.linkDestination),
    (config, linkDestination) => ({ ...config, focus: { recentActivityHours: resolveFocusRecentActivityHours(config.focus?.recentActivityHours),
      ...config.focus, linkDestination } })),
] satisfies readonly ScalarSetting[]
