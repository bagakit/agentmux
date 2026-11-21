import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { DemandProjection } from './global-demand-board'
import { GOAL_STAGES, goalNextStepFact, type GoalStage } from './goal-presentation'

/** Reading order of the grouped list: what waits on a person first, then work owned by Agents. */
export const GOAL_GROUP_ORDER: readonly GoalStage[] = ['you', 'attention', 'define', 'agents', 'unknown', 'finished']
export const GOAL_GROUP_LABELS: Record<GoalStage, string> = {
  you: 'Needs you', attention: 'Needs attention', define: 'To define', agents: 'With agents', unknown: 'Observation unknown', finished: 'Finished'
}
const SUMMARY: Record<GoalStage, (count: number) => string> = {
  you: count => `${count} need${count === 1 ? 's' : ''} you`, attention: count => `${count} need${count === 1 ? 's' : ''} attention`,
  define: count => `${count} to define`, agents: count => `${count} with agents`, unknown: count => `${count} unknown`, finished: count => `${count} finished`
}
/** One distinct glyph per stage, so the mark still reads without its color. */
export const GOAL_STAGE_ICON_NAMES = {
  you: 'object.user', attention: 'status.warning', define: 'object.idea',
  agents: 'status.working', unknown: 'status.unknown', finished: 'status.completed'
} as const satisfies Record<GoalStage, string>
const STAGE_ICONS = Object.fromEntries(Object.entries(GOAL_STAGE_ICON_NAMES).map(([stage, name]) => [stage, semanticIconComponent(name)])) as
  Record<GoalStage, ReturnType<typeof semanticIconComponent>>
const CancelledIcon = semanticIconComponent('status.disabled')
if (GOAL_GROUP_ORDER.length !== GOAL_STAGES.length) throw new Error('Every Goal stage needs one reading position.')

export type GoalGroup = { stage: GoalStage; goals: DemandProjection[] }

/**
 * One projection of the filtered collection. The acknowledgement failure a person still has to
 * resolve belongs to them, whatever the owner fact says.
 */
export function groupGoals(goals: readonly DemandProjection[], acknowledgementFailed: (id: string) => boolean, retainedStart: (id: string) => unknown = () => undefined): GoalGroup[] {
  const buckets = new Map<GoalStage, DemandProjection[]>()
  for (const goal of goals) {
    const stage = acknowledgementFailed(goal.id) ? 'you' : goalNextStepFact(goal, retainedStart(goal.id)).stage
    const bucket = buckets.get(stage)
    if (bucket) bucket.push(goal)
    else buckets.set(stage, [goal])
  }
  return GOAL_GROUP_ORDER.flatMap(stage => buckets.get(stage)?.length ? [{ stage, goals: buckets.get(stage)! }] : [])
}

export function goalGroupSummary(stage: GoalStage, count: number): string { return SUMMARY[stage](count) }

/** A fixed-width stage glyph; the sentence beside it stays the primary reading. */
export function GoalStageMark({ stage, size = 12, cancelled = false }: { stage: GoalStage; size?: number; cancelled?: boolean }) {
  const Icon = cancelled ? CancelledIcon : STAGE_ICONS[stage]
  return <span className="goal-stage-mark" data-goal-stage={cancelled ? 'cancelled' : stage} aria-hidden="true"><Icon size={size} strokeWidth={1.8} animation="none" /></span>
}
