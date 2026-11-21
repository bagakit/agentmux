import { demandAgentReferenceKey } from '@agentmux/demand/relations'
import type { DemandSpaceMemberReference } from '@agentmux/demand/relations'
import { alignmentConfirmationIssue, goalPlanReviewState, groundingAcceptanceIssue, isDemandEvidenceReference, isCurrentGroundingAccepted } from '@agentmux/demand/goals'
import { delegationWorkerHostId } from '@agentmux/demand/delegations'
import type { DemandRecord } from './global-demand-board'
import { goalDelegationNextRow, type GoalDelegationRow } from './goal-delegation-presentation'
import { readGoalFiniteStartIntent } from './goal-finite-start'
import { goalStartNextRow, type GoalStartRow } from './goal-start-presentation'

/**
 * Whose turn a Goal is, for grouping and marking the list. Reading projection only: it
 * authorizes no confirmation, acceptance, input or recovery.
 * - define: the target still needs shaping in discussion
 * - you: a person's confirmation or result review is the next step
 * - agents: an Agent owns the next step and nothing is known to be wrong
 * - attention: something stopped, is stale or unverified and needs a decision
 * - unknown: the original observation is missing; nothing is inferred
 * - finished: the current result was accepted, or work was cancelled
 */
export const GOAL_STAGES = ['you', 'attention', 'define', 'agents', 'unknown', 'finished'] as const
export type GoalStage = (typeof GOAL_STAGES)[number]
export type GoalNextStepSource =
  | { kind: 'definition'; revision: number | null }
  | { kind: 'results'; submissionId: string | null; revision: number | null }
  | ({ kind: 'start'; operationId: string; runId?: string } & ({ hostId?: string; agentSessionId: string; agentReference?: never } | { agentReference: DemandSpaceMemberReference; hostId?: never; agentSessionId?: never }))
  | { kind: 'delegation'; operationId: string; sourceMessageId: string; hostId: string; agentSessionId: string; runId: string; replyMessageId?: string }
  | { kind: 'patrol'; operationId: string }
  | { kind: 'goal' }
export type GoalNextStepFact = { stage: GoalStage; text: string; source: GoalNextStepSource }
type GoalNextStepInput = Pick<DemandRecord, 'id' | 'alignment' | 'grounding' | 'status' | 'delegations' | 'delegationObservations' | 'delegationObservationIssue' | 'dispatches' | 'startObservations' | 'patrols' | 'patrolObservations' | 'plan' | 'planState'>

const DELEGATION_STAGE: Record<GoalDelegationRow['state'], GoalStage> = {
  // A worker report is collected and verified by the Supervisor Agent before a person reviews it.
  report: 'agents', collected: 'agents', changes: 'agents', working: 'agents', accepted: 'finished',
  question: 'attention', exited: 'attention', unknown: 'unknown'
}
const START_STAGE: Record<GoalStartRow['state'], GoalStage> = { review: 'attention', continuation: 'attention', working: 'agents', unknown: 'unknown', requested: 'attention', rejected: 'attention' }
function retainedGoalInputHere(value: unknown, goalId: string): boolean {
  if (value === undefined) return false
  if (value && typeof value === 'object' && 'goalId' in value && typeof value.goalId === 'string' && value.goalId !== goalId &&
      readGoalFiniteStartIntent(value, value.goalId)) return false
  return true
}

/** Reading budget only; these retained objects do not grant input or completion. */
export function goalHasOriginalWork(demand: Pick<DemandRecord, 'id' | 'dispatches' | 'delegations' | 'patrols' | 'responsibility'>, retainedStart?: unknown): boolean {
  return Boolean(demand.dispatches?.some(item => item.execution === 'finite') || demand.delegations?.length ||
    readGoalFiniteStartIntent(retainedStart, demand.id)?.phase !== 'selecting-access' && retainedGoalInputHere(retainedStart, demand.id) ||
    demand.patrols?.some(item => item.purpose === undefined) || demand.responsibility?.executions.length)
}

/** Display the owner facts. Business status is not an acknowledgement. */
export function goalNextStep(demand: GoalNextStepInput): string {
  return goalNextStepFact(demand).text
}

