/** Pure original public method metadata; discovery cannot depend on codec loading order. */
export const GOAL_DELEGATION_METHODS = {
  'goal.delegation.prepare': 'long', 'goal.delegation.bind': 'long', 'goal.delegate': 'long',
  'goal.report': 'long', 'goal.collect': 'long', 'goal.delegations': 'long', 'goal.progress': 'long',
  'goal.patrol': 'long', 'goal.patrol.continue': 'long', 'goal.patrol.report': 'long',
  'goal.plan': 'long', 'goal.plan.revise': 'long', 'goal.plan.assignment': 'long', 'goal.plan.claim': 'long', 'goal.plan.review': 'long'
} as const
export type GoalDelegationMethod = keyof typeof GOAL_DELEGATION_METHODS
export function isGoalDelegationMethod(value: string): value is GoalDelegationMethod {
  return Object.hasOwn(GOAL_DELEGATION_METHODS, value)
}
