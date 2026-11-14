import { isCurrentGroundingAccepted } from '@agentmux/demand/goals'
import { demandAgentReferenceKey, demandAgentReferenceLabel, mergeDemandAgentReferences } from '@agentmux/demand/relations'
import { SearchInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@agentmux/client-ui/components/Button'
import { agentSessionPresentationIndex } from '../lib/session-presentation'
import { projectWorkspaces } from '../lib/workspace-projects'
import type { GoalStage } from '../lib/goal-presentation'
import { GOAL_GROUP_LABELS, goalGroupSummary, groupGoals } from '../lib/goal-groups'
import { adjacentGoalId, createGoalRetainedStartsSelector, goalQueuePosition, stageIndex, stageTransitions } from '../lib/goal-navigation'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { useAppStore } from '../store'
import { executionFocusSessionId } from '../lib/agent-focus'
import { DEMAND_STATUS_IDS, DEMAND_STATUS_LABELS, demandColumns, projectDemands, type DemandProjection, type DemandStatus } from '../lib/global-demand-board'
import { requestPmoTeamsTopicFloatingOpen } from '../lib/pmo-teams-topic-floating'
import { DIRECT_GOAL_TITLE, directGoalRequest, retryDirectGoal, saveDirectGoal, startDirectGoal, subscribeDirectGoalRequest } from '../lib/goals-direct-pmo'
import { GoalDetail } from './GoalDetail'
import { GoalBoardWorkflow, GoalRow, GoalsCollectionBody } from './GoalsCollection'
import { EMPTY_GOAL_ACKNOWLEDGEMENT, type GoalAcknowledgementFeedback } from './GoalAlignment'
import { GoalsCommonActions } from './GoalsCommonActions'
import { GlobalGoalPatrolControl } from './GlobalGoalPatrolControl'
import { SelectionField } from './SelectionField'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import { resolveGoalsPreferences } from '@agentmux/host/goals-preferences'
import goalsHeaderArtUrl from '@agentmux/client-ui/brand/illustrations/goals/goals-companions-header.png'

const ThemeActionClearIcon = semanticIconComponent('action.clear')
const ThemeActionAdjustIcon = semanticIconComponent('action.adjust')
const ThemeObjectListIcon = semanticIconComponent('object.list')
const ThemeLayoutColumns3Icon = semanticIconComponent('layout.columns-3')
const ThemeActionCreateIcon = semanticIconComponent('action.create')
const ThemeObjectGoalIcon = semanticIconComponent('object.goal')


export function GlobalBoardSurface() {
  const config = useAppStore((state) => state.config)
  const demands = useAppStore((state) => state.demands)
  const selectedDemandId = useAppStore((state) => state.selectedDemandId)
  const selectedSessionId = useAppStore((state) => executionFocusSessionId(state.agentFocus))
  const setSelectedDemand = useAppStore((state) => state.setSelectedDemand)
  const creation = useSyncExternalStore(subscribeDirectGoalRequest, directGoalRequest, directGoalRequest)
  const requestDemandPmoTask = useAppStore((state) => state.requestDemandPmoTask)
  const openDemandPmo = useAppStore((state) => state.openDemandPmo)
  const [query, setQuery] = useState('')
  const [view, setView] = useState(() => resolveGoalsPreferences(config?.goals).defaultView)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [stageFilter, setStageFilter] = useState<GoalStage | null>(null)
  const [statusFilter, setStatusFilter] = useState<DemandStatus | 'all'>('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [routingFilter, setRoutingFilter] = useState<'all' | 'unassigned' | 'assigned'>('all')
  const [assigneeFilter, setAssigneeFilter] = useState('all')
  const assigneeEntries = useAppStore(useShallow(state => {
    if (!filtersOpen && assigneeFilter === 'all') return [] as string[]
    const index = agentSessionPresentationIndex(state.sessions)
    const refs = mergeDemandAgentReferences(state.sessions.filter(session => session.kind === 'agent').map(session => session.control.agentSessionId), Object.values(state.demands).flatMap(demand => demand.assigneeSessionIds ?? []))
    return refs.flatMap(ref => { const candidates = typeof ref === 'string' ? index.get(ref) : undefined, session = candidates?.length === 1 ? candidates[0] : undefined; return [demandAgentReferenceKey(ref), session ? state.agentNames[session.id] ?? session.label : `${demandAgentReferenceLabel(ref)} · Unavailable`] })
  }))
  const assigneeIds = assigneeEntries.filter((_value, index) => index % 2 === 0)
  const assigneeName = (id: string) => { const index = assigneeIds.indexOf(id); return index < 0 ? `${id} · Unavailable` : assigneeEntries[index * 2 + 1]! }
  const [showHistory, setShowHistory] = useState(() => resolveGoalsPreferences(config?.goals).showFinished)
  const [moteErrors, setMoteErrors] = useState<Record<string, { message: string; mode: 'open' | 'grill' | 'grounding' | 'plan' }>>({})
  const [motePending, setMotePending] = useState<Record<string, 'open' | 'grill' | 'grounding' | 'plan'>>({})
  const [acknowledgementFeedback, setAcknowledgementFeedback] = useState<Record<string, GoalAcknowledgementFeedback>>({})
  const moteRequests = useRef(new Set<string>())
  const newGoalRef = useRef<HTMLButtonElement>(null)
  const filterRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const selectedRowRef = useRef<HTMLElement | null>(null)
  const surfaceRef = useRef<HTMLElement>(null)
  const projectedDemands = useMemo(() => projectDemands(config, [], demands), [demands, config])
  const retainedStartsSelector = useMemo(() => createGoalRetainedStartsSelector(projectedDemands), [projectedDemands])
  const retainedStarts = useAppStore(useShallow(retainedStartsSelector))
  const selectedDemand = projectedDemands.find((demand) => demand.id === selectedDemandId) ?? null
  const projects = useMemo(() => projectWorkspaces((config?.workspaces ?? []).filter((workspace) => workspace.id !== SCRATCH_WORKSPACE_ID)), [config?.workspaces])
  const scopedDemands = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return projectedDemands.filter(demand => {
      const matchesQuery = !normalized || `${demand.title} ${demand.description} ${demand.projectName ?? ''}`.toLocaleLowerCase().includes(normalized)
      const matchesRouting = routingFilter === 'all' || (routingFilter === 'unassigned' ? !demand.projectId || !demand.assigneeSessionIds?.length : Boolean(demand.projectId && demand.assigneeSessionIds?.length))
      return matchesQuery && (statusFilter === 'all' || demand.status === statusFilter) && (projectFilter === 'all' || demand.projectId === projectFilter) && matchesRouting && (assigneeFilter === 'all' || demand.assigneeSessionIds?.some(ref => demandAgentReferenceKey(ref) === assigneeFilter))
    })
  }, [assigneeFilter, projectFilter, query, routingFilter, statusFilter, projectedDemands])
  const acknowledgementFailed = (id: string) => Boolean(acknowledgementFeedback[id]?.failure)
  const filteredDemands = useMemo(() => showHistory || statusFilter !== 'all' ? scopedDemands : scopedDemands.filter(demand =>
    demand.status !== 'cancelled' && (demand.status !== 'done' || !isCurrentGroundingAccepted(demand.alignment, demand.grounding))),
  [showHistory, statusFilter, scopedDemands])
  const allGroups = useMemo(() => groupGoals(scopedDemands, id => Boolean(acknowledgementFeedback[id]?.failure), id => retainedStarts[id]), [scopedDemands, acknowledgementFeedback, retainedStarts])
  const defaultGroups = useMemo(() => {
    if (filteredDemands === scopedDemands) return allGroups
    const visible = new Set(filteredDemands)
    return allGroups.map(group => ({ ...group, goals: group.goals.filter(goal => visible.has(goal)) })).filter(group => group.goals.length)
  }, [allGroups, scopedDemands, filteredDemands])
  // Selecting Finished explicitly opens the matching history, preserving the default view when returning to All.
  const workflowGroups = useMemo(() => allGroups.flatMap(group => group.stage === 'finished' ? [group] : defaultGroups.filter(item => item.stage === group.stage)), [allGroups, defaultGroups])
  const groups = useMemo(() => stageFilter ? workflowGroups.filter(group => group.stage === stageFilter) : defaultGroups, [workflowGroups, defaultGroups, stageFilter])
  const visibleDemands = stageFilter ? groups[0]?.goals ?? [] : filteredDemands
  const columns = useMemo(() => demandColumns(visibleDemands), [visibleDemands])
  const summaryGroups = groups.filter(group => group.stage !== 'finished')
  // A Goal that was already shown and moved group because its facts changed gets one short cue.
  const shownStages = useRef(new Map<string, GoalStage>())
  const [changedStages, setChangedStages] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    const moved = stageTransitions(shownStages.current, workflowGroups)
    shownStages.current = stageIndex(workflowGroups)
    if (moved.size) setChangedStages(moved)
  }, [workflowGroups])
  const collectionView = view
  const queue = selectedDemandId ? goalQueuePosition(groups, selectedDemandId) : null
  function moveFocus(from: HTMLElement, step: 1 | -1) {
    const id = adjacentGoalId(groups, from.dataset.demandId ?? null, step)
    if (id) surfaceRef.current?.querySelector<HTMLElement>(`[data-demand-id="${CSS.escape(id)}"]`)?.focus()
  }
  const visibleStatuses = statusFilter === 'all' ? DEMAND_STATUS_IDS : [statusFilter]
  const appliedFilters = [
    ...(stageFilter ? [{ label: GOAL_GROUP_LABELS[stageFilter], clear: () => setStageFilter(null) }] : []),
    ...(statusFilter !== 'all' ? [{ label: DEMAND_STATUS_LABELS[statusFilter], clear: () => setStatusFilter('all') }] : []),
    ...(projectFilter !== 'all' ? [{ label: projects.find((project) => project.id === projectFilter)?.name ?? 'Project unavailable', clear: () => setProjectFilter('all') }] : []),
    ...(routingFilter !== 'all' ? [{ label: routingFilter === 'unassigned' ? 'Needs routing' : 'Assigned', clear: () => setRoutingFilter('all') }] : []),
    ...(assigneeFilter !== 'all' ? [{ label: assigneeName(assigneeFilter), clear: () => setAssigneeFilter('all') }] : [])
  ]
  function clearConditions() { setStageFilter(null); setQuery(''); setStatusFilter('all'); setProjectFilter('all'); setRoutingFilter('all'); setAssigneeFilter('all'); setFiltersOpen(false); queueMicrotask(() => searchRef.current?.focus()) }

  function closeDetail() {
    const row = selectedRowRef.current ?? surfaceRef.current?.querySelector<HTMLElement>('[data-demand-id][aria-pressed="true"]')
    selectedRowRef.current = null
    setSelectedDemand(null); queueMicrotask(() => { if (row?.isConnected) row.focus(); else newGoalRef.current?.focus() })
  }
  async function openMote(demandId: string, mode?: 'grill' | 'grounding' | 'plan') {
    if (moteRequests.current.has(demandId)) return
    moteRequests.current.add(demandId); setMotePending(current => ({ ...current, [demandId]: mode ?? 'open' }))
    try {
      const tabId = mode ? await requestDemandPmoTask(demandId, mode) : await openDemandPmo(demandId)
      if (tabId) requestPmoTeamsTopicFloatingOpen({ targetTabId: tabId })
      setMoteErrors(current => { const next = { ...current }; delete next[demandId]; return next })
    } catch (error) { setMoteErrors(current => ({ ...current, [demandId]: { mode: mode ?? 'open', message: error instanceof Error ? error.message : String(error) } })) }
    finally { moteRequests.current.delete(demandId); setMotePending(current => { const next = { ...current }; delete next[demandId]; return next }) }
  }
  function createGoal() {
    if (stageFilter && stageFilter !== 'define') setStageFilter(null)
    const project = projects.find(candidate => candidate.id === projectFilter)
    if (query.trim() && !DIRECT_GOAL_TITLE.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) setQuery('')
    if (statusFilter !== 'all' && statusFilter !== 'backlog') setStatusFilter('all')
    if (routingFilter === 'assigned') setRoutingFilter('all')
    if (assigneeFilter !== 'all') setAssigneeFilter('all')
    if (projectFilter !== 'all' && !project) setProjectFilter('all')
    void startDirectGoal(project)
  }
  function renderRow(demand: DemandProjection) { return <GoalRow key={demand.id} board={view === 'board' && !selectedDemandId} demand={demand} selected={demand.id === selectedDemandId} acknowledgementFailed={acknowledgementFailed(demand.id)} stageChanged={changedStages.has(demand.id)} selectedSessionId={selectedSessionId} compact={Boolean(selectedDemandId)} onSelect={() => { selectedRowRef.current = document.activeElement as HTMLElement; setSelectedDemand(demand.id) }} /> }

  return <section ref={surfaceRef} className={`global-board-surface goals-surface${selectedDemandId ? ' goals-surface--detail-open' : ''}`} onKeyDown={(event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.goals-collection [data-demand-id]')
    if (row && event.target === row && !event.nativeEvent.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const step = event.key === 'j' || event.key === 'ArrowDown' ? 1 : event.key === 'k' || event.key === 'ArrowUp' ? -1 : 0
      if (step) { event.preventDefault(); moveFocus(row, step); return }
    }
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
    if ((event.target as HTMLElement).closest('[role="menu"], [role="dialog"]')) return
    if (filtersOpen) { setFiltersOpen(false); queueMicrotask(() => filterRef.current?.focus()) }
    else if (selectedDemand && !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) closeDetail()
  }}>
    <div className="goals-layout"><div className="goals-index">
      <header className="goals-page-header">
        {projectedDemands.length && !selectedDemandId ? <img className="goals-page-header__art" src={goalsHeaderArtUrl} alt="" aria-hidden="true" width={139} height={96} draggable={false} onError={event => { event.currentTarget.hidden = true }} /> : null}
        <div className="goals-page-header__title"><span className="goals-page-header__mark" aria-hidden="true"><ThemeObjectGoalIcon size={16} /></span><h1>Goals</h1></div>
        {projectedDemands.length && view !== 'board' ? <p className="goals-page-header__summary" aria-live="polite">{summaryGroups.map(group => <span key={group.stage} data-goal-summary-stage={group.stage}>{goalGroupSummary(group.stage, group.goals.length)}</span>)}{!groups.some(group => group.stage === 'you') ? <span data-goal-summary-clear>Nothing waits on you</span> : null}</p> : null}
        <div className="goals-page-header__actions">
          <GlobalGoalPatrolControl />
          <button ref={newGoalRef} type="button" className={selectedDemandId ? 'small-button' : 'primary-button'} aria-label="New Goal" aria-describedby="goals-create-effect" data-new-goal disabled={Boolean(creation)} onClick={createGoal}><ThemeActionCreateIcon size={14} />New Goal<span id="goals-create-effect" className="goals-visually-hidden">Draft + discussion</span></button>
        </div>
        <GoalsCommonActions contextCompact={Boolean(selectedDemandId)} onReturnToCommon={() => setSelectedDemand(null)} />
      </header>
      <header className="goals-toolbar">
        <SearchInput className="goals-search" ref={searchRef} aria-label="Search goals" placeholder="Search goals…"
          clearLabel="Clear search" value={query} onValueChange={setQuery} />
        <button ref={filterRef} type="button" className={`small-button${appliedFilters.length ? ' small-button--active' : ''}`} aria-label="Goal filters" aria-expanded={filtersOpen} aria-controls="goals-filters" onClick={() => setFiltersOpen(!filtersOpen)}><ThemeActionAdjustIcon size={13} /><span>Filter</span>{appliedFilters.length ? <span>{appliedFilters.length}</span> : null}</button>
        {!selectedDemandId ? <SurfaceModeSwitch value={view} onChange={setView} active ariaLabel="Goal view" options={[{ value: 'list', label: <ThemeObjectListIcon size={14} />, ariaLabel: 'List view' }, { value: 'board', label: <ThemeLayoutColumns3Icon size={14} />, ariaLabel: 'Board view' }]} /> : null}
      </header>
      {filtersOpen ? <div id="goals-filters" className="goals-filters" aria-label="Filter goals">
        <label>Work status<SelectionField label="Filter work status" value={statusFilter} onValueChange={value => setStatusFilter(value as typeof statusFilter)} options={[{ value: 'all', label: showHistory ? 'All statuses' : 'All active' }, ...DEMAND_STATUS_IDS.map(value => ({ value, label: DEMAND_STATUS_LABELS[value] }))]} /></label>
        <label>Project<SelectionField label="Filter project" value={projectFilter} onValueChange={setProjectFilter} options={[{ value: 'all', label: 'All projects' }, ...(projectFilter !== 'all' && !projects.some(project => project.id === projectFilter) ? [{ value: projectFilter, label: 'Project unavailable', disabled: true }] : []), ...projects.map(project => ({ value: project.id, label: project.name }))]} /></label>
        <label>Routing<SelectionField label="Filter routing" value={routingFilter} onValueChange={value => setRoutingFilter(value as typeof routingFilter)} options={[{ value: 'all', label: 'All routing' }, { value: 'unassigned', label: 'Needs routing' }, { value: 'assigned', label: 'Assigned' }]} /></label>
        <label>Assignee<SelectionField label="Filter assignee" value={assigneeFilter} onValueChange={setAssigneeFilter} options={[{ value: 'all', label: 'Any assignee' }, ...assigneeIds.map(value => ({ value, label: assigneeName(value) }))]} /></label>
      </div> : null}
      {appliedFilters.length ? <div className="goals-filter-chips">{appliedFilters.map((filter) => <button type="button" key={filter.label} onClick={filter.clear} aria-label={`Clear ${filter.label} filter`}>{filter.label}<ThemeActionClearIcon size={11} /></button>)}<button type="button" className="goals-filter-chips__clear" data-goal-clear-all onClick={clearConditions}>Clear all</button></div> : null}
      {creation ? <div className="goals-service goals-creation" role="status" data-direct-goal-id={creation.id}>
        {creation.pending ? creation.phase === 'save' ? 'Saving goal…' : 'Goal saved. Preparing its discussion…' : creation.phase === 'save' ? creation.notSaved ? 'The goal is not saved. Save this same goal to continue.' : 'Goal save is unconfirmed. Read this same goal before continuing.' : 'Goal saved. Its discussion is unconfirmed; the original workface is kept.'}
        {creation.error ? <><span>{creation.error}</span><Button type="button" variant="primary" onClick={() => void (creation.notSaved ? saveDirectGoal() : retryDirectGoal())}>{creation.phase === 'save' ? creation.notSaved ? 'Save this goal' : 'Read goal again' : 'Retry goal discussion'}</Button></> : null}
      </div> : null}
      {collectionView === 'board' && projectedDemands.length > 0 ? <GoalBoardWorkflow groups={workflowGroups} selected={stageFilter}
        onSelect={value => setStageFilter(current => current === value ? null : value)} /> : null}
      <div className={`goals-collection goals-collection--${collectionView}`} role="region" aria-label="Global goals">
        <GoalsCollectionBody view={collectionView} groups={groups} columns={columns} visibleStatuses={visibleStatuses} hasGoals={projectedDemands.length > 0} hasMatches={visibleDemands.length > 0} query={query} filterCount={appliedFilters.length} hideStart={creation?.phase === 'save' && !creation.notSaved} onClearConditions={clearConditions} onShowFinished={() => setShowHistory(true)} renderRow={renderRow} />
      </div>
      <footer className="goals-footer"><span>{visibleDemands.length} of {projectedDemands.length} goals{collectionView === 'board' ? ' · Work status' : ''}</span><button type="button" aria-pressed={showHistory} onClick={() => setShowHistory(!showHistory)}>{showHistory ? 'Hide finished' : 'Show finished'}</button></footer>
    </div>
    {selectedDemand ? <GoalDetail
      key={selectedDemand.id}
      demand={selectedDemand}
      acknowledgementFeedback={acknowledgementFeedback[selectedDemand.id] ?? EMPTY_GOAL_ACKNOWLEDGEMENT}
      onAcknowledgementFeedbackChange={(patch) => setAcknowledgementFeedback(current => ({ ...current, [selectedDemand.id]: { ...(current[selectedDemand.id] ?? EMPTY_GOAL_ACKNOWLEDGEMENT), ...patch } }))}
      onClose={closeDetail}
      onOpenMote={() => void openMote(selectedDemand.id)}
      onGrill={() => void openMote(selectedDemand.id, 'grill')}
      onGrounding={() => void openMote(selectedDemand.id, 'grounding')}
      onPlan={() => void openMote(selectedDemand.id, 'plan')}
      motePending={motePending[selectedDemand.id] ?? null}
      moteError={moteErrors[selectedDemand.id] ?? null}
      onRetryMote={() => { const mode = moteErrors[selectedDemand.id]?.mode; void openMote(selectedDemand.id, mode === 'open' ? undefined : mode) }}
      queue={queue}
      onOpenGoal={setSelectedDemand}
    /> : selectedDemandId ? <aside className="goals-detail"><button className="small-button" onClick={closeDetail}>Back to goals</button><p className="goals-service">The selected goal is not available yet. Its identity is kept while recovery continues.</p></aside> : null}
    </div>
  </section>
}
