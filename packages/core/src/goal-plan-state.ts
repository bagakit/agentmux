import type { DemandDelegation } from '@agentmux/demand/delegations'
import { parseGoalPlanState, type GoalPlan, type GoalPlanState } from '@agentmux/demand/goal-plan'
import { AgentMuxError } from './errors.js'

/**
 * The Goal owner's derivation of the plan it returns. A reader keeps the owner's rules, which
 * another version may not share. A state without its plan, or one that describes another plan or
 * other delegations, violates this result even though a write in the same request may be saved.
 */
export function parseOwnerGoalPlanState(value: unknown, plan: GoalPlan | undefined, delegations: readonly DemandDelegation[]): GoalPlanState | undefined {
  if (value === undefined) return undefined
  const refused = (issue: string) => new AgentMuxError(`The Goal owner returned a plan state that ${issue}. `
    + 'A write in this request may already be saved by the owner; read the Goal again instead of repeating the write.', 'CONTROL_PROTOCOL_ERROR')
  if (!plan) throw refused('comes without its plan')
  try { return parseGoalPlanState(value, plan, delegations) }
  catch (error) { throw refused(`does not describe its plan and delegations: ${error instanceof Error ? error.message : String(error)}`) }
}
