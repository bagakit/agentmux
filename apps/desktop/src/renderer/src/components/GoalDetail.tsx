import { semanticIconComponent } from '@agentmux/client-ui/icons'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { useRef, useState } from 'react'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import { ComposerTextarea } from '@agentmux/client-ui/input'
import { GoalCommonProperties, GoalProperties } from './GoalProperties'
import { GoalDelegationWork } from './GoalDelegationWork'
import { GoalIntent } from './GoalIntent'
import { GoalContinuationAgent } from './GoalContinuationControl'
import { DEMAND_STATUS_LABELS } from '../lib/global-demand-board'
import { ConfirmationDialog } from './ConfirmationDialog'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { GoalExecution } from './GoalExecution'
import { GoalPlanGraph } from './GoalPlanGraph'
import { GoalFiniteStartControl } from './GoalFiniteStartControl'
import { useGoalDiscussionRecipient } from '../lib/goal-discussion-recipient'
import { editGoalDraft, saveGoalDrafts } from '../lib/goal-edit-drafts'
import { GoalActivity } from './GoalActivity'
import { GoalAlignment, type GoalAcknowledgementFeedback } from './GoalAlignment'
import { goalNextStepFact } from '../lib/goal-presentation'
import { GOAL_GROUP_LABELS, GoalStageMark } from '../lib/goal-groups'
import type { GoalQueuePosition } from '../lib/goal-navigation'
import type { GoalStage } from '../lib/goal-presentation'

const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeActionMoreIcon = semanticIconComponent('action.more')
const ThemeActionRemoveIcon = semanticIconComponent('action.remove')
const ThemeObjectGoalIcon = semanticIconComponent('object.goal')
const ThemeNavigationForwardIcon = semanticIconComponent('navigation.forward')
const QUEUE_NAMES: Record<GoalStage, string> = { you: 'needs you', attention: 'needs attention', define: 'needs defining', agents: 'is with agents', unknown: 'is unknown', finished: 'is finished' }


