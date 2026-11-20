import { deriveObjectId } from '@agentmux/identity'
import type { Demand } from './demand-types.js'
import { projectGoalPlan, type GoalPlanProjection } from './goal-plan.js'
import { isDemandEvidenceReference, type DemandEvidence, type DemandGrounding, type DemandGroundingCheck } from './goals.js'

type GoalGroundingFacts = Pick<Demand, 'id' | 'alignment' | 'grounding' | 'plan' | 'delegations' | 'patrols'>

/** Distinguish an original Goal report from the prior flat collection of worker reports. */
export function independentGoalGrounding(goal: GoalGroundingFacts): DemandGrounding | undefined {
  const { alignment, grounding, delegations, patrols } = goal
  if (!alignment || !grounding || grounding.alignmentRevision !== alignment.revision || grounding.acceptedAt !== null) return undefined
  if (!delegations?.some(attempt => attempt.collection?.groundingSubmissionId === grounding.submissionId)) return grounding
  // A patrol could attach this same Goal report to a collected worker. The original
  // applied inspection, with its full reported check content, remains on the Goal.
  const { alignmentRevision, summary, checks } = grounding
  return patrols?.some(({ report }) => report?.applied &&
    JSON.stringify(report.grounding) === JSON.stringify({ alignmentRevision, summary, checks })) ? grounding : undefined
}

/** Reuse the Demand owner's current attempts and receipts without rewriting original reports. */
export function currentGoalGrounding(goal: GoalGroundingFacts, projection?: GoalPlanProjection): DemandGrounding | undefined {
  const { alignment, grounding, plan, delegations = [] } = goal
  if (!alignment || !plan?.nodes.length || grounding?.acceptedAt != null && grounding.alignmentRevision === alignment.revision)
    return grounding
  if (!grounding && !delegations.some(attempt => attempt.planNodeId && attempt.report)) return undefined

  const current = projection ?? projectGoalPlan(plan, delegations, alignment.criteria, undefined, alignment.revision)
  const byCriterion = new Map<string, (DemandGroundingCheck & { nodeId: string; replaces: string[] })[]>()
  const basis = []
  for (const { node, state, delegation, review, staleCriteria, unknown } of current.nodes) {
    if (state === 'cancelled') continue
    const report = delegation?.report
    const deliveryHash = report?.delivery?.hash
    const signedPass = state === 'done' && Boolean(deliveryHash && review?.deliveryHash === deliveryHash && review.completion)
    basis.push([node.id, state, delegation?.operationId, deliveryHash, review?.operationId, review?.completion?.hash])
    for (const criterionId of node.criterionIds) {
      const check = staleCriteria.includes(criterionId) || unknown.includes('predecessors') || !deliveryHash
        ? undefined : report?.grounding.checks.find(result => result.criterionId === criterionId)
      const evidence = (check?.evidence ?? []).filter(isDemandEvidenceReference)
      const met = signedPass && check?.outcome === 'met' && evidence.length > 0
      // A signed audit can pass its own review while identifying a gap in the product.
      const gap = check?.outcome === 'gap' && evidence.length > 0 && Boolean(check.note)
      const outcome = met ? 'met' : gap ? 'gap' : 'unknown'
      const note = `${node.title} (${node.id})${report ? ` · ${report.replyMessageId}` : ''}: ${outcome === 'unknown'
        ? `Unverified (${state}${staleCriteria.includes(criterionId) ? ', standard changed' : ''}).${check?.note ? ` ${check.note}` : ''}`
        : check!.note || 'Current delivery independently verified.'}`
      const source = { nodeId: node.id, criterionId, outcome, note, evidence,
        replaces: met ? (delegation?.predecessors ?? []).filter(ref => ref.deliveryHash && ref.completionHash).map(ref => ref.nodeId) : [] } as const
      const contributions = byCriterion.get(criterionId)
      if (contributions) contributions.push(source)
      else byCriterion.set(criterionId, [source])
    }
  }

  const independent = independentGoalGrounding(goal)
  const independentChecks = new Map(independent?.checks.map(check => [check.criterionId, check]))
  const checks = alignment.criteria.map(({ id }): DemandGroundingCheck => {
    const contributions = byCriterion.get(id) ?? []
    const resolved = new Set(contributions.flatMap(source => source.replaces))
    const sources: DemandGroundingCheck[] = contributions.filter(source => source.outcome !== 'gap' || !resolved.has(source.nodeId))
    const check = independentChecks.get(id)
    if (independent && check) {
      const supported = check.evidence.length > 0 && check.evidence.every(isDemandEvidenceReference) &&
        (check.outcome !== 'gap' || Boolean(check.note.trim()))
      sources.push({ ...check, outcome: supported ? check.outcome : 'unknown',
        note: [`Independent Goal report ${independent.submissionId}.`, check.note,
          !supported && check.outcome !== 'unknown' ? 'The reported outcome needs locatable evidence and any gap needs a description.' : ''].filter(Boolean).join(' ') })
    }
    if (!sources.length) return { criterionId: id, outcome: 'unknown', evidence: [], note: 'No current Ticket verifies this success criterion.' }
    const evidence = new Map<string, DemandEvidence>()
    for (const source of sources) for (const ref of source.evidence) evidence.set(JSON.stringify(ref), ref)
    return { criterionId: id,
      outcome: sources.some(source => source.outcome === 'unknown') ? 'unknown' : sources.some(source => source.outcome === 'gap') ? 'gap' : 'met',
      evidence: [...evidence.values()], note: sources.map(source => source.note).join('\n') }
  })
  const summary = independent ? `Current evidence from the original Goal plan.\n${independent.summary}` : 'Current evidence from the original Goal plan.'
  const proposal = { alignmentRevision: alignment.revision, summary, checks }
  const identity = independent ? [goal.id, proposal, basis, independent.submissionId] : [goal.id, proposal, basis]
  return { ...proposal, submissionId: deriveObjectId('agentmux.goal-current-grounding.v1', JSON.stringify(identity)), acceptedAt: null }
}
