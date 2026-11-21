import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useRef, useState } from 'react'
import { alignmentConfirmationIssue, groundingAcceptanceIssue, isCurrentGroundingAccepted, type DemandGroundingCheck, type UnknownGoalResult } from '@agentmux/demand/goals'
import { currentGoalConfirmationNotice, type GoalConfirmationRecipient } from '@agentmux/demand/goal-patrol'
import { Button } from '@agentmux/client-ui/components/Button'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import { useIconFeedback } from '../lib/use-icon-feedback'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { goalNextStepFact, goalResultExplanation, goalUnknownResultsForClosure } from '../lib/goal-presentation'
import { GoalEvidence } from './GoalEvidence'
import { GoalConfirmationSupervisorAvatar, useGoalConfirmationSupervisor } from './GoalAgentGroup'
import { refreshGoalDelegations } from '../lib/goal-delegation-work'
import { useGoalDiscussionRecipient } from '../lib/goal-discussion-recipient'
import { ConfirmationDialog } from './ConfirmationDialog'
import '../styles/goal-review.css'

const ThemeObjectGoalIcon = semanticIconComponent('object.goal')
const ThemeActionConfirmIcon = semanticIconComponent('action.confirm')
const ThemeActionAcceptResultsIcon = semanticIconComponent('action.accept-results')
const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')
const ThemeStatusGapIcon = semanticIconComponent('status.gap')
const ThemeStatusUnknownIcon = semanticIconComponent('status.unknown')


type Acknowledgement = { kind: 'confirm'; revision: number; continueWith?: GoalConfirmationRecipient } | { kind: 'accept'; revision: number; submissionId: string; gaps: boolean; finish?: boolean; unknownResults?: UnknownGoalResult[] }
type CloseoutDraft = { revision: number; submissionId: string; gaps: boolean; checks: { criterionId: string; text: string; note: string; reason: string }[] }
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

