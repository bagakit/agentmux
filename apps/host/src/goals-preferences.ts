import type { GoalsCommonActionsConfig } from '@agentmux/core'
export type { GoalsCommonActionRef, GoalsCommonActionsConfig } from '@agentmux/core'

export const GOALS_VIEW_IDS = ['list', 'board'] as const
export type GoalsView = typeof GOALS_VIEW_IDS[number]
export const GOAL_WORKFLOW_TEMPLATE_IDS = ['off', 'execution-review', 'evidence-synthesis'] as const
export type GoalWorkflowTemplateId = typeof GOAL_WORKFLOW_TEMPLATE_IDS[number]
export const GOAL_WORKFLOW_TEMPLATES = {
  off: { title: 'No default template', description: 'Plan each Goal as the work requires.' },
  'execution-review': { title: 'Execution and review', description: 'Deliver the result, run an independent check, and return any required changes to the same ticket.' },
  'evidence-synthesis': { title: 'Evidence and synthesis', description: 'Gather evidence in parallel, check the sources independently, then combine the verified findings.' }
} as const satisfies Record<GoalWorkflowTemplateId, { title: string; description: string }>

export type GoalWorkflowPreferences = {
  template?: GoalWorkflowTemplateId
  reviewerHostId?: string
  reviewerRuntimeId?: string
  reviewerSessionId?: string
  maxConcurrent?: number
  maxAttempts?: number
}
export type ResolvedGoalWorkflowPreferences = Required<GoalWorkflowPreferences>
export type GoalWorkflowReviewer = { hostId: string; runtimeId: string; sessionId: string }
export type ResolvedGoalsPreferences = { defaultView: GoalsView; showFinished: boolean; requesterAsSupervisor: boolean }
export type GoalsPreferences = Partial<ResolvedGoalsPreferences> & { workflow?: GoalWorkflowPreferences }

export function resolveGoalWorkflowPreferences(value?: GoalWorkflowPreferences): ResolvedGoalWorkflowPreferences {
  return { template: value?.template ?? 'off', reviewerHostId: value?.reviewerHostId ?? 'local',
    reviewerRuntimeId: value?.reviewerRuntimeId ?? '', reviewerSessionId: value?.reviewerSessionId ?? '',
    maxConcurrent: value?.maxConcurrent ?? 0, maxAttempts: value?.maxAttempts ?? 0 }
}

export function isGoalWorkflowAddressPart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}

export function resolveGoalWorkflowReviewer(value?: Pick<GoalWorkflowPreferences, 'reviewerHostId' | 'reviewerRuntimeId' | 'reviewerSessionId'>): GoalWorkflowReviewer | undefined {
  const { reviewerHostId, reviewerRuntimeId, reviewerSessionId } = resolveGoalWorkflowPreferences(value)
  if (isGoalWorkflowAddressPart(reviewerHostId) && isGoalWorkflowAddressPart(reviewerRuntimeId) && isGoalWorkflowAddressPart(reviewerSessionId))
    return { hostId: reviewerHostId, runtimeId: reviewerRuntimeId, sessionId: reviewerSessionId }
  return undefined
}

export function resolveGoalsPreferences(value: GoalsPreferences | undefined): ResolvedGoalsPreferences {
  return { defaultView: value?.defaultView ?? 'list', showFinished: value?.showFinished ?? false,
    requesterAsSupervisor: value?.requesterAsSupervisor ?? true }
}

/** One default for the original Goals directory, its Settings editor and Main scalar. */
export const DEFAULT_GOALS_COMMON_ACTIONS: GoalsCommonActionsConfig = {
  items: [{ kind: 'builtin', id: 'understand' }, { kind: 'builtin', id: 'ideas' }, { kind: 'builtin', id: 'next' }],
  collapsed: false
}

export function resolveGoalsCommonActions(value: GoalsCommonActionsConfig | undefined): GoalsCommonActionsConfig {
  return value ?? DEFAULT_GOALS_COMMON_ACTIONS
}
