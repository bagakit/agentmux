import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useRef, useState } from 'react'
import { alignmentConfirmationIssue, groundingAcceptanceIssue, isCurrentGroundingAccepted, type DemandGroundingCheck } from '@agentmux/demand/goals'
import { Button } from '@agentmux/client-ui/components/Button'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import { useIconFeedback } from '../lib/use-icon-feedback'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { goalNextStepFact, goalResultExplanation } from '../lib/goal-presentation'
import { GoalEvidence } from './GoalEvidence'
import { useGoalDiscussionRecipient } from '../lib/goal-discussion-recipient'
import dialogueArtworkUrl from '@agentmux/client-ui/brand/illustrations/goals/demand-dialogue.png'
import '../styles/goal-review.css'

const ThemeObjectGoalIcon = semanticIconComponent('object.goal')
const ThemeActionConfirmIcon = semanticIconComponent('action.confirm')
const ThemeActionAcceptResultsIcon = semanticIconComponent('action.accept-results')
const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')
const ThemeStatusGapIcon = semanticIconComponent('status.gap')
const ThemeStatusUnknownIcon = semanticIconComponent('status.unknown')


type Acknowledgement = { kind: 'confirm'; revision: number } | { kind: 'accept'; revision: number; submissionId: string; gaps: boolean; finish?: boolean }
export type GoalAcknowledgementFeedback = { pending: boolean; failure: { attempt: Acknowledgement; message: string } | null; reloadError: string | null }
export const EMPTY_GOAL_ACKNOWLEDGEMENT: GoalAcknowledgementFeedback = { pending: false, failure: null, reloadError: null }
export function GoalAcknowledgementRecovery({ goalId, feedback, onFeedbackChange }: {
  goalId: string; feedback: GoalAcknowledgementFeedback; onFeedbackChange: (patch: Partial<GoalAcknowledgementFeedback>) => void
}) {
  const refreshDemand = useAppStore(state => state.refreshDemand)
  const { failure, pending, reloadError } = feedback
  const acknowledgementPending = useRef(false)
  async function reload() {
    if (pending || acknowledgementPending.current) return
    acknowledgementPending.current = true; onFeedbackChange({ pending: true, reloadError: null })
    try { await refreshDemand(goalId); onFeedbackChange({ failure: null }) }
    catch (error) { onFeedbackChange({ reloadError: error instanceof Error ? error.message : String(error) }) }
    finally { acknowledgementPending.current = false; onFeedbackChange({ pending: false }) }
  }
  return failure ? <div className="goals-service" role="status" data-goal-acknowledgement-failure>{failure.attempt.kind === 'confirm' ? 'Goal confirmation' : 'Result acceptance'} is unconfirmed. Your goal and current work are kept. <span>{failure.message}</span><Button type="button" variant="primary" disabled={pending} onClick={() => void reload()}>Reload current proposal</Button>{reloadError ? <span>Reload failed: {reloadError}</span> : null}</div> : null
}

