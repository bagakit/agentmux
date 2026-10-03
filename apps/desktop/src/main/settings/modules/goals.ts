import { DEFAULT_GOALS_COMMON_ACTIONS, resolveGoalsCommonActions } from '../../../shared/goals-preferences.js'
import { booleanSetting, type ScalarSetting } from '../scalar-setting.js'

export const goalsSettings = [
  booleanSetting('goalsCommonActions.collapsed', DEFAULT_GOALS_COMMON_ACTIONS.collapsed,
    config => resolveGoalsCommonActions(config.goalsCommonActions).collapsed,
    (config, collapsed) => ({ ...config, goalsCommonActions: { ...resolveGoalsCommonActions(config.goalsCommonActions), collapsed } }))
] satisfies readonly ScalarSetting[]
