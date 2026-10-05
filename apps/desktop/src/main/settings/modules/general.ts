import type { AgentMuxControlSettingEntry } from '@agentmux/core'
import type { AppConfig } from '../../../shared/contracts.js'
import { PROJECT_RAIL_DENSITY_IDS, PROJECT_RAIL_DENSITY_DEFAULT, MOTE_DIRECTORY_VIEW_IDS, MOTE_DIRECTORY_VIEW_DEFAULT, MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT, MOTE_DIRECTORY_AVATAR_SIZE_MIN, MOTE_DIRECTORY_AVATAR_SIZE_MAX } from '../../../shared/contracts.js'
import { booleanSetting, enumSetting, invalid } from '../scalar-setting.js'
import type { ScalarSetting } from '../scalar-setting.js'
import { MESSAGE_TOOL_INITIAL_LAYOUT_IDS, MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT } from '../../../shared/contracts.js'

export const generalSettings = [
  enumSetting('messageToolInitialLayout', MESSAGE_TOOL_INITIAL_LAYOUT_IDS, MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT,
    config => config.messageToolInitialLayout ?? MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT,
    (config, messageToolInitialLayout) => ({ ...config, messageToolInitialLayout })),
  enumSetting('moteDirectoryView', MOTE_DIRECTORY_VIEW_IDS, MOTE_DIRECTORY_VIEW_DEFAULT,
    config => config.moteDirectoryView ?? MOTE_DIRECTORY_VIEW_DEFAULT,
    (config, moteDirectoryView) => ({ ...config, moteDirectoryView })),
  {
    key: 'moteDirectoryAvatarSize',
    entry(config: AppConfig): AgentMuxControlSettingEntry { return {
      key: this.key, kind: 'number', value: config.moteDirectoryAvatarSize ?? MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT,
      default: MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT,
      enum: Array.from({ length: MOTE_DIRECTORY_AVATAR_SIZE_MAX - MOTE_DIRECTORY_AVATAR_SIZE_MIN + 1 }, (_, index) => MOTE_DIRECTORY_AVATAR_SIZE_MIN + index)
    } },
    apply(config: AppConfig, value: string): AppConfig {
      const next = Number(value)
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(next) || next < MOTE_DIRECTORY_AVATAR_SIZE_MIN || next > MOTE_DIRECTORY_AVATAR_SIZE_MAX) throw invalid(this.key, value)
      if (this.entry(config).value === next) return config
      return { ...config, moteDirectoryAvatarSize: next }
    }
  },
  booleanSetting('copyPathsAsAbsolute', false, (config) => config.copyPathsAsAbsolute === true,
    (config, copyPathsAsAbsolute) => ({ ...config, copyPathsAsAbsolute })),
  enumSetting('projectRailDensity', PROJECT_RAIL_DENSITY_IDS, PROJECT_RAIL_DENSITY_DEFAULT,
    (config) => config.projectRailDensity ?? PROJECT_RAIL_DENSITY_DEFAULT,
    (config, projectRailDensity) => ({ ...config, projectRailDensity })),
] satisfies readonly ScalarSetting[]
