import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { GoalPlanNodeState, GoalPlanUnknownReason } from '@agentmux/demand/goal-plan'

export type GoalPlanNodePresentation = {
  state: GoalPlanNodeState | null
  unknown: GoalPlanUnknownReason[]
  wholeGoal?: { conclusion: string; assignees: number }
}

/** One distinct glyph per node state, so a node still reads without its color. */
const STATE_ICON_NAMES = {
  waiting: 'status.queued', ready: 'action.start', working: 'status.working', review: 'action.review-source',
  changes: 'status.gap', done: 'status.completed', cancelled: 'status.disabled', unknown: 'status.unknown'
} as const satisfies Record<GoalPlanNodeState, string>
const STATE_ICONS = Object.fromEntries(Object.entries(STATE_ICON_NAMES).map(([state, name]) => [state, semanticIconComponent(name)])) as
  Record<GoalPlanNodeState, ReturnType<typeof semanticIconComponent>>
const GOAL_PLAN_STATE_LABELS: Record<Exclude<GoalPlanNodeState, 'unknown'>, string> = {
  waiting: 'Waiting on dependencies', ready: 'Ready to start', working: 'In progress', review: 'Awaiting review',
  changes: 'Changes requested', done: 'Done', cancelled: 'Cancelled'
}
const UNKNOWN_LABELS: Record<GoalPlanUnknownReason, string> = { criteria: 'Criteria need review', 'dispatch-link': 'Delivery unconfirmed', predecessors: 'Predecessor evidence changed', 'completion-proof': 'Signed completion unavailable' }

const ThemeObjectGoalIcon = semanticIconComponent('object.goal')

/** An unknown node names every reason it needs reconciliation; other states read as themselves. */
export function goalPlanStateLabel(item: GoalPlanNodePresentation): string {
  if (item.wholeGoal) return item.wholeGoal.conclusion
  return item.state === null ? 'State unavailable' : item.state === 'unknown' ? item.unknown.map(reason => UNKNOWN_LABELS[reason]).join(' · ') : GOAL_PLAN_STATE_LABELS[item.state]
}

export function GoalPlanMark({ item }: { item: Pick<GoalPlanNodePresentation, 'state' | 'wholeGoal'> }) {
  const Icon = item.wholeGoal ? ThemeObjectGoalIcon : STATE_ICONS[item.state ?? 'unknown']
  return <span className="goal-plan-node__mark" data-goal-plan-state={item.wholeGoal ? 'goal' : item.state ?? 'unavailable'} aria-hidden="true"><Icon size={12} strokeWidth={1.8} animation="none" /></span>
}
