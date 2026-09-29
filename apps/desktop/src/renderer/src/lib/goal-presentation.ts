import { alignmentConfirmationIssue, groundingAcceptanceIssue, isDemandEvidenceReference } from '@agentmux/demand/goals'
import type { DemandRecord } from './global-demand-board'

/** Display the owner facts. Business status is not an acknowledgement. */
export function goalNextStep(demand: Pick<DemandRecord, 'alignment' | 'grounding' | 'status'>): string {
  const { alignment, grounding } = demand
  if (demand.status === 'done' && !grounding) return 'Results not verified'
  if (!alignment) return 'Goal needs an outline'
  if (alignmentConfirmationIssue(alignment)) return alignment.openQuestions.length ? 'Decision needed' : 'Success criteria needed'
  if (alignment.confirmedAt === null) return 'Goal ready for confirmation'
  if (!grounding) return 'Goal agreed · No result report'
  if (grounding.alignmentRevision !== alignment.revision) return 'Results need updating'
  const gapsAllowed = groundingAcceptanceIssue(alignment, grounding, true) === null
  const hasGaps = grounding.checks.some(check => check.outcome === 'gap')
  if (grounding.acceptedAt !== null && gapsAllowed) return hasGaps ? 'Accepted with gaps' : 'Accepted'
  if (gapsAllowed) return hasGaps ? 'Results have known gaps' : 'Results ready for review'
  return 'Results need checking'
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
