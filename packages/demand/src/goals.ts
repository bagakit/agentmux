/** Pure Goal facts and validation. Safe to consume from a browser. */
import { deriveObjectId } from '@agentmux/identity'
import { parseDemandEvidence, type DemandEvidence } from './evidence.js'
import type { DemandStatus } from './demand-types.js'
export { parseDemandEvidence, demandEvidenceText, demandEvidenceLabel, type DemandEvidence, type DemandFileEvidence } from './evidence.js'
export type DemandCriterion = { id: string; text: string }
export function deriveBoundGoalId(runtimeId: string, namespace: string, creationOperationId: string): string {
  return deriveObjectId('agentmux.goal-root.v1', JSON.stringify([runtimeId, namespace, creationOperationId]))
}
export type DemandAlignmentProposal = {
  summary: string
  criteria: DemandCriterion[]
  openQuestions: string[]
}
export type DemandAlignmentConfirmer =
  | { kind: 'agent'; id: string; hostId: string; runtimeId: string }
  | { kind: 'user' | 'device'; id: string }
export type DemandAlignment = DemandAlignmentProposal & {
  revision: number
  confirmedAt: number | null
  confirmedBy?: DemandAlignmentConfirmer
}
export type DemandGroundingCheck = {
  criterionId: string
  outcome: 'met' | 'gap' | 'unknown'
  evidence: DemandEvidence[]
  note: string
}
export type DemandGroundingProposal = {
  alignmentRevision: number
  summary: string
  checks: DemandGroundingCheck[]
}
export type UnknownGoalResult = { criterionId: string; reason: string }
export type UnknownGoalResultDecision = { by: { kind: 'user' | 'device'; id: string }; checks: UnknownGoalResult[] }
export type DemandGrounding = DemandGroundingProposal & {
  submissionId: string
  acceptedAt: number | null
  unknownDecision?: UnknownGoalResultDecision
}

export function parseUnknownGoalResults(value: unknown): UnknownGoalResult[] {
  if (!Array.isArray(value) || !value.length) throw new Error('Name each unverified criterion and why its evidence cannot be recovered')
  const checks = value.map(item => {
    const p = record(item, 'Unknown result disposition', ['criterionId', 'reason'])
    return { criterionId: text(p.criterionId, 'Criterion ID'), reason: text(p.reason, 'Reason') }
  }).sort((left, right) => left.criterionId < right.criterionId ? -1 : left.criterionId === right.criterionId ? 0 : 1)
  if (new Set(checks.map(check => check.criterionId)).size !== checks.length) throw new Error('Use one disposition per criterion')
  return checks
}

export function parseUnknownGoalResultDecision(value: unknown): UnknownGoalResultDecision {
  const p = record(value, 'Unknown result decision', ['by', 'checks'])
  const by = record(p.by, 'Original decision author', ['kind', 'id'])
  if (by.kind !== 'user' && by.kind !== 'device') throw new Error('Only an authenticated person or device can close with an unknown result')
  return { by: { kind: by.kind, id: text(by.id, 'Original decision author ID') }, checks: parseUnknownGoalResults(p.checks) }
}

export function parseAcceptedGoalResults(value: unknown): DemandGrounding[] {
  if (!Array.isArray(value)) throw new Error('Accepted Goal results must be an array')
  const results = value.map(parseGrounding)
  if (results.some(result => result.acceptedAt === null) || new Set(results.map(result => result.submissionId)).size !== results.length)
    throw new Error('Accepted Goal results need distinct, accepted submissions')
  return results
}

/** The next result step once the original owner confirms the plan's work has passed. */
export function goalPlanReviewState(status: DemandStatus,
  alignment: DemandAlignment | undefined, grounding: DemandGrounding | undefined) {
  if (status !== 'in_review') return undefined
  if (isCurrentGroundingAccepted(alignment, grounding)) return 'accepted'
  if (!grounding) return 'awaiting-report'
  return groundingAcceptanceIssue(alignment, grounding, true) ? 'awaiting-evidence' : 'awaiting-acceptance'
}

function record(value: unknown, label: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) if (!keys.includes(key) && !optional.includes(key)) throw new Error(`${label} has unknown field ${key}`)
  for (const key of keys) if (!(key in source)) throw new Error(`${label} is missing ${key}`)
  return source
}

