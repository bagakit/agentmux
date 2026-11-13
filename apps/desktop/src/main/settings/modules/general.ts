import { DEFAULT_COMPOSER_INPUT_CONFIG, resolveComposerInputConfig, validateComposerInputConfig, type ComposerInputConfig } from '@agentmux/client-ui/composer-input-config'
import type { AgentMuxControlSettingEntry } from '@agentmux/core'
import type { AppConfig } from '../../../shared/contracts.js'
import { PROJECT_RAIL_DENSITY_IDS, PROJECT_RAIL_DENSITY_DEFAULT, MOTE_DIRECTORY_VIEW_IDS, MOTE_DIRECTORY_VIEW_DEFAULT, MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT, MOTE_DIRECTORY_AVATAR_SIZE_MIN, MOTE_DIRECTORY_AVATAR_SIZE_MAX } from '../../../shared/contracts.js'
import { booleanSetting, enumSetting, integerSetting } from '../scalar-setting.js'
import type { ScalarSetting } from '../scalar-setting.js'
import { MESSAGE_TOOL_INITIAL_LAYOUT_IDS, MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT } from '../../../shared/contracts.js'

const completionPrefixes = (['command', 'skill', 'reference'] as const).map(field => ({
  key: `messageToolCompletion.${field}`,
  entry(config: AppConfig): AgentMuxControlSettingEntry {
    return { key: this.key, kind: 'string', value: resolveComposerInputConfig(config.messageToolCompletion)[field] ?? '', default: DEFAULT_COMPOSER_INPUT_CONFIG[field] ?? '' }
  },
  apply(config: AppConfig, value: string): AppConfig {
    if (this.entry(config).value === value) return config
    const messageToolCompletion: ComposerInputConfig = { ...resolveComposerInputConfig(config.messageToolCompletion), [field]: value === '' ? null : value }
    const error = validateComposerInputConfig(messageToolCompletion)
    if (error) throw Object.assign(new Error(`${error} Run amux settings inspect ${this.key} for the current value; an empty string disables this shortcut.`), { code: 'INVALID_SETTING_VALUE' })
    return { ...config, messageToolCompletion }
  }
} satisfies ScalarSetting))

export const generalSettings = [
  ...completionPrefixes,
  booleanSetting('messageToolCompletion.keywords', DEFAULT_COMPOSER_INPUT_CONFIG.keywords,
    config => resolveComposerInputConfig(config.messageToolCompletion).keywords,
    (config, keywords) => ({ ...config, messageToolCompletion: { ...resolveComposerInputConfig(config.messageToolCompletion), keywords } })),
  enumSetting('messageToolInitialLayout', MESSAGE_TOOL_INITIAL_LAYOUT_IDS, MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT,
    config => config.messageToolInitialLayout ?? MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT,
    (config, messageToolInitialLayout) => ({ ...config, messageToolInitialLayout })),
  enumSetting('moteDirectoryView', MOTE_DIRECTORY_VIEW_IDS, MOTE_DIRECTORY_VIEW_DEFAULT,
    config => config.moteDirectoryView ?? MOTE_DIRECTORY_VIEW_DEFAULT,
    (config, moteDirectoryView) => ({ ...config, moteDirectoryView })),
  integerSetting('moteDirectoryAvatarSize', { min: MOTE_DIRECTORY_AVATAR_SIZE_MIN, max: MOTE_DIRECTORY_AVATAR_SIZE_MAX }, MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT,
    config => config.moteDirectoryAvatarSize ?? MOTE_DIRECTORY_AVATAR_SIZE_DEFAULT,
    (config, moteDirectoryAvatarSize) => ({ ...config, moteDirectoryAvatarSize })),
  booleanSetting('copyPathsAsAbsolute', false, (config) => config.copyPathsAsAbsolute === true,
    (config, copyPathsAsAbsolute) => ({ ...config, copyPathsAsAbsolute })),
  enumSetting('projectRailDensity', PROJECT_RAIL_DENSITY_IDS, PROJECT_RAIL_DENSITY_DEFAULT,
    (config) => config.projectRailDensity ?? PROJECT_RAIL_DENSITY_DEFAULT,
    (config, projectRailDensity) => ({ ...config, projectRailDensity })),
  booleanSetting('gitHistoryShowTime', true, config => config.gitHistoryShowTime !== false,
    (config, gitHistoryShowTime) => ({ ...config, gitHistoryShowTime })),
] satisfies readonly ScalarSetting[]
