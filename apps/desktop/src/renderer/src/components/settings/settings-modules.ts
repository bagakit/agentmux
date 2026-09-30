import { createSettingsCatalog } from './settings-catalog'
import { appearanceSettingsModule } from './modules/appearance'
import { notificationsSettingsModule } from './modules/notifications'
import { browserSettingsModule } from './modules/browser'
import { generalSettingsModule } from './modules/general'
import { keyboardShortcutsSettingsModule } from './modules/keyboard-shortcuts'
import { agentsSettingsModule } from './modules/agents'
import { promptsSettingsModule } from './modules/prompts'
import { workspacesSettingsModule } from './modules/workspaces'
import { hostsSettingsModule } from './modules/hosts'
import { toolkitSettingsModule } from './modules/toolkit'

/** The only Renderer composition point. Order is the product's navigation order. */
export const settingsModules = [
  appearanceSettingsModule,
  notificationsSettingsModule,
  browserSettingsModule,
  generalSettingsModule,
  keyboardShortcutsSettingsModule,
  toolkitSettingsModule,
  agentsSettingsModule,
  promptsSettingsModule,
  workspacesSettingsModule,
  hostsSettingsModule
] as const

export type SettingsSectionId = typeof settingsModules[number]['id']
export type SettingsPageId = 'overview' | SettingsSectionId

export const settingsCatalog = createSettingsCatalog(settingsModules)
export const visibleSettingsSections = settingsCatalog.visibleSections
export const settingsNavGroups = settingsCatalog.navGroups
