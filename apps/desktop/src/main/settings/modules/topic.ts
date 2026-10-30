import { TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT, TOPIC_DIRECTORY_INITIAL_VIEW_IDS } from '../../../shared/contracts.js'
import { enumSetting } from '../scalar-setting.js'

/** The original ConfigOwner persists this client presentation default. */
export const topicSettings = [
  enumSetting('topicDirectoryInitialView', TOPIC_DIRECTORY_INITIAL_VIEW_IDS, TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT,
    config => config.topicDirectoryInitialView ?? TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT,
    (config, topicDirectoryInitialView) => ({ ...config, topicDirectoryInitialView }))
]
