import { larkSettingsModule } from './modules/lark'
import { createSettingsCatalog } from './settings-catalog'
import { appearanceSettingsModule } from './modules/appearance'
import { notificationsSettingsModule } from './modules/notifications'
import { browserSettingsModule } from './modules/browser'
import { browserAgentControlSettingsModule } from './modules/browser-agent-control'
import { generalSettingsModule } from './modules/general'
import { keyboardShortcutsSettingsModule } from './modules/keyboard-shortcuts'
import { agentsSettingsModule } from './modules/agents'
import { promptsSettingsModule } from './modules/prompts'
import { messageToolSettingsModule } from './modules/message-tool'
import { a2aSettingsModule } from './modules/a2a'
import { automationSettingsModule } from './modules/automation'
import { amuxProtocolsSettingsModule } from './modules/amux-protocols'
import { profileSettingsModule } from './modules/profile'
import { focusSettingsModule } from './modules/focus'
import { hostsSettingsModule } from './modules/hosts'
import { mobileSettingsModule } from './modules/mobile'
import { inappConversationSettingsModule } from './modules/inapp-conversation'
import { toolkitSettingsModule } from './modules/toolkit'
import { spaceSettingsModule } from './modules/space'
import { goalsSettingsModule } from './modules/goals'
import { moteSettingsModule } from './modules/mote'
import { surveySettingsModule } from './modules/survey'
import { notesSettingsModule } from './modules/notes'
import { continuitySettingsModule } from './modules/continuity'

/** The only Renderer composition point. Registration preserves order within each group. */
export const settingsModules = [
  profileSettingsModule,
  appearanceSettingsModule,
  notificationsSettingsModule,
  continuitySettingsModule,
  browserSettingsModule,
  browserAgentControlSettingsModule,
  generalSettingsModule,
  keyboardShortcutsSettingsModule,
  messageToolSettingsModule,
  a2aSettingsModule,
  automationSettingsModule,
  promptsSettingsModule,
  amuxProtocolsSettingsModule,
  moteSettingsModule,
  spaceSettingsModule,
  focusSettingsModule,
  goalsSettingsModule,
  surveySettingsModule,
  notesSettingsModule,
  toolkitSettingsModule,
  agentsSettingsModule,
  hostsSettingsModule,
  mobileSettingsModule,
  inappConversationSettingsModule,
  larkSettingsModule
] as const

export type SettingsSectionId = typeof settingsModules[number]['id']
export type SettingsPageId = 'overview' | SettingsSectionId

export const settingsCatalog = createSettingsCatalog(settingsModules)
export const visibleSettingsSections = settingsCatalog.visibleSections
export const settingsNavGroups = settingsCatalog.navGroups