export function GoalAlignment({ demand, emphasis, onGrill, onGrounding, motePending = null, feedback, onFeedbackChange }: { demand: DemandProjection; emphasis?: 'definition' | 'results' | null; onGrill: () => void; onGrounding: () => void; motePending?: 'open' | 'grill' | 'grounding' | 'plan' | null; feedback: GoalAcknowledgementFeedback; onFeedbackChange: (patch: Partial<GoalAcknowledgementFeedback>) => void }) {
  const confirmDemandGoal = useAppStore((state) => state.confirmDemandGoal)
  const acceptDemandResult = useAppStore((state) => state.acceptDemandResult)
  const recipient = useGoalDiscussionRecipient(demand.id)
  const alignment = demand.alignment, grounding = demand.grounding
  const active = useWorkbenchPresentationActive()
  const heading = useRef<HTMLHeadingElement>(null)
  const cue = useIconFeedback(JSON.stringify([demand.id, alignment?.revision]), active, heading)
  const focus = emphasis === undefined ? goalNextStepFact(demand).source.kind : emphasis
  const confirmIssue = alignmentConfirmationIssue(alignment)
  const supervisor = useGoalConfirmationSupervisor(demand, active && Boolean(demand.address && alignment && !alignment.confirmedAt && !confirmIssue &&
    demand.status !== 'done' && demand.status !== 'cancelled'))
  const confirmation = currentGoalConfirmationNotice(demand)
  const notification = confirmation && demand.patrolObservations?.find(item => item.operationId === confirmation.operationId)
  const gapIssue = groundingAcceptanceIssue(alignment, grounding, true)
  const stale = Boolean(alignment && grounding && grounding.alignmentRevision !== alignment.revision)
  const accepted = isCurrentGroundingAccepted(alignment, grounding)
  const hasGaps = Boolean(grounding?.checks.some(check => check.outcome === 'gap'))
  const unknown = goalUnknownResultsForClosure(demand)
  const canCloseWithUnknown = unknown.length > 0
  const [closing, setClosing] = useState(false)
  const [closeout, setCloseout] = useState<CloseoutDraft>()
  const currentCloseout = canCloseWithUnknown && closeout?.revision === alignment?.revision && closeout?.submissionId === grounding?.submissionId
  function openCloseout() {
    if (!canCloseWithUnknown || !alignment || !grounding) return
    if (!currentCloseout) setCloseout({ revision: alignment.revision, submissionId: grounding.submissionId, gaps: hasGaps,
      checks: unknown.map(check => ({ criterionId: check.criterionId, note: check.note, reason: '',
        text: alignment.criteria.find(item => item.id === check.criterionId)!.text })) })
    setClosing(true)
  }
  const { pending, failure } = feedback
  const acknowledgementPending = useRef(false)
  async function acknowledge(attempt: Acknowledgement) {
    if (failure || pending || acknowledgementPending.current) return
    acknowledgementPending.current = true; onFeedbackChange({ pending: true, failure: null, reloadError: null })
    try {
      if (attempt.kind === 'confirm') {
        await confirmDemandGoal(demand.id, attempt.revision, attempt.continueWith)
        const confirmed = useAppStore.getState().demands[demand.id]?.alignment
        // Decoration consumes the original owner result; it never grants confirmation.
        if (confirmed?.revision === attempt.revision && confirmed.confirmedAt != null) {
          cue.play(JSON.stringify([demand.id, attempt.revision]), 'confirm')
        }
      }
      else await acceptDemandResult(demand.id, attempt.revision, attempt.submissionId, attempt.gaps, attempt.finish, attempt.unknownResults)
    } catch (error) { onFeedbackChange({ failure: { attempt, message: error instanceof Error ? error.message : String(error) } }) }
    finally { acknowledgementPending.current = false; onFeedbackChange({ pending: false }) }
  }
  const checks = new Map(grounding?.checks.map(check => [check.criterionId, check]) ?? [])
  const currentReport = Boolean(alignment && grounding && !stale)
  const compactAgreement = Boolean(alignment?.confirmedAt && !confirmIssue && !grounding && demand.status !== 'done' && !failure)
  const agentConfirmer = alignment?.confirmedBy?.kind === 'agent' ? alignment.confirmedBy : undefined
  const criterionIds = new Set(alignment?.criteria.map(criterion => criterion.id))
  const extraChecks = grounding?.checks.filter(check => !criterionIds.has(check.criterionId)) ?? []
  const resultExplanation = goalResultExplanation(demand)
  const missingDoneReport = demand.status === 'done' && !grounding
  const needsDefinition = focus === 'definition' || focus === 'results' && missingDoneReport && !alignment?.confirmedAt
  const useBrief = missingDoneReport && !alignment && Boolean(demand.description.trim())
  const goalRequestButton = <button type="button" className={!failure && needsDefinition && (!alignment || confirmIssue) ? 'primary-button' : 'small-button'} data-goal-grill disabled={Boolean(motePending)} onClick={onGrill}>{motePending === 'grill' ? 'Sending request…' : useBrief ? 'Draft criteria from brief' : recipient.requestLabel('grill')}</button>
  const goalRequestNote = <span className="goals-request-action goals-caption">{recipient.description}</span>
  const resultRequest = alignment?.confirmedAt ? <button type="button" className={!failure && focus === 'results' && demand.status === 'done' && !grounding ? 'primary-button' : 'small-button'} data-goal-grounding disabled={Boolean(motePending)} onClick={onGrounding}>{motePending === 'grounding' ? 'Sending request…' : recipient.requestLabel('grounding')}</button> : null
  const unknownDecision = grounding?.unknownDecision
  const closingReasons = new Map(unknownDecision?.checks.map(check => [check.criterionId, check.reason]))
  const reportCaption = accepted ? unknownDecision ? 'Closed with unverified results' : hasGaps ? 'Accepted with gaps' : 'Accepted by you' : stale ? 'Report needs updating' : 'Agent report · Not accepted yet'
  const reportState = accepted ? unknownDecision ? 'closed-unverified' : hasGaps ? 'accepted-with-gaps' : 'accepted' : stale ? 'stale' : 'reported'
  const reportActions = grounding ? <>
    {!accepted && !stale && resultExplanation ? <p className="goals-condition">{canCloseWithUnknown ? 'Request another check, or close the Goal if the missing evidence cannot be recovered.' : resultExplanation}</p> : null}
    {accepted && hasGaps ? <p className="goals-condition">You accepted this result with the reported gaps. Those gaps remain part of the record.</p> : null}
    {accepted ? <p className="goals-caption" data-goal-completion-state>{demand.status === 'done' ? 'Goal finished · Results and original work are kept.' : 'Results accepted · Goal remains open.'}</p> : null}
    <div className="goals-inline-actions">
      {!failure && alignment && gapIssue === null && demand.status !== 'done' ? <button type="button" className={focus === 'results' ? 'primary-button' : 'small-button'} data-goal-finish disabled={pending} onClick={() => void acknowledge({ kind: 'accept', revision: alignment.revision, submissionId: grounding.submissionId, gaps: hasGaps, finish: true })}>{pending ? 'Saving…' : accepted ? 'Finish goal' : hasGaps ? 'Accept with gaps and finish' : 'Accept and finish'}<ThemeActionAcceptResultsIcon size={13} /></button> : null}
      {!failure && !accepted && alignment && gapIssue === null ? <button type="button" className={focus === 'results' && demand.status === 'done' ? 'primary-button' : 'small-button'} {...(hasGaps ? { 'data-goal-accept-gaps': true } : { 'data-goal-accept': true })} disabled={pending} onClick={() => void acknowledge({ kind: 'accept', revision: alignment.revision, submissionId: grounding.submissionId, gaps: hasGaps })}>{pending ? 'Saving…' : hasGaps ? 'Accept results, keep gaps' : 'Accept results'}<ThemeActionAcceptResultsIcon size={13} /></button> : null}
      {!failure && canCloseWithUnknown ? <Button type="button" disabled={pending} onClick={openCloseout}>Close with unverified results</Button> : null}
      {resultRequest}
    </div>
    {!accepted && gapIssue === null && demand.status !== 'done' ? <p className="goals-caption">Accept and finish also closes the goal.</p> : null}
  </> : null
  const definitionActions = <div className="goals-inline-actions">
    {!failure && alignment && !alignment.confirmedAt && !confirmIssue ? <button type="button" className={needsDefinition ? 'primary-button' : 'small-button'} data-goal-confirm disabled={pending}
      aria-label={pending || !supervisor ? undefined : `Confirm goal and let ${supervisor.name ?? supervisor.label} continue`}
      onClick={() => {
        const target = supervisor?.subject
        void acknowledge({ kind: 'confirm', revision: alignment.revision, ...(target ? { continueWith: { hostId: target.hostId, agentSessionId: target.agentSessionId } } : {}) })
      }}>{pending ? 'Saving…' : supervisor ? <>Confirm goal and let <GoalConfirmationSupervisorAvatar face={supervisor} /> continue</>
        : <>Confirm goal<ThemeActionConfirmIcon size={13} /></>}</button> : null}
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
      {reportCounts.unchecked ? <span><ThemeStatusUnknownIcon size={13} aria-hidden="true" />{reportCounts.unchecked} {unknownDecision || canCloseWithUnknown ? 'unverified' : 'need checking'}</span> : null}
    </p> : null}
    {demand.status === 'in_review' ? reportActions : null}
    <details className={`goal-review__disclosure${stale ? ' goals-previous-report' : ''}`}>
      <summary>{stale ? `Previous report · v${grounding.alignmentRevision}` : currentReport && !alignment!.confirmedAt ? 'Review success criteria' : 'Criteria and evidence'}</summary>
      <div className="goal-review__body">
        {currentReport ? <p className="goals-proposal" data-goal-summary>{alignment!.summary}</p> : stale ? <p className="goals-proposal">{grounding.summary}</p> : null}
        {currentReport ? <>
          <div className="goals-result-checks">{resultChecks.map(criterion => <GoalResultCheck key={criterion.id} criterionId={criterion.id} criterion={criterion.text} check={criterion.check} stale={false} currentCriterion closingReason={closingReasons.get(criterion.id)} />)}</div>
          {extraChecks.length ? <div className="goal-review__extra-checks"><h3>Additional reported checks</h3>{extraChecks.map(check => <GoalResultCheck key={check.criterionId} criterionId={check.criterionId} criterion={`Reported criterion: ${check.criterionId}`} check={check} stale={false} />)}</div> : null}
          {alignment!.openQuestions.length ? <div className="goals-open-questions"><h3>Decisions needed</h3><ul>{alignment!.openQuestions.map((question, i) => <li key={i}>{question}</li>)}</ul></div> : null}
          {definitionActions}
        </> : grounding.checks.map(check => <GoalResultCheck key={check.criterionId} criterionId={check.criterionId} criterion={`Reported criterion: ${check.criterionId}`} check={check} stale={false} closingReason={closingReasons.get(check.criterionId)} />)}
      </div>
    </details>
    {demand.status !== 'in_review' ? reportActions : null}
  </section> : null
  const noResults = <div className={`goals-no-results${compactAgreement ? ' goal-review__no-results--compact' : ''}`} data-goal-result-state="missing">
    {!compactAgreement && !missingDoneReport ? <div className="goals-section-heading"><h2>Results review</h2><span className="goals-caption">No report yet</span></div> : null}
    {missingDoneReport ? <p className="goals-muted">Ask the agent to check the finished work against the confirmed criteria.</p>
      : !confirmation ? <p className="goals-muted">Agents work on this goal next. Ask for a result check when the work is ready.</p> : null}
    {resultRequest ? <div className="goals-inline-actions">{resultRequest}</div> : null}
  </div>
  return <>
    {closing && closeout ? <ConfirmationDialog open title="Close with unverified results?" intent="neutral" busy={pending}
      description={closeout.gaps ? 'Explain why each unknown cannot be verified. Closing keeps the unknown results and the reported gaps.' : 'Explain why each unknown cannot be verified. Closing keeps these results marked unknown.'}
      confirmLabel="Keep unknowns and close" confirmDisabled={!currentCloseout || Boolean(failure) || closeout.checks.some(check => !check.reason.trim())}
      onCancel={() => setClosing(false)} onConfirm={() => {
        if (!currentCloseout) return
        const unknownResults = closeout.checks.map(({ criterionId, reason }) => ({ criterionId, reason: reason.trim() }))
        void acknowledge({ kind: 'accept', revision: closeout.revision, submissionId: closeout.submissionId, gaps: closeout.gaps, finish: true, unknownResults })
          .finally(() => setClosing(false))
      }} feedback={<div className="goal-closeout__checks">
        {!currentCloseout && !pending ? <p role="status">The report changed. Return to results to review the current version.</p> : null}
        {closeout.checks.map(check => <div key={check.criterionId}>
          <strong>{check.text}</strong>
          {check.note ? <p>{check.note}</p> : null}
          <label>Reason for closing<textarea aria-label={`Reason for closing: ${check.text}`} rows={2} disabled={pending || !currentCloseout}
            value={check.reason} onChange={event => {
              const reason = event.target.value
              setCloseout(draft => draft && { ...draft, checks: draft.checks.map(item => item.criterionId === check.criterionId ? { ...item, reason } : item) })
            }} /></label>
        </div>)}
      </div>} /> : null}
    {confirmation ? <div className="goal-review__notification" data-goal-confirmation-notification={notification?.state ?? 'checking'}>
      <span role="status" title={notification?.reason}>{notification?.state === 'delivered' ? notification.reason
        : notification?.state === 'stale' ? notification.reason
        : notification?.state === 'unknown' || demand.delegationObservationIssue ? 'Goal confirmed · Supervisor notification unconfirmed'
        : 'Goal confirmed · Waiting to notify Supervisor'}</span>
      {notification?.state !== 'delivered' && notification?.state !== 'stale' ? <Button type="button" onClick={() => void refreshGoalDelegations(demand.id)}>Check notification</Button> : null}
    </div> : null}
    {currentReport ? report : alignment ? <section className={`goals-alignment goal-review${compactAgreement ? ' goal-review--compact' : ''}`} aria-label="Goal definition" data-goal-id={demand.id} data-goal-alignment-revision={alignment.revision} data-goal-confirmation-state={alignment.confirmedAt ? 'confirmed' : 'unconfirmed'}>
      <details className="goal-review__disclosure" open={!compactAgreement}>
      <summary className="goals-section-heading"><h2 ref={heading}><ThemeObjectGoalIcon key={cue.key} size={14} aria-hidden="true" animation={cue.animation} onAnimationEnd={cue.stop} />Goal definition</h2><span className="goals-caption" title={agentConfirmer ? `Confirmed by Agent ${agentConfirmer.id} on ${agentConfirmer.hostId}` : undefined}>{alignment.confirmedAt ? `${agentConfirmer ? 'Confirmed by Agent' : 'Goal confirmed'} · ${alignment.criteria.length} success criteria${compactAgreement ? ' · No report yet' : ''}` : confirmIssue ? alignment.openQuestions.length ? 'Decisions needed' : 'Define success criteria' : demand.supervisorSessionId ? 'Ready for Supervisor confirmation' : 'Ready for confirmation'}</span></summary>
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

function GoalResultCheck({ criterionId, criterion, check, stale, closingReason, currentCriterion = false }: { criterionId: string; criterion: string; check: DemandGroundingCheck | undefined; stale: boolean; closingReason?: string | undefined; currentCriterion?: boolean }) {
  const [evidenceRead, setEvidenceRead] = useState(false)
  const outcome = stale ? 'stale' : check?.outcome ?? 'missing'
  const Icon = outcome === 'met' ? ThemeStatusCompletedIcon : outcome === 'gap' ? ThemeStatusGapIcon : ThemeStatusUnknownIcon
  const label = { met: 'Reported met', gap: 'Reported gap', unknown: 'Unknown', missing: 'Missing check', stale: 'Needs current check' }[outcome]
  return <div className="goals-result-check" data-goal-criterion-id={criterionId} data-goal-outcome={outcome}>
    <div className="goals-result-check__heading"><strong {...(currentCriterion ? { 'data-goal-success-criterion': criterionId } : {})}>{criterion}</strong><span><Icon size={12} />{label}</span></div>
    {check?.note ? <p className="goals-result-note">{check.note}</p> : null}
    {closingReason ? <p className="goals-result-note"><strong>Reason for closing</strong> {closingReason}</p> : null}
    {check?.evidence.length ? <details className="goal-review__evidence" onToggle={event => { if (event.currentTarget.open) setEvidenceRead(true) }}>
      <summary>{check.evidence.length} {check.evidence.length === 1 ? 'evidence reference' : 'evidence references'}</summary>
      {evidenceRead ? <GoalEvidence evidence={check.evidence} criterion={criterion} /> : null}
    </details> : check ? <p className="goals-result-note goals-result-note--missing">No evidence provided.</p> : null}
  </div>
}
