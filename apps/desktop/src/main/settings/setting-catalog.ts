import { appearanceSettings } from './modules/appearance.js'
import { generalSettings } from './modules/general.js'
import { notificationsSettings } from './modules/notifications.js'
import { browserSettings } from './modules/browser.js'
import { toolkitSettings } from './modules/toolkit.js'
import { profileSettings } from './modules/profile.js'
import { focusSettings } from './modules/focus.js'
import { goalsSettings } from './modules/goals.js'

/** The only Main scalar composition point; the existing ConfigOwner performs every write. */
export const scalarSettings = [
  ...profileSettings,
  ...focusSettings,
  ...goalsSettings,
  ...appearanceSettings,
  ...generalSettings,
  ...notificationsSettings,
  ...browserSettings,
  ...toolkitSettings
]
