import { alignmentConfirmationIssue, groundingAcceptanceIssue } from '@agentmux/demand/goals'
import type { DemandRecord } from './global-demand-board'

/** Display the owner facts. Business status is not an acknowledgement. */
export function goalNextStep(demand: Pick<DemandRecord, 'alignment' | 'grounding' | 'status'>): string {
  const { alignment, grounding } = demand
  if (!alignment) return demand.status === 'done' ? 'Result unverified' : 'Align goal'
  if (alignmentConfirmationIssue(alignment)) return alignment.openQuestions.length ? 'Resolve choices' : 'Define success'
  if (alignment.confirmedAt === null) return 'Confirm goal'
  if (!grounding) return 'Ground results'
  if (grounding.alignmentRevision !== alignment.revision) return 'Update results'
  const gapsAllowed = groundingAcceptanceIssue(alignment, grounding, true) === null
  const hasGaps = grounding.checks.some(check => check.outcome === 'gap')
  if (grounding.acceptedAt !== null && gapsAllowed) return hasGaps ? 'Accepted · gaps kept' : 'Accepted'
  if (gapsAllowed) return hasGaps ? 'Review gaps' : 'Review results'
  if (grounding.checks.some(check => check.outcome === 'unknown')) return 'Resolve unknowns'
  return 'Complete checks'
}
