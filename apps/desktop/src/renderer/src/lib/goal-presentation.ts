import { alignmentConfirmationIssue, groundingAcceptanceIssue, isDemandEvidenceReference, isCurrentGroundingAccepted } from '@agentmux/demand/goals'
import type { DemandRecord } from './global-demand-board'
import { goalDelegationNextRow, type GoalDelegationRow } from './goal-delegation-presentation'
import { goalStartNextRow, type GoalStartRow } from './goal-start-presentation'

/**
 * Whose turn a Goal is, for grouping and marking the list. Reading projection only: it
 * authorizes no confirmation, acceptance, input or recovery.
 * - define: the target still needs shaping in discussion
 * - you: a person's confirmation or result review is the next step
 * - agents: an Agent owns the next step and nothing is known to be wrong
 * - attention: something stopped, is stale or unverified and needs a decision
 * - unknown: the original observation is missing; nothing is inferred
 * - finished: the current result was accepted
 */
export const GOAL_STAGES = ['you', 'attention', 'define', 'agents', 'unknown', 'finished'] as const
export type GoalStage = (typeof GOAL_STAGES)[number]
export type GoalNextStepFact = { stage: GoalStage; text: string }
type GoalNextStepInput = Pick<DemandRecord, 'alignment' | 'grounding' | 'status' | 'delegations' | 'delegationObservations' | 'delegationObservationIssue' | 'dispatches' | 'startObservations'>

const DELEGATION_STAGE: Record<GoalDelegationRow['state'], GoalStage> = {
  // A worker report is collected and verified by the Supervisor Agent before a person reviews it.
  report: 'agents', collected: 'agents', working: 'agents', accepted: 'finished',
  question: 'attention', exited: 'attention', unknown: 'unknown'
}
const START_STAGE: Record<GoalStartRow['state'], GoalStage> = { review: 'attention', continuation: 'attention', working: 'agents', unknown: 'unknown' }

/** Display the owner facts. Business status is not an acknowledgement. */
export function goalNextStep(demand: GoalNextStepInput): string {
  return goalNextStepFact(demand).text
}

/** One branch decides both the sentence and its stage, so they cannot drift apart. */
export function goalNextStepFact(demand: GoalNextStepInput): GoalNextStepFact {
  const { alignment, grounding } = demand
  if (isCurrentGroundingAccepted(alignment, grounding)) {
    const result = grounding!.checks.some(check => check.outcome === 'gap') ? 'Accepted with gaps' : 'Accepted'
    return { stage: 'finished', text: demand.status === 'done' ? `${result} · Finished` : result }
  }
  if (demand.status === 'done' && !grounding) return { stage: 'attention', text: 'Results not verified' }
  if (demand.status !== 'done') {
    const delegated = goalDelegationNextRow(demand)
    if (delegated) return { stage: DELEGATION_STAGE[delegated.state], text: delegated.next }
    const start = goalStartNextRow(demand)
    if (start) return { stage: START_STAGE[start.state], text: start.next }
  }
  if (!alignment) return { stage: 'define', text: 'Goal needs an outline' }
  if (alignmentConfirmationIssue(alignment)) return { stage: 'define', text: alignment.openQuestions.length ? 'Decision needed' : 'Success criteria needed' }
  if (alignment.confirmedAt === null) return { stage: 'you', text: 'Goal ready for confirmation' }
  if (!grounding) return { stage: 'agents', text: 'Goal agreed · No result report' }
  if (grounding.alignmentRevision !== alignment.revision) return { stage: 'attention', text: 'Results need updating' }
  const gapsAllowed = groundingAcceptanceIssue(alignment, grounding, true) === null
  const hasGaps = grounding.checks.some(check => check.outcome === 'gap')
  if (gapsAllowed) return { stage: 'you', text: hasGaps ? 'Results have known gaps' : 'Results ready for review' }
  return { stage: 'attention', text: 'Results need checking' }
}

/** Short reading feedback only. Acceptance authority remains in the domain validator. */
export function goalResultExplanation(demand: Pick<DemandRecord, 'alignment' | 'grounding'>): string | null {
  const { alignment, grounding } = demand
  if (!grounding || groundingAcceptanceIssue(alignment, grounding) === null) return null
  if (!alignment || alignment.criteria.length === 0) return 'Define the goal and success criteria before accepting this report.'
  if (!alignment.confirmedAt) return 'Confirm the current goal before accepting these results.'
  if (grounding.alignmentRevision !== alignment.revision) return 'This report needs checking against the current goal.'
  const checks = new Map(grounding.checks.map(check => [check.criterionId, check]))
  if (checks.size !== alignment.criteria.length || alignment.criteria.some(criterion => !checks.has(criterion.id))) return 'Some success criteria have no matching result check.'
  if (grounding.checks.some(check => check.outcome === 'unknown')) return 'Some results are still unknown.'
  if (grounding.checks.some(check => !check.evidence.length || check.evidence.some(reference => !isDemandEvidenceReference(reference)))) return 'Some checks are missing locatable evidence.'
  if (grounding.checks.some(check => check.outcome === 'gap' && !check.note.trim())) return 'A reported gap still needs an explanation.'
  if (grounding.checks.some(check => check.outcome === 'gap')) return 'Gaps remain. Accepting this result keeps those gaps in the record.'
  return 'These results are not ready to accept.'
}
