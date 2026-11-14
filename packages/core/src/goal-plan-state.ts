import type { DemandDelegation } from '@agentmux/demand/delegations'
import { parseGoalPlanState, type GoalPlan, type GoalPlanState } from '@agentmux/demand/goal-plan'

/** A failed read of this non-control derivation never discards the accompanying owner facts. */
export function parseOwnerGoalPlanState(value: unknown, plan: GoalPlan | undefined, delegations: readonly DemandDelegation[], issue?: unknown):
  { planState?: GoalPlanState; planStateIssue?: string } {
  const recovery = 'Read this Goal again; update its Host if the state remains unavailable. The plan, original delegations and saved operations are retained.'
  // A normalized result can cross more than one public codec. Keep its original diagnostic.
  if (value === undefined) return typeof issue === 'string' && issue.trim() ? { planStateIssue: issue }
    : plan ? { planStateIssue: `Node states are unavailable: this Goal's owner returned no derivation. ${recovery}` } : {}
  if (!plan) return { planStateIssue: `Node states are unavailable: the Goal owner returned them without a plan. ${recovery}` }
  try { return { planState: parseGoalPlanState(value, plan, delegations) } }
  catch (error) { return { planStateIssue: `Node states are unavailable: the Goal owner's derivation does not describe its plan and delegations: ${error instanceof Error ? error.message : String(error)}. ${recovery}` } }
}
