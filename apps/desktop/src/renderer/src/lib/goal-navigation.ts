import type { GoalGroup } from './goal-groups'
import type { GoalStage } from './goal-presentation'
import type { GoalFiniteStartIntent } from './goal-finite-start'

/** Read only the collection's retained inputs, once per actual input-map revision. */
export function createGoalRetainedStartsSelector(goals: readonly { id: string }[]) {
  type Intents = Readonly<Record<string, GoalFiniteStartIntent>>
  let observed: Intents | undefined
  let selected: Record<string, GoalFiniteStartIntent> = {}
  return (state: { goalFiniteStartIntents: Intents }): Record<string, GoalFiniteStartIntent> => {
    if (state.goalFiniteStartIntents === observed) return selected
    observed = state.goalFiniteStartIntents
    selected = {}
    for (const { id } of goals) {
      const intent = observed[id]
      if (intent) selected[id] = intent
    }
    return selected
  }
}

/**
 * Movement through the Goals list follows the grouped order exactly as it is shown. These read
 * only that projection: no store, no subscription, and no fact beyond what the list already shows.
 */
export function adjacentGoalId(groups: readonly GoalGroup[], currentId: string | null, step: 1 | -1): string | null {
  const ids = groups.flatMap(group => group.goals.map(goal => goal.id))
  if (!ids.length) return null
  if (currentId === null) return step > 0 ? ids[0]! : ids.at(-1)!
  const index = ids.indexOf(currentId)
  if (index < 0) return null
  return ids[index + step] ?? null
}

export type GoalQueuePosition = { stage: GoalStage; index: number; total: number; nextId: string | null }

/** Where a Goal sits within its own group, and which Goal waits after it in that same group. */
export function goalQueuePosition(groups: readonly GoalGroup[], id: string): GoalQueuePosition | null {
  for (const group of groups) {
    const index = group.goals.findIndex(goal => goal.id === id)
    if (index >= 0) return { stage: group.stage, index: index + 1, total: group.goals.length, nextId: group.goals[index + 1]?.id ?? null }
  }
  return null
}

/** Goals that were already shown and now sit in another group. New or first-shown Goals never count. */
export function stageTransitions(previous: ReadonlyMap<string, GoalStage>, groups: readonly GoalGroup[]): Set<string> {
  const moved = new Set<string>()
  for (const group of groups) for (const goal of group.goals) {
    const before = previous.get(goal.id)
    if (before !== undefined && before !== group.stage) moved.add(goal.id)
  }
  return moved
}

export function stageIndex(groups: readonly GoalGroup[]): Map<string, GoalStage> {
  return new Map(groups.flatMap(group => group.goals.map(goal => [goal.id, group.stage] as const)))
}
