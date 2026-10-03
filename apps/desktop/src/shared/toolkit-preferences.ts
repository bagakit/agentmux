import type { ToolkitToolDefinition } from '@agentmux/core/control'

export const PERFORMANCE_STATUS_BAR_IDS = ['icon', 'label'] as const
export const TOOLKIT_ICON_IDS = ['terminal', 'zap', 'refresh-cw', 'gauge', 'key-round', 'credit-card', 'bot', 'sparkles'] as const
export type PerformanceStatusBar = typeof PERFORMANCE_STATUS_BAR_IDS[number]
export type PerformancePreferences = { enabled: boolean; statusBar: PerformanceStatusBar }
export const MOBILE_CONNECTION_TOOL_ID = 'builtin:mobile-connection'
export const MOBILE_CONNECTION_STATUS_BAR_IDS = PERFORMANCE_STATUS_BAR_IDS
export type MobileConnectionPreferences = { enabled: boolean; statusBar: PerformanceStatusBar }
export type ToolkitPreferences = { performance?: Partial<PerformancePreferences>; mobileConnection?: Partial<MobileConnectionPreferences>; tools?: ToolkitToolDefinition[] }

export const DEFAULT_PERFORMANCE_PREFERENCES: PerformancePreferences = Object.freeze({ enabled: true, statusBar: 'icon' })

/** An absent preference is a default, not a reason to write the config. */
export function resolvePerformancePreferences(config: { toolkit?: ToolkitPreferences }): PerformancePreferences {
  return {
    enabled: config.toolkit?.performance?.enabled ?? DEFAULT_PERFORMANCE_PREFERENCES.enabled,
    statusBar: config.toolkit?.performance?.statusBar ?? DEFAULT_PERFORMANCE_PREFERENCES.statusBar
  }
}

export const DEFAULT_MOBILE_CONNECTION_PREFERENCES: MobileConnectionPreferences = Object.freeze({ enabled: true, statusBar: 'icon' })

/** Showing the entry is independent of device authorization or private-access availability. */
export function resolveMobileConnectionPreferences(config: { toolkit?: ToolkitPreferences }): MobileConnectionPreferences {
  return {
    enabled: config.toolkit?.mobileConnection?.enabled ?? DEFAULT_MOBILE_CONNECTION_PREFERENCES.enabled,
    statusBar: config.toolkit?.mobileConnection?.statusBar ?? DEFAULT_MOBILE_CONNECTION_PREFERENCES.statusBar
  }
}
