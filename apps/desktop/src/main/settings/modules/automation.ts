import type { AppConfig } from '../../../shared/contracts.js'
import { DEFAULT_AUTOMATION_PREFERENCES, resolveAutomationPreferences, validateAutomationPreferences, type AutomationDefaults } from '../../../shared/automation-preferences.js'
import { invalid, type ScalarSetting } from '../scalar-setting.js'

/** Exact scalar declarations; ConfigOwner remains the only persistence/publication owner. */
export const automationSettings = (Object.keys(DEFAULT_AUTOMATION_PREFERENCES) as (keyof AutomationDefaults)[]).map((key): ScalarSetting => ({
  key: `automation.${key}`,
  entry(config) {
    const value = resolveAutomationPreferences(config.automation)[key], fallback = DEFAULT_AUTOMATION_PREFERENCES[key]
    return typeof value === 'number' && typeof fallback === 'number'
      ? { key: this.key, kind: 'number', value, default: fallback }
      : { key: this.key, kind: 'string', value: value as string, default: fallback as string }
  },
  apply(config: AppConfig, text: string): AppConfig {
    const value = typeof DEFAULT_AUTOMATION_PREFERENCES[key] === 'number' ? Number(text) : text
    if (typeof value === 'number' && (!/^\d+$/.test(text) || !Number.isSafeInteger(value))) throw invalid(this.key, text)
    if (this.entry(config).value === value) return config
    const next = { ...config, automation: { ...config.automation, [key]: value } }
    try { validateAutomationPreferences(next.automation) }
    catch (error) { const failure = invalid(this.key, text); failure.message += ' ' + (error instanceof Error ? error.message : 'Invalid automation defaults.'); throw failure }
    return next
  }
}))
