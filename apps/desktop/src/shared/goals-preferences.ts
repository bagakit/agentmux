import type { GoalsCommonActionsConfig } from './contracts'

export const GOALS_VIEW_IDS = ['list', 'board'] as const
export type GoalsView = typeof GOALS_VIEW_IDS[number]
export type GoalsPreferences = { defaultView?: GoalsView; showFinished?: boolean; requesterAsSupervisor?: boolean }

export function resolveGoalsPreferences(value: GoalsPreferences | undefined): Required<GoalsPreferences> {
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
