import { telegramSettingsModule } from './modules/telegram'
import { discordSettingsModule } from './modules/discord'
import { larkSettingsModule } from './modules/lark'
import { createSettingsCatalog } from './settings-catalog'
import { appearanceSettingsModule } from './modules/appearance'
import { notificationsSettingsModule } from './modules/notifications'
import { browserSettingsModule } from './modules/browser'
import { browserProfilesSettingsModule } from './modules/browser-profiles'
import { capsuleSettingsModule } from './modules/capsule'
import { browserAgentControlSettingsModule } from './modules/browser-agent-control'
import { generalSettingsModule } from './modules/general'
import { keyboardShortcutsSettingsModule } from './modules/keyboard-shortcuts'
import { agentsSettingsModule } from './modules/agents'
import { promptsSettingsModule } from './modules/prompts'
import { messageToolSettingsModule } from './modules/message-tool'
import { a2aSettingsModule } from './modules/a2a'
import { automationSettingsModule } from './modules/automation'
import { profileSettingsModule } from './modules/profile'
import { focusSettingsModule } from './modules/focus'
import { networkNodeSettingsModule } from './modules/network-node'
import { hostsSettingsModule } from './modules/hosts'
import { remoteExecutionSettingsModule } from './modules/remote-execution'
import { mobileSettingsModule } from './modules/mobile'
import { inappConversationSettingsModule } from './modules/inapp-conversation'
import { toolkitSettingsModule } from './modules/toolkit'
import { spaceSettingsModule } from './modules/space'
import { goalsSettingsModule } from './modules/goals'
import { topicSettingsModule, motePromotionSettingsModule } from './modules/topic'
import { moteSettingsModule } from './modules/mote'
import { surveySettingsModule } from './modules/survey'
import { notesSettingsModule } from './modules/notes'
import { continuitySettingsModule } from './modules/continuity'
import { derivedActionsSettingsModule } from './modules/derived-actions'

/** The only Renderer composition point. Registration preserves order within each group. */
export const settingsModules = [
  profileSettingsModule,
  appearanceSettingsModule,
  notificationsSettingsModule,
  agentsSettingsModule,
  derivedActionsSettingsModule,
  continuitySettingsModule,
  browserSettingsModule,
  browserProfilesSettingsModule,
  capsuleSettingsModule,
  browserAgentControlSettingsModule,
  generalSettingsModule,
  keyboardShortcutsSettingsModule,
  messageToolSettingsModule,
  a2aSettingsModule,
  automationSettingsModule,
  promptsSettingsModule,
  moteSettingsModule,
  motePromotionSettingsModule,
  spaceSettingsModule,
  focusSettingsModule,
  goalsSettingsModule,
  topicSettingsModule,
  surveySettingsModule,
  notesSettingsModule,
  toolkitSettingsModule,
  networkNodeSettingsModule,
  hostsSettingsModule,
  remoteExecutionSettingsModule,
  mobileSettingsModule,
  inappConversationSettingsModule,
  larkSettingsModule,
  discordSettingsModule,
  telegramSettingsModule
] as const

export type SettingsSectionId = typeof settingsModules[number]['id']
export type SettingsPageId = 'overview' | SettingsSectionId

export const settingsCatalog = createSettingsCatalog(settingsModules)
export const visibleSettingsSections = settingsCatalog.visibleSections
export const settingsNavGroups = settingsCatalog.navGroups
