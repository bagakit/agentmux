import { ArrowUpRight, Check, CircleHelp, Minus } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { alignmentConfirmationIssue, groundingAcceptanceIssue, isDemandEvidenceReference, type DemandGroundingCheck } from '@agentmux/demand/goals'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import { resolveWorkspaceRelativePath } from '../lib/terminal-path-link'
import { parseHttpLinkUrl } from '../lib/open-destination'
import { api } from '../lib/api'
import { goalResultExplanation } from '../lib/goal-presentation'
import { projectWorkspaces } from '../lib/workspace-projects'
import type { WorkspaceRecord } from '../../../shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'

type Acknowledgement = { kind: 'confirm'; revision: number } | { kind: 'accept'; revision: number; submissionId: string; gaps: boolean }
export type GoalAcknowledgementFeedback = { pending: boolean; failure: { attempt: Acknowledgement; message: string } | null; reloadError: string | null }
export const EMPTY_GOAL_ACKNOWLEDGEMENT: GoalAcknowledgementFeedback = { pending: false, failure: null, reloadError: null }
export function GoalAlignment({ demand, onGrill, onGrounding, onOpenMote, motePending = null, feedback, onFeedbackChange }: { demand: DemandProjection; onGrill: () => void; onGrounding: () => void; onOpenMote: () => void; motePending?: 'open' | 'grill' | 'grounding' | null; feedback: GoalAcknowledgementFeedback; onFeedbackChange: (patch: Partial<GoalAcknowledgementFeedback>) => void }) {
  const confirmDemandGoal = useAppStore((state) => state.confirmDemandGoal)
  const acceptDemandResult = useAppStore((state) => state.acceptDemandResult)
  const refreshDemand = useAppStore((state) => state.refreshDemand)
  const workspaces = useAppStore((state) => state.config?.workspaces)
  const workspace = useMemo(() => {
    const project = projectWorkspaces((workspaces ?? []).filter(workspace => workspace.id !== SCRATCH_WORKSPACE_ID)).find(project => project.id === demand.projectId)
    return workspaces?.find(workspace => workspace.id === project?.preferredWorkspaceId)
  }, [workspaces, demand.projectId])
  const alignment = demand.alignment, grounding = demand.grounding
  const confirmIssue = alignmentConfirmationIssue(alignment)
  const acceptIssue = groundingAcceptanceIssue(alignment, grounding)
  const gapIssue = groundingAcceptanceIssue(alignment, grounding, true)
  const stale = Boolean(alignment && grounding && grounding.alignmentRevision !== alignment.revision)
  const accepted = Boolean(grounding?.acceptedAt && gapIssue === null)
  const hasGaps = Boolean(grounding?.checks.some(check => check.outcome === 'gap'))
  const { pending, failure, reloadError } = feedback
  const acknowledgementPending = useRef(false)
  async function acknowledge(attempt: Acknowledgement) {
    if (failure || pending || acknowledgementPending.current) return
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
  const checks = new Map(grounding?.checks.map(check => [check.criterionId, check]) ?? [])
  const resultExplanation = goalResultExplanation(demand)
  const goalRequest = <div className="goals-request-action"><button type="button" className={`goals-button${!failure && (!alignment || confirmIssue) ? ' goals-button--primary' : ''}`} data-goal-grill disabled={Boolean(motePending)} onClick={onGrill}>{motePending === 'grill' ? 'Sending request…' : alignment ? 'Discuss changes' : 'Clarify goal'}<ArrowUpRight size={13} /></button><span className="goals-caption">Sends a goal request to the agent.</span></div>
  const resultRequest = alignment?.confirmedAt ? <button type="button" className="goals-button" data-goal-grounding disabled={Boolean(motePending)} onClick={onGrounding}>{motePending === 'grounding' ? 'Sending request…' : grounding ? 'Ask agent to check again' : 'Ask agent to check work'}<ArrowUpRight size={13} /></button> : null
  return <>
    {alignment ? <section className="goals-alignment" aria-label="Goal definition" data-goal-id={demand.id} data-goal-alignment-revision={alignment.revision} data-goal-confirmation-state={alignment.confirmedAt ? 'confirmed' : 'unconfirmed'}>
      <div className="goals-section-heading"><h2>Goal definition</h2><span className="goals-caption">{alignment.confirmedAt ? 'Confirmed by you' : confirmIssue ? alignment.openQuestions.length ? 'Decisions needed' : 'Define success criteria' : 'Needs your confirmation'}</span></div>
      <p className="goals-proposal" data-goal-summary>{alignment.summary}</p>
      <h3>Success criteria</h3>
      {alignment.criteria.length ? <ol className="goals-criteria">{alignment.criteria.map(criterion => <li key={criterion.id} data-goal-success-criterion={criterion.id}>{criterion.text}</li>)}</ol> : <p className="goals-muted">Define how to recognize success before confirming this goal.</p>}
      {alignment.openQuestions.length ? <div className="goals-open-questions"><h3>Decisions needed</h3><ul>{alignment.openQuestions.map((question, i) => <li key={i}>{question}</li>)}</ul></div> : null}
      {confirmIssue && alignment.openQuestions.length ? <p className="goals-condition">Resolve these decisions before confirming the goal.</p> : null}
      <div className="goals-inline-actions">{!failure && !alignment.confirmedAt && !confirmIssue ? <button type="button" className="goals-button goals-button--primary" data-goal-confirm disabled={pending} onClick={() => void acknowledge({ kind: 'confirm', revision: alignment.revision })}>{pending ? 'Saving…' : 'Confirm goal'}<Check size={13} /></button> : null}{goalRequest}</div>
    </section> : <div className="goals-clarification" aria-label="Clarify goal" data-goal-id={demand.id} data-goal-confirmation-state="unconfirmed">
      <p className="goals-muted">Clarify the outcome and what success looks like with the agent.</p>{goalRequest}
    </div>}
    {grounding ? <section className="goals-grounding" aria-label="Results review" data-goal-grounding-submission={grounding.submissionId} data-goal-result-state={accepted ? (hasGaps ? 'accepted-with-gaps' : 'accepted') : stale ? 'stale' : 'reported'}>
      <div className="goals-section-heading"><h2>Results review</h2><span className="goals-caption">{accepted ? hasGaps ? 'Accepted with gaps' : 'Accepted by you' : stale ? 'Report needs updating' : 'Agent report · Not accepted yet'}</span></div>
      {stale ? <p className="goals-condition">This report is for the previous goal (v{grounding.alignmentRevision}). Check the current goal (v{alignment!.revision}) again; previous acceptance does not apply.</p> : <p className="goals-proposal" data-goal-result-summary>{grounding.summary}</p>}
      {alignment?.criteria.length ? <div className="goals-result-checks">{alignment.criteria.map(criterion => <GoalResultCheck key={criterion.id} criterionId={criterion.id} criterion={criterion.text} check={stale ? undefined : checks.get(criterion.id)} demand={demand} workspace={workspace} stale={stale} />)}</div> : <div className="goals-result-checks">{grounding.checks.map(check => <GoalResultCheck key={check.criterionId} criterionId={check.criterionId} criterion={`Reported criterion: ${check.criterionId}`} check={check} demand={demand} workspace={workspace} stale={false} />)}</div>}
      {stale ? <details className="goals-previous-report"><summary>Previous agent report</summary><p className="goals-proposal">{grounding.summary}</p>{grounding.checks.map(check => <GoalResultCheck key={check.criterionId} criterionId={check.criterionId} criterion={alignment?.criteria.find(criterion => criterion.id === check.criterionId)?.text ?? check.criterionId} check={check} demand={demand} workspace={workspace} stale={false} />)}</details> : null}
      {!accepted && !stale && resultExplanation ? <p className="goals-condition">{resultExplanation}</p> : null}
      {accepted && hasGaps ? <p className="goals-condition">You accepted this result with the reported gaps. Those gaps remain part of the record.</p> : null}
      <div className="goals-inline-actions">{!failure && !accepted && alignment && !acceptIssue ? <button type="button" className="goals-button goals-button--primary" data-goal-accept disabled={pending} onClick={() => void acknowledge({ kind: 'accept', revision: alignment.revision, submissionId: grounding.submissionId, gaps: false })}>{pending ? 'Saving…' : 'Accept results'}<Check size={13} /></button> : !failure && !accepted && alignment && gapIssue === null ? <button type="button" className="goals-button goals-button--primary" data-goal-accept-gaps disabled={pending} onClick={() => void acknowledge({ kind: 'accept', revision: alignment.revision, submissionId: grounding.submissionId, gaps: true })}>{pending ? 'Saving…' : 'Accept results, keep gaps'}</button> : null}{resultRequest}</div>
    </section> : demand.status === 'done' || alignment?.confirmedAt ? <div className="goals-no-results" data-goal-result-state="missing">
      <div className="goals-section-heading"><h2>Results review</h2><span className="goals-caption">No report yet</span></div>
      {demand.status === 'done' ? <><p className="goals-condition"><strong>Results not verified</strong></p><p className="goals-muted">Marked done, but no report has checked the work against success criteria.</p></> : <p className="goals-muted">No result report yet. Continue in your discussion or workspace. When ready, ask the agent to check work against these criteria.</p>}
      <div className="goals-inline-actions">{alignment?.confirmedAt ? <button type="button" className={`goals-button${!failure ? ' goals-button--primary' : ''}`} disabled={Boolean(motePending)} onClick={onOpenMote} aria-label={`Open discussion for ${demand.title}`}>{motePending === 'open' ? 'Opening discussion…' : 'Open discussion'}<ArrowUpRight size={13} /></button> : null}{resultRequest}</div>
    </div> : null}
    {failure ? <div className="goals-service" role="status" data-goal-acknowledgement-failure>{failure.attempt.kind === 'confirm' ? 'Goal confirmation' : 'Result acceptance'} is unconfirmed. Your goal and current work are kept. <span>{failure.message}</span><button type="button" className="goals-button goals-button--primary" disabled={pending} onClick={() => void reload()}>Reload current proposal</button>{reloadError ? <span>Reload failed: {reloadError}</span> : null}</div> : null}
  </>

}

function GoalResultCheck({ criterionId, criterion, check, demand, workspace, stale }: { criterionId: string; criterion: string; check: DemandGroundingCheck | undefined; demand: DemandProjection; workspace: WorkspaceRecord | undefined; stale: boolean }) {
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
      if (!workspace) throw new Error(demand.projectId ? 'The bound Project is unavailable. Its identity is kept. Restore the Project or copy this evidence location.' : 'Choose the goal’s Project in More properties to open local evidence, or copy its location.')
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
