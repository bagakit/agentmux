import { connectionsSettingsModule } from './modules/connections'
import { createSettingsCatalog } from './settings-catalog'
import { appearanceSettingsModule } from './modules/appearance'
import { notificationsSettingsModule } from './modules/notifications'
import { browserSettingsModule } from './modules/browser'
import { generalSettingsModule } from './modules/general'
import { keyboardShortcutsSettingsModule } from './modules/keyboard-shortcuts'
import { agentsSettingsModule } from './modules/agents'
import { promptsSettingsModule } from './modules/prompts'
import { messageToolSettingsModule } from './modules/message-tool'
import { profileSettingsModule } from './modules/profile'
import { focusSettingsModule } from './modules/focus'
import { hostsSettingsModule } from './modules/hosts'
import { devicesSettingsModule } from './modules/devices'
import { toolkitSettingsModule } from './modules/toolkit'
import { spaceSettingsModule } from './modules/space'
import { goalsSettingsModule } from './modules/goals'
import { moteSettingsModule } from './modules/mote'
import { surveySettingsModule } from './modules/survey'
import { notesSettingsModule } from './modules/notes'

/** The only Renderer composition point. Registration preserves order within each group. */
export const settingsModules = [
  profileSettingsModule,
  appearanceSettingsModule,
  notificationsSettingsModule,
  browserSettingsModule,
  generalSettingsModule,
  keyboardShortcutsSettingsModule,
  messageToolSettingsModule,
  promptsSettingsModule,
  moteSettingsModule,
  spaceSettingsModule,
  focusSettingsModule,
  goalsSettingsModule,
  surveySettingsModule,
  notesSettingsModule,
  toolkitSettingsModule,
  agentsSettingsModule,
  hostsSettingsModule,
  devicesSettingsModule,
  connectionsSettingsModule
] as const

export type SettingsSectionId = typeof settingsModules[number]['id']
export type SettingsPageId = 'overview' | SettingsSectionId

export const settingsCatalog = createSettingsCatalog(settingsModules)
export const visibleSettingsSections = settingsCatalog.visibleSections
export const settingsNavGroups = settingsCatalog.navGroups
