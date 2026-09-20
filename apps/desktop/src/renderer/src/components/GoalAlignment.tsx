import { ArrowUpRight, Check, CircleHelp, Minus } from 'lucide-react'
import { useRef, useState } from 'react'
import { alignmentConfirmationIssue, groundingAcceptanceIssue, isDemandEvidenceReference, type DemandGroundingCheck } from '@agentmux/demand/goals'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import { resolveWorkspaceRelativePath } from '../lib/terminal-path-link'
import { parseHttpLinkUrl } from '../lib/open-destination'
import { api } from '../lib/api'

type Acknowledgement = { kind: 'confirm'; revision: number } | { kind: 'accept'; revision: number; submissionId: string; gaps: boolean }
export type GoalAcknowledgementFeedback = { pending: boolean; failure: { attempt: Acknowledgement; message: string } | null; reloadError: string | null }
export const EMPTY_GOAL_ACKNOWLEDGEMENT: GoalAcknowledgementFeedback = { pending: false, failure: null, reloadError: null }
export function GoalAlignment({ demand, onGrill, onGrounding, motePending = false, feedback, onFeedbackChange }: { demand: DemandProjection; onGrill: () => void; onGrounding: () => void; motePending?: boolean; feedback: GoalAcknowledgementFeedback; onFeedbackChange: (patch: Partial<GoalAcknowledgementFeedback>) => void }) {
  const confirmDemandGoal = useAppStore((state) => state.confirmDemandGoal)
  const acceptDemandResult = useAppStore((state) => state.acceptDemandResult)
  const refreshDemand = useAppStore((state) => state.refreshDemand)
  const alignment = demand.alignment, grounding = demand.grounding
  const confirmIssue = alignmentConfirmationIssue(alignment)
  const acceptIssue = groundingAcceptanceIssue(alignment, grounding)
  const gapIssue = groundingAcceptanceIssue(alignment, grounding, true)
  const stale = Boolean(grounding && grounding.alignmentRevision !== alignment?.revision)
  const accepted = Boolean(grounding?.acceptedAt && gapIssue === null)
  const hasGaps = Boolean(grounding?.checks.some(check => check.outcome === 'gap'))
  const { pending, failure, reloadError } = feedback
  const acknowledgementPending = useRef(false)
  async function acknowledge(attempt: Acknowledgement) {
    if (pending || acknowledgementPending.current) return
    acknowledgementPending.current = true; onFeedbackChange({ pending: true, failure: null, reloadError: null })
    try {
      if (attempt.kind === 'confirm') await confirmDemandGoal(demand.id, attempt.revision)
      else await acceptDemandResult(demand.id, attempt.revision, attempt.submissionId, attempt.gaps)
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
  const failureStillCurrent = failure && failure.attempt.revision === alignment?.revision && (failure.attempt.kind === 'confirm' || failure.attempt.submissionId === grounding?.submissionId)
  const checks = new Map(grounding?.checks.map(check => [check.criterionId, check]) ?? [])
  return <>
    <section className="goals-alignment" aria-label="Grill: align the goal" data-goal-id={demand.id} data-goal-alignment-revision={alignment?.revision} data-goal-confirmation-state={alignment?.confirmedAt ? 'confirmed' : 'unconfirmed'}>
      <div className="goals-section-heading"><h2>Grill <span>Align the goal</span></h2><span className="goals-caption">{alignment ? `v${alignment.revision} · ${alignment.confirmedAt ? 'Confirmed by you' : 'Not confirmed'}` : 'Not proposed'}</span></div>
      {alignment ? <>
        <p className="goals-proposal" data-goal-summary>{alignment.summary}</p>
        <h3>Success criteria</h3>
        {alignment.criteria.length ? <ol className="goals-criteria">{alignment.criteria.map(criterion => <li key={criterion.id} data-goal-success-criterion={criterion.id}>{criterion.text}</li>)}</ol> : <p className="goals-muted">No success criteria have been proposed yet.</p>}
        {alignment.openQuestions.length ? <div className="goals-open-questions"><h3>Decisions still needed</h3><ul>{alignment.openQuestions.map((question, i) => <li key={i}>{question}</li>)}</ul></div> : null}
        {confirmIssue ? <p className="goals-condition">{confirmIssue}</p> : null}
        <div className="goals-inline-actions">{!alignment.confirmedAt && !confirmIssue ? <button type="button" className="goals-button goals-button--primary" data-goal-confirm disabled={pending} onClick={() => void acknowledge({ kind: 'confirm', revision: alignment.revision })}>{pending ? 'Saving…' : 'Confirm goal'}<Check size={13} /></button> : null}<button type="button" className="goals-button" data-goal-grill disabled={motePending} onClick={onGrill}>{motePending ? 'Opening Mote…' : 'Discuss the goal'}<ArrowUpRight size={13} /></button></div>
      </> : <><p className="goals-muted">Discuss the outcome and the choices that change it. Mote will propose a goal and success criteria here.</p><button type="button" className="goals-button" data-goal-grill disabled={motePending} onClick={onGrill}>{motePending ? 'Opening Mote…' : 'Discuss the goal'}<ArrowUpRight size={13} /></button></>}
    </section>
    <section className="goals-grounding" aria-label="Grounding: verify the result" data-goal-grounding-submission={grounding?.submissionId} data-goal-result-state={accepted ? (hasGaps ? 'accepted-with-gaps' : 'accepted') : stale ? 'stale' : grounding ? 'reported' : 'missing'}>
      <div className="goals-section-heading"><h2>Grounding <span>Verify the result</span></h2><span className="goals-caption">{accepted ? hasGaps ? 'Accepted · gaps kept' : 'Accepted by you' : grounding ? stale ? `Previous goal v${grounding.alignmentRevision}` : 'Agent report · not accepted' : 'Not submitted'}</span></div>
      {grounding ? <>
        {stale ? <p className="goals-condition">These results are for goal v{grounding.alignmentRevision}. Current goal v{alignment?.revision} needs a new check; previous acceptance does not apply.</p> : <p className="goals-proposal" data-goal-result-summary>{grounding.summary}</p>}
        {alignment?.criteria.length ? <div className="goals-result-checks">{alignment.criteria.map(criterion => <GoalResultCheck key={criterion.id} criterionId={criterion.id} criterion={criterion.text} check={stale ? undefined : checks.get(criterion.id)} demand={demand} stale={stale} />)}</div> : <p className="goals-condition">There are no current success criteria to check.</p>}
        {stale ? <details className="goals-previous-report"><summary>Previous Agent report</summary><p className="goals-proposal">{grounding.summary}</p>{grounding.checks.map(check => <GoalResultCheck key={check.criterionId} criterionId={check.criterionId} criterion={alignment?.criteria.find(criterion => criterion.id === check.criterionId)?.text ?? check.criterionId} check={check} demand={demand} stale={false} />)}</details> : null}
        {!accepted && acceptIssue ? <p className="goals-condition">{acceptIssue}</p> : null}
        {accepted && hasGaps ? <p className="goals-condition">You accepted this result with the reported gaps. Those gaps remain part of the record.</p> : null}
        <div className="goals-inline-actions">{!accepted && alignment && !acceptIssue ? <button type="button" className="goals-button goals-button--primary" data-goal-accept disabled={pending} onClick={() => void acknowledge({ kind: 'accept', revision: alignment.revision, submissionId: grounding.submissionId, gaps: false })}>{pending ? 'Saving…' : 'Accept results'}<Check size={13} /></button> : !accepted && alignment && gapIssue === null ? <button type="button" className="goals-button goals-button--primary" data-goal-accept-gaps disabled={pending} onClick={() => void acknowledge({ kind: 'accept', revision: alignment.revision, submissionId: grounding.submissionId, gaps: true })}>{pending ? 'Saving…' : 'Accept results, keep gaps'}</button> : null}{alignment?.confirmedAt ? <button type="button" className="goals-button" data-goal-grounding disabled={motePending} onClick={onGrounding}>{motePending ? 'Opening Mote…' : accepted ? 'Check again' : 'Check results'}<ArrowUpRight size={13} /></button> : null}</div>
      </> : <><p className="goals-muted">{demand.status === 'done' ? 'Marked done, but no result has been checked against agreed success criteria.' : alignment?.confirmedAt ? 'The goal is agreed. Ask Mote to check the work against these success criteria.' : 'Agree on the goal before reviewing the result.'}</p>{alignment?.confirmedAt ? <button type="button" className="goals-button" data-goal-grounding disabled={motePending} onClick={onGrounding}>{motePending ? 'Opening Mote…' : 'Check results'}<ArrowUpRight size={13} /></button> : null}</>}
    </section>
    {failure ? <div className="goals-service" role="status" data-goal-acknowledgement-failure>{failure.attempt.kind === 'confirm' ? 'Goal confirmation' : 'Result acceptance'} is unconfirmed. Your goal and current work are kept. <span>{failure.message}</span><button type="button" className="goals-button" disabled={pending} onClick={() => void reload()}>Reload current proposal</button>{failureStillCurrent ? <button type="button" className="goals-button" disabled={pending} onClick={() => void acknowledge(failure.attempt)}>Retry {failure.attempt.kind === 'confirm' ? 'confirmation' : 'acceptance'}</button> : <span>The proposal changed. Review the current content before choosing again.</span>}{reloadError ? <span>Reload failed: {reloadError}</span> : null}</div> : null}
  </>
}

function GoalResultCheck({ criterionId, criterion, check, demand, stale }: { criterionId: string; criterion: string; check: DemandGroundingCheck | undefined; demand: DemandProjection; stale: boolean }) {
  const workspace = useAppStore((state) => state.config?.workspaces.find(project => project.id === demand.projectId))
  const openFile = useAppStore((state) => state.openFile)
  const openHttpLink = useAppStore((state) => state.openHttpLink)
  const [openingError, setOpeningError] = useState<string | null>(null)
  const outcome = stale ? 'stale' : check?.outcome ?? 'missing'
  const Icon = outcome === 'met' ? Check : outcome === 'gap' ? Minus : CircleHelp
  const label = { met: 'Reported met', gap: 'Reported gap', unknown: 'Unknown', missing: 'Missing check', stale: 'Needs current check' }[outcome]
  async function openEvidence(reference: string) {
    setOpeningError(null)
    try {
      const http = parseHttpLinkUrl(reference)
      if (http) {
        if (workspace) {
          if (!useAppStore.getState().layouts[workspace.id]) await useAppStore.getState().selectWorkspace(workspace.id)
          await openHttpLink({ workspaceId: workspace.id, tabGroupId: useAppStore.getState().layouts[workspace.id]!.activeGroupId }, http, 'tab')
        }
        else await api.ui.openExternal(http)
        return
      }
      if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(reference) && !reference.startsWith('file://')) { await api.ui.openExternal(reference); return }
      const match = reference.match(/^(.*?)(?::([1-9]\d*)(?::([1-9]\d*))?)?$/u)!
      const raw = match[1]!.startsWith('file://') ? decodeURIComponent(new URL(match[1]!).pathname) : match[1]!
      if (!workspace) throw new Error('Choose the goal’s Project in More properties to open local evidence, or copy its location.')
      const path = resolveWorkspaceRelativePath(raw, workspace.path)
      if (!path) throw new Error('This reference is outside the goal’s Project. Copy its location to inspect it in its own workspace.')
      const location = match[2] ? { line: Number(match[2]), ...(match[3] ? { column: Number(match[3]) } : {}) } : undefined
      if (!useAppStore.getState().layouts[workspace.id]) await useAppStore.getState().selectWorkspace(workspace.id)
      if (!await openFile(path, undefined, location, workspace.id)) throw new Error('The evidence could not be opened. Its contents remain unverified here.')
    } catch (error) { setOpeningError(error instanceof Error ? error.message : String(error)) }
  }
  return <div className="goals-result-check" data-goal-criterion-id={criterionId} data-goal-outcome={outcome}>
    <div className="goals-result-check__heading"><strong>{criterion}</strong><span><Icon size={12} />{label}</span></div>
    {check?.note ? <p className="goals-result-note">{check.note}</p> : null}
    {check?.evidence.length ? <div className="goals-evidence" aria-label={`Reported evidence for ${criterion}`}>{check.evidence.map((reference, index) => <span key={index}><button type="button" className="goals-evidence__open" title={reference} disabled={!isDemandEvidenceReference(reference)} onClick={() => void openEvidence(reference)}>{reference.replace(/^.*\//u, '') || reference}<ArrowUpRight size={11} /></button><button type="button" className="goals-evidence__copy" aria-label={`Copy evidence location ${reference}`} title="Copy full location" onClick={() => void api.ui.writeClipboardText(reference).catch(error => setOpeningError(String(error)))}>Copy</button></span>)}</div> : check ? <p className="goals-result-note goals-result-note--missing">No evidence provided.</p> : null}
    {openingError ? <p className="goals-service" role="status">Reference could not be opened or copied. The reported result is preserved; its contents have not been verified here. <span>{openingError}</span></p> : null}
  </div>
}