export function GoalAlignment({ demand, emphasis, onGrill, onGrounding, onOpenMote, motePending = null, feedback, onFeedbackChange }: { demand: DemandProjection; emphasis?: 'definition' | 'results' | null; onGrill: () => void; onGrounding: () => void; onOpenMote: () => void; motePending?: 'open' | 'grill' | 'grounding' | 'plan' | null; feedback: GoalAcknowledgementFeedback; onFeedbackChange: (patch: Partial<GoalAcknowledgementFeedback>) => void }) {
  const confirmDemandGoal = useAppStore((state) => state.confirmDemandGoal)
  const acceptDemandResult = useAppStore((state) => state.acceptDemandResult)
  const recipient = useGoalDiscussionRecipient(demand.id)
  const alignment = demand.alignment, grounding = demand.grounding
  const active = useWorkbenchPresentationActive()
  const heading = useRef<HTMLHeadingElement>(null)
  const cue = useIconFeedback(JSON.stringify([demand.id, alignment?.revision]), active, heading)
  const focus = emphasis === undefined ? goalNextStepFact(demand).source.kind : emphasis
  const confirmIssue = alignmentConfirmationIssue(alignment)
  const gapIssue = groundingAcceptanceIssue(alignment, grounding, true)
  const stale = Boolean(alignment && grounding && grounding.alignmentRevision !== alignment.revision)
  const accepted = isCurrentGroundingAccepted(alignment, grounding)
  const hasGaps = Boolean(grounding?.checks.some(check => check.outcome === 'gap'))
  const { pending, failure } = feedback
  const acknowledgementPending = useRef(false)
  async function acknowledge(attempt: Acknowledgement) {
    if (failure || pending || acknowledgementPending.current) return
    acknowledgementPending.current = true; onFeedbackChange({ pending: true, failure: null, reloadError: null })
    try {
      if (attempt.kind === 'confirm') {
        await confirmDemandGoal(demand.id, attempt.revision)
        const confirmed = useAppStore.getState().demands[demand.id]?.alignment
        // Decoration consumes the original owner result; it never grants confirmation.
        if (confirmed?.revision === attempt.revision && confirmed.confirmedAt != null) {
          cue.play(JSON.stringify([demand.id, attempt.revision]), 'confirm')
        }
      }
      else await acceptDemandResult(demand.id, attempt.revision, attempt.submissionId, attempt.gaps, attempt.finish)
    } catch (error) { onFeedbackChange({ failure: { attempt, message: error instanceof Error ? error.message : String(error) } }) }
    finally { acknowledgementPending.current = false; onFeedbackChange({ pending: false }) }
  }
  const checks = new Map(grounding?.checks.map(check => [check.criterionId, check]) ?? [])
  const currentReport = Boolean(alignment && grounding && !stale)
  const compactAgreement = Boolean(alignment?.confirmedAt && !confirmIssue && !grounding && demand.status !== 'done' && !failure)
  const criterionIds = new Set(alignment?.criteria.map(criterion => criterion.id))
  const extraChecks = grounding?.checks.filter(check => !criterionIds.has(check.criterionId)) ?? []
  const resultExplanation = goalResultExplanation(demand)
  const missingDoneReport = demand.status === 'done' && !grounding
  const needsDefinition = focus === 'definition' || focus === 'results' && missingDoneReport && !alignment?.confirmedAt
  const useBrief = missingDoneReport && !alignment && Boolean(demand.description.trim())
  const goalRequestButton = <button type="button" className={!failure && needsDefinition && (!alignment || confirmIssue) ? 'primary-button' : 'small-button'} data-goal-grill disabled={Boolean(motePending)} onClick={onGrill}>{motePending === 'grill' ? 'Sending request…' : useBrief ? 'Draft criteria from brief' : recipient.requestLabel('grill')}</button>
  const goalRequestNote = <span className="goals-request-action"><img className="goals-request-action__art" src={dialogueArtworkUrl} alt="" aria-hidden="true" onError={(event) => { event.currentTarget.hidden = true }} /><span className="goals-caption">{recipient.description}</span></span>
  const resultRequest = alignment?.confirmedAt ? <button type="button" className={!failure && focus === 'results' && demand.status === 'done' && !grounding ? 'primary-button' : 'small-button'} data-goal-grounding disabled={Boolean(motePending)} onClick={onGrounding}>{motePending === 'grounding' ? 'Sending request…' : recipient.requestLabel('grounding')}</button> : null
  const reportCaption = accepted ? hasGaps ? 'Accepted with gaps' : 'Accepted by you' : stale ? 'Report needs updating' : 'Agent report · Not accepted yet'
  const reportState = accepted ? (hasGaps ? 'accepted-with-gaps' : 'accepted') : stale ? 'stale' : 'reported'
  const reportActions = grounding ? <>
    {!accepted && !stale && resultExplanation ? <p className="goals-condition">{resultExplanation}</p> : null}
    {accepted && hasGaps ? <p className="goals-condition">You accepted this result with the reported gaps. Those gaps remain part of the record.</p> : null}
    {accepted ? <p className="goals-caption" data-goal-completion-state>{demand.status === 'done' ? 'Goal finished · Results and original work are kept.' : 'Results accepted · Goal remains open.'}</p> : null}
    <div className="goals-inline-actions">
      {!failure && alignment && gapIssue === null && demand.status !== 'done' ? <button type="button" className={focus === 'results' ? 'primary-button' : 'small-button'} data-goal-finish disabled={pending} onClick={() => void acknowledge({ kind: 'accept', revision: alignment.revision, submissionId: grounding.submissionId, gaps: hasGaps, finish: true })}>{pending ? 'Saving…' : accepted ? 'Finish goal' : hasGaps ? 'Accept with gaps and finish' : 'Accept and finish'}<ThemeActionAcceptResultsIcon size={13} /></button> : null}
      {!failure && !accepted && alignment && gapIssue === null ? <button type="button" className={focus === 'results' && demand.status === 'done' ? 'primary-button' : 'small-button'} {...(hasGaps ? { 'data-goal-accept-gaps': true } : { 'data-goal-accept': true })} disabled={pending} onClick={() => void acknowledge({ kind: 'accept', revision: alignment.revision, submissionId: grounding.submissionId, gaps: hasGaps })}>{pending ? 'Saving…' : hasGaps ? 'Accept results, keep gaps' : 'Accept results'}<ThemeActionAcceptResultsIcon size={13} /></button> : null}
      {resultRequest}
    </div>
    {!accepted && gapIssue === null && demand.status !== 'done' ? <p className="goals-caption">Accept and finish also closes the goal.</p> : null}
  </> : null
  const definitionActions = <div className="goals-inline-actions">
    {!failure && alignment && !alignment.confirmedAt && !confirmIssue ? <button type="button" className={needsDefinition ? 'primary-button' : 'small-button'} data-goal-confirm disabled={pending} onClick={() => void acknowledge({ kind: 'confirm', revision: alignment.revision })}>{pending ? 'Saving…' : 'Confirm goal'}<ThemeActionConfirmIcon size={13} /></button> : null}
    {goalRequestButton}{goalRequestNote}
  </div>
  const resultChecks = alignment && currentReport ? alignment.criteria.map(criterion => ({ ...criterion, check: checks.get(criterion.id) })) : []
  const reportCounts = resultChecks.reduce((counts, { check }) => {
    if (check?.outcome === 'met') counts.met++
    else if (check?.outcome === 'gap') counts.gaps++
    else counts.unchecked++
    return counts
  }, { met: 0, gaps: 0, unchecked: 0 })
  const report = grounding ? <section className="goals-grounding goal-review goal-review--report" aria-label="Goal result" tabIndex={-1}
    data-goal-id={demand.id} data-goal-alignment-revision={currentReport ? alignment!.revision : undefined}
    data-goal-confirmation-state={currentReport ? alignment!.confirmedAt ? 'confirmed' : 'unconfirmed' : undefined}
    data-goal-grounding-submission={grounding.submissionId} data-goal-result-state={reportState}>
    <div className="goals-section-heading"><h2 ref={currentReport ? heading : undefined}><ThemeObjectGoalIcon key={cue.key} size={15} aria-hidden="true" animation={cue.animation} onAnimationEnd={cue.stop} />Goal result</h2><span className="goal-review__status">{reportCaption}</span></div>
    {stale ? <p className="goals-condition">This report checked goal v{grounding.alignmentRevision}. The previous acceptance does not apply to goal v{alignment!.revision}.</p>
      : <p className="goals-proposal goal-review__summary" data-goal-result-summary>{grounding.summary}</p>}
    {currentReport && resultChecks.length ? <p className="goal-review__counts">
      {reportCounts.met ? <span><ThemeStatusCompletedIcon size={13} aria-hidden="true" />{reportCounts.met} reported met</span> : null}
      {reportCounts.gaps ? <span><ThemeStatusGapIcon size={13} aria-hidden="true" />{reportCounts.gaps} reported {reportCounts.gaps === 1 ? 'gap' : 'gaps'}</span> : null}
      {reportCounts.unchecked ? <span><ThemeStatusUnknownIcon size={13} aria-hidden="true" />{reportCounts.unchecked} need checking</span> : null}
    </p> : null}
    <details className={`goal-review__disclosure${stale ? ' goals-previous-report' : ''}`}>
      <summary>{stale ? `Previous report · v${grounding.alignmentRevision}` : currentReport && !alignment!.confirmedAt ? 'Review success criteria' : 'Criteria and evidence'}</summary>
      <div className="goal-review__body">
        {currentReport ? <p className="goals-proposal" data-goal-summary>{alignment!.summary}</p> : stale ? <p className="goals-proposal">{grounding.summary}</p> : null}
        {currentReport ? <>
          <div className="goals-result-checks">{resultChecks.map(criterion => <GoalResultCheck key={criterion.id} criterionId={criterion.id} criterion={criterion.text} check={criterion.check} stale={false} currentCriterion />)}</div>
          {extraChecks.length ? <div className="goal-review__extra-checks"><h3>Additional reported checks</h3>{extraChecks.map(check => <GoalResultCheck key={check.criterionId} criterionId={check.criterionId} criterion={`Reported criterion: ${check.criterionId}`} check={check} stale={false} />)}</div> : null}
          {alignment!.openQuestions.length ? <div className="goals-open-questions"><h3>Decisions needed</h3><ul>{alignment!.openQuestions.map((question, i) => <li key={i}>{question}</li>)}</ul></div> : null}
          {definitionActions}
        </> : grounding.checks.map(check => <GoalResultCheck key={check.criterionId} criterionId={check.criterionId} criterion={`Reported criterion: ${check.criterionId}`} check={check} stale={false} />)}
      </div>
    </details>
    {reportActions}
  </section> : null
  const noResults = <div className={`goals-no-results${compactAgreement ? ' goal-review__no-results--compact' : ''}`} data-goal-result-state="missing">
    {!compactAgreement && !missingDoneReport ? <div className="goals-section-heading"><h2>Results review</h2><span className="goals-caption">No report yet</span></div> : null}
    {missingDoneReport ? <p className="goals-muted">Ask the agent to check the finished work against the confirmed criteria.</p> : <p className="goals-muted">Agents work on this goal next. Ask for a result check when the work is ready.</p>}
    <div className="goals-inline-actions">{alignment?.confirmedAt ? <Button type="button" disabled={Boolean(motePending)} onClick={onOpenMote} aria-label={`Open discussion for ${demand.title}`}>{motePending === 'open' ? 'Opening discussion…' : recipient.openLabel}</Button> : null}{resultRequest}</div>
  </div>
  return <>
    {currentReport ? report : alignment ? <section className={`goals-alignment goal-review${compactAgreement ? ' goal-review--compact' : ''}`} aria-label="Goal definition" data-goal-id={demand.id} data-goal-alignment-revision={alignment.revision} data-goal-confirmation-state={alignment.confirmedAt ? 'confirmed' : 'unconfirmed'}>
      <details className="goal-review__disclosure" open={!compactAgreement}>
      <summary className="goals-section-heading"><h2 ref={heading}><ThemeObjectGoalIcon key={cue.key} size={14} aria-hidden="true" animation={cue.animation} onAnimationEnd={cue.stop} />Goal definition</h2><span className="goals-caption">{alignment.confirmedAt ? `Confirmed by you · ${alignment.criteria.length} success criteria${compactAgreement ? ' · No report yet' : ''}` : confirmIssue ? alignment.openQuestions.length ? 'Decisions needed' : 'Define success criteria' : 'Needs your confirmation'}</span></summary>
      <div className="goal-review__body">
      <p className="goals-proposal" data-goal-summary>{alignment.summary}</p>
      {alignment.criteria.length ? grounding ? <div className="goals-result-checks">{alignment.criteria.map(criterion => <GoalResultCheck key={criterion.id} criterionId={criterion.id} criterion={criterion.text} check={stale ? undefined : checks.get(criterion.id)} stale={stale} currentCriterion />)}</div>
        : <ol className="goals-criteria">{alignment.criteria.map(criterion => <li key={criterion.id} data-goal-success-criterion={criterion.id}>{criterion.text}</li>)}</ol> : <p className="goals-muted">Define how to recognize success before confirming this goal.</p>}
      {alignment.openQuestions.length ? <div className="goals-open-questions"><h3>Decisions needed</h3><ul>{alignment.openQuestions.map((question, i) => <li key={i}>{question}</li>)}</ul></div> : null}
      {confirmIssue && alignment.openQuestions.length ? <p className="goals-condition">Resolve these decisions before confirming the goal.</p> : null}
      {definitionActions}
      </div></details>
      {compactAgreement ? noResults : null}
    </section> : <div className="goals-clarification" aria-label="Clarify goal" data-goal-id={demand.id} data-goal-confirmation-state="unconfirmed">
      <div className="goal-agreement__prompt"><span>Success criteria haven’t been set.</span>{goalRequestButton}</div>
      {goalRequestNote}
    </div>}
    {grounding && !currentReport ? report : !grounding && !compactAgreement && alignment?.confirmedAt ? noResults : null}
  </>

}