function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${label} must be a ${allowEmpty ? '' : 'non-empty '}string`)
  return value.trim()
}

function revision(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`)
  return value
}

function acknowledgement(value: unknown, label: string): number | null {
  if (value === null) return null
  return revision(value, label)
}

function texts(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((entry, index) => text(entry, `${label}[${index}]`))
}

export function parseAlignmentProposal(value: unknown): DemandAlignmentProposal {
  const source = record(value, 'alignment', ['summary', 'criteria', 'openQuestions'])
  if (!Array.isArray(source.criteria)) throw new Error('alignment.criteria must be an array')
  const criteria = source.criteria.map((value, index) => {
    const entry = record(value, `alignment.criteria[${index}]`, ['id', 'text'])
    return { id: text(entry.id, 'criterion.id'), text: text(entry.text, 'criterion.text') }
  })
  if (new Set(criteria.map(entry => entry.id)).size !== criteria.length) throw new Error('alignment criteria IDs must be unique')
  return { summary: text(source.summary, 'alignment.summary'), criteria, openQuestions: texts(source.openQuestions, 'alignment.openQuestions') }
}

export function parseAlignment(value: unknown): DemandAlignment {
  const source = record(value, 'alignment', ['summary', 'criteria', 'openQuestions', 'revision', 'confirmedAt'], ['confirmedBy'])
  const proposal = parseAlignmentProposal({ summary: source.summary, criteria: source.criteria, openQuestions: source.openQuestions })
  const result: DemandAlignment = { ...proposal, revision: revision(source.revision, 'alignment.revision'), confirmedAt: acknowledgement(source.confirmedAt, 'alignment.confirmedAt') }
  if (source.confirmedBy !== undefined) {
    const actor = record(source.confirmedBy, 'alignment confirmer', ['kind', 'id'], ['hostId', 'runtimeId'])
    const id = text(actor.id, 'alignment confirmer id')
    if (result.confirmedAt === null) throw new Error('An unconfirmed alignment cannot have a confirmer')
    if (actor.kind === 'agent') {
      result.confirmedBy = { kind: actor.kind, id, hostId: text(actor.hostId, 'confirmer Host'), runtimeId: text(actor.runtimeId, 'confirmer Runtime') }
    } else {
      if ((actor.kind !== 'user' && actor.kind !== 'device') || actor.hostId !== undefined || actor.runtimeId !== undefined) throw new Error('Invalid alignment confirmer')
      result.confirmedBy = { kind: actor.kind, id }
    }
  }
  if (result.confirmedAt !== null && alignmentConfirmationIssue(result)) throw new Error('alignment acknowledgement does not match a confirmable proposal')
  return result
}

export function parseGroundingProposal(value: unknown): DemandGroundingProposal {
  const source = record(value, 'grounding', ['alignmentRevision', 'summary', 'checks'])
  if (!Array.isArray(source.checks)) throw new Error('grounding.checks must be an array')
  const checks: DemandGroundingCheck[] = source.checks.map((value, index) => {
    const entry = record(value, `grounding.checks[${index}]`, ['criterionId', 'outcome', 'evidence', 'note'])
    if (entry.outcome !== 'met' && entry.outcome !== 'gap' && entry.outcome !== 'unknown') throw new Error('grounding outcome must be met, gap or unknown')
    if (!Array.isArray(entry.evidence)) throw new Error('check.evidence must be an array')
    return { criterionId: text(entry.criterionId, 'check.criterionId'), outcome: entry.outcome, evidence: entry.evidence.map(parseDemandEvidence), note: text(entry.note, 'check.note', true) }
  })
  if (new Set(checks.map(entry => entry.criterionId)).size !== checks.length) throw new Error('grounding criterion IDs must be unique')
  return { alignmentRevision: revision(source.alignmentRevision, 'grounding.alignmentRevision'), summary: text(source.summary, 'grounding.summary'), checks }
}

