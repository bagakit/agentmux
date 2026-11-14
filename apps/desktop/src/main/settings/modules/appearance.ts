import { APP_ICON_IDS, DEFAULT_APP_ICON } from '@agentmux/client-ui/app-icon-catalog'
import { DEFAULT_THEME_ID, getThemeCatalog } from '@agentmux/client-ui/theme'
import { CONVERSATION_DETAIL_LEVELS, CONVERSATION_DETAIL_LEVEL_DEFAULT } from '@agentmux/client-ui/conversation-detail-level'
import { CONVERSATION_CONFIRMED_SEND_RECEIPTS, resolveConversationConfirmedSendReceipt, resolveConversationShowSendReceipts } from '@agentmux/client-ui/conversation-send-receipts'
import type { AgentMuxControlSettingEntry } from '@agentmux/core'
import type { AppConfig } from '../../../shared/contracts.js'
import { APP_APPEARANCE_IDS, APP_APPEARANCE_DEFAULT, EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX, TERMINAL_THEME_IDS, TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX } from '../../../shared/contracts.js'
import { DEFAULT_CONFIG } from '../../config-store.js'
import { booleanSetting, enumSetting, integerSetting, invalid, parseIntegerSettingValue } from '../scalar-setting.js'
import type { ScalarSetting } from '../scalar-setting.js'

export const appearanceSettings = [
  booleanSetting('appearance.conversationShowSendReceipts', true,
    config => resolveConversationShowSendReceipts(config.appearance.conversationShowSendReceipts),
    (config, conversationShowSendReceipts) => ({ ...config, appearance: { ...config.appearance, conversationShowSendReceipts } })),
  enumSetting('appearance.conversationConfirmedSendReceipt', CONVERSATION_CONFIRMED_SEND_RECEIPTS, resolveConversationConfirmedSendReceipt(undefined),
    config => resolveConversationConfirmedSendReceipt(config.appearance.conversationConfirmedSendReceipt),
    (config, conversationConfirmedSendReceipt) => ({ ...config, appearance: { ...config.appearance, conversationConfirmedSendReceipt } })),
  enumSetting('appearance.conversationDetailLevel', CONVERSATION_DETAIL_LEVELS, CONVERSATION_DETAIL_LEVEL_DEFAULT,
    config => config.appearance.conversationDetailLevel === undefined ? CONVERSATION_DETAIL_LEVEL_DEFAULT : String(config.appearance.conversationDetailLevel),
    (config, conversationDetailLevel) => ({ ...config, appearance: { ...config.appearance, conversationDetailLevel } })),
  enumSetting('appearance.appIcon', APP_ICON_IDS, DEFAULT_APP_ICON,
    (config) => config.appearance.appIcon ?? DEFAULT_APP_ICON,
    (config, appIcon) => ({ ...config, appearance: { ...config.appearance, appIcon } })),
  {
    key: 'appearance.themeId',
    entry(config: AppConfig): AgentMuxControlSettingEntry { return {
      key: this.key, kind: 'string', value: config.appearance.themeId ?? DEFAULT_THEME_ID, default: DEFAULT_THEME_ID,
      enum: getThemeCatalog(config.appearance.customThemes).items.map(item => item.id)
    } },
    apply(config: AppConfig, value: string): AppConfig {
      if (!getThemeCatalog(config.appearance.customThemes).items.some(item => item.id === value)) throw invalid(this.key, value)
      if (this.entry(config).value === value) return config
      return { ...config, appearance: { ...config.appearance, themeId: value } }
    }
  },
  enumSetting('appearance.appAppearance', APP_APPEARANCE_IDS, APP_APPEARANCE_DEFAULT,
    (config) => config.appearance.appAppearance ?? APP_APPEARANCE_DEFAULT,
    (config, appAppearance) => ({ ...config, appearance: { ...config.appearance, appAppearance } })),
  enumSetting('appearance.terminalTheme', TERMINAL_THEME_IDS, DEFAULT_CONFIG.appearance.terminalTheme,
    (config) => config.appearance.terminalTheme,
    (config, terminalTheme) => ({ ...config, appearance: { ...config.appearance, terminalTheme } })),
  integerSetting('appearance.terminalFontSize', { min: TERMINAL_FONT_SIZE_MIN, max: TERMINAL_FONT_SIZE_MAX }, TERMINAL_FONT_SIZE_DEFAULT,
    config => config.appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT,
    (config, terminalFontSize) => ({ ...config, appearance: { ...config.appearance, terminalFontSize } })),
  {
    key: 'appearance.editorFontSize',
    entry(config: AppConfig): AgentMuxControlSettingEntry { return {
      key: this.key, kind: 'string', value: String(config.appearance.editorFontSize ?? 'inherit'), default: 'inherit',
      enum: ['inherit', ...Array.from({ length: EDITOR_FONT_SIZE_MAX - EDITOR_FONT_SIZE_MIN + 1 }, (_, index) => String(EDITOR_FONT_SIZE_MIN + index))]
    } },
    apply(config: AppConfig, value: string): AppConfig {
      if (value === 'inherit') {
        if (config.appearance.editorFontSize === undefined) return config
        const appearance = { ...config.appearance }
        delete appearance.editorFontSize
        return { ...config, appearance }
      }
      const next = parseIntegerSettingValue(this.key, value, EDITOR_FONT_SIZE_MIN, EDITOR_FONT_SIZE_MAX)
      if (config.appearance.editorFontSize === next) return config
      return { ...config, appearance: { ...config.appearance, editorFontSize: next } }
    }
  },
] satisfies readonly ScalarSetting[]
