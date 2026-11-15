import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { Button } from '@agentmux/client-ui/components/Button'
import dialogueArtworkUrl from '@agentmux/client-ui/brand/illustrations/goals/demand-dialogue.png'
import { GoalReadingOutline, type GoalReadingSection } from './GoalReadingOutline'
import * as Menu from './DropdownMenu'
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import { ComposerTextarea } from '@agentmux/client-ui/input'
import { GoalCommonProperties, GoalProperties } from './GoalProperties'
import { GoalWorkArea } from './GoalWorkArea'
import { GoalIntent } from './GoalIntent'
import { ConfirmationDialog } from './ConfirmationDialog'
import type { GoalAgentRole } from '../lib/goal-agent-selection'
import { GoalAgentPicker } from './GoalAgentPicker'
import { GoalExecution } from './GoalExecution'
import { GoalPlanGraph, goalPlanDeliveries, goalPlanProjection, type GoalPlanReveal } from './GoalPlanGraph'
import { GoalPlanRequest } from './GoalPlanRequest'
import { GoalSupervisorRail } from './GoalSupervisorRail'
import { useGoalDiscussionRecipient } from '../lib/goal-discussion-recipient'
import { editGoalDraft, saveGoalDrafts } from '../lib/goal-edit-drafts'
import { GoalActivity } from './GoalActivity'
import { GoalAcknowledgementRecovery, GoalAlignment, type GoalAcknowledgementFeedback } from './GoalAlignment'
import { goalNextStepFact, type GoalNextStepSource } from '../lib/goal-presentation'
import { GOAL_GROUP_LABELS, GoalStageMark } from '../lib/goal-groups'
import type { GoalQueuePosition } from '../lib/goal-navigation'
import type { GoalStage } from '../lib/goal-presentation'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { desktopPresentationCommitted } from '../lib/desktop-presentation'
import '../styles/goal-reading.css'