export function parseGrounding(value: unknown): DemandGrounding {
  const source = record(value, 'grounding', ['alignmentRevision', 'summary', 'checks', 'submissionId', 'acceptedAt'], ['unknownDecision'])
  const proposal = parseGroundingProposal({ alignmentRevision: source.alignmentRevision, summary: source.summary, checks: source.checks })
  const acceptedAt = acknowledgement(source.acceptedAt, 'grounding.acceptedAt')
  const unknownDecision = source.unknownDecision === undefined ? undefined : parseUnknownGoalResultDecision(source.unknownDecision)
  const unknown = new Set(proposal.checks.filter(check => check.outcome === 'unknown').map(check => check.criterionId))
  if (acceptedAt !== null && unknown.size && !unknownDecision ||
      unknownDecision && (acceptedAt === null || unknownDecision.checks.length !== unknown.size ||
        unknownDecision.checks.some(check => !unknown.has(check.criterionId))))
    throw new Error('The decision must cover the exact accepted unknown results')
  return { ...proposal, submissionId: text(source.submissionId, 'grounding.submissionId'), acceptedAt, ...(unknownDecision ? { unknownDecision } : {}) }
}

/** A location is not a proof: callers still show the Agent's claim and its source. */
export function isDemandEvidenceReference(value: DemandEvidence): boolean {
  if (typeof value !== 'string') { try { parseDemandEvidence(value); return true } catch { return false } }
  const reference = value.trim()
  if (!reference || /[\r\n]/u.test(reference)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(reference)) {
    try { const location = new URL(reference); return location.pathname.length > 0 || location.hostname.length > 0 } catch { return false }
  }
  return (reference.includes('/') && !reference.endsWith('/')) || /^(?:[^\s/:]+\.[^\s/:]+(?::[1-9]\d*(?::[1-9]\d*)?)?|[^\s/:]+:[1-9]\d*(?::[1-9]\d*)?)$/u.test(reference)
}

/** Saved human acceptance is a fact; later readiness checks cannot revoke it. */
export function isCurrentGroundingAccepted(alignment: DemandAlignment | undefined, grounding: DemandGrounding | undefined): boolean {
  return Boolean(alignment && alignment.confirmedAt !== null && grounding && grounding.acceptedAt !== null && grounding.alignmentRevision === alignment.revision)
}

export function alignmentConfirmationIssue(alignment: DemandAlignment | undefined): string | null {
  if (!alignment?.summary.trim()) return 'Ask Mote to propose the goal first.'
  if (alignment.criteria.length === 0) return 'The goal needs at least one success criterion.'
  if (alignment.openQuestions.length > 0) return 'Resolve the open questions before confirming the goal.'
  return null
}

export function groundingAcceptanceIssue(alignment: DemandAlignment | undefined, grounding: DemandGrounding | undefined, acceptGaps = false,
  dispositions: readonly UnknownGoalResult[] = []): string | null {
  const goalIssue = alignmentConfirmationIssue(alignment)
  if (goalIssue) return goalIssue
  if (!alignment || alignment.confirmedAt === null) return 'Confirm the current goal before accepting results.'
  if (!grounding) return 'Ask Mote to ground the results first.'
  if (grounding.alignmentRevision !== alignment.revision) return 'These results refer to an earlier goal. Ask Mote to check the current goal.'
  const checks = new Map(grounding.checks.map(check => [check.criterionId, check]))
  if (checks.size !== alignment.criteria.length || grounding.checks.length !== checks.size) return 'Every current success criterion needs exactly one result check.'
  const resolved = new Set(dispositions.map(item => item.criterionId))
  if (dispositions.some(item => checks.get(item.criterionId)?.outcome !== 'unknown'))
    return 'Each disposition must name a currently unknown result.'
  for (const criterion of alignment.criteria) {
    const check = checks.get(criterion.id)
    if (!check) return `Missing result for: ${criterion.text}`
    if (check.outcome === 'unknown') {
      if (!resolved.has(criterion.id)) return `Result is still unknown: ${criterion.text}`
      continue
    }
    if (check.evidence.length === 0 || !check.evidence.every(isDemandEvidenceReference)) return `Missing locatable evidence for: ${criterion.text}`
    if (check.outcome === 'gap' && !check.note.trim()) return `Describe the remaining gap: ${criterion.text}`
    if (check.outcome === 'gap' && !acceptGaps) return 'There are remaining gaps. Review them and explicitly accept with gaps.'
  }
  return null
}

export { parseDemandParticipations, parseDemandCreationOrigin } from './collaboration.js'
