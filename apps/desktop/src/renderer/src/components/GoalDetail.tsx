import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { Button } from '@agentmux/client-ui/components/Button'
import { SelectionIndicator } from '@agentmux/client-ui/components/SelectionIndicator'
import * as Menu from './DropdownMenu'
import { useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import { ComposerTextarea } from '@agentmux/client-ui/input'
import { demandAgentReferenceLabel, goalSupervisorHostWitnesses } from '@agentmux/demand/relations'
import { GoalCommonProperties, GoalProperties } from './GoalProperties'
import { GoalWorkArea } from './GoalWorkArea'
import { GoalIntent } from './GoalIntent'
import { GoalContinuationAgent } from './GoalContinuationControl'
import { DEMAND_STATUS_LABELS } from '../lib/global-demand-board'
import { ConfirmationDialog } from './ConfirmationDialog'
import { GoalExecution } from './GoalExecution'
import { GoalPlanGraph, type GoalPlanReveal } from './GoalPlanGraph'
import { GoalSupervisorRail } from './GoalSupervisorRail'
import { useGoalDiscussionRecipient } from '../lib/goal-discussion-recipient'
import { editGoalDraft, saveGoalDrafts } from '../lib/goal-edit-drafts'
import { GoalActivity } from './GoalActivity'
import { GoalAlignment, type GoalAcknowledgementFeedback } from './GoalAlignment'
import { goalHasOriginalWork, goalNextStepFact, type GoalNextStepSource } from '../lib/goal-presentation'
import { GOAL_GROUP_LABELS, GoalStageMark } from '../lib/goal-groups'
import type { GoalQueuePosition } from '../lib/goal-navigation'
import type { GoalStage } from '../lib/goal-presentation'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { desktopPresentationCommitted } from '../lib/desktop-presentation'
import '../styles/goal-reading.css'

const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeActionMoreIcon = semanticIconComponent('action.more')
const ThemeActionRemoveIcon = semanticIconComponent('action.remove')
const ThemeObjectGoalIcon = semanticIconComponent('object.goal')
const ThemeNavigationForwardIcon = semanticIconComponent('navigation.forward')
const QUEUE_NAMES: Record<GoalStage, string> = { you: 'needs you', attention: 'needs attention', define: 'needs defining', agents: 'is with agents', unknown: 'is unknown', finished: 'is finished' }
type GoalReadingSection = 'overview' | 'plan' | 'activity'

export function GoalDetail({ demand, onClose, onOpenMote, onGrill, onGrounding, onPlan, acknowledgementFeedback, onAcknowledgementFeedbackChange, motePending = null, moteError, onRetryMote, queue = null, onOpenGoal }: { queue?: GoalQueuePosition | null; onOpenGoal?: (id: string) => void; demand: DemandProjection; onClose: () => void; onOpenMote: () => void; onGrill: () => void; onGrounding: () => void; onPlan: () => void; acknowledgementFeedback: GoalAcknowledgementFeedback; onAcknowledgementFeedbackChange: (patch: Partial<GoalAcknowledgementFeedback>) => void; motePending?: 'open' | 'grill' | 'grounding' | 'plan' | null; moteError: { message: string; mode: 'open' | 'grill' | 'grounding' | 'plan' } | null; onRetryMote: () => void }) {
  const updateDemand = useAppStore((state) => state.updateDemand)
  const deleteDemand = useAppStore((state) => state.deleteDemand)
  const draft = useAppStore(useShallow(state => { const drafts = state.goalEditDrafts[demand.id]; return { title: drafts?.title, description: drafts?.description, tags: drafts?.tags } }))
  const retainedStart = useAppStore(state => state.goalFiniteStartIntents[demand.id])
  const title = draft?.title?.value ?? demand.title, description = draft?.description?.value ?? demand.description
  const titleDirty = Boolean(draft?.title), descriptionDirty = Boolean(draft?.description)
  const failedPatch = useRef<Parameters<typeof updateDemand>[1]>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const [deleteRequested, setDeleteRequested] = useState(false)
  const actionsRef = useRef<HTMLButtonElement>(null)
  const detailRef = useRef<HTMLElement>(null)
  const teamRef = useRef<HTMLElement>(null)
  const overviewRef = useRef<HTMLElement>(null)
  const planRef = useRef<HTMLDivElement>(null)
  const activityRef = useRef<HTMLDivElement>(null)
  const [showSupervisor, setShowSupervisor] = useState(false)
  const [planReveal, setPlanReveal] = useState<GoalPlanReveal | null>(null)
  const [readingSection, setReadingSection] = useState<GoalReadingSection>('overview')
  const hasActivity = Boolean(demand.activities?.length || demand.decisions?.length)
  const visibleSection = showSupervisor ? 'supervisor' : readingSection === 'activity' && !hasActivity ? 'overview' : readingSection
  const readingNavRef = useRef<HTMLElement>(null)
  const readingEntry = useAppStore(state => state.goalReadingEntry)
  const revealedEntry = useRef<string | null>(null)
  const [copied, setCopied] = useState<'goal' | 'plan' | null>(null)
  const [copyIssue, setCopyIssue] = useState<string | null>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const [intentEditing, setIntentEditing] = useState(descriptionDirty)
  useLayoutEffect(() => {
    const nav = readingNavRef.current
    const detail = detailRef.current
    const toolbar = detail?.querySelector<HTMLElement>('.goals-detail__toolbar')
    if (!nav || !detail || !toolbar) return
    const updateOffsets = () => {
      detail.style.setProperty('--goal-detail-toolbar-height', `${toolbar.offsetHeight}px`)
      detail.style.setProperty('--goal-detail-reading-offset', `${toolbar.offsetHeight + nav.offsetHeight + 12}px`)
    }
    updateOffsets()
    const observer = new ResizeObserver(updateOffsets)
    observer.observe(nav)
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [demand.id])
  function revealSection(section: HTMLElement | null, focus = true) {
    const detail = detailRef.current
    if (!detail || !section) return
    const destination = section.dataset.goalReadingSection as GoalReadingSection | undefined
    if (destination) setReadingSection(destination)
    if (focus) useAppStore.setState({ goalReadingEntry: null })
    const margin = Number.parseFloat(getComputedStyle(section).scrollMarginTop) || 0
    detail.scrollTop = Math.max(0, detail.scrollTop + section.getBoundingClientRect().top - detail.getBoundingClientRect().top - margin)
    if (focus) section.focus({ preventScroll: true })
  }
  function revealWork(section: HTMLElement | null, focus = true) {
    if (!showSupervisor) { revealSection(section, focus); return }
    setShowSupervisor(false)
    requestAnimationFrame(() => revealSection(section, focus))
  }
  function revealOriginalWork(source: Extract<GoalNextStepSource, { kind: 'start' | 'delegation' }>) {
    const operation = CSS.escape(source.operationId)
    const detail = detailRef.current
    const pending = source.kind === 'start' ? detail?.querySelector<HTMLElement>(`[data-goal-retained-operation="${operation}"]`) : null
    const original = pending ?? detail?.querySelector<HTMLElement>(`[data-goal-work-kind="${source.kind}"][data-goal-work-operation="${operation}"]`)
    if (original) revealWork(original)
  }
  function revealSupervisor() {
    const section = teamRef.current
    setShowSupervisor(true)
    if (section && getComputedStyle(section).display === 'none') requestAnimationFrame(() => revealSection(section))
    else revealSection(section)
  }
  function revealAttempt(nodeId: string, operationId: string, trigger: HTMLButtonElement) {
    setShowSupervisor(false)
    setPlanReveal({ target: { nodeId, attemptId: operationId }, trigger,
      ...(showSupervisor ? { restore: () => setShowSupervisor(true) } : {}) })
  }
  useLayoutEffect(() => {
    const detail = detailRef.current
    if (!detail || showSupervisor) return
    let frame: number | null = null
    function updateReadingSection() {
      frame = null
      const sections = [overviewRef.current, planRef.current, activityRef.current].filter((section): section is HTMLElement => Boolean(section))
      const viewport = detail!.getBoundingClientRect()
      if (!viewport.height || !sections.length) return
      const margin = Number.parseFloat(getComputedStyle(sections[0]!).scrollMarginTop) || 0
      const readingLine = viewport.top + margin + 2
      const positions = sections.map(section => ({ id: section.dataset.goalReadingSection as GoalReadingSection, top: section.getBoundingClientRect().top }))
      const passed = positions.filter(section => section.top <= readingLine)
      const latestTop = Math.max(...passed.map(section => section.top))
      // When anchors align, keep the one the reader explicitly selected.
      const currentRow = passed.filter(section => Math.abs(section.top - latestTop) <= 2)
      const activity = positions.find(section => section.id === 'activity')
      const atEnd = detail!.scrollHeight > detail!.clientHeight && detail!.scrollHeight - detail!.scrollTop - detail!.clientHeight <= 2
      setReadingSection(current => atEnd && activity && activity.top < viewport.bottom ? 'activity'
        : currentRow.find(section => section.id === current)?.id ?? currentRow[0]?.id ?? 'overview')
    }
    function scheduleReadingSection() { if (frame === null) frame = requestAnimationFrame(updateReadingSection) }
    detail.addEventListener('scroll', scheduleReadingSection, { passive: true })
    const observer = new ResizeObserver(scheduleReadingSection)
    observer.observe(detail)
    for (const section of [overviewRef.current, planRef.current, activityRef.current]) if (section) observer.observe(section)
    return () => { detail.removeEventListener('scroll', scheduleReadingSection); observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame) }
  }, [demand.id, showSupervisor, hasActivity])
  useLayoutEffect(() => {
    if (!readingEntry || readingEntry.phase !== 'ready' || readingEntry.section !== 'plan' || readingEntry.goalId !== demand.id || revealedEntry.current === readingEntry.token) return
    const state = useAppStore.getState()
    if (state.mainSurface !== 'board' || state.selectedDemandId !== demand.id || state.goalReadingEntry?.token !== readingEntry.token || !planRef.current) return
    if (readingEntry.runtimeId !== undefined && readingEntry.runtimeId !== demand.address?.runtimeId || readingEntry.namespace !== undefined && readingEntry.namespace !== demand.address?.namespace) return
    revealedEntry.current = readingEntry.token
    revealWork(planRef.current, false)
    desktopPresentationCommitted()
  }, [readingEntry, demand.id])
  async function copyLink(kind: 'goal' | 'plan') {
    const link = kind === 'goal' ? demand.address?.goalUrl : demand.address?.planUrl
    if (!link) { setCopyIssue('The original Goal address is not confirmed. Your goal and work are kept.'); return }
    setCopyIssue(null)
    const saved = await copyTextToClipboard(link, error => setCopyIssue(error instanceof Error ? error.message : String(error)))
    if (saved) setCopied(kind)
  }
  async function update(patch: Parameters<typeof updateDemand>[1], expectedUpdatedAt?: number, relationAccess?: Parameters<typeof updateDemand>[4]): Promise<boolean> {
    try { await updateDemand(demand.id, patch, undefined, expectedUpdatedAt, relationAccess); for (const key of Object.keys(patch) as Array<keyof typeof patch>) if (failedPatch.current[key] === patch[key]) delete failedPatch.current[key]; if (!Object.keys(failedPatch.current).length) setSaveError(null); return true }
    catch (error) { if (expectedUpdatedAt !== undefined) throw error; failedPatch.current = { ...failedPatch.current, ...patch }; setSaveError(error instanceof Error ? error.message : String(error)); return false }
  }
  const intentBody = <ComposerTextarea aria-label="Goal description" value={description} onValueChange={value => editGoalDraft(demand.id, 'description', value)} onBlur={() => { if (descriptionDirty) void saveGoalDrafts(demand.id, ['description']) }} rows={Math.max(3, Math.min(14, description.split('\n').length + 1))} placeholder="Describe the outcome in your own words…" />
  const recipient = useGoalDiscussionRecipient(demand.id)
  const intent = (lines: number) => <GoalIntent text={description} lines={lines} editor={intentBody} editing={intentEditing || descriptionDirty} onEditingChange={editing => { setIntentEditing(editing); if (!editing && descriptionDirty) void saveGoalDrafts(demand.id, ['description']) }} />
  const editDrafts = [draft?.title, draft?.description, draft?.tags]
  const draftIssue = editDrafts.find(entry => entry?.issue)?.issue
  const hasEditDraft = editDrafts.some(Boolean)
  const saveFeedback = saveError || draftIssue ? <div className="goals-service" role="status">Changes are not saved. Your draft is kept. <span>{saveError ?? draftIssue}</span><Button type="button" onClick={() => void retrySave()}>Retry save</Button></div> : null
  async function retrySave() {
    await saveGoalDrafts(demand.id)
    if (Object.keys(failedPatch.current).length) await update({ ...failedPatch.current })
  }
  const continueInBody = Boolean(demand.alignment?.confirmedAt && !demand.grounding)
  const finished = demand.status === 'done' || demand.status === 'cancelled'
  const fact = goalNextStepFact(demand, retainedStart)
  const hasOriginalWork = goalHasOriginalWork(demand, retainedStart)
  const plan = <div ref={planRef} tabIndex={-1} className="goals-detail__plan" data-goal-reading-section="plan" data-goal-reading-id={demand.id} data-goal-reading-runtime={demand.address?.runtimeId} data-goal-reading-namespace={demand.address?.namespace}>
    {demand.address ? <div className="goals-detail__plan-tools"><Button type="button" onClick={() => void copyLink('plan')}>{copied === 'plan' ? 'Plan link copied' : 'Copy plan link'}</Button></div> : null}
    <GoalPlanGraph demand={demand} reveal={planReveal} compact={hasOriginalWork || Boolean(demand.alignment || demand.grounding || acknowledgementFeedback.failure)} {...(finished ? {} : { onRequestPlan: onPlan })} pending={motePending === 'plan'} busy={Boolean(motePending)} />
  </div>
  const stage = acknowledgementFeedback.failure ? 'you' : fact.stage
  const next = acknowledgementFeedback.failure ? 'Acknowledgement unconfirmed' : fact.text
  const currentWork = !acknowledgementFeedback.failure && (fact.source.kind === 'start' || fact.source.kind === 'delegation') ? fact.source : null
  const reviewFirst = Boolean(acknowledgementFeedback.failure) || !demand.plan && (fact.source.kind === 'definition' || fact.source.kind === 'results')
  const review = <div key="goal-review" ref={resultsRef} tabIndex={-1} className="goals-detail__definition"><GoalAlignment key={demand.id} emphasis={fact.source.kind === 'definition' || fact.source.kind === 'results' ? fact.source.kind : null} feedback={acknowledgementFeedback} onFeedbackChange={onAcknowledgementFeedbackChange} demand={demand} onGrill={onGrill} onGrounding={onGrounding} onOpenMote={onOpenMote} motePending={motePending} /></div>
  const brief = <section ref={overviewRef} tabIndex={-1} className="goals-intent-body goals-detail__brief" aria-label="Goal brief" data-goal-reading-section="overview" data-goal-reading-id={demand.id} data-goal-reading-runtime={demand.address?.runtimeId} data-goal-reading-namespace={demand.address?.namespace}>
    <div className="goals-section-heading"><h2><ThemeObjectGoalIcon size={14} aria-hidden="true" />{demand.alignment ? 'Your original intent' : 'Goal brief'}</h2>{descriptionDirty ? <span className="goals-caption">Unsaved draft</span> : null}</div>{intent(demand.plan ? 3 : 14)}{saveFeedback}
  </section>
  return <aside ref={detailRef} className="goals-detail" data-goal-detail-id={demand.id} data-goal-view={showSupervisor ? 'supervisor' : 'work'} aria-label={`Goal workspace for ${demand.title}`}>
    <header className="goals-detail__toolbar"><Button type="button" onClick={onClose} aria-label="Back to goals"><ThemeNavigationBackIcon size={14} />Goals</Button><span>{demand.projectName}</span>{!demand.plan && !continueInBody ? <Button type="button" disabled={Boolean(motePending)} onClick={onOpenMote} aria-label={`Open discussion for ${demand.title}`}>{motePending === 'open' ? 'Opening discussion…' : recipient.openLabel}</Button> : null}<Menu.Root modal={false}><Menu.Trigger asChild><button ref={actionsRef} type="button" className="icon-button" aria-label="Goal actions"><ThemeActionMoreIcon size={15} /></button></Menu.Trigger><Menu.Portal><div className="window-overlay-host__entry" data-overlay-layer="popover"><Menu.Content className="tab-context-menu" align="end" sideOffset={4} collisionPadding={8} aria-label="Goal actions"><Menu.Item className="tab-context-menu__item goals-delete-action" onSelect={() => { actionsRef.current?.focus(); setDeleteRequested(true) }}><ThemeActionRemoveIcon size={13} />Delete goal</Menu.Item></Menu.Content></div></Menu.Portal></Menu.Root></header>
    <article className="goals-document">
      <header className="goals-detail__head">
        <ComposerTextarea className="goals-title" aria-label="Goal title" value={title} onValueChange={value => editGoalDraft(demand.id, 'title', value)} rows={1} onBlur={() => { if (titleDirty && title.trim()) void saveGoalDrafts(demand.id, ['title']) }} />
        <div className="goals-detail__stage-row"><p className="goals-detail__stage" data-goal-detail-stage><GoalStageMark stage={stage} /><span><small>{GOAL_GROUP_LABELS[stage]}</small><strong>{next}</strong></span></p>
          {currentWork ? <Button className="goals-detail__current-work" onClick={() => revealOriginalWork(currentWork)}>View current work<ThemeNavigationForwardIcon size={12} aria-hidden="true" /></Button> : null}
          {queue && queue.total > 1 ? <span className="goals-detail__queue" data-goal-queue><span>{GOAL_GROUP_LABELS[queue.stage]} · {queue.index} of {queue.total}</span>{queue.nextId ? <Button type="button" data-goal-queue-next aria-label={`Next goal that ${QUEUE_NAMES[queue.stage]}`} onClick={() => onOpenGoal?.(queue.nextId!)}>Next<ThemeNavigationForwardIcon size={13} /></Button> : null}</span> : null}</div>
        <div className="goals-detail__overview"><GoalMeta demand={demand} />
          {demand.plan && (fact.source.kind === 'definition' || fact.source.kind === 'results') && !acknowledgementFeedback.failure
            ? <Button type="button" onClick={() => revealWork(resultsRef.current)}>{fact.source.kind === 'results' ? 'Read results' : 'Read success criteria'}</Button> : null}
        </div>
        <p className="goals-detail__edit-status" aria-live="polite">{hasEditDraft ? draftIssue ? 'Edits kept · Save unconfirmed' : 'Unsaved edits' : null}</p>
      </header>
        <nav ref={readingNavRef} className="goals-detail__reading-nav" aria-label="Goal reading sections">
          <SelectionIndicator />
          <button type="button" aria-current={visibleSection === 'overview' ? 'location' : undefined} onClick={() => revealWork(overviewRef.current)}>Overview</button>
          <button type="button" aria-current={visibleSection === 'plan' ? 'location' : undefined} onClick={() => revealWork(planRef.current)}>Plan</button>
          {hasActivity ? <button type="button" aria-current={visibleSection === 'activity' ? 'location' : undefined} onClick={() => revealWork(activityRef.current)}>Activity</button> : null}
          <button type="button" className="goals-detail__team-link" aria-current={visibleSection === 'supervisor' ? 'location' : undefined} onClick={revealSupervisor}>Supervisor</button>
          {demand.address ? <button type="button" className="goals-detail__copy" onClick={() => void copyLink('goal')}>{copied === 'goal' ? 'Goal link copied' : 'Copy goal link'}</button> : null}
        </nav>
        {!demand.address ? <details className="goals-detail__address-issue"><summary>Goal address unconfirmed</summary><p className="goals-caption">{demand.addressIssue ?? 'The original Goal owner has not confirmed its address. You can keep reading and working with this goal.'}</p></details> : null}
        {copyIssue ? <p className="goals-service" role="status">Link could not be copied. {copyIssue}</p> : null}
        {moteError ? <div className="goals-service" role="status">{moteError.mode === 'open' ? 'Goal saved. The discussion could not be opened.' : `${moteError.mode === 'plan' ? 'Planning' : moteError.mode === 'grill' ? 'Goal' : 'Check'} request delivery is unconfirmed. Your goal and current work are kept.`} <span>{moteError.message}</span><Button type="button" disabled={Boolean(motePending)} onClick={onRetryMote}>{moteError.mode === 'open' ? 'Retry opening discussion' : moteError.mode === 'plan' ? 'Check planning request' : moteError.mode === 'grill' ? 'Retry goal request' : 'Retry check request'}</Button></div> : null}
      <div className="goals-detail__body">
        <div className="goals-detail__main">
          {reviewFirst ? review : null}
          <GoalWorkArea key={`work:${demand.id}`} demand={demand} overview={brief} plan={plan} primary={!acknowledgementFeedback.failure} onRevealResults={() => revealSection(resultsRef.current)} />
          {!reviewFirst ? review : null}
          {hasActivity ? <div ref={activityRef} tabIndex={-1} className="goals-detail__activity" data-goal-reading-section="activity" data-goal-reading-id={demand.id} data-goal-reading-runtime={demand.address?.runtimeId} data-goal-reading-namespace={demand.address?.namespace}><GoalActivity demand={demand} /></div> : null}
        </div>
        <aside ref={teamRef} tabIndex={-1} className="goals-detail__side" aria-label="Goal team and properties">
          <GoalSupervisorRail demand={demand} onOpenDiscussion={demand.plan && !continueInBody ? onOpenMote : undefined} discussionBusy={Boolean(motePending)} onRevealAttempt={revealAttempt} />
          <details className="goals-detail__relationships"><summary>Team and relationships</summary>
            <GoalExecution demand={demand} onUpdate={update} />
          </details>
          <details className="goals-detail__properties" aria-label="Goal properties"><summary><ThemeNavigationForwardIcon className="goals-detail__properties-chevron" size={12} aria-hidden="true" />Properties<span>Status, priority, project</span></summary><GoalCommonProperties demand={demand} onUpdate={patch => void update(patch)} /><GoalProperties demand={demand} onUpdate={patch => void update(patch)} /></details>
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
  const supervisorHosts = goalSupervisorHostWitnesses(demand)
  return <p className="goals-detail__meta" data-goal-meta>
    <span data-goal-meta-status>{DEMAND_STATUS_LABELS[demand.status]}</span>
    {demand.plan ? progress ? <span className="goals-detail__meta-plan" data-goal-meta-plan={`${progress.done}/${progress.total}`}>
      <span className="goals-detail__meta-bar" aria-hidden="true"><span style={{ transform: `scaleX(${progress.total ? progress.done / progress.total : 0})` }} /></span>
      Plan {progress.done} of {progress.total} done</span>
      : <span data-goal-meta-plan="unavailable">Plan · node states unavailable</span> : null}
    <span className="goals-detail__meta-agent" data-goal-meta-supervisor>{demand.supervisorSessionId
      ? supervisorHosts.length === 1 ? <>Supervisor <GoalContinuationAgent agentSessionId={demand.supervisorSessionId} hostId={supervisorHosts[0]!} active size={16} /></>
        : <span title={demandAgentReferenceLabel(demand.supervisorSessionId)}>Supervisor reference · {typeof demand.supervisorSessionId === 'string' ? supervisorHosts.length ? 'Host conflict' : 'Host unconfirmed' : demandAgentReferenceLabel(demand.supervisorSessionId)}</span> : 'No Supervisor yet'}</span>
    <span>{demand.projectName ?? 'No project'}</span>
  </p>
}