export function GoalDetail({ demand, onClose, onOpenMote, onGrill, onGrounding, onPlan, acknowledgementFeedback, onAcknowledgementFeedbackChange, motePending = null, moteError, onRetryMote, queue = null, onOpenGoal }: { queue?: GoalQueuePosition | null; onOpenGoal?: (id: string) => void; demand: DemandProjection; onClose: () => void; onOpenMote: () => void; onGrill: () => void; onGrounding: () => void; onPlan: () => void; acknowledgementFeedback: GoalAcknowledgementFeedback; onAcknowledgementFeedbackChange: (patch: Partial<GoalAcknowledgementFeedback>) => void; motePending?: 'open' | 'grill' | 'grounding' | 'plan' | null; moteError: { message: string; mode: 'open' | 'grill' | 'grounding' | 'plan' } | null; onRetryMote: () => void }) {
  const updateDemand = useAppStore((state) => state.updateDemand)
  const deleteDemand = useAppStore((state) => state.deleteDemand)
  const draft = useAppStore(state => state.goalEditDrafts[demand.id])
  const title = draft?.title?.value ?? demand.title, description = draft?.description?.value ?? demand.description
  const titleDirty = Boolean(draft?.title), descriptionDirty = Boolean(draft?.description)
  const failedPatch = useRef<Parameters<typeof updateDemand>[1]>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleteRequested, setDeleteRequested] = useState(false)
  const actionsRef = useRef<HTMLButtonElement>(null)
  const teamRef = useRef<HTMLElement>(null)
  const [intentEditing, setIntentEditing] = useState(descriptionDirty)
  async function update(patch: Parameters<typeof updateDemand>[1], expectedUpdatedAt?: number): Promise<boolean> {
    try { await updateDemand(demand.id, patch, undefined, expectedUpdatedAt); for (const key of Object.keys(patch) as Array<keyof typeof patch>) if (failedPatch.current[key] === patch[key]) delete failedPatch.current[key]; if (!Object.keys(failedPatch.current).length) setSaveError(null); return true }
    catch (error) { if (expectedUpdatedAt !== undefined) return false; failedPatch.current = { ...failedPatch.current, ...patch }; setSaveError(error instanceof Error ? error.message : String(error)); return false }
  }
  const intentBody = <ComposerTextarea aria-label="Goal description" value={description} onValueChange={value => editGoalDraft(demand.id, 'description', value)} onBlur={() => { if (descriptionDirty) void saveGoalDrafts(demand.id, ['description']) }} rows={Math.max(3, Math.min(14, description.split('\n').length + 1))} placeholder="Describe the outcome in your own words…" />
  const recipient = useGoalDiscussionRecipient(demand.id)
  const intent = (lines: number) => <GoalIntent text={description} lines={lines} editor={intentBody} editing={intentEditing || descriptionDirty} onEditingChange={editing => { setIntentEditing(editing); if (!editing && descriptionDirty) void saveGoalDrafts(demand.id, ['description']) }} />
  const draftIssue = Object.values(draft ?? {}).find(entry => entry?.issue)?.issue
  const saveFeedback = saveError || draftIssue ? <div className="goals-service" role="status">Changes are not saved. Your draft is kept. <span>{saveError ?? draftIssue}</span><button type="button" className="small-button" onClick={() => void retrySave()}>Retry save</button></div> : null
  async function retrySave() {
    await saveGoalDrafts(demand.id)
    if (Object.keys(failedPatch.current).length) await update({ ...failedPatch.current })
  }
  const continueInBody = Boolean(demand.alignment?.confirmedAt && !demand.grounding)
  const finished = demand.status === 'done' || demand.status === 'cancelled'
  const plan = <GoalPlanGraph demand={demand} {...(finished ? {} : { onRequestPlan: onPlan })} pending={motePending === 'plan'} busy={Boolean(motePending)} />
  const fact = goalNextStepFact(demand)
  const stage = acknowledgementFeedback.failure ? 'you' : fact.stage
  const next = acknowledgementFeedback.failure ? 'Acknowledgement unconfirmed' : fact.text
  return <aside className="goals-detail" data-goal-detail-id={demand.id} aria-label={`Goal workspace for ${demand.title}`}>
    <header className="goals-detail__toolbar"><button className="small-button" type="button" onClick={onClose} aria-label="Back to goals"><ThemeNavigationBackIcon size={14} />Goals</button><span>{demand.projectName}</span>{!continueInBody ? <button type="button" className="small-button" disabled={Boolean(motePending)} onClick={onOpenMote} aria-label={`Open discussion for ${demand.title}`}>{motePending === 'open' ? 'Opening discussion…' : recipient.openLabel}</button> : null}<Menu.Root modal={false}><Menu.Trigger asChild><button ref={actionsRef} type="button" className="icon-button" aria-label="Goal actions"><ThemeActionMoreIcon size={15} /></button></Menu.Trigger><DocumentOverlayPortal component={Menu.Portal}><div className="window-overlay-host__entry" data-overlay-layer="popover"><Menu.Content className="tab-context-menu" align="end" sideOffset={4} collisionPadding={8} aria-label="Goal actions"><Menu.Item className="tab-context-menu__item goals-delete-action" onSelect={() => { actionsRef.current?.focus(); setDeleteRequested(true) }}><ThemeActionRemoveIcon size={13} />Delete goal</Menu.Item></Menu.Content></div></DocumentOverlayPortal></Menu.Root></header>
    <article className="goals-document">
      <header className="goals-detail__head">
        <ComposerTextarea className="goals-title" aria-label="Goal title" value={title} onValueChange={value => editGoalDraft(demand.id, 'title', value)} rows={1} onBlur={() => { if (titleDirty && title.trim()) void saveGoalDrafts(demand.id, ['title']) }} />
        <div className="goals-detail__stage-row"><p className="goals-detail__stage" data-goal-detail-stage><GoalStageMark stage={stage} /><span><small>{GOAL_GROUP_LABELS[stage]}</small><strong>{next}</strong></span></p>
          {queue && queue.total > 1 ? <span className="goals-detail__queue" data-goal-queue><span>{queue.index} of {queue.total}</span>{queue.nextId ? <button type="button" className="small-button" data-goal-queue-next aria-label={`Next goal that ${QUEUE_NAMES[queue.stage]}`} onClick={() => onOpenGoal?.(queue.nextId!)}>Next<ThemeNavigationForwardIcon size={13} /></button> : null}</span> : null}</div>
        <div className="goals-detail__overview"><GoalMeta demand={demand} /><button type="button" className="goals-detail__team-link" onClick={() => { teamRef.current?.scrollIntoView({ block: 'start' }); teamRef.current?.focus({ preventScroll: true }) }}>Team<ThemeNavigationForwardIcon size={12} /></button></div>
        <p className="goals-detail__edit-status" aria-live="polite">{draft ? draftIssue ? 'Edits kept · Save unconfirmed' : 'Unsaved edits' : null}</p>
      </header>
      <div className="goals-detail__body">
        <div className="goals-detail__main">
          {plan}
          {!demand.alignment ? <section className="goals-intent-body goals-intent-body--undefined"><div className="goals-section-heading"><h2><ThemeObjectGoalIcon size={14} aria-hidden="true" /> Goal definition</h2><span className="goals-caption">{descriptionDirty ? 'Your intent · Unsaved draft' : 'Your intent · Not outlined yet'}</span></div>{intent(3)}</section> : null}
          {!demand.alignment ? saveFeedback : null}
          {!demand.plan && !finished && !demand.grounding && demand.alignment?.confirmedAt ? <GoalFiniteStartControl key={`start:${demand.id}`} demand={demand} primary={!acknowledgementFeedback.failure} /> : null}
          <GoalAlignment key={demand.id} feedback={acknowledgementFeedback} onFeedbackChange={onAcknowledgementFeedbackChange} demand={demand} onGrill={onGrill} onGrounding={onGrounding} onOpenMote={onOpenMote} motePending={motePending} />
          {demand.plan || finished && !demand.grounding || !demand.alignment?.confirmedAt || demand.grounding && !finished ? <GoalFiniteStartControl key={`start:${demand.id}`} demand={demand} primary={false} /> : null}
          {demand.alignment ? <section className="goals-original-intent goals-intent-body" aria-label="Your original intent"><div className="goals-section-heading"><h2>Your original intent</h2>{descriptionDirty ? <span className="goals-caption">Unsaved draft</span> : null}</div>{intent(8)}</section> : null}
          {demand.alignment ? saveFeedback : null}
          {moteError ? <div className="goals-service" role="status">{moteError.mode === 'open' ? 'Goal saved. The discussion could not be opened.' : `${moteError.mode === 'plan' ? 'Planning' : moteError.mode === 'grill' ? 'Goal' : 'Check'} request delivery is unconfirmed. Your goal and current work are kept.`} <span>{moteError.message}</span><button type="button" className="small-button" disabled={Boolean(motePending)} onClick={onRetryMote}>{moteError.mode === 'open' ? 'Retry opening discussion' : moteError.mode === 'plan' ? 'Check planning request' : moteError.mode === 'grill' ? 'Retry goal request' : 'Retry check request'}</button></div> : null}
          <GoalDelegationWork demand={demand} />
          <GoalActivity demand={demand} />
        </div>
        <aside ref={teamRef} tabIndex={-1} className="goals-detail__side" aria-label="Goal team and properties">
          <GoalExecution demand={demand} onUpdate={update} />
          <section className="goals-detail__properties" aria-label="Goal properties"><h2>Properties</h2><GoalCommonProperties demand={demand} onUpdate={patch => void update(patch)} /><GoalProperties demand={demand} onUpdate={patch => void update(patch)} /></section>
        </aside>
      </div>
    </article>
    <ConfirmationDialog open={deleteRequested} title="Delete goal?" subject={demand.title}
      description="This removes the goal and its saved planning records. Linked Sessions keep running."
      confirmLabel="Delete goal" onCancel={() => setDeleteRequested(false)}
      onConfirm={() => { setDeleteRequested(false); deleteDemand(demand.id); onClose() }} />
  </aside>
}

/** One line answering where the Goal stands and who carries it; progress is the owner's plan derivation. */
function GoalMeta({ demand }: { demand: DemandProjection }) {
  const progress = demand.planState
  return <p className="goals-detail__meta" data-goal-meta>
    <span data-goal-meta-status>{DEMAND_STATUS_LABELS[demand.status]}</span>
    {demand.plan ? progress ? <span className="goals-detail__meta-plan" data-goal-meta-plan={`${progress.done}/${progress.total}`}>
      <span className="goals-detail__meta-bar" aria-hidden="true"><span style={{ transform: `scaleX(${progress.total ? progress.done / progress.total : 0})` }} /></span>
      Plan {progress.done} of {progress.total} done</span>
      : <span data-goal-meta-plan="unavailable">Plan · node states unavailable</span> : null}
    <span className="goals-detail__meta-agent" data-goal-meta-supervisor>{demand.supervisorSessionId
      ? <>Supervisor <GoalContinuationAgent agentSessionId={demand.supervisorSessionId} active size={16} /></> : 'No Supervisor yet'}</span>
    <span>{demand.projectName ?? 'No project'}</span>
  </p>
}
