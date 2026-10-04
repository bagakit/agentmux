import { appearanceSettings } from './modules/appearance.js'
import { generalSettings } from './modules/general.js'
import { notificationsSettings } from './modules/notifications.js'
import { browserSettings } from './modules/browser.js'
import { toolkitSettings } from './modules/toolkit.js'

/** The only Main scalar composition point; the existing ConfigOwner performs every write. */
export const scalarSettings = [
  ...appearanceSettings,
  ...generalSettings,
  ...notificationsSettings,
  ...browserSettings,
  ...toolkitSettings
]
