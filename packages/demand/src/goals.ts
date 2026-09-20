/** Pure Goal facts and validation. Safe to consume from a browser. */
export type DemandCriterion = { id: string; text: string }
export type DemandAlignmentProposal = {
  summary: string
  criteria: DemandCriterion[]
  openQuestions: string[]
}
export type DemandAlignment = DemandAlignmentProposal & {
  revision: number
  confirmedAt: number | null
}
export type DemandGroundingCheck = {
  criterionId: string
  outcome: 'met' | 'gap' | 'unknown'
  evidence: string[]
  note: string
}
export type DemandGroundingProposal = {
  alignmentRevision: number
  summary: string
  checks: DemandGroundingCheck[]
}
export type DemandGrounding = DemandGroundingProposal & {
  submissionId: string
  acceptedAt: number | null
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) if (!keys.includes(key)) throw new Error(`${label} has unknown field ${key}`)
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
  const source = record(value, 'alignment', ['summary', 'criteria', 'openQuestions', 'revision', 'confirmedAt'])
  const proposal = parseAlignmentProposal({ summary: source.summary, criteria: source.criteria, openQuestions: source.openQuestions })
  const result = { ...proposal, revision: revision(source.revision, 'alignment.revision'), confirmedAt: acknowledgement(source.confirmedAt, 'alignment.confirmedAt') }
  if (result.confirmedAt !== null && alignmentConfirmationIssue(result)) throw new Error('alignment acknowledgement does not match a confirmable proposal')
  return result
}

export function parseGroundingProposal(value: unknown): DemandGroundingProposal {
  const source = record(value, 'grounding', ['alignmentRevision', 'summary', 'checks'])
  if (!Array.isArray(source.checks)) throw new Error('grounding.checks must be an array')
  const checks: DemandGroundingCheck[] = source.checks.map((value, index) => {
    const entry = record(value, `grounding.checks[${index}]`, ['criterionId', 'outcome', 'evidence', 'note'])
    if (entry.outcome !== 'met' && entry.outcome !== 'gap' && entry.outcome !== 'unknown') throw new Error('grounding outcome must be met, gap or unknown')
    return { criterionId: text(entry.criterionId, 'check.criterionId'), outcome: entry.outcome, evidence: texts(entry.evidence, 'check.evidence'), note: text(entry.note, 'check.note', true) }
  })
  if (new Set(checks.map(entry => entry.criterionId)).size !== checks.length) throw new Error('grounding criterion IDs must be unique')
  return { alignmentRevision: revision(source.alignmentRevision, 'grounding.alignmentRevision'), summary: text(source.summary, 'grounding.summary'), checks }
}

export function parseGrounding(value: unknown): DemandGrounding {
  const source = record(value, 'grounding', ['alignmentRevision', 'summary', 'checks', 'submissionId', 'acceptedAt'])
  const proposal = parseGroundingProposal({ alignmentRevision: source.alignmentRevision, summary: source.summary, checks: source.checks })
  return { ...proposal, submissionId: text(source.submissionId, 'grounding.submissionId'), acceptedAt: acknowledgement(source.acceptedAt, 'grounding.acceptedAt') }
}

/** A location is not a proof: callers still show the Agent's claim and its source. */
export function isDemandEvidenceReference(value: string): boolean {
  const reference = value.trim()
  if (!reference || /[\r\n]/u.test(reference)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(reference)) {
    try { const location = new URL(reference); return location.pathname.length > 0 || location.hostname.length > 0 } catch { return false }
  }
  return (reference.includes('/') && !reference.endsWith('/')) || /^(?:[^\s/:]+\.[^\s/:]+(?::[1-9]\d*(?::[1-9]\d*)?)?|[^\s/:]+:[1-9]\d*(?::[1-9]\d*)?)$/u.test(reference)
}

export function alignmentConfirmationIssue(alignment: DemandAlignment | undefined): string | null {
  if (!alignment?.summary.trim()) return 'Ask Mote to propose the goal first.'
  if (alignment.criteria.length === 0) return 'The goal needs at least one success criterion.'
  if (alignment.openQuestions.length > 0) return 'Resolve the open questions before confirming the goal.'
  return null
}

export function groundingAcceptanceIssue(alignment: DemandAlignment | undefined, grounding: DemandGrounding | undefined, acceptGaps = false): string | null {
  const goalIssue = alignmentConfirmationIssue(alignment)
  if (goalIssue) return goalIssue
  if (!alignment || alignment.confirmedAt === null) return 'Confirm the current goal before accepting results.'
  if (!grounding) return 'Ask Mote to ground the results first.'
  if (grounding.alignmentRevision !== alignment.revision) return 'These results refer to an earlier goal. Ask Mote to check the current goal.'
  const checks = new Map(grounding.checks.map(check => [check.criterionId, check]))
  if (checks.size !== alignment.criteria.length || grounding.checks.length !== checks.size) return 'Every current success criterion needs exactly one result check.'
  for (const criterion of alignment.criteria) {
    const check = checks.get(criterion.id)
    if (!check) return `Missing result for: ${criterion.text}`
    if (check.outcome === 'unknown') return `Result is still unknown: ${criterion.text}`
    if (check.evidence.length === 0 || !check.evidence.every(isDemandEvidenceReference)) return `Missing locatable evidence for: ${criterion.text}`
    if (check.outcome === 'gap' && !check.note.trim()) return `Describe the remaining gap: ${criterion.text}`
    if (check.outcome === 'gap' && !acceptGaps) return 'There are remaining gaps. Review them and explicitly accept with gaps.'
  }
  return null
}