const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeActionMoreIcon = semanticIconComponent('action.more')
const ThemeActionRemoveIcon = semanticIconComponent('action.remove')
const ThemeNavigationForwardIcon = semanticIconComponent('navigation.forward')
const ThemeDoneIcon = semanticIconComponent('status.completed')
const QUEUE_NAMES: Record<GoalStage, string> = { you: 'needs you', attention: 'needs attention', define: 'needs defining', agents: 'is with agents', unknown: 'is unknown', finished: 'is finished' }
const SupervisorPaneIcon = semanticIconComponent('layout.open-right')
const CopyLinkIcon = semanticIconComponent('action.copy-address')

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
  const teamRegionId = useId()
  const overviewRef = useRef<HTMLElement>(null)
  const planRef = useRef<HTMLDivElement>(null)
  const planningControls = useRef<HTMLDivElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const executionRef = useRef<HTMLElement>(null)
  const [inspectorRole, setInspectorRole] = useState<GoalAgentRole | null>(null)
  const activityRef = useRef<HTMLDivElement>(null)
  const [showSupervisor, setShowSupervisor] = useState(false)
  const [planReveal, setPlanReveal] = useState<GoalPlanReveal | null>(null)
  const jumpedToScrollTop = useRef<number | null>(null)
  const [readingSection, setReadingSection] = useState<GoalReadingSection>('plan')
  const hasActivity = Boolean(demand.activities?.length || demand.decisions?.length)
  const visibleSection = readingSection === 'activity' && !hasActivity ? 'plan' : readingSection
  const toolbarRef = useRef<HTMLElement>(null)
  const supervisorToggle = useRef<HTMLButtonElement>(null)
  const previousReadingTop = useRef<number | null>(null)
  const readingEntry = useAppStore(state => state.goalReadingEntry)
  const revealedEntry = useRef<string | null>(null)
  const [copied, setCopied] = useState<'goal' | 'plan' | null>(null)
  const [copyIssue, setCopyIssue] = useState<string | null>(null)
  const [intentEditing, setIntentEditing] = useState(descriptionDirty)
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current, detail = detailRef.current
    if (!detail || !toolbar) return
    const updateOffsets = () => {
      detail.style.setProperty('--goal-detail-toolbar-height', `${toolbar.offsetHeight}px`)
      detail.style.setProperty('--goal-detail-reading-offset', `${toolbar.offsetHeight + 12}px`)
      if (supervisorToggle.current && getComputedStyle(supervisorToggle.current).display === 'none') setShowSupervisor(false)
    }
    updateOffsets()
    const observer = new ResizeObserver(updateOffsets)
    observer.observe(detail)
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [demand.id])
  useLayoutEffect(() => {
    if (!showSupervisor && previousReadingTop.current !== null && detailRef.current) {
      detailRef.current.scrollTop = previousReadingTop.current
      previousReadingTop.current = null
    }
  }, [showSupervisor])
  function revealSection(section: HTMLElement | null, focus = true) {
    const detail = detailRef.current
    if (!detail || !section) return
    const destination = section.closest<HTMLElement>('[data-goal-reading-section]')?.dataset.goalReadingSection as GoalReadingSection | undefined
    if (destination) setReadingSection(destination)
    if (focus) useAppStore.setState({ goalReadingEntry: null })
    const margin = Number.parseFloat(getComputedStyle(section).scrollMarginTop) || 0
    detail.scrollTop = Math.max(0, detail.scrollTop + section.getBoundingClientRect().top - detail.getBoundingClientRect().top - margin)
    if (destination) jumpedToScrollTop.current = detail.scrollTop
    if (focus) section.focus({ preventScroll: true })
  }
  function revealWork(section: HTMLElement | null, focus = true) {
    if (!showSupervisor) { revealSection(section, focus); return }
    previousReadingTop.current = null
    setShowSupervisor(false)
    requestAnimationFrame(() => revealSection(section, focus))
  }
  function revealGoalReview(definition: boolean) {
    const section = resultsRef.current
    const details = definition ? section?.querySelector<HTMLDetailsElement>('.goal-review__disclosure') : null
    if (details) details.open = true
    const report = !definition ? section?.querySelector<HTMLElement>('[data-goal-grounding-submission]') : null
    revealWork(report ?? section)
  }
  function revealOriginalWork(source: Extract<GoalNextStepSource, { kind: 'start' | 'delegation' | 'patrol' }>) {
    const operation = CSS.escape(source.operationId)
    const detail = detailRef.current
    const pending = source.kind === 'start' ? detail?.querySelector<HTMLElement>(`[data-goal-retained-operation="${operation}"]`) : null
    const original = pending ?? detail?.querySelector<HTMLElement>(`[data-goal-work-kind="${source.kind}"][data-goal-work-operation="${operation}"]`)
    if (!original) return
    if (source.kind === 'patrol') {
      revealSupervisor(true, original)
      return
    }
    for (let ancestor = original.parentElement; ancestor && ancestor !== executionRef.current; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true
    }
    revealWork(original)
  }
  function revealSupervisor(focus = true, target = teamRef.current) {
    const side = teamRef.current
    const detail = detailRef.current
    if (!side || !detail || !target) return
    const narrow = supervisorToggle.current && getComputedStyle(supervisorToggle.current).display !== 'none'
    if (narrow) {
      if (!showSupervisor) previousReadingTop.current = detail.scrollTop
      setShowSupervisor(true)
    }
    useAppStore.setState({ goalReadingEntry: null })
    const reveal = () => {
      if (narrow) {
        detail.scrollTop = target === side ? 0 : Math.max(0, detail.scrollTop + target.getBoundingClientRect().top
          - detail.getBoundingClientRect().top - (toolbarRef.current?.offsetHeight ?? 0) - 12)
      } else if (target !== side) {
        side.scrollTop += target.getBoundingClientRect().top - side.getBoundingClientRect().top
      }
      if (focus) target.focus({ preventScroll: true })
    }
    if (narrow && !showSupervisor) requestAnimationFrame(reveal)
    else reveal()
  }
  function revealPlanningControls() {
    const target = planningControls.current
    const actions = target?.querySelector('details')
    if (actions) actions.open = true
    revealSupervisor(true, target)
  }
  function revealAttempt(nodeId: string, operationId: string, trigger: HTMLButtonElement) {
    previousReadingTop.current = null
    setShowSupervisor(false)
    jumpedToScrollTop.current = null
    setReadingSection('plan')
    setPlanReveal({ target: { nodeId, attemptId: operationId }, trigger,
      ...(showSupervisor ? { restore: () => revealSupervisor(false) } : {}) })
  }
  useLayoutEffect(() => {
    const detail = detailRef.current
    if (!detail || showSupervisor) return
    let frame: number | null = null
    const roots = [planRef.current, overviewRef.current, executionRef.current, activityRef.current]
    function updateReadingSection() {
      frame = null
      if (jumpedToScrollTop.current === detail!.scrollTop) return
      jumpedToScrollTop.current = null
      const sections = roots.filter((section): section is HTMLElement => Boolean(section))
      const viewport = detail!.getBoundingClientRect()
      if (!viewport.height || !sections.length) return
      const margin = Number.parseFloat(getComputedStyle(sections[0]!).scrollMarginTop) || 0
      const readingLine = viewport.top + margin + 2
      const positions = sections.map(section => ({ id: section.dataset.goalReadingSection as GoalReadingSection, top: section.getBoundingClientRect().top }))
      const passed = positions.filter(section => section.top <= readingLine)
      const latestTop = Math.max(...passed.map(section => section.top))
      // When anchors align, keep the one the reader explicitly selected.
      const currentRow = passed.filter(section => Math.abs(section.top - latestTop) <= 2)
      const tail = positions.at(-1)
      const atEnd = detail!.scrollHeight > detail!.clientHeight && detail!.scrollHeight - detail!.scrollTop - detail!.clientHeight <= 2
      setReadingSection(current => atEnd && tail && tail.top < viewport.bottom ? tail.id
        : currentRow.find(section => section.id === current)?.id ?? currentRow[0]?.id ?? 'plan')
    }
    function scheduleReadingSection() { if (frame === null) frame = requestAnimationFrame(updateReadingSection) }
    detail.addEventListener('scroll', scheduleReadingSection, { passive: true })
    const observer = new ResizeObserver(scheduleReadingSection)
    observer.observe(detail)
    for (const section of roots) if (section) observer.observe(section)
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
  const intentBody = <ComposerTextarea syntax="markdown" aria-label="Goal description" value={description} onValueChange={value => editGoalDraft(demand.id, 'description', value)} onBlur={() => { if (descriptionDirty) void saveGoalDrafts(demand.id, ['description']) }} rows={Math.max(3, Math.min(14, description.split('\n').length + 1))} placeholder="Describe the outcome in your own words…" />
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
  const finished = demand.status === 'done' || demand.status === 'cancelled'
  const fact = useMemo(() => goalNextStepFact(demand, retainedStart), [demand, retainedStart])
  const projection = useMemo(() => goalPlanProjection(demand, fact), [demand, fact])
  const deliveries = useMemo(() => goalPlanDeliveries(projection), [projection])
  const currentDelivery = deliveries[0]
  const currentWork = !acknowledgementFeedback.failure && (fact.source.kind === 'start' || fact.source.kind === 'delegation' || fact.source.kind === 'patrol') ? fact.source : null
  const plan = <div ref={planRef} tabIndex={-1} className="goals-detail__plan" data-goal-reading-section="plan" data-goal-reading-id={demand.id} data-goal-reading-runtime={demand.address?.runtimeId} data-goal-reading-namespace={demand.address?.namespace}>
    <GoalPlanGraph demand={demand} projection={projection} reveal={planReveal} onOpenGoalWork={currentWork ? () => revealOriginalWork(currentWork) : undefined}
      planningLink={!finished ? <Button type="button" onClick={revealPlanningControls}>{demand.plan?.nodes.length ? 'Plan actions' : 'Plan with Supervisor'}<SupervisorPaneIcon size={14} aria-hidden="true" /></Button> : null}
      planLink={demand.address ? <button type="button" className="icon-button goal-plan__copy" title={copied === 'plan' ? 'Plan link copied' : 'Copy plan link'} onClick={() => void copyLink('plan')}>
        {copied === 'plan' ? <ThemeDoneIcon size={15} aria-hidden="true" /> : <CopyLinkIcon size={15} aria-hidden="true" />}
        <span className="goals-visually-hidden">{copied === 'plan' ? 'Plan link copied' : 'Copy plan link'}</span>
      </button> : null} />
  </div>
  const stage = acknowledgementFeedback.failure ? 'you' : fact.stage
  const next = acknowledgementFeedback.failure ? 'Acknowledgement unconfirmed' : fact.text
  const missingDoneReport = demand.status === 'done' && !demand.grounding
  const readReport = Boolean(demand.grounding) && (fact.source.kind === 'results' || fact.source.kind === 'definition' && !demand.alignment)
  const readDefinition = Boolean(demand.alignment) && (fact.source.kind === 'definition' || missingDoneReport && !demand.alignment?.confirmedAt)
  const requestFeedback = moteError ? <div className="goals-service" role="status">
    {moteError.mode === 'open' ? 'Goal saved. The discussion could not be opened.' : `${moteError.mode === 'plan' ? 'Planning' : moteError.mode === 'grill' ? 'Goal' : 'Check'} request delivery is unconfirmed. Your goal and current work are kept.`}
    <span>{moteError.message}</span>
    <Button type="button" disabled={Boolean(motePending)} onClick={onRetryMote}>
      {moteError.mode === 'open' ? 'Retry opening discussion' : moteError.mode === 'plan' ? 'Check planning request' : moteError.mode === 'grill' ? 'Retry goal request' : 'Retry check request'}
    </Button>
  </div> : null
  const readingTargets = { plan: planRef, overview: overviewRef, execution: executionRef, activity: activityRef }
  return <aside ref={detailRef} className="goals-detail" data-goal-detail-id={demand.id} data-goal-view={showSupervisor ? 'supervisor' : 'work'} aria-label={`Goal workspace for ${demand.title}`}>
    <header ref={toolbarRef} className="goals-detail__toolbar">
      <nav className="goal-outline__trail" aria-label="Goal location">
        <button type="button" className="goal-outline__back" onClick={onClose} aria-label="Back to goals"><ThemeNavigationBackIcon size={13} aria-hidden="true" />Goals</button>
        {demand.projectName ? <span className="goal-outline__project" title={demand.projectName}><i aria-hidden="true">/</i><span>{demand.projectName}</span></span> : null}
        <i aria-hidden="true">/</i>
        <GoalReadingOutline current={visibleSection} supervisor={showSupervisor} hasActivity={hasActivity}
          onNavigate={id => revealWork(readingTargets[id].current)} />
      </nav>
      <div className="goal-outline__tools">
        <button type="button" ref={supervisorToggle} className="goals-detail__team-link" data-goal-supervisor-toggle
          aria-label="Supervisor" aria-controls={teamRegionId} title={showSupervisor ? 'Return to goal' : 'Open Supervisor'} aria-pressed={showSupervisor}
          onClick={() => showSupervisor ? setShowSupervisor(false) : revealSupervisor()}>
          <SupervisorPaneIcon size={16} aria-hidden="true" /><span>{showSupervisor ? 'Return to goal' : 'Supervisor'}</span>
        </button>
        <Menu.Root modal={false}>
          <Menu.Trigger asChild><button ref={actionsRef} type="button" className="icon-button" aria-label="Goal actions"><ThemeActionMoreIcon size={15} /></button></Menu.Trigger>
          <Menu.Portal><div className="window-overlay-host__entry" data-overlay-layer="popover">
            <Menu.Content className="tab-context-menu" align="end" sideOffset={4} collisionPadding={8} aria-label="Goal actions">
              {demand.address ? <Menu.Item className="tab-context-menu__item" onSelect={() => void copyLink('goal')}><CopyLinkIcon size={14} />{copied === 'goal' ? 'Goal link copied' : 'Copy goal link'}</Menu.Item>
                : <Menu.Label className="goal-outline__address-issue"><strong>Goal address unconfirmed</strong>{demand.addressIssue ?? 'The original Goal owner has not confirmed its address.'}</Menu.Label>}
              <Menu.Separator className="tab-context-menu__separator" />
              <Menu.Item className="tab-context-menu__item goals-delete-action" onSelect={() => { actionsRef.current?.focus(); setDeleteRequested(true) }}><ThemeActionRemoveIcon size={13} />Delete goal</Menu.Item>
            </Menu.Content>
          </div></Menu.Portal>
        </Menu.Root>
      </div>
    </header>
    <article className="goals-document">
      <div className="goals-detail__body">
      <header className="goals-detail__head">
        <div className="goals-detail__identity">
          <div className="goals-detail__title">
            <ComposerTextarea className="goals-title" aria-label="Goal title" value={title} onValueChange={value => editGoalDraft(demand.id, 'title', value)} rows={1} onBlur={() => { if (titleDirty && title.trim()) void saveGoalDrafts(demand.id, ['title']) }} />
            <p className="goals-detail__stage"><span className="goals-detail__status"><GoalStageMark stage={stage} /><strong data-goal-detail-stage>{next}</strong></span>{currentWork ? <button type="button" className="goals-detail__current-work" onClick={() => revealOriginalWork(currentWork)}>{currentWork.kind === 'patrol' ? 'View original inspection' : 'View current work'}<ThemeNavigationForwardIcon size={12} aria-hidden="true" /></button> : null}</p>
          </div>
        </div>
        <div className="goals-detail__actions">
          {deliveries.length ? <span className="goals-detail__pending-review">{deliveries.length} awaiting review</span> : null}
          {projection.progress ? <span className="goals-detail__progress" data-goal-meta-plan={`${projection.progress.done}/${projection.progress.total}`}>
            Plan {projection.progress.done} of {projection.progress.total} done</span> : null}
          {currentDelivery ? <Button variant="primary" onClick={event => revealAttempt(currentDelivery.node.id, currentDelivery.delegation.operationId, event.currentTarget)}>View delivery<ThemeNavigationForwardIcon size={13} aria-hidden="true" /></Button> : null}
          {(readReport || readDefinition) && !acknowledgementFeedback.failure
            ? <Button type="button" onClick={() => revealGoalReview(readDefinition)}>{readReport ? 'Read results' : demand.alignment?.criteria.length ? 'Read success criteria' : 'Read proposal'}</Button> : null}
          {queue && queue.total > 1 ? <span className="goals-detail__queue" data-goal-queue><span>{GOAL_GROUP_LABELS[queue.stage]} · {queue.index} of {queue.total}</span>{queue.nextId ? <Button type="button" data-goal-queue-next aria-label={`Next goal that ${QUEUE_NAMES[queue.stage]}`} onClick={() => onOpenGoal?.(queue.nextId!)}>Next<ThemeNavigationForwardIcon size={13} /></Button> : null}</span> : null}
        </div>
        <p className="goals-detail__edit-status" aria-live="polite">{hasEditDraft ? draftIssue ? 'Edits kept · Save unconfirmed' : 'Unsaved edits' : null}</p>
      </header>
        {copyIssue ? <p className="goals-service" role="status">Link could not be copied. {copyIssue}</p> : null}
        {moteError?.mode !== 'open' ? requestFeedback : null}
        {acknowledgementFeedback.failure ? <GoalAcknowledgementRecovery goalId={demand.id} feedback={acknowledgementFeedback} onFeedbackChange={onAcknowledgementFeedbackChange} /> : null}
        <div className="goals-detail__main">
          {plan}
          <section ref={overviewRef} tabIndex={-1} className="goals-detail__overview" aria-label="Goal overview" data-goal-reading-section="overview"
            data-goal-reading-id={demand.id} data-goal-reading-runtime={demand.address?.runtimeId} data-goal-reading-namespace={demand.address?.namespace}>
            <div className="goals-section-heading goals-detail__overview-heading">
              <h2>Goal overview</h2>
              <Button type="button" className="goals-detail__discussion" disabled={Boolean(motePending)} onClick={onOpenMote}
                aria-label={`Open discussion for ${demand.title}`} title={recipient.openLabel}>
                <img src={dialogueArtworkUrl} width={34} height={24} alt="" decoding="async" loading="lazy"
                  onError={event => { event.currentTarget.hidden = true }} />
                {motePending === 'open' ? 'Opening discussion…' : recipient.openLabel}
              </Button>
            </div>
            {moteError?.mode === 'open' ? requestFeedback : null}
            {descriptionDirty ? <span className="goals-caption">Unsaved draft</span> : null}
            <div className="goals-intent-body goals-detail__brief" aria-label="Goal brief">{intent(demand.plan ? 3 : 6)}{saveFeedback}</div>
            <div ref={resultsRef} tabIndex={-1} className="goals-detail__definition" aria-label="Criteria and results">
              <GoalAlignment emphasis={fact.source.kind === 'definition' || fact.source.kind === 'results' ? fact.source.kind : null}
                feedback={acknowledgementFeedback} onFeedbackChange={onAcknowledgementFeedbackChange}
                demand={demand} onGrill={onGrill} onGrounding={onGrounding} motePending={motePending} />
            </div>
          </section>
          <GoalWorkArea key={demand.id} demand={demand} sectionRef={executionRef} primary={!acknowledgementFeedback.failure && !currentDelivery} onRevealResults={() => revealGoalReview(false)} />
          {hasActivity ? <div ref={activityRef} tabIndex={-1} className="goals-detail__activity" data-goal-reading-section="activity" data-goal-reading-id={demand.id} data-goal-reading-runtime={demand.address?.runtimeId} data-goal-reading-namespace={demand.address?.namespace}><GoalActivity demand={demand} /></div> : null}
        </div>
      </div>
        <aside ref={teamRef} id={teamRegionId} tabIndex={-1} className="goals-detail__side" aria-label="Goal team and properties">
          <GoalSupervisorRail demand={demand} inspectionIsCurrent={currentWork?.kind === 'patrol' && !currentDelivery}
            onChooseSupervisor={() => setInspectorRole('supervisor')} onAddAssignee={() => setInspectorRole('assignees')}
            planning={!finished ? <div ref={planningControls} className="goal-supervisor-rail__planning" tabIndex={-1} aria-label="Planning with Supervisor">
              <GoalPlanRequest demand={demand} onRequest={onPlan} pending={motePending === 'plan'} busy={Boolean(motePending)}
                onChooseSupervisor={() => setInspectorRole(demand.assigneeSessionIds?.length ? 'supervisor' : 'assignees')} />
            </div> : null}
            currentDelivery={currentDelivery ? { nodeId: currentDelivery.node.id, operationId: currentDelivery.delegation.operationId, title: currentDelivery.node.title } : undefined} onRevealAttempt={revealAttempt} />
          <details className="goals-detail__relationships"><summary>Team and relationships</summary>
            <GoalExecution demand={demand} onUpdate={update} onChooseSupervisor={() => setInspectorRole('supervisor')} />
          </details>
          <details className="goals-detail__properties" aria-label="Goal properties"><summary><ThemeNavigationForwardIcon className="goals-detail__properties-chevron" size={12} aria-hidden="true" />Properties<span>Status, priority, project</span></summary><GoalCommonProperties demand={demand} onUpdate={patch => void update(patch)} /><GoalProperties demand={demand} onUpdate={patch => void update(patch)} /></details>
        </aside>
    </article>
    {inspectorRole ? <GoalAgentPicker demand={demand} role={inspectorRole} onSave={update} onClose={() => setInspectorRole(null)} /> : null}
    <ConfirmationDialog open={deleteRequested} title="Delete goal?" subject={demand.title}
      description="This removes the goal and its saved planning records. Linked Sessions keep running."
      confirmLabel="Delete goal" onCancel={() => setDeleteRequested(false)}
      onConfirm={() => { setDeleteRequested(false); deleteDemand(demand.id); onClose() }} />
  </aside>
}