/** One branch decides both the sentence and its stage, so they cannot drift apart. */
export function goalNextStepFact(demand: GoalNextStepInput, retainedInput?: unknown): GoalNextStepFact {
  const retained = readGoalFiniteStartIntent(retainedInput, demand.id)
  const retainedStart = retained?.phase === 'selecting-access' ? undefined : retained
  const { alignment, grounding } = demand
  const planReview = goalPlanReviewState(demand.planState, alignment, grounding)
  const resultSource: GoalNextStepSource = { kind: 'results', submissionId: grounding?.submissionId ?? null, revision: alignment?.revision ?? null }
  const definitionSource: GoalNextStepSource = { kind: 'definition', revision: alignment?.revision ?? null }
  if (demand.status === 'cancelled') return { stage: 'finished', text: 'Cancelled', source: { kind: 'goal' } }
  if (planReview ? planReview === 'accepted' : isCurrentGroundingAccepted(alignment, grounding)) {
    const result = grounding!.checks.some(check => check.outcome === 'gap') ? 'Accepted with gaps' : 'Accepted'
    return { stage: 'finished', text: demand.status === 'done' ? `${result} · Finished` : result, source: resultSource }
  }
  if (demand.status === 'done' && !grounding) return { stage: 'attention', text: 'Marked done · No verification report', source: resultSource }
  if (demand.status !== 'done') {
    if (retained?.phase === 'selecting-access') return { stage: 'attention', text: 'Choose task connections · No task submitted', source: { kind: 'goal' } }
    if (retainedGoalInputHere(retainedInput, demand.id) && !retained) return { stage: 'unknown', text: 'Original task input unreadable · Retained', source: { kind: 'goal' } }
    const currentStart = goalStartNextRow(demand)
    const retainedReference = retainedStart?.agentReference
    const retainedRecord = retainedReference && demand.dispatches?.find(value => value.operationId === retainedStart?.operationId &&
      'target' in value && demandAgentReferenceKey(value.target) === demandAgentReferenceKey(retainedReference))
    const businessRequest = retainedRecord?.stage === 'requested' && retainedRecord.request.goalUpdatedAt === retainedStart?.expectedUpdatedAt
    const businessRejection = retainedRecord?.stage === 'rejected' && retainedRecord.expectedUpdatedAt === retainedStart?.expectedUpdatedAt
    const historicalRejection = businessRejection && currentStart?.start.operationId !== retainedRecord.operationId
    if ((businessRequest || businessRejection && !historicalRejection) && retainedStart?.agentReference)
      return { stage: 'attention', text: businessRequest ? 'Task saved before input preparation · Continue the original request' : 'Task request rejected · Review before preparing a current task',
        source: { kind: 'start', operationId: retainedStart.operationId, agentReference: retainedStart.agentReference } }
    if (retainedStart && !historicalRejection && retainedStart.goalId === demand.id && !demand.dispatches?.some(start => start.operationId === retainedStart.operationId && start.stage === 'confirmed'))
      return { stage: retainedStart.phase === 'not-attempted' ? 'attention' : 'unknown',
        text: retainedStart.phase === 'not-attempted' ? 'Original task retained · Not submitted' : 'Original task input unconfirmed',
        source: { kind: 'start', operationId: retainedStart.operationId, ...(retainedStart.agentReference ? { agentReference: retainedStart.agentReference } : { agentSessionId: retainedStart.sessionId }) } }
    const patrols = demand.patrols ?? []
    let patrol: (typeof patrols)[number] | undefined
    for (let index = patrols.length - 1; index >= 0; index--) {
      const candidate = patrols[index]!
      if (candidate.purpose !== undefined) continue
      patrol = candidate
      break
    }
    const observed = patrol && demand.patrolObservations?.find(item => item.operationId === patrol.operationId)
    if (!planReview && patrol && !patrol.report && observed && observed.state !== 'stale' && observed.state !== 'reported' && observed.state !== 'planned') {
      const text = { unknown: 'Original inspection input unconfirmed', missing: 'Inspection saved · Not delivered',
        prepared: 'Inspection prepared · Awaiting input', delivered: 'Inspection delivered · Awaiting report' }[observed.state]
      return { stage: observed.state === 'unknown' ? 'unknown' : observed.state === 'missing' ? 'attention' : 'agents', text,
        source: { kind: 'patrol', operationId: patrol.operationId } }
    }
    const delegated = goalDelegationNextRow(demand)
    if (delegated) return { stage: DELEGATION_STAGE[delegated.state], text: delegated.next, source: { kind: 'delegation', operationId: delegated.delegation.operationId, sourceMessageId: delegated.delegation.sourceMessageId, hostId: delegationWorkerHostId(delegated.delegation), agentSessionId: delegated.delegation.workerAgentSessionId, runId: delegated.delegation.workerRunId, ...(delegated.replyMessageId ? { replyMessageId: delegated.replyMessageId } : {}) } }
    const start = currentStart
    if (start) return { stage: START_STAGE[start.state], text: start.next, source: { kind: 'start', operationId: start.start.operationId, ...('target' in start.start ? { agentReference: start.start.target } : { hostId: start.start.hostId, agentSessionId: start.start.agentSessionId }), ...(start.start.runId === undefined ? {} : { runId: start.start.runId }) } }
  }
  if (!alignment) return { stage: 'define', text: 'Goal needs an outline', source: definitionSource }
  if (alignmentConfirmationIssue(alignment)) return { stage: 'define', text: alignment.openQuestions.length ? 'Decision needed' : 'Success criteria needed', source: definitionSource }
  if (alignment.confirmedAt === null) return demand.supervisorSessionId
    ? { stage: 'agents', text: 'Supervisor can confirm the goal', source: definitionSource }
    : { stage: 'you', text: 'Goal ready for confirmation', source: definitionSource }
  if (!grounding) {
    const { planState } = demand
    let text = 'Goal agreed · No result report'
    if (planState) {
      if (planReview === 'awaiting-report') text = 'Plan complete · Awaiting result report'
      else {
        const ready = planState.nodes.find(node => node.state === 'ready')
        const nextTicket = ready && demand.plan?.nodes.find(node => node.id === ready.id)
        if (nextTicket) text = nextTicket.claimOpen ? 'Waiting for an Agent to claim a Ticket'
          : nextTicket.executor ? 'Waiting for Supervisor to dispatch a Ticket' : 'Waiting for Ticket assignment'
      }
    }
    return { stage: 'agents', text, source: { kind: 'goal' } }
  }
  if (grounding.alignmentRevision !== alignment.revision) return { stage: 'attention', text: 'Results need updating', source: resultSource }
  const gapsAllowed = planReview ? planReview === 'awaiting-acceptance' : groundingAcceptanceIssue(alignment, grounding, true) === null
  const hasGaps = grounding.checks.some(check => check.outcome === 'gap')
  if (gapsAllowed) return { stage: 'you', text: hasGaps ? 'Results have known gaps' : 'Results ready for review', source: resultSource }
  return { stage: 'attention', text: 'Results need checking', source: resultSource }
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
