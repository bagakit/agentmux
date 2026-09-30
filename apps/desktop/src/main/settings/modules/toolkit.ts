import { PERFORMANCE_STATUS_BAR_IDS, DEFAULT_PERFORMANCE_PREFERENCES, resolvePerformancePreferences } from '../../../shared/toolkit-preferences.js'
import { booleanSetting, enumSetting, type ScalarSetting } from '../scalar-setting.js'

export const toolkitSettings = [
  booleanSetting('toolkit.performance.enabled', DEFAULT_PERFORMANCE_PREFERENCES.enabled,
    config => resolvePerformancePreferences(config).enabled,
    (config, enabled) => ({ ...config, toolkit: { ...config.toolkit, performance: { ...resolvePerformancePreferences(config), enabled } } })),
  enumSetting('toolkit.performance.statusBar', PERFORMANCE_STATUS_BAR_IDS, DEFAULT_PERFORMANCE_PREFERENCES.statusBar,
    config => resolvePerformancePreferences(config).statusBar,
    (config, statusBar) => ({ ...config, toolkit: { ...config.toolkit, performance: { ...resolvePerformancePreferences(config), statusBar } } }))
] satisfies readonly ScalarSetting[]
