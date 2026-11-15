import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { compactReferenceId } from '@agentmux/client-ui/display-name'
import { mintObjectId } from '@agentmux/core/object-id'
import { parseGoalPlanReviewInput, type GoalPlanReview, type GoalPlanReviewInput } from '@agentmux/demand/goal-plan'
import { delegationWorkerHostId, type DemandDelegation } from '@agentmux/demand/delegations'
import { Button } from '@agentmux/client-ui/components/Button'
import type { DemandProjection } from '../lib/global-demand-board'
import { api } from '../lib/api'
import { applyGoalDelegationResult, beginGoalDelegationRead } from '../lib/goal-delegation-work'
import { useGoalAgentName } from '../lib/goal-discussion-recipient'
import type { GoalPlanNodeView } from './GoalPlanGraph'
import { GoalEvidence } from './GoalEvidence'
import { GoalPlanThread } from './GoalPlanThread'
import type { GoalPlanReviewDraft as RetainedGoalPlanReviewDraft } from '../lib/goal-edit-drafts'

/** UI draft only. The original Goal owner alone stores and derives review facts. */
export type GoalPlanReviewDraft = RetainedGoalPlanReviewDraft & { pending?: boolean | undefined; issue?: string | undefined; reread?: boolean | undefined }

function originalReview(reviews: readonly GoalPlanReview[] | undefined, request: GoalPlanReviewDraft['request']) {
  if (!request) return undefined
  return reviews?.find(({ reviewer: _reviewer, reviewedAt: _time, ...review }) => JSON.stringify(review) === JSON.stringify(request.review))
}

function DeliveryReport({ delegation }: { delegation: DemandDelegation }) {
  const report = delegation.report
  if (!report) return <p className="goals-caption">No report recorded for this attempt.</p>
  const criteria = new Map(delegation.capturedCriteria.map(criterion => [criterion.id, criterion.text]))
  return <div className="goal-delivery__report" data-goal-delivery-report={report.operationId}>
    <p className="goal-delivery__summary">{report.grounding.summary}</p>
    <ul className="goal-delivery__checks">{report.grounding.checks.map(check => <li key={check.criterionId}>
      <div><strong>{criteria.get(check.criterionId) ?? check.criterionId}</strong><span data-goal-delivery-check={check.outcome}>{check.outcome === 'met' ? 'Reported met' : check.outcome === 'gap' ? 'Reported gap' : 'Unknown'}</span></div>
      {check.note ? <p>{check.note}</p> : null}
      {check.evidence.length ? <GoalEvidence evidence={check.evidence} criterion={check.criterionId} /> : <p className="goals-caption">No evidence reported.</p>}
    </li>)}</ul>
  </div>
}

function PreviousAttemptAuthor({ attempt }: { attempt: DemandDelegation }) {
  const name = useGoalAgentName(attempt.workerAgentSessionId, delegationWorkerHostId(attempt))
  return <h4>{name ?? `Agent · ${compactReferenceId(attempt.workerAgentSessionId)}`}</h4>
}

