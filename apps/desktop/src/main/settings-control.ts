import type { AgentMuxControlRequest, AgentMuxControlResult, AgentMuxControlSettingEntry } from '@agentmux/core'
import {
  APP_APPEARANCE_IDS, APP_APPEARANCE_DEFAULT, PROJECT_RAIL_DENSITY_IDS, PROJECT_RAIL_DENSITY_DEFAULT,
  TERMINAL_THEME_IDS, TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX, type AppConfig
} from '../shared/contracts.js'
import { BROWSER_TOOLBAR_ITEM_ORDER } from '../shared/browser-toolbar.js'
import {
  NOTIFICATION_TIERS, DEFAULT_NOTIFICATION_MODE_ID, DEFAULT_NOTIFICATION_SOUND,
  resolveNotificationModeId, resolveNotificationSound
} from '../shared/notification-presentation.js'
import { DEFAULT_CONFIG } from './config-store.js'
import type { ConfigOwner } from './config-owner.js'

type Setting = {
  key: string
  entry(config: AppConfig): AgentMuxControlSettingEntry
  apply(config: AppConfig, value: string): AppConfig
}

function enumSetting<T extends string>(
  key: string, choices: readonly T[], defaultValue: T, read: (config: AppConfig) => T,
  write: (config: AppConfig, value: T) => AppConfig
): Setting {
  return {
    key,
    entry(config) { return { key, kind: 'string', value: read(config), default: defaultValue, enum: [...choices] } },
    apply(config, value) {
      if (!(choices as readonly string[]).includes(value)) throw invalid(key, value)
      return this.entry(config).value === value ? config : write(config, value as T)
    }
  }
}

function booleanSetting(
  key: string, defaultValue: boolean, read: (config: AppConfig) => boolean,
  write: (config: AppConfig, value: boolean) => AppConfig
): Setting {
  return {
    key,
    entry(config) { return { key, kind: 'boolean', value: read(config), default: defaultValue } },
    apply(config, value) {
      if (value !== 'true' && value !== 'false') throw invalid(key, value)
      const next = value === 'true'
      return this.entry(config).value === next ? config : write(config, next)
    }
  }
}

const settings: Setting[] = [
  enumSetting('appearance.appAppearance', APP_APPEARANCE_IDS, APP_APPEARANCE_DEFAULT,
    (config) => config.appearance.appAppearance ?? APP_APPEARANCE_DEFAULT,
    (config, appAppearance) => ({ ...config, appearance: { ...config.appearance, appAppearance } })),
  booleanSetting('copyPathsAsAbsolute', false, (config) => config.copyPathsAsAbsolute === true,
    (config, copyPathsAsAbsolute) => ({ ...config, copyPathsAsAbsolute })),
  enumSetting('appearance.terminalTheme', TERMINAL_THEME_IDS, DEFAULT_CONFIG.appearance.terminalTheme,
    (config) => config.appearance.terminalTheme,
    (config, terminalTheme) => ({ ...config, appearance: { ...config.appearance, terminalTheme } })),
  {
    key: 'appearance.terminalFontSize',
    entry(config: AppConfig): AgentMuxControlSettingEntry { return {
      key: this.key, kind: 'number', value: config.appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT,
      default: TERMINAL_FONT_SIZE_DEFAULT,
      enum: Array.from({ length: TERMINAL_FONT_SIZE_MAX - TERMINAL_FONT_SIZE_MIN + 1 }, (_, index) => TERMINAL_FONT_SIZE_MIN + index)
    } },
    apply(config: AppConfig, value: string): AppConfig {
      const next = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(next) || next < TERMINAL_FONT_SIZE_MIN || next > TERMINAL_FONT_SIZE_MAX) throw invalid(this.key, value)
      if (this.entry(config).value === next) return config
      return { ...config, appearance: { ...config.appearance, terminalFontSize: next } }
    }
  },
  enumSetting('notifications.mode', NOTIFICATION_TIERS.map((tier) => tier.id), DEFAULT_NOTIFICATION_MODE_ID,
    resolveNotificationModeId,
    (config, mode) => ({ ...config, notifications: { ...config.notifications, mode } })),
  booleanSetting('notifications.sound', DEFAULT_NOTIFICATION_SOUND, resolveNotificationSound,
    (config, sound) => ({ ...config, notifications: { mode: resolveNotificationModeId(config), ...config.notifications, sound } })),
  enumSetting('projectRailDensity', PROJECT_RAIL_DENSITY_IDS, PROJECT_RAIL_DENSITY_DEFAULT,
    (config) => config.projectRailDensity ?? PROJECT_RAIL_DENSITY_DEFAULT,
    (config, projectRailDensity) => ({ ...config, projectRailDensity })),
  booleanSetting('browser.agentAutomation', DEFAULT_CONFIG.browser.agentAutomation === true,
    (config) => config.browser.agentAutomation === true,
    (config, agentAutomation) => ({ ...config, browser: { ...config.browser, agentAutomation } })),
  ...BROWSER_TOOLBAR_ITEM_ORDER.map((item) => booleanSetting(`browser.toolbar.${item}`, DEFAULT_CONFIG.browser.toolbar[item],
    (config) => config.browser.toolbar[item],
    (config, shown) => ({ ...config, browser: { ...config.browser, toolbar: { ...config.browser.toolbar, [item]: shown } } })))
]

function invalid(key: string, value: string): Error {
  return Object.assign(new Error(`Invalid value for ${key}: ${value}. Run agentmux settings get ${key} for valid values.`), { code: 'INVALID_SETTING_VALUE' })
}
function unsupported(key: string): Error {
  return Object.assign(new Error(`Unsupported setting: ${key}. Run agentmux settings get to see the currently supported settings.`), { code: 'UNSUPPORTED_SETTING' })
}

export async function executeSettingsControl(
  request: Extract<AgentMuxControlRequest, { operation: 'settings.get' | 'settings.set' }>,
  owner: ConfigOwner
): Promise<Extract<AgentMuxControlResult, { operation: 'settings.get' | 'settings.set' }>> {
  if (request.operation === 'settings.get') {
    const selected = request.target === undefined || request.target === '' ? settings :
      request.target === 'appearance' || request.target === 'notifications' || request.target === 'browser' || request.target === 'browser.toolbar'
      ? settings.filter((setting) => setting.key.startsWith(`${request.target}.`))
      : settings.filter((setting) => setting.key === request.target)
    if (!selected.length) throw unsupported(request.target ?? '')
    return { operation: request.operation, entries: selected.map((setting) => setting.entry(owner.current)), partial: true as const }
  }
  const setting = settings.find((candidate) => candidate.key === request.key)
  if (!setting) throw unsupported(request.key)
  const saved = await owner.update((current) => setting.apply(current, request.value))
  return { operation: request.operation, entry: setting.entry(saved) }
}
