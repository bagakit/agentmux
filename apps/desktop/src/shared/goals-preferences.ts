import type { GoalsCommonActionsConfig } from './contracts'

/** One default for the original Goals directory, its Settings editor and Main scalar. */
export const DEFAULT_GOALS_COMMON_ACTIONS: GoalsCommonActionsConfig = {
  items: [{ kind: 'builtin', id: 'understand' }, { kind: 'builtin', id: 'ideas' }, { kind: 'builtin', id: 'next' }],
  collapsed: false
}

export function resolveGoalsCommonActions(value: GoalsCommonActionsConfig | undefined): GoalsCommonActionsConfig {
  return value ?? DEFAULT_GOALS_COMMON_ACTIONS
}