/** Human review reaches the existing public owner; no command is executed here. */
export function GoalPlanDelivery({ demand, item, historical, author, context, draft, onDraft, previousDrafts, onReadGoal, onConfirmed }: { demand: DemandProjection; item: GoalPlanNodeView; historical: boolean; author: ReactNode; context: ReactNode;
  draft?: GoalPlanReviewDraft | undefined; onDraft(value: GoalPlanReviewDraft): void; previousDrafts: Readonly<Record<string, GoalPlanReviewDraft>>; onReadGoal(): void; onConfirmed(request: NonNullable<GoalPlanReviewDraft['request']>): void }) {
  const delegation = item.delegation, report = delegation?.report
  const current = draft ?? { command: item.node.check, result: '', evidence: '', note: '' }
  const request = current.request, submitted = useRef(request), busy = useRef(false), requested = useRef(false), receipt = useRef<HTMLParagraphElement>(null)
  const recorded = originalReview(demand.plan?.reviews, request ?? submitted.current)
  useLayoutEffect(() => {
    if (recorded && requested.current) { requested.current = false; receipt.current?.focus() }
    if (recorded && request) onConfirmed(request)
  }, [recorded, request, onConfirmed])
  if (!delegation || !report) return null
  const previous = historical ? [] : (demand.delegations ?? []).filter(attempt => attempt.planNodeId === item.node.id && attempt.operationId !== delegation.operationId)
  async function submit(verdict?: GoalPlanReviewInput['verdict']) {
    if (busy.current || current.pending) return
    let original = request
    if (!original) {
      try { original = { goalId: demand.id, review: parseGoalPlanReviewInput({ operationId: mintObjectId(), nodeId: item.node.id,
        ...(item.delegation?.report?.delivery ? { deliveryHash: item.delegation.report.delivery.hash } : {}),
        delegationOperationId: delegation!.operationId, verdict, check: { command: current.command, result: current.result,
          evidence: current.evidence.split('\n').map(line => line.trim()).filter(Boolean) }, note: current.note }) } }
      catch (error) { onDraft({ ...current, issue: error instanceof Error ? error.message : String(error) }); return }
    }
    const frozen = { ...current, request: original, pending: true, issue: undefined, reread: false }
    busy.current = true; requested.current = true; submitted.current = original; onDraft(frozen)
    const cut = beginGoalDelegationRead()
    try {
      const result = await api.demands.delegation('goal.plan.review', original)
      if (result.goalId !== original.goalId) throw new Error('The review receipt belongs to another Goal. Keep the original request and read its Goal again.')
      applyGoalDelegationResult(result, cut)
      const saved = Boolean(originalReview(result.plan?.reviews, original))
      if (saved) onConfirmed(original)
      else onDraft({ ...frozen, pending: false, issue: 'The review receipt is unconfirmed. Read the original Goal before another action.' })
    } catch (error) { onDraft({ ...frozen, pending: false, issue: error instanceof Error ? error.message : String(error) }) }
    finally { busy.current = false }
  }
  async function readOriginal() {
    if (!request || busy.current || current.pending) return
    busy.current = true; requested.current = true; submitted.current = request; onDraft({ ...current, pending: true })
    const cut = beginGoalDelegationRead()
    try {
      const result = await api.demands.delegation('goal.delegations', { goalId: request.goalId })
      if (result.goalId !== request.goalId) throw new Error('The observation belongs to another Goal. The original review request is retained.')
      applyGoalDelegationResult(result, cut)
      const saved = Boolean(originalReview(result.plan?.reviews, request))
      if (saved) onConfirmed(request)
      else onDraft({ ...current, pending: false, reread: true, issue: 'This review is not recorded in the original Goal. Its exact request is retained.' })
    } catch (error) { onDraft({ ...current, pending: false, issue: error instanceof Error ? error.message : String(error) }) }
    finally { busy.current = false }
  }
  const acknowledged = Boolean(recorded)
  return <section className="goal-delivery" aria-label={`Delivery for ${item.node.title}`} data-goal-delivery={delegation.operationId}>
    <DeliveryReport delegation={delegation} />
    {item.review ? <div className="goal-delivery__verdict" data-goal-plan-verdict={item.review.verdict}>
      {item.staleCriteria.length ? <p className="goals-caption">Previous review · criteria changed</p> : null}<strong>{item.review.verdict === 'pass' ? 'Passed' : 'Changes requested'}</strong><span> by {item.review.reviewer.id}</span>
      {item.review.note ? <p>{item.review.note}</p> : null}
      {item.review.check.command ? <p><code>{item.review.check.command}</code> → {item.review.check.result}</p> : null}
      {item.review.check.evidence.length ? <GoalEvidence evidence={item.review.check.evidence} criterion="Independent review" /> : null}
    </div> : null}
    {acknowledged ? <p ref={receipt} tabIndex={-1} role="status" className="goal-delivery__receipt">Review saved · {recorded?.verdict === 'pass' ? 'Node passed' : 'Changes requested'}. Goal acceptance remains separate.</p> : null}
    {!historical && item.state === 'review' || request ? <div className="goal-delivery__review" aria-label="Independent node review">
      {!acknowledged && request ? <div className="goals-service" role="status">
        {current.pending ? 'Saving or reading the original review…' : current.issue ?? 'Original review request retained.'}
        <div className="goals-inline-actions"><Button type="button" disabled={current.pending} onClick={() => void readOriginal()}>Read original Goal</Button>
          {!historical && current.reread && item.state === 'review' && delegation.operationId === request.review.delegationOperationId ? <Button type="button" disabled={current.pending} onClick={() => void submit()}>Submit original review</Button> : null}</div>
      </div> : current.issue ? <p className="goals-service" role="status">{current.issue}</p> : null}
      {!historical ? <details className="goal-delivery__form"><summary>Record review</summary>
      <p className="goals-caption">Run the declared check independently and record what you observed. This reviews this attempt only.</p>
      <label>Check performed<input aria-label="Review check performed" value={current.command} readOnly={Boolean(request)} onChange={event => onDraft({ ...current, command: event.target.value })} /></label>
      <label>Observed result<textarea aria-label="Review observed result" rows={2} value={current.result} readOnly={Boolean(request)} onChange={event => onDraft({ ...current, result: event.target.value })} /></label>
      <label>Evidence locations <small>One per line</small><textarea aria-label="Review evidence locations" rows={2} value={current.evidence} readOnly={Boolean(request)} onChange={event => onDraft({ ...current, evidence: event.target.value })} /></label>
      <label>Review note<textarea aria-label="Review note" rows={2} value={current.note} readOnly={Boolean(request)} onChange={event => onDraft({ ...current, note: event.target.value })} /></label>
      {!request ? <div className="goals-inline-actions"><Button type="button" variant="primary" onClick={() => void submit('pass')}>Pass node</Button><Button type="button" onClick={() => void submit('changes')}>Request changes</Button></div> : null}
      </details> : null}
      {request ? <details><summary>Original review request</summary><pre>{JSON.stringify(request, null, 2)}</pre></details> : null}
    </div> : null}
    <details className="goal-delivery__source"><summary>Original attempt</summary>
      <div className="goal-delivery__byline">Report by {author}<span>Attempt {item.attempts}</span></div>
      {context}<GoalPlanThread delegation={delegation} />
    </details>
    {previous.length ? <details className="goal-delivery__history"><summary>Previous attempts · {previous.length}</summary>{previous.map(attempt => <article key={attempt.operationId} data-goal-delivery-history={attempt.operationId}>
      <PreviousAttemptAuthor attempt={attempt} /><DeliveryReport delegation={attempt} />
      {(demand.plan?.reviews ?? []).filter(review => review.delegationOperationId === attempt.operationId).map(review => <div key={review.operationId}>
        <p>{review.verdict === 'pass' ? 'Passed' : 'Changes requested'} by {review.reviewer.id}{review.note ? ` · ${review.note}` : ''}</p>
        {review.check.command ? <p><code>{review.check.command}</code> → {review.check.result}</p> : null}
        {review.check.evidence.length ? <GoalEvidence evidence={review.check.evidence} criterion="Previous independent review" /> : null}
      </div>)}
      {previousDrafts[attempt.operationId]?.request ? <details><summary>Original review request</summary><pre>{JSON.stringify(previousDrafts[attempt.operationId]!.request, null, 2)}</pre>
        {previousDrafts[attempt.operationId]?.issue ? <p className="goals-service">{previousDrafts[attempt.operationId]!.issue}</p> : null}<Button type="button" onClick={onReadGoal}>Read original Goal</Button>
      </details> : null}
      <GoalPlanThread delegation={attempt} />
    </article>)}</details> : null}
  </section>
}
