import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useRef } from 'react'
import { alignmentConfirmationIssue, groundingAcceptanceIssue, isCurrentGroundingAccepted, type DemandGroundingCheck } from '@agentmux/demand/goals'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import { useIconFeedback } from '../lib/use-icon-feedback'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { goalResultExplanation } from '../lib/goal-presentation'
import { GoalEvidence } from './GoalEvidence'
import { useGoalDiscussionRecipient } from '../lib/goal-discussion-recipient'
import dialogueArtworkUrl from '../../../../resources/artwork/demand-dialogue.png'

const ThemeObjectGoalIcon = semanticIconComponent('object.goal')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeActionConfirmIcon = semanticIconComponent('action.confirm')
const ThemeActionAcceptResultsIcon = semanticIconComponent('action.accept-results')
const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')
const ThemeStatusGapIcon = semanticIconComponent('status.gap')
const ThemeStatusUnknownIcon = semanticIconComponent('status.unknown')


type Acknowledgement = { kind: 'confirm'; revision: number } | { kind: 'accept'; revision: number; submissionId: string; gaps: boolean; finish?: boolean }
export type GoalAcknowledgementFeedback = { pending: boolean; failure: { attempt: Acknowledgement; message: string } | null; reloadError: string | null }
export const EMPTY_GOAL_ACKNOWLEDGEMENT: GoalAcknowledgementFeedback = { pending: false, failure: null, reloadError: null }
export function GoalAlignment({ demand, onGrill, onGrounding, onOpenMote, motePending = null, feedback, onFeedbackChange }: { demand: DemandProjection; onGrill: () => void; onGrounding: () => void; onOpenMote: () => void; motePending?: 'open' | 'grill' | 'grounding' | null; feedback: GoalAcknowledgementFeedback; onFeedbackChange: (patch: Partial<GoalAcknowledgementFeedback>) => void }) {
  const confirmDemandGoal = useAppStore((state) => state.confirmDemandGoal)
  const acceptDemandResult = useAppStore((state) => state.acceptDemandResult)
  const refreshDemand = useAppStore((state) => state.refreshDemand)
  const recipient = useGoalDiscussionRecipient(demand.id)
  const alignment = demand.alignment, grounding = demand.grounding
  const active = useWorkbenchPresentationActive()
  const heading = useRef<HTMLHeadingElement>(null)
  const cue = useIconFeedback(JSON.stringify([demand.id, alignment?.revision]), active, heading)
  const confirmIssue = alignmentConfirmationIssue(alignment)
  const gapIssue = groundingAcceptanceIssue(alignment, grounding, true)
  const stale = Boolean(alignment && grounding && grounding.alignmentRevision !== alignment.revision)
  const accepted = isCurrentGroundingAccepted(alignment, grounding)
  const hasGaps = Boolean(grounding?.checks.some(check => check.outcome === 'gap'))
  const { pending, failure, reloadError } = feedback
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
  async function reload() {
    if (pending || acknowledgementPending.current) return
    acknowledgementPending.current = true; onFeedbackChange({ pending: true, reloadError: null })
    try { await refreshDemand(demand.id); onFeedbackChange({ failure: null }) }
    catch (error) { onFeedbackChange({ reloadError: error instanceof Error ? error.message : String(error) }) }
    finally { acknowledgementPending.current = false; onFeedbackChange({ pending: false }) }
  }
  const checks = new Map(grounding?.checks.map(check => [check.criterionId, check]) ?? [])
  const resultExplanation = goalResultExplanation(demand)
  const goalRequest = <div className="goals-request-action">
    <img className="goals-request-action__art" src={dialogueArtworkUrl} alt="" aria-hidden="true" onError={(event) => { event.currentTarget.hidden = true }} />
    <div className="goals-request-action__content"><button type="button" className={`goals-button${!failure && (!alignment || confirmIssue) ? ' goals-button--primary' : ''}`} data-goal-grill disabled={Boolean(motePending)} onClick={onGrill}>{motePending === 'grill' ? 'Sending request…' : recipient.requestLabel('grill')}<ThemeActionOpenExternalIcon size={13} /></button><span className="goals-caption">{recipient.description}</span></div>
  </div>
  const resultRequest = alignment?.confirmedAt ? <button type="button" className={`goals-button${!failure && demand.status === 'done' && !grounding ? ' goals-button--primary' : ''}`} data-goal-grounding disabled={Boolean(motePending)} onClick={onGrounding}>{motePending === 'grounding' ? 'Sending request…' : recipient.requestLabel('grounding')}<ThemeActionOpenExternalIcon size={13} /></button> : null
  return <>
    {alignment ? <section className="goals-alignment" aria-label="Goal definition" data-goal-id={demand.id} data-goal-alignment-revision={alignment.revision} data-goal-confirmation-state={alignment.confirmedAt ? 'confirmed' : 'unconfirmed'}>
      <div className="goals-section-heading"><h2 ref={heading}><ThemeObjectGoalIcon key={cue.key} size={14} aria-hidden="true" animation={cue.animation} onAnimationEnd={cue.stop} /> Goal definition</h2><span className="goals-caption">{alignment.confirmedAt ? 'Confirmed by you' : confirmIssue ? alignment.openQuestions.length ? 'Decisions needed' : 'Define success criteria' : 'Needs your confirmation'}</span></div>
      <p className="goals-proposal" data-goal-summary>{alignment.summary}</p>
      <details className="goals-criteria-reading" open={!alignment.confirmedAt} key={`${demand.id}:${alignment.revision}:${Boolean(alignment.confirmedAt)}`}><summary>Success criteria · {alignment.criteria.length}</summary>
      {alignment.criteria.length ? <ol className="goals-criteria">{alignment.criteria.map(criterion => <li key={criterion.id} data-goal-success-criterion={criterion.id}>{criterion.text}</li>)}</ol> : <p className="goals-muted">Define how to recognize success before confirming this goal.</p>}
      </details>
      {alignment.openQuestions.length ? <div className="goals-open-questions"><h3>Decisions needed</h3><ul>{alignment.openQuestions.map((question, i) => <li key={i}>{question}</li>)}</ul></div> : null}
      {confirmIssue && alignment.openQuestions.length ? <p className="goals-condition">Resolve these decisions before confirming the goal.</p> : null}
      <div className="goals-inline-actions">{!failure && !alignment.confirmedAt && !confirmIssue ? <button type="button" className="goals-button goals-button--primary" data-goal-confirm disabled={pending} onClick={() => void acknowledge({ kind: 'confirm', revision: alignment.revision })}>{pending ? 'Saving…' : 'Confirm goal'}<ThemeActionConfirmIcon size={13} /></button> : null}{goalRequest}</div>
    </section> : <div className="goals-clarification" aria-label="Clarify goal" data-goal-id={demand.id} data-goal-confirmation-state="unconfirmed">
      <p className="goals-muted">Clarify the outcome and what success looks like with the agent.</p>{goalRequest}
    </div>}
    {grounding ? <section className="goals-grounding" aria-label="Results review" data-goal-grounding-submission={grounding.submissionId} data-goal-result-state={accepted ? (hasGaps ? 'accepted-with-gaps' : 'accepted') : stale ? 'stale' : 'reported'}>
      <div className="goals-section-heading"><h2>Results review</h2><span className="goals-caption">{accepted ? hasGaps ? 'Accepted with gaps' : 'Accepted by you' : stale ? 'Report needs updating' : 'Agent report · Not accepted yet'}</span></div>
      {stale ? <p className="goals-condition">This report is for the previous goal (v{grounding.alignmentRevision}). Check the current goal (v{alignment!.revision}) again; previous acceptance does not apply.</p> : <p className="goals-proposal" data-goal-result-summary>{grounding.summary}</p>}
      {alignment?.criteria.length ? <div className="goals-result-checks">{alignment.criteria.map(criterion => <GoalResultCheck key={criterion.id} criterionId={criterion.id} criterion={criterion.text} check={stale ? undefined : checks.get(criterion.id)} stale={stale} />)}</div> : <div className="goals-result-checks">{grounding.checks.map(check => <GoalResultCheck key={check.criterionId} criterionId={check.criterionId} criterion={`Reported criterion: ${check.criterionId}`} check={check} stale={false} />)}</div>}
      {stale ? <details className="goals-previous-report"><summary>Previous agent report</summary><p className="goals-proposal">{grounding.summary}</p>{grounding.checks.map(check => <GoalResultCheck key={check.criterionId} criterionId={check.criterionId} criterion={alignment?.criteria.find(criterion => criterion.id === check.criterionId)?.text ?? check.criterionId} check={check} stale={false} />)}</details> : null}
      {!accepted && !stale && resultExplanation ? <p className="goals-condition">{resultExplanation}</p> : null}
      {accepted && hasGaps ? <p className="goals-condition">You accepted this result with the reported gaps. Those gaps remain part of the record.</p> : null}
      {accepted ? <p className="goals-caption" data-goal-completion-state>{demand.status === 'done' ? 'Goal finished · Results and original work are kept.' : 'Results accepted · Goal remains open.'}</p> : null}
      <div className="goals-inline-actions">
        {!failure && alignment && gapIssue === null && demand.status !== 'done' ? <button type="button" className="goals-button goals-button--primary" data-goal-finish disabled={pending} onClick={() => void acknowledge({ kind: 'accept', revision: alignment.revision, submissionId: grounding.submissionId, gaps: hasGaps, finish: true })}>{pending ? 'Saving…' : accepted ? 'Finish goal' : hasGaps ? 'Accept with gaps and finish' : 'Accept and finish'}<ThemeActionAcceptResultsIcon size={13} /></button> : null}
        {!failure && !accepted && alignment && gapIssue === null ? <button type="button" className={`goals-button${demand.status === 'done' ? ' goals-button--primary' : ''}`} {...(hasGaps ? { 'data-goal-accept-gaps': true } : { 'data-goal-accept': true })} disabled={pending} onClick={() => void acknowledge({ kind: 'accept', revision: alignment.revision, submissionId: grounding.submissionId, gaps: hasGaps })}>{pending ? 'Saving…' : hasGaps ? 'Accept results, keep gaps' : 'Accept results'}<ThemeActionAcceptResultsIcon size={13} /></button> : null}
        {resultRequest}
      </div>
      {!accepted && gapIssue === null && demand.status !== 'done' ? <p className="goals-caption">Accept and finish closes this goal and ends its scheduled follow-up. Original Agents keep running. Accept results keeps the goal open.</p> : null}
    </section> : demand.status === 'done' || alignment?.confirmedAt ? <div className="goals-no-results" data-goal-result-state="missing">
      <div className="goals-section-heading"><h2>Results review</h2><span className="goals-caption">No report yet</span></div>
      {demand.status === 'done' ? <><p className="goals-condition"><strong>Results not verified</strong></p><p className="goals-muted">Marked done, but no report has checked the work against success criteria.</p></> : <p className="goals-muted">No result report yet. Start one task with an assigned Agent, or continue the original work. Ask for a result check when work is ready.</p>}
      <div className="goals-inline-actions">{alignment?.confirmedAt ? <button type="button" className="goals-button" disabled={Boolean(motePending)} onClick={onOpenMote} aria-label={`Open discussion for ${demand.title}`}>{motePending === 'open' ? 'Opening discussion…' : recipient.openLabel}<ThemeActionOpenExternalIcon size={13} /></button> : null}{resultRequest}</div>
    </div> : null}
    {failure ? <div className="goals-service" role="status" data-goal-acknowledgement-failure>{failure.attempt.kind === 'confirm' ? 'Goal confirmation' : 'Result acceptance'} is unconfirmed. Your goal and current work are kept. <span>{failure.message}</span><button type="button" className="goals-button goals-button--primary" disabled={pending} onClick={() => void reload()}>Reload current proposal</button>{reloadError ? <span>Reload failed: {reloadError}</span> : null}</div> : null}
  </>

}

function GoalResultCheck({ criterionId, criterion, check, stale }: { criterionId: string; criterion: string; check: DemandGroundingCheck | undefined; stale: boolean }) {
  const outcome = stale ? 'stale' : check?.outcome ?? 'missing'
  const Icon = outcome === 'met' ? ThemeStatusCompletedIcon : outcome === 'gap' ? ThemeStatusGapIcon : ThemeStatusUnknownIcon
  const label = { met: 'Reported met', gap: 'Reported gap', unknown: 'Unknown', missing: 'Missing check', stale: 'Needs current check' }[outcome]
  return <div className="goals-result-check" data-goal-criterion-id={criterionId} data-goal-outcome={outcome}>
    <div className="goals-result-check__heading"><strong>{criterion}</strong><span><Icon size={12} />{label}</span></div>
    {check?.note ? <p className="goals-result-note">{check.note}</p> : null}
    {check?.evidence.length ? <GoalEvidence evidence={check.evidence} criterion={criterion} /> : check ? <p className="goals-result-note goals-result-note--missing">No evidence provided.</p> : null}
  </div>
}
