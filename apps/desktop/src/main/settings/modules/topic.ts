import { TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT, TOPIC_DIRECTORY_INITIAL_VIEW_IDS } from '../../../shared/contracts.js'
import { booleanSetting, enumSetting } from '../scalar-setting.js'

/** The original ConfigOwner persists this client presentation default. */
export const topicSettings = [
  booleanSetting('promotion.enabled', true, config => config.promotion?.enabled ?? true,
    (config, enabled) => ({ ...config, promotion: { ...config.promotion, enabled } })),
  enumSetting('topicDirectoryInitialView', TOPIC_DIRECTORY_INITIAL_VIEW_IDS, TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT,
    config => config.topicDirectoryInitialView ?? TOPIC_DIRECTORY_INITIAL_VIEW_DEFAULT,
    (config, topicDirectoryInitialView) => ({ ...config, topicDirectoryInitialView }))
]
