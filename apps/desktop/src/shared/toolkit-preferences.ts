import type { ToolkitToolDefinition } from '@agentmux/core/control'

export const PERFORMANCE_STATUS_BAR_IDS = ['icon', 'label'] as const
export const TOOLKIT_ICON_IDS = ['terminal', 'zap', 'refresh-cw', 'gauge', 'key-round', 'credit-card', 'bot', 'sparkles'] as const
export type PerformanceStatusBar = typeof PERFORMANCE_STATUS_BAR_IDS[number]
export type PerformancePreferences = { enabled: boolean; statusBar: PerformanceStatusBar }
export type ToolkitPreferences = { performance?: Partial<PerformancePreferences>; tools?: ToolkitToolDefinition[] }

export const DEFAULT_PERFORMANCE_PREFERENCES: PerformancePreferences = Object.freeze({ enabled: true, statusBar: 'icon' })

/** An absent preference is a default, not a reason to write the config. */
export function resolvePerformancePreferences(config: { toolkit?: ToolkitPreferences }): PerformancePreferences {
  return {
    enabled: config.toolkit?.performance?.enabled ?? DEFAULT_PERFORMANCE_PREFERENCES.enabled,
    statusBar: config.toolkit?.performance?.statusBar ?? DEFAULT_PERFORMANCE_PREFERENCES.statusBar
  }
}
