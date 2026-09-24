import type { AgentMuxControlSettingEntry } from '@agentmux/core'
import type { AppConfig } from '../../../shared/contracts.js'
import { APP_APPEARANCE_IDS, APP_APPEARANCE_DEFAULT, TERMINAL_THEME_IDS, TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX } from '../../../shared/contracts.js'
import { DEFAULT_CONFIG } from '../../config-store.js'
import { enumSetting, invalid } from '../scalar-setting.js'
import type { ScalarSetting } from '../scalar-setting.js'

export const appearanceSettings = [
  enumSetting('appearance.appAppearance', APP_APPEARANCE_IDS, APP_APPEARANCE_DEFAULT,
    (config) => config.appearance.appAppearance ?? APP_APPEARANCE_DEFAULT,
    (config, appAppearance) => ({ ...config, appearance: { ...config.appearance, appAppearance } })),
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
] satisfies readonly ScalarSetting[]
