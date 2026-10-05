import { DEFAULT_GOALS_COMMON_ACTIONS, GOALS_VIEW_IDS, resolveGoalsCommonActions, resolveGoalsPreferences } from '../../../shared/goals-preferences.js'
import { booleanSetting, enumSetting, type ScalarSetting } from '../scalar-setting.js'

export const goalsSettings = [
  enumSetting('goals.defaultView', GOALS_VIEW_IDS, resolveGoalsPreferences(undefined).defaultView,
    config => resolveGoalsPreferences(config.goals).defaultView,
    (config, defaultView) => ({ ...config, goals: { ...config.goals, defaultView } })),
  booleanSetting('goals.showFinished', resolveGoalsPreferences(undefined).showFinished,
    config => resolveGoalsPreferences(config.goals).showFinished,
    (config, showFinished) => ({ ...config, goals: { ...config.goals, showFinished } })),
  booleanSetting('goals.requesterAsSupervisor', resolveGoalsPreferences(undefined).requesterAsSupervisor,
    config => resolveGoalsPreferences(config.goals).requesterAsSupervisor,
    (config, requesterAsSupervisor) => ({ ...config, goals: { ...config.goals, requesterAsSupervisor } })),
  booleanSetting('goalsCommonActions.collapsed', DEFAULT_GOALS_COMMON_ACTIONS.collapsed,
    config => resolveGoalsCommonActions(config.goalsCommonActions).collapsed,
    (config, collapsed) => ({ ...config, goalsCommonActions: { ...resolveGoalsCommonActions(config.goalsCommonActions), collapsed } }))
] satisfies readonly ScalarSetting[]
