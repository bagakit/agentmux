import { PERFORMANCE_STATUS_BAR_IDS, DEFAULT_PERFORMANCE_PREFERENCES, resolvePerformancePreferences, MOBILE_CONNECTION_STATUS_BAR_IDS, DEFAULT_MOBILE_CONNECTION_PREFERENCES, resolveMobileConnectionPreferences } from '../../../shared/toolkit-preferences.js'
import { booleanSetting, enumSetting, type ScalarSetting } from '../scalar-setting.js'

export const toolkitSettings = [
  booleanSetting('toolkit.mobileConnection.enabled', DEFAULT_MOBILE_CONNECTION_PREFERENCES.enabled,
    config => resolveMobileConnectionPreferences(config).enabled,
    (config, enabled) => ({ ...config, toolkit: { ...config.toolkit, mobileConnection: { ...resolveMobileConnectionPreferences(config), enabled } } })),
  enumSetting('toolkit.mobileConnection.statusBar', MOBILE_CONNECTION_STATUS_BAR_IDS, DEFAULT_MOBILE_CONNECTION_PREFERENCES.statusBar,
    config => resolveMobileConnectionPreferences(config).statusBar,
    (config, statusBar) => ({ ...config, toolkit: { ...config.toolkit, mobileConnection: { ...resolveMobileConnectionPreferences(config), statusBar } } })),
  booleanSetting('toolkit.performance.enabled', DEFAULT_PERFORMANCE_PREFERENCES.enabled,
    config => resolvePerformancePreferences(config).enabled,
    (config, enabled) => ({ ...config, toolkit: { ...config.toolkit, performance: { ...resolvePerformancePreferences(config), enabled } } })),
  enumSetting('toolkit.performance.statusBar', PERFORMANCE_STATUS_BAR_IDS, DEFAULT_PERFORMANCE_PREFERENCES.statusBar,
    config => resolvePerformancePreferences(config).statusBar,
    (config, statusBar) => ({ ...config, toolkit: { ...config.toolkit, performance: { ...resolvePerformancePreferences(config), statusBar } } }))
] satisfies readonly ScalarSetting[]
