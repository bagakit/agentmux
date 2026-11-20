import { DEFAULT_GOALS_COMMON_ACTIONS, GOALS_VIEW_IDS, GOAL_WORKFLOW_TEMPLATE_IDS, isGoalWorkflowAddressPart, resolveGoalWorkflowPreferences,
  resolveGoalWorkflowReviewer, resolveGoalsCommonActions, resolveGoalsPreferences, type GoalWorkflowPreferences, type GoalWorkflowReviewer } from '@agentmux/host/goals-preferences'
import type { AppConfig } from '../../../shared/contracts.js'
import { booleanSetting, enumSetting, invalid, parseIntegerSettingValue, type ScalarSetting } from '../scalar-setting.js'

const workflowDefaults = resolveGoalWorkflowPreferences()
const readWorkflow = (config: AppConfig) => resolveGoalWorkflowPreferences(config.goals?.workflow)
const writeWorkflow = (config: AppConfig, patch: GoalWorkflowPreferences): AppConfig =>
  ({ ...config, goals: { ...config.goals, workflow: { ...config.goals?.workflow, ...patch } } })

function workflowLimit(field: 'maxConcurrent' | 'maxAttempts'): ScalarSetting {
  const key = `goals.workflow.${field}`
  return {
    key,
    entry: config => ({ key, kind: 'number', value: readWorkflow(config)[field], default: workflowDefaults[field] }),
    apply(config, text) {
      const value = parseIntegerSettingValue(key, text)
      return readWorkflow(config)[field] === value ? config : writeWorkflow(config, { [field]: value })
    }
  }
}

function reviewerValue(config: AppConfig): string {
  const reviewer = resolveGoalWorkflowReviewer(config.goals?.workflow)
  return reviewer ? JSON.stringify(reviewer) : ''
}

function parseReviewer(text: string): GoalWorkflowReviewer {
  const key = 'goals.workflow.reviewer'
  let input: unknown
  try { input = JSON.parse(text) } catch { throw invalid(key, text) }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 3 ||
      !('hostId' in input) || !('runtimeId' in input) || !('sessionId' in input) ||
      !isGoalWorkflowAddressPart(input.hostId) || !isGoalWorkflowAddressPart(input.runtimeId) || !isGoalWorkflowAddressPart(input.sessionId)) throw invalid(key, text)
  return { hostId: input.hostId, runtimeId: input.runtimeId, sessionId: input.sessionId }
}

const workflowReviewer: ScalarSetting = {
  key: 'goals.workflow.reviewer',
  entry: config => ({ key: 'goals.workflow.reviewer', kind: 'string', value: reviewerValue(config), default: '' }),
  apply(config, text) {
    const reviewer = text === '' ? undefined : parseReviewer(text)
    if (reviewerValue(config) === (reviewer ? JSON.stringify(reviewer) : '')) return config
    return writeWorkflow(config, { reviewerHostId: reviewer?.hostId ?? workflowDefaults.reviewerHostId,
      reviewerRuntimeId: reviewer?.runtimeId ?? '', reviewerSessionId: reviewer?.sessionId ?? '' })
  }
}

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
  enumSetting('goals.workflow.template', GOAL_WORKFLOW_TEMPLATE_IDS, workflowDefaults.template,
    config => readWorkflow(config).template, (config, template) => writeWorkflow(config, { template })),
  workflowReviewer,
  workflowLimit('maxConcurrent'),
  workflowLimit('maxAttempts'),
  booleanSetting('goalsCommonActions.collapsed', DEFAULT_GOALS_COMMON_ACTIONS.collapsed,
    config => resolveGoalsCommonActions(config.goalsCommonActions).collapsed,
    (config, collapsed) => ({ ...config, goalsCommonActions: { ...resolveGoalsCommonActions(config.goalsCommonActions), collapsed } }))
] satisfies readonly ScalarSetting[]
