import { createSettingsCatalog } from './settings-catalog'
import { appearanceSettingsModule } from './modules/appearance'
import { notificationsSettingsModule } from './modules/notifications'
import { browserSettingsModule } from './modules/browser'
import { generalSettingsModule } from './modules/general'
import { keyboardShortcutsSettingsModule } from './modules/keyboard-shortcuts'
import { agentsSettingsModule } from './modules/agents'
import { promptsSettingsModule } from './modules/prompts'
import { profileSettingsModule } from './modules/profile'
import { focusSettingsModule } from './modules/focus'
import { hostsSettingsModule } from './modules/hosts'
import { devicesSettingsModule } from './modules/devices'
import { toolkitSettingsModule } from './modules/toolkit'
import { spaceSettingsModule } from './modules/space'
import { goalsSettingsModule } from './modules/goals'

/** The only Renderer composition point. Order is the product's navigation order. */
export const settingsModules = [
  profileSettingsModule,
  appearanceSettingsModule,
  notificationsSettingsModule,
  browserSettingsModule,
  generalSettingsModule,
  keyboardShortcutsSettingsModule,
  spaceSettingsModule,
  focusSettingsModule,
  goalsSettingsModule,
  toolkitSettingsModule,
  agentsSettingsModule,
  promptsSettingsModule,
  hostsSettingsModule,
  devicesSettingsModule
] as const

export type SettingsSectionId = typeof settingsModules[number]['id']
export type SettingsPageId = 'overview' | SettingsSectionId

export const settingsCatalog = createSettingsCatalog(settingsModules)
export const visibleSettingsSections = settingsCatalog.visibleSections
export const settingsNavGroups = settingsCatalog.navGroups
