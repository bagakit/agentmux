import { appearanceSettings } from './modules/appearance.js'
import { generalSettings } from './modules/general.js'
import { notificationsSettings } from './modules/notifications.js'
import { a2aSettings } from './modules/a2a.js'
import { browserSettings } from './modules/browser.js'
import { toolkitSettings } from './modules/toolkit.js'
import { profileSettings } from './modules/profile.js'
import { focusSettings } from './modules/focus.js'
import { focusMapSettings } from './modules/focus-map.js'
import { goalsSettings } from './modules/goals.js'
import { notesSettings, notesDirectorySetting } from './modules/notes.js'
import { markdownSettings } from './modules/markdown.js'
import { topicSettings } from './modules/topic.js'
import { continuitySettings } from './modules/continuity.js'
import { automationSettings } from './modules/automation.js'
import type { AppConfig } from '../../shared/contracts.js'
import type { NotesStorageOwner } from '../notes-storage-owner.js'

export const ownedSettings = (notes?: Pick<NotesStorageOwner, 'inspect' | 'change'>) => notes ? [notesDirectorySetting(notes)] : []

/** The only Main scalar composition point; the existing ConfigOwner performs every write. */
export const scalarSettings = (config: AppConfig) => [
  ...profileSettings,
  ...focusSettings,
  ...focusMapSettings(config),
  ...goalsSettings,
  ...notesSettings,
  ...markdownSettings,
  ...topicSettings,
  ...continuitySettings,
  ...automationSettings,
  ...a2aSettings,
  ...appearanceSettings,
  ...generalSettings,
  ...notificationsSettings,
  ...browserSettings,
  ...toolkitSettings
]