function GoalResultCheck({ criterionId, criterion, check, stale, currentCriterion = false }: { criterionId: string; criterion: string; check: DemandGroundingCheck | undefined; stale: boolean; currentCriterion?: boolean }) {
  const [evidenceRead, setEvidenceRead] = useState(false)
  const outcome = stale ? 'stale' : check?.outcome ?? 'missing'
  const Icon = outcome === 'met' ? ThemeStatusCompletedIcon : outcome === 'gap' ? ThemeStatusGapIcon : ThemeStatusUnknownIcon
  const label = { met: 'Reported met', gap: 'Reported gap', unknown: 'Unknown', missing: 'Missing check', stale: 'Needs current check' }[outcome]
  return <div className="goals-result-check" data-goal-criterion-id={criterionId} data-goal-outcome={outcome}>
    <div className="goals-result-check__heading"><strong {...(currentCriterion ? { 'data-goal-success-criterion': criterionId } : {})}>{criterion}</strong><span><Icon size={12} />{label}</span></div>
    {check?.note ? <p className="goals-result-note">{check.note}</p> : null}
    {check?.evidence.length ? <details className="goal-review__evidence" onToggle={event => { if (event.currentTarget.open) setEvidenceRead(true) }}>
      <summary>{check.evidence.length} {check.evidence.length === 1 ? 'evidence reference' : 'evidence references'}</summary>
      {evidenceRead ? <GoalEvidence evidence={check.evidence} criterion={criterion} /> : null}
    </details> : check ? <p className="goals-result-note goals-result-note--missing">No evidence provided.</p> : null}
  </div>
}
