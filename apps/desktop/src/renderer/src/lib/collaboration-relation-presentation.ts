import type { CollaborationEvidence, CollaborationRelation } from './agent-collaboration'

export const COLLABORATION_LABELS = { communication: 'Messages', creation: 'Creation', supervision: 'Dispatch' } as const

/** A preparation record is provenance, not evidence of a completed or running operation. */
export function collaborationRelationSummary(kind: CollaborationRelation['kind'], evidence: readonly CollaborationEvidence[]) {
  if (kind !== 'creation') return { title: COLLABORATION_LABELS[kind], unconfirmed: false }
  const records = evidence.filter(item => item.kind === 'creation')
  const unconfirmed = records.filter(item => item.record.phase === 'prepared').length
  return { title: unconfirmed ? unconfirmed === records.length ? 'Creation unconfirmed' : 'Creation records · includes unconfirmed'
    : records.length ? 'Created' : 'Creation records', unconfirmed: unconfirmed > 0 }
}
