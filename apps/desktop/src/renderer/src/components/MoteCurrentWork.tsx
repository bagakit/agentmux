import { ArrowUpRight, ChevronDown, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { goalsForMote, moteCurrentGoals, moteGoalContext, moteGoalSummary } from '../lib/mote-goals'
import { sessionPresentationById } from '../lib/session-presentation'
import { fileNavigationSelection, useAppStore } from '../store'
import { MoteBehaviorAction } from './MoteBehaviorDialog'
import { SelectionField } from './SelectionField'
import { GoalContinuationControl } from './GoalContinuationControl'

/** A reading surface over the original Goal owner; it has no timer or execution state. */
export function MoteCurrentWork({ scope, reference, active = true }: {
  scope: MoteWorkfaceScope; reference?: WorkbenchProjectionSelection | null | undefined; active?: boolean
}) {
  const facts = useAppStore(useShallow(state => active ? ({ config: state.config, tabs: state.tabs, layouts: state.layouts,
    scratchTopicSnapshots: state.scratchTopicSnapshots, spaceZoneBindings: state.spaceZoneBindings,
    topicCategories: state.topicCategories, workbenchSpaceSelection: state.workbenchSpaceSelection, activeWorkspaceId: state.activeWorkspaceId }) : null))
  const observedDemands = useAppStore(state => active ? state.demands : null)
  const retainedDemands = useRef(observedDemands ?? useAppStore.getState().demands)
  if (observedDemands !== null) retainedDemands.current = observedDemands
  const demands = retainedDemands.current
  const currentContext = useRef<{ identity: string; value: ReturnType<typeof moteGoalContext> } | null>(null)
  const identity = JSON.stringify([scope.workspace.id, scope.workspace.hostId, scope.workspace.path, scope.topic.id, scope.rootPath, reference])
  const context = useMemo(() => {
    if (!active && currentContext.current?.identity === identity) return currentContext.current.value
    const value = moteGoalContext(useAppStore.getState(), scope, reference)
    currentContext.current = { identity, value }; return value
  }, [active, facts, scope, reference, identity])
  const resourceIdentity = JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id, scope.rootPath])
  const retainedContext = useRef({ identity: resourceIdentity, value: context })
  if (retainedContext.current.identity !== resourceIdentity || !context.issue || context.sessionIds.length || context.contentRef)
    retainedContext.current = { identity: resourceIdentity, value: context }
  const visibleContext = context.issue ? retainedContext.current.value : context
  const visibleSessionIds = visibleContext.sessionIds
  const observedLabels = useAppStore(useShallow(state => {
    if (!active) return null
    const byId = sessionPresentationById(state.sessions)
    return Object.fromEntries(visibleSessionIds.flatMap(id => {
      const session = byId.get(id)
      return session ? [[id, session.label]] : []
    }))
  }))
  const retainedLabels = useRef<{ identity: string; value: Record<string, string> } | null>(null)
  const labelIdentity = JSON.stringify([identity, visibleSessionIds])
  if (observedLabels !== null) retainedLabels.current = { identity: labelIdentity, value: observedLabels }
  if (retainedLabels.current?.identity !== labelIdentity) {
    const byId = sessionPresentationById(useAppStore.getState().sessions)
    retainedLabels.current = { identity: labelIdentity, value: Object.fromEntries(visibleSessionIds.flatMap(id => { const session = byId.get(id); return session ? [[id, session.label]] : [] })) }
  }
  const labels = retainedLabels.current.value
  const goals = useMemo(() => goalsForMote(demands, visibleSessionIds, visibleContext.contentRef), [demands, visibleSessionIds, visibleContext.contentRef])
  const currentGoals = useMemo(() => moteCurrentGoals(goals), [goals])
  const [showAll, setShowAll] = useState(false)
  const visibleGoals = showAll ? goals : currentGoals.slice(0, 3)
  const [expanded, setExpanded] = useState<string | null>(null), [chooser, setChooser] = useState(false)
  const [selectedGoal, setSelectedGoal] = useState(''), [sessionId, setSessionId] = useState('')
  const [loading, setLoading] = useState(false), [issue, setIssue] = useState<string | null>(null)
  const inspected = useRef<object | null>(null)
  const flight = useRef<object | null>(null), lifetime = useRef<object>({})
  const associationIntent = useRef<object>({})
  const navigationRequest = useRef<AbortController | null>(null)
  const referenceKey = JSON.stringify(reference), observedReference = useRef(referenceKey)
  if (observedReference.current !== referenceKey) { observedReference.current = referenceKey; associationIntent.current = {}; navigationRequest.current?.abort() }
  useEffect(() => {
    const owner = {}; lifetime.current = owner
    setShowAll(false); setExpanded(null); setChooser(false)
    flight.current = null
    inspected.current = null
    return () => { lifetime.current = {}; navigationRequest.current?.abort() }
  }, [scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id, scope.rootPath])
  useEffect(() => { if (active && inspected.current !== lifetime.current) void refresh() }, [active, scope.workspace.hostId, scope.workspace.id, scope.workspace.path, scope.topic.id, scope.rootPath])
  async function refresh(owner = lifetime.current) {
    if (flight.current) return
    inspected.current = owner
    const token = {}; flight.current = token; setLoading(true)
    try {
      await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: crypto.randomUUID(), operation: 'demand.list' })
      if (lifetime.current === owner) setIssue(null)
    } catch (error) { if (lifetime.current === owner) setIssue(presentError(error)) }
    finally { if (flight.current === token) { flight.current = null; if (lifetime.current === owner) setLoading(false) } }
  }
  async function openGoal(id: string | null) {
    associationIntent.current = {}; navigationRequest.current?.abort()
    const state = useAppStore.getState()
    const navigation = fileNavigationSelection(state), controller = new AbortController()
    navigationRequest.current = controller
    const cancel = () => controller.abort()
    const unsubscribe = useAppStore.subscribe(next => {
      if (fileNavigationSelection(next) !== navigation && !(next.mainSurface === 'board' && (id === null || next.selectedDemandId === id))) cancel()
    })
    const events = ['pointerdown', 'keydown', 'input'] as const
    for (const event of events) document.addEventListener(event, cancel, true)
    try {
      const result = await state.executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: crypto.randomUUID(),
        operation: 'focus', target: id ? { kind: 'goal', goalId: id } : { kind: 'surface', surface: 'goals' }, inputPolicy: 'preserve' }, controller.signal)
      if (result.operation === 'focus' && result.navigation.state === 'rejected') setIssue(result.issues.map(item => item.message).join(' '))
    } catch (error) { if (!controller.signal.aborted) state.reportError(error) }
    finally { if (navigationRequest.current === controller) navigationRequest.current = null; unsubscribe(); for (const event of events) document.removeEventListener(event, cancel, true) }
  }
  async function link() {
    if (flight.current) return
    const state = useAppStore.getState(), current = moteGoalContext(state, scope, reference), goal = state.demands[selectedGoal]
    if (!goal || !current.sessionIds.includes(sessionId)) { setIssue('Choose a current Goal and an exact Mote discussion. Existing work is kept.'); return }
    const token = {}; flight.current = token; const owner = lifetime.current
    const submittedIntent = associationIntent.current
    const navigation = fileNavigationSelection(state); let moved = false
    const unsubscribe = useAppStore.subscribe(next => { if (fileNavigationSelection(next) !== navigation) moved = true })
    setLoading(true)
    try {
      await state.updateDemand(goal.id, { sessionIds: [...new Set([...goal.sessionIds, sessionId])],
        ...(current.contentRef ? { contentRefs: [current.contentRef] } : {}) }, undefined, goal.updatedAt)
      if (lifetime.current === owner && associationIntent.current === submittedIntent && !moved) { setChooser(false); setIssue(null); setExpanded(goal.id) }
    } catch (error) { if (lifetime.current === owner && associationIntent.current === submittedIntent) setIssue(presentError(error)) }
    finally { unsubscribe(); if (flight.current === token) { flight.current = null; if (lifetime.current === owner) setLoading(false) } }
  }
  return <section className="mote-current-work" aria-label="This Mote’s work">
    <div className="mote-details__section-actions"><span>{showAll ? 'All work' : 'Current work'}<small className="mote-current-work__count">{showAll ? goals.length : currentGoals.length}</small></span><div className="mote-current-work__actions">
      <MoteBehaviorAction label="Refresh this Mote’s goals" onClick={() => void refresh()}><RefreshCw size={13} /></MoteBehaviorAction>
      <MoteBehaviorAction label="Choose or create a goal" expanded={chooser} onClick={() => { associationIntent.current = {}; setChooser(value => !value) }}><Plus size={14} /></MoteBehaviorAction>
    </div></div>
    {context.issue || issue ? <p role="status" className="mote-details__issue">{issue ?? context.issue} Last confirmed goals are kept.</p> : null}
    {loading ? <p role="status" className="mote-details__hint">Reading original goals…</p> : null}
    {visibleGoals.map(goal => {
      const summary = moteGoalSummary(goal), open = expanded === goal.id
      const unloaded = goal.sessionIds.filter(id => context.sessionIds.includes(id) && !Object.hasOwn(labels, id))
      return <div className="mote-current-work__goal" key={goal.id} data-mote-goal={goal.id}>
        <div className="mote-current-work__row"><button type="button" className="mote-current-work__copy" aria-expanded={open}
          onClick={() => { associationIntent.current = {}; setExpanded(open ? null : goal.id) }}><strong>{goal.title}</strong><span>{summary.next}</span></button>
          <MoteBehaviorAction label={`Open goal and results: ${goal.title}`} onClick={() => void openGoal(goal.id)}><ArrowUpRight size={15} /></MoteBehaviorAction>
        </div>
        {open && summary.detail ? <p className="mote-current-work__detail">{summary.detail}</p> : null}
        {unloaded.length ? <p className="mote-details__hint">{unloaded.length} linked discussion{unloaded.length > 1 ? 's' : ''} not loaded. Original references retained.</p> : null}
        {open ? <GoalContinuationControl demand={goal} active={active} onRefresh={() => void refresh()} /> : null}
      </div>
    })}
    {!showAll && goals.length && !currentGoals.length ? <p className="mote-details__hint">No current work. Original results are kept below.</p> : null}
    {showAll || goals.length > visibleGoals.length ? <button type="button" className="mote-current-work__navigation mote-current-work__all" aria-expanded={showAll}
      onClick={() => { associationIntent.current = {}; setShowAll(value => !value) }}>{showAll ? 'Current summary' : 'All work'}<span>{showAll ? currentGoals.length : goals.length}<ChevronDown size={12} /></span></button> : null}
    {chooser ? <div className="mote-current-work__chooser">
      <button type="button" className="mote-current-work__navigation" onClick={() => void openGoal(null)}>Create or review in Goals<ArrowUpRight size={13} /></button>
      <SelectionField label="Goal to associate with this Mote" value={selectedGoal}
        onValueChange={value => { associationIntent.current = {}; setSelectedGoal(value) }}
        options={[{ value: '', label: 'Choose an existing goal…' }, ...Object.values(demands).map(goal => ({ value: goal.id, label: goal.title }))]} />
      <SelectionField label="Mote discussion for the goal" value={sessionId}
        onValueChange={value => { associationIntent.current = {}; setSessionId(value) }}
        options={[{ value: '', label: 'Choose a discussion…' }, ...context.sessionIds.map(id => ({ value: id, label: labels[id] ?? 'Retained discussion · ' + id }))]} />
      <button type="button" className="mote-current-work__navigation" onClick={() => void link()} disabled={loading || !selectedGoal || !sessionId}>Link this discussion<ChevronDown size={12} /></button>
      <p className="mote-details__hint">Linking does not start work. Confirm the scope and choose its executing Agent before continuing.</p>
    </div> : null}
  </section>
}
