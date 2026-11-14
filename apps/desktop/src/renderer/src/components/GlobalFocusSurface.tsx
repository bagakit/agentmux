import type { FocusContextAccess } from '../lib/focus-context-access'
import { spaceMountKey } from '../../../shared/space-mount'
import { originalSourceEntryForSelection } from '../lib/original-space-navigation'
import { useFocusSources } from '../lib/use-focus-sources'
import { focusContextIdentityKey } from '../lib/focus-context-identity'
import { SpaceSourceReaders } from './SpaceSourceReaders'
import { LocalRetainedInputsPanel } from './LocalRetainedInputs'
import { TextInput } from '@agentmux/client-ui/input'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { agentRegionExecution, agentRegionLocationsKnown, agentRegionLocationBindings, useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { createFocusProjectionSelector, agentContextForSession, retainedFocusContext } from '../lib/focus-context'
import { FocusContextCards } from './FocusContextCards'
import { useFocusHierarchy } from '../lib/use-focus-hierarchy'
import { deriveFocusProjectLanes, deriveRetainedFocusProjects, focusWorkspaceProject, focusProjectKey, focusLaneProjectKey, focusLanesByContext, type FocusProjectLane } from '../lib/focus-project-lanes'
import { useFocusHistorySources } from '../lib/focus-history-sources'
import type { ExecutionFocusPresentation } from '../lib/focus-tab-projection'
import { AttentionRequestPanel } from './AttentionRequestPanel'
import { SessionObservationRegions } from './SessionObservationRegions'
import { AgentTopologySummary } from './AgentTopologySummary'
import { FocusProjectLanes, FocusRetainedProjects } from './FocusProjectLanes'
import { FocusScanLaneContent } from './FocusScanLaneContent'
import { filterFocusScanLanes, focusTopicContextKey } from '../lib/focus-collection-lanes'
import { useFocusCollectionLanes } from '../lib/use-focus-collection-lanes'
import { useFocusProjectOrder } from '../lib/use-focus-project-order'
import { FocusGroupDiscussion } from './FocusGroupDiscussion'
import { focusVisitTimes, focusQuietProject } from '../lib/focus-attention'
import { focusLaneOrigins, type FocusSourceType } from '../lib/focus-lane-origin'
import { EMPTY_FOCUS_FILTERS, FOCUS_FILTER_STATES, focusMatchesProject, focusMatchesState, focusMatchesTypes, type FocusFilters as FocusFilterSelection } from '../lib/focus-filters'
import { FocusFilters } from './FocusFilters'
import { readSurveyPresentation } from '../lib/mobile-presentation'
import { focusCardTrackHeight, type FocusLaneMetrics } from '../lib/focus-lane-layout'
import { resolveFocusReplyLines, resolveFocusTopicPresentation } from '../../../shared/focus-preferences'
import { focusSelectionStyle } from '../lib/focus-selection-style'
import { FocusToolbar } from './FocusToolbar'
import { FocusHistorySearch } from './FocusHistorySearch'
import { useFocusHistorySearch } from '../lib/use-focus-history-search'
import { createFocusGoalLinksSelector } from '../lib/focus-goal-links'
import { FocusSearchLocations, focusSearchResultName } from './FocusSearchLocations'
import { focusSearchCatalog, focusSearchContextKey, searchFocus } from '../lib/focus-search'
import { FocusSourceStatus } from './FocusSourceStatus'
import { projectRailNavigation } from '../lib/workspace-projects'
import { RecentFocusTimeline } from './RecentFocusTimeline'
import type { RevealConversationItem } from '../lib/mailbox-message-navigation'
import { requestPmoTeamsTopicFloatingOpen, readPmoTeamsTopicFloatingState } from '../lib/pmo-teams-topic-floating'
import { executionFocusSessionId, focusLaneForSession } from '../lib/agent-focus'
import { workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { sameWorkbenchProjectionSelection } from '../lib/workbench-projection'
import { agentSessionPresentationIndex, sessionPresentationById } from '../lib/session-presentation'
import { sourceRegionProjectionReference, topicIdForSession, workspaceForSession, type WorkbenchTab } from '../lib/workbench-tabs'
import { useWorkbenchTabRecord, useWorkbenchTabNameMetadata, useWorkbenchTabSessions } from '../lib/workbench-session-subscriptions'
import { workbenchTabDisplayName } from '../lib/workbench-tab-presentation'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import { WorkbenchPresentationContext, type WorkbenchViewTargets } from '../lib/workbench-presentation'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { groupIds, regionIds } from '@agentmux/layout'
import { createFocusContextIdentitySelector, focusContextAtRegion } from '../lib/focus-context-identity'
import { workbenchNavigationTabs } from '../lib/workbench-navigation-catalog'

const ThemeActionSearchIcon = semanticIconComponent('action.search')
const ArrangeProjectsIcon = semanticIconComponent('object.history')
const ThemeObjectTeamIcon = semanticIconComponent('object.team')


function FocusLocationChoice({ reference, tab, workspaceName, groupIndex, regionIndex, onSelect }: {
  reference: WorkbenchProjectionSelection
  tab: WorkbenchTab | undefined
  workspaceName: string
  groupIndex: number
  regionIndex: number
  onSelect: () => void
}) {
  const sessions = useWorkbenchTabSessions(tab)
  const sessionNameMetadata = useWorkbenchTabNameMetadata(tab)
  const names = useWorkbenchTabRecord('agentNames', tab)
  const timelines = useWorkbenchTabRecord('timelines', tab)
  return <button type="button" className="small-button focus-location-choice" onClick={onSelect}
    title={`${reference.displayWorkspaceId} / ${reference.groupId} / ${reference.tabId} / ${reference.regionId}`}>
    <strong>{tab ? workbenchTabDisplayName(tab, sessions, names, timelines, sessionNameMetadata) : 'Original work surface'}</strong>
    <small>{workspaceName}{' · '}{groupIndex >= 0 ? `Group ${groupIndex + 1}` : 'Original Group'}
      {' · '}{regionIndex >= 0 ? `Region ${regionIndex + 1}` : 'Original Region'}</small>
  </button>
}

export function GlobalFocusSurface({ presentation, currentReference = null, directoryIssue = null, viewTargets, regionOnly, onToggleRegion, workspaceOpen, onCloseWorkspace, onSelectContext, onSelectLocation, visible: hostVisible = true }: {
  visible?: boolean
  workspaceOpen?: boolean
  onCloseWorkspace?: (() => void) | undefined
  onSelectContext?: ((id: string, reference?: import('../lib/workbench-projection').WorkbenchProjectionSelection) => void) | undefined
  onSelectLocation?: import('../lib/workbench-projection').WorkbenchProjection['onSelect'] | undefined
  presentation?: ExecutionFocusPresentation
  /** A verified view of the common main choice, independent of the Reader's MRU. */
  currentReference?: import('../lib/workbench-projection').WorkbenchProjectionSelection | null | undefined
  regionOnly?: boolean | undefined
  onToggleRegion?: (() => void) | undefined
  directoryIssue?: string | null
  viewTargets?: WorkbenchViewTargets
} = {}) {
  const surfaceVisible = useAppStore(state => state.mainSurface === 'agents' && state.focusView === 'list')
  const visible = hostVisible && surfaceVisible
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<FocusFilterSelection>(EMPTY_FOCUS_FILTERS)
  const [inspectingFilters, setInspectingFilters] = useState(false)
  const [allTimelineProjects, setAllTimelineProjects] = useState(false)
  const changeFilters = (next: FocusFilterSelection) => {
    if (filters.projects.length && !next.projects.length) setAllTimelineProjects(false)
    setFilters(next)
  }
  const filtering = Boolean(query.trim() || filters.projects.length || filters.states.length || filters.types.length)
  const contextSelector = useMemo(createFocusProjectionSelector, [])
  const {contexts: ordinaryRows, laneContexts: ordinaryLaneContexts, coordinationContexts, pmoAttention} = useAppStore(useShallow(state => contextSelector(state, visible, query.trim() ? 'full' : 'metadata', filtering || inspectingFilters)))
  const [sourceChoices, setSourceChoices] = useState<{ locations: FocusContextAccess['locations']; choose(location: FocusContextAccess['locations'][number]): void } | null>(null)
  const chooseSourceLocation = useCallback((request: NonNullable<typeof sourceChoices>) => setSourceChoices(request), [])
  const observedProjectLanes = useRef<readonly FocusProjectLane[]>([])
  const recordSourceFocus = useCallback((context: import('../lib/focus-context').FocusContext) => {
    const memberships = observedProjectLanes.current.filter(lane => lane.contextRefs.some(ref => ref.hostId === context.hostId && ref.id === context.id))
    const project = memberships.length === 1 ? memberships[0] : undefined
    useAppStore.getState().focusExecutionSession(context.id, undefined, { navigate: false, identity: {
      name: context.name, kind: context.kind, providerId: context.providerId, hostId: context.hostId, workspacePath: context.workspacePath,
      ...(context.access ? { source: context.access.identity } : {}),
      ...(project ? { project: { id: project.projectId, name: project.name } } : {})
    } })
  }, [])
  const sourceFacts = useFocusSources({ visible, contexts: ordinaryRows, onFocusContext: recordSourceFocus, onChooseLocation: chooseSourceLocation, ...(onSelectLocation ? { onSelectLocation } : {}) })
  const executionRows = useMemo(() => [...ordinaryRows, ...sourceFacts.contexts], [ordinaryRows, sourceFacts.contexts])
  const laneContexts = useMemo(() => [...ordinaryLaneContexts, ...sourceFacts.contexts], [ordinaryLaneContexts, sourceFacts.contexts])
  const selectedSourceKey = useAppStore(state => {
    const choice = state.workbenchSpaceSelection, tab = choice?.tabId ? state.tabs[choice.tabId] : undefined
    return tab && !tab.source ? null : originalSourceEntryForSelection(state)?.key ?? null
  })
  const sourceChoice = useAppStore(state => state.workbenchSpaceSelection), tabs = useAppStore(state => state.tabs)
  const sourceSelection = useMemo(() => {
    if (!selectedSourceKey || !sourceChoice?.tabId || !sourceChoice.regionId) return null
    const tab = tabs[sourceChoice.tabId], region = tab?.regions[sourceChoice.regionId], source = tab?.source, regionSource = sourceRegionProjectionReference(region)
    if (!source || !regionSource || spaceMountKey(source.reference) !== selectedSourceKey) return null
    const selected = { tabId: source.tabId, regionId: regionSource.regionId }
    for (const context of executionRows) {
      const access = context.access ?? sourceFacts.aliases.get(focusContextIdentityKey(context.hostId, context.id))
      const location = access?.locations.find(location => spaceMountKey(location.source.reference) === selectedSourceKey && location.tabId === selected.tabId && location.regionId === selected.regionId)
      if (access && location) return { context, access, location }
    }
    return null
  }, [selectedSourceKey, sourceChoice, tabs, executionRows, sourceFacts.aliases])
  const goalLinksSelector = useMemo(createFocusGoalLinksSelector, [])
  const goalLinks = useAppStore(state => goalLinksSelector(state, visible))
  const moteIdentity = useAppStore(useShallow(state => {
    const session = state.sessions.find(item => item.id === pmoAttention[0])
    const workspace = session && workspaceForSession(state.config, session, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots))
    const id = session && topicIdForSession(state.config, session, scratchTopicsForConfig(state.config, state.scratchTopicSnapshots))
    const topic = id && scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)?.find(item => item.id === id)
    const target = workspace && topic && !topic.readError ? topicSpaceIconTarget(workspace, topic) : null
    const key = target?.key
    return { name: topic && !topic.readError ? topic.title || 'Mote' : 'Mote', icon: key ? state.spaceObjectIcons[key] ?? null : null, avatarWorkspaceId: target?.avatarTarget?.workspaceId, avatarTopicId: target?.avatarTarget?.topicId, avatarObjectKey: key }
  }))
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore(state => state.activeWorkspaceId)
  const timelineProject = useMemo(() => {
    if (!config || selectedSourceKey) return null
    const resource = projectRailNavigation(config.workspaces).projects.flatMap(project => project.workspaces).find(workspace => workspace.id === activeWorkspaceId)
    return resource ? focusWorkspaceProject(resource, config) : null
  }, [config, activeWorkspaceId, selectedSourceKey])
  const timelineProjectScope = useMemo(() => {
    const projects = filters.projects.length ? filters.projects : !allTimelineProjects && timelineProject ? [timelineProject] : []
    return { projects, label: projects.length ? projects.map(project => project.name).join(' or ') : 'All projects' }
  }, [filters.projects, allTimelineProjects, timelineProject])
  const replyLines = resolveFocusReplyLines(config?.focus?.replyLines)
  const topicPresentation = resolveFocusTopicPresentation(config?.focus?.topicPresentation)
  const topicSnapshots = useAppStore(state => state.scratchTopicSnapshots)
  const layouts = useAppStore(state => state.layouts)
  const selectedId = useAppStore((state) => executionFocusSessionId(state.agentFocus))
  const selectedMoteId = useAppStore(state => state.agentFocus.pmo.sessionId)
  const agentReveal = useAppStore(state => state.focusAgentReveal)
  const revealSessions = useAppStore(useShallow(state => !agentReveal ? [] :
    (agentSessionPresentationIndex(state.sessions).get(agentReveal.agentSessionId) ?? []).filter(session =>
      session.control.hostId === agentReveal.hostId && session.control.agentSessionId === agentReveal.agentSessionId &&
      (agentReveal.presentationSessionId === undefined || session.id === agentReveal.presentationSessionId))))
  const finishReveal = useAppStore(state => state.finishFocusAgentReveal)
  const clearReveal = useAppStore(state => state.clearFocusAgentReveal)
  const revealName = useAppStore(state => agentReveal ? state.agentNames[agentReveal.presentationSessionId ?? agentReveal.agentSessionId] : undefined)
  const projection = presentation?.projection ?? null
  const selectedTab = projection?.selection.length === 1 ? tabs[projection.selection[0]!.tabId] ?? null : null
  const activeSurface = projection?.selection[0] && selectedTab?.regions[projection.selection[0].regionId]
  const shownSessionId = activeSurface && (activeSurface.kind === 'agent' || activeSurface.kind === 'terminal') ? activeSurface.sessionId : null
  const currentSurface = currentReference && tabs[currentReference.tabId]?.regions[currentReference.regionId]
  const currentContext = sourceSelection?.context ?? (currentSurface && (currentSurface.kind === 'agent' || currentSurface.kind === 'terminal') && currentReference
    ? focusContextAtRegion(executionRows.filter(context => context.id === currentSurface.sessionId), currentReference, agentRegionExecution) : null)
  const showWorkspace = Boolean(sourceSelection || sourceChoices) || (workspaceOpen ?? Boolean(projection || presentation?.unselected || presentation?.issue || selectedId))
  const selectedSessionIds = useMemo(() => selectedId ? [selectedId] : [], [selectedId])
  const sessions = useAppStore(useShallow(state => selectedTab ? [] : selectedSessionIds.flatMap(id => { const session = sessionPresentationById(state.sessions).get(id); return session ? [session] : [] })))
  // A Session Core still lists, with no Region occurrence at all: the reachable recovery is to give it one.
  // Placing it starts, stops, resumes and sends nothing; its own Region then owns any recovery.
  const placeless = !projection && !directoryIssue && presentation?.issue && !presentation.references.length &&
    sessions.length === 1 && sessions[0]!.id === selectedId ? sessions[0]! : null
  const executionHistory = useAppStore((state) => state.agentFocus.execution.history)
  const focusVisits = useMemo(() => focusVisitTimes(executionHistory), [executionHistory])
  const timelines = useAppStore(useShallow(state => {
    const held: typeof state.timelines = {}
    for (const entry of executionHistory) if (entry.identity?.kind === 'agent' && state.timelines[entry.sessionId]) held[entry.sessionId] = state.timelines[entry.sessionId]!
    return held
  }))
  const cardPresentation = useMemo(() => ({ active: visible, retainedRegionId: null }), [visible])
  const catalogue = useFocusHistorySources(visible)
  const focusPmoSession = useAppStore(state => state.focusPmoSession)
  const storedFocusExecutionSession = useAppStore((state) => state.focusExecutionSession)
  const selectOriginalContext = onSelectContext ?? storedFocusExecutionSession
  const executionTargets = useRef({ contexts: sourceFacts.contexts, aliases: sourceFacts.aliases, ordinaryRows })
  executionTargets.current = { contexts: sourceFacts.contexts, aliases: sourceFacts.aliases, ordinaryRows }
  const focusExecutionSession = useCallback((id: string, reference?: WorkbenchProjectionSelection) => {
    clearReveal()
    const source = executionTargets.current.contexts.find(context => context.id === id)?.access
    if (source) { source.select(); return }
    const aliases = executionTargets.current.aliases.get(focusContextIdentityKey(executionTargets.current.ordinaryRows.find(context => context.id === id)?.hostId ?? '', id))
    const current = useAppStore.getState()
    const hasOriginalPosition = workbenchSelectionCatalog(current).locations.some(location => {
      const region = current.tabs[location.tabId]?.regions[location.regionId]
      return (region?.kind === 'agent' || region?.kind === 'terminal') && region.sessionId === id
    })
    if (!reference && !hasOriginalPosition && aliases) { aliases.select(); return }
    selectOriginalContext(id, reference)
  }, [clearReveal, selectOriginalContext])
  const selectTimelineContext = useCallback((context: import('../lib/focus-context').FocusContext) => {
    if (context.access) { clearReveal(); context.access.select(); return }
    focusExecutionSession(context.id)
  }, [clearReveal, focusExecutionSession])
  const openPlaceless = useCallback((id: string) => {
    // The original placement owner selects the new occurrence and reports its own refusal;
    // the notice and this action stay available when it declines.
    clearReveal(); useAppStore.getState().selectSession(id, undefined, { keepSurface: true })
  }, [clearReveal])
  const revealedContext = useMemo(() => {
    if (!agentReveal) return null
    if (revealSessions.length > 1) return null
    const session = revealSessions[0]
    if (session) {
      const context = executionRows.find(row => row.hostId === session.hostId && row.id === session.id)
      if (context) return { context, lane: 'execution' as const }
      const topics = scratchTopicsForConfig(config, topicSnapshots), workspace = workspaceForSession(config, session, topics)
      const topicId = topicIdForSession(config, session, topics)
      return { context: agentContextForSession(session, undefined, revealName, workspace, topicId),
        lane: focusLaneForSession(topicId, scratchTopicsForWorkspace(topicSnapshots, workspace)) }
    }
    const sources = catalogue.sources.filter(source => source.hostId === agentReveal.hostId && source.agentSessionId === agentReveal.agentSessionId)
    return sources.length === 1 ? { context: retainedFocusContext(sources[0]!, revealName), lane: null } : null
  }, [agentReveal, revealSessions, executionRows, config, topicSnapshots, catalogue.sources, revealName])
  const handledReveal = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!agentReveal?.pending) return
    if (!visible) { finishReveal(agentReveal.requestId); return }
    if (handledReveal.current === agentReveal.requestId) return
    if (!revealedContext) {
      if (catalogue.available || catalogue.error) { handledReveal.current = agentReveal.requestId; finishReveal(agentReveal.requestId) }
      return
    }
    handledReveal.current = agentReveal.requestId
    // Reading a retained or coordination Context must not write execution history.
    if (revealedContext.lane === 'execution') storedFocusExecutionSession(revealedContext.context.id, undefined, { navigate: false })
    else if (revealedContext.lane === 'pmo') focusPmoSession(revealedContext.context.id)
  }, [agentReveal, visible, revealedContext, catalogue.available, catalogue.error, finishReveal, storedFocusExecutionSession, focusPmoSession])
  const revealFocusRecord = useCallback<RevealConversationItem>(async (itemRef, routeHostId = itemRef.hostId) => {
    const original = sessionPresentationById(useAppStore.getState().sessions).get(itemRef.agentSessionId)
    if (original?.kind !== 'agent' || original.control.hostId !== routeHostId) {
      return { kind: 'unavailable', itemRef, message: 'Original Session is unconfirmed. The recorded content remains readable; choose its original Context to inspect the source.' }
    }
    // Keep App's original Focus presentation callback, then hand off only a reading intent.
    focusExecutionSession(itemRef.agentSessionId)
    const result = await useAppStore.getState().revealConversationItem(itemRef, routeHostId)
    if (result.kind === 'unavailable') useAppStore.getState().reportError(new Error(result.message), { kind: 'indeterminate' })
    return result
  }, [focusExecutionSession])
  useEffect(() => {
    if (!visible) useAppStore.getState().conversationRevealIntent?.complete({ kind: 'cancelled' })
  }, [visible])
  useEffect(() => () => { useAppStore.getState().conversationRevealIntent?.complete({ kind: 'cancelled' }) }, [])
  const historySearch = useFocusHistorySearch(query, visible)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [historyWindowRequest, setHistoryWindowRequest] = useState<{ at: number; sequence: number }>()
  const [workspaceRatio, setWorkspaceRatio] = useState(0.618)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const clearLocalFilters = () => {
    historySearch.retainForLocalQuery('')
    setQuery(''); setFilters(EMPTY_FOCUS_FILTERS); setAllTimelineProjects(false)
    searchRef.current?.focus()
  }
  const closeWorkspace = () => { setSourceChoices(null); onCloseWorkspace?.(); searchRef.current?.focus() }
  const focusLayoutRef = useRef<HTMLDivElement | null>(null)
  const resizingFocusRef = useRef(false)
  const adjustWorkspaceRatio = (next: number) => setWorkspaceRatio(Math.min(0.76, Math.max(0.38, next)))
  useEffect(() => {
    if (!visible) return
    const onPointerMove = (event: PointerEvent) => {
      if (!resizingFocusRef.current || !focusLayoutRef.current) return
      const rect = focusLayoutRef.current.getBoundingClientRect()
      if (rect.width <= 0) return
      adjustWorkspaceRatio((rect.right - event.clientX) / rect.width)
    }
    const stop = () => { resizingFocusRef.current = false; document.body.style.cursor = ''; document.body.style.userSelect = '' }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stop)
    return () => { stop(); window.removeEventListener('pointermove', onPointerMove); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); window.removeEventListener('blur', stop) }
  }, [visible])
  const { facts, errors: hierarchyErrors, refresh: refreshHierarchy } = useFocusHierarchy(laneContexts, config, visible)
  const boardRowsRef = useRef<HTMLDivElement>(null)
  const [arrangeProjects, setArrangeProjects] = useState(0)
  const separateRevealRef = useRef<HTMLDivElement>(null)
  const filterContexts = useMemo(() => [...executionRows, ...coordinationContexts], [executionRows, coordinationContexts])
  const scanInteraction = useRef(false)
  const navigationCatalog = useAppStore(workbenchSelectionCatalog)
  const identityTabs = workbenchNavigationTabs(tabs)
  const identitySelector = useMemo(createFocusContextIdentitySelector, [])
  const locationsKnown = useAppStore(agentRegionLocationsKnown)
  const executionBindings = useAppStore(agentRegionLocationBindings)
  const lastIdentities = useRef<ReturnType<typeof identitySelector>>(new Map())
  const contextIdentities = useMemo(() => {
    if (visible) lastIdentities.current = identitySelector(navigationCatalog, identityTabs, filterContexts, config, layouts, agentRegionExecution, locationsKnown, executionBindings)
    const merged = new Map(lastIdentities.current)
    for (const [key, identity] of sourceFacts.identities) {
      const previous = merged.get(key)
      const all = [...(previous?.locations.occurrences ?? []), ...identity.locations.occurrences]
      const unique = [...new Map(all.map(item => [JSON.stringify(item), item])).values()]
      merged.set(key, { ...identity, tabs: previous?.tabs.length ? previous.tabs : identity.tabs, occurrenceCount: unique.length || identity.occurrenceCount,
        locations: { status: unique.length ? 'confirmed' : identity.locations.status, occurrences: unique } })
    }
    return merged
  }, [sourceFacts.identities, visible, identitySelector, navigationCatalog, identityTabs, filterContexts, config?.executors, config?.appearance.agentAvatars, config?.workspaces, layouts, locationsKnown, executionBindings])
  const allLanes = useMemo(() => deriveFocusProjectLanes(laneContexts, config, facts, contextIdentities, Date.now(), topicSnapshots), [laneContexts, config, facts, tabs, topicSnapshots, contextIdentities])
  observedProjectLanes.current = allLanes
  const coordinationLanes = useMemo(() => deriveFocusProjectLanes(coordinationContexts, config, undefined, contextIdentities, Date.now(), topicSnapshots), [coordinationContexts, config, tabs, topicSnapshots, contextIdentities])
  const filterLanes = useMemo(() => [...allLanes, ...coordinationLanes], [allLanes, coordinationLanes])
  const survey = useAppStore(useShallow(state => ({ surveyCollectedZones: state.surveyCollectedZones, surveyOrganization: state.surveyOrganization, surveyExplorationNames: state.surveyExplorationNames })))
  const originContent = useAppStore(useShallow(state => ({ bindings: state.spaceZoneBindings, categories: state.topicCategories })))
  const surveyItems = useMemo(() => readSurveyPresentation({ ...survey, surveyPageReferences: [], surveyZoneSelection: null, tabs }, navigationCatalog).items, [survey, tabs, navigationCatalog])
  const laneMembership = JSON.stringify(filterLanes.map(lane => [lane.id, lane.hostId, lane.workspaceId, lane.projectWorkspaceId, lane.topicId, lane.objectKind, lane.contextRefs]))
  const laneOrigins = useMemo(() => focusLaneOrigins(filterLanes, navigationCatalog, surveyItems, originContent, contextIdentities), [laneMembership, navigationCatalog, tabs, surveyItems, originContent, contextIdentities])
  const retainedProjects = useMemo(() => deriveRetainedFocusProjects(executionHistory, allLanes, {
    timelines, sources: catalogue.sources, sourcesAvailable: catalogue.available
  }), [executionHistory, allLanes, timelines, catalogue.sources, catalogue.available])
  const trimmedQuery = query.trim()
  const searchingMetadata = Boolean(trimmedQuery)
  const searchCatalog = useMemo(() => searchingMetadata ? focusSearchCatalog(navigationCatalog, agentRegionExecution) : navigationCatalog,
    [searchingMetadata, navigationCatalog, executionRows])
  const searchResult = useMemo(() => searchFocus(query, { rows: filterContexts, lanes: filterLanes, catalog: searchCatalog, sources: catalogue.sources, history: executionHistory, retained: retainedProjects }), [query, filterContexts, filterLanes, searchCatalog, catalogue.sources, executionHistory, retainedProjects])
  const searchNames = useMemo(() => {
    if (!query.trim()) return { locations: new Map<string, string | undefined>(), sources: new Map<string, string>(), unplaced: new Map<string, string | undefined>(), descriptions: new Map<string, string>() }
    const names = new Map(filterContexts.map(row => [focusSearchContextKey(row.hostId, row.id, row.kind), row.name]))
    const regions = new Map(searchCatalog.regions.map(region => [JSON.stringify([region.tabId, region.regionId]), region]))
    const catalogTabs = new Map(searchCatalog.tabs.map(tab => [tab.tabId, tab]))
    const zones = new Map(searchCatalog.zones.map(zone => [zone.zoneId, zone]))
    const descriptions = new Map<string, string>()
    const locations = new Map(searchResult.locations.map(location => {
      const ref = location.reference, region = regions.get(JSON.stringify([ref.tabId, ref.regionId]))
      const hostId = region?.execution?.hostId ?? zones.get(catalogTabs.get(ref.tabId)?.zoneId ?? '')?.hostId
      const workspace = config?.workspaces.find(item => item.id === ref.displayWorkspaceId && item.hostId === hostId)
      const host = config?.hosts.find(item => item.id === hostId), layout = layouts[ref.displayWorkspaceId]
      const index = layout ? groupIds(layout.root).indexOf(ref.groupId) : -1
      descriptions.set(location.address, `${workspace?.name ?? 'Original workspace'} · ${host?.label ?? hostId ?? 'Host unconfirmed'} · ${index >= 0 ? `Group ${index + 1}` : 'Group unconfirmed'}`)
      const name = hostId && location.sessionId && (location.kind === 'agent' || location.kind === 'terminal')
        ? names.get(focusSearchContextKey(hostId, location.sessionId, location.kind)) : undefined
      const ids = [ref.regionId, ref.tabId, location.sessionId]
      return [location.address, focusSearchResultName(name, ids) ?? focusSearchResultName(tabs[ref.tabId]?.name, ids)] as const
    }))
    const sources = new Map<string, string>()
    for (const entry of executionHistory) if (entry.identity?.kind === 'agent') {
      const key = JSON.stringify([entry.identity.hostId, entry.sessionId])
      const name = focusSearchResultName(entry.identity.name, [entry.sessionId])
      if (name && !sources.has(key)) sources.set(key, name)
    }
    const unplaced = new Map(searchResult.unplaced.filter(object => object.kind === 'zone').map(object => {
      const zone = zones.get(object.id), workspace = config?.workspaces.find(item => zone && item.id === zone.workspaceId && item.hostId === zone.hostId)
      return [object.id, zone?.branch ?? workspace?.name] as const
    }))
    return { locations, sources, unplaced, descriptions }
  }, [query, searchResult, filterContexts, searchCatalog, executionHistory, tabs, config?.workspaces, config?.hosts, layouts])

  const lanesByContext = focusLanesByContext(filterLanes)
  // The common Region choice is independent of both the project filter and Agent MRU.
  const resourceLaneIds = new Set(currentSurface && currentSurface.kind !== 'agent' && currentSurface.kind !== 'terminal'
    ? filterLanes.filter(lane => lane.workspaceId === currentSurface.workspaceId
      && lane.hostId === config?.workspaces.find(workspace => workspace.id === currentSurface.workspaceId)?.hostId
      && lane.topicId === (tabs[currentReference!.tabId]?.topicId ?? null)).map(lane => lane.id) : [])
  const currentLanes = currentContext ? (lanesByContext.get(focusTopicContextKey(currentContext.hostId, currentContext.id)) ?? []).filter(lane =>
    contextIdentities.get(focusTopicContextKey(currentContext.hostId, currentContext.id))?.locations.status === 'confirmed' &&
    contextIdentities.get(focusTopicContextKey(currentContext.hostId, currentContext.id))!.locations.occurrences.some(occurrence =>
      occurrence.display.workspaceId === lane.workspaceId && occurrence.display.workspaceId === currentReference?.displayWorkspaceId &&
      occurrence.display.groupId === currentReference.groupId && occurrence.display.tabId === currentReference.tabId && occurrence.display.regionId === currentReference.regionId)) : []
  const currentLaneId = currentContext ? currentLanes.length === 1 ? currentLanes[0]!.id : null
    : resourceLaneIds.size === 1 ? resourceLaneIds.values().next().value ?? null : null
  const projectsForRow = (row: typeof executionRows[number]) => [...new Set((lanesByContext.get(focusTopicContextKey(row.hostId, row.id)) ?? []).map(focusLaneProjectKey))]
  const typesForRow = (row: typeof executionRows[number]): readonly FocusSourceType[] => {
    const lanes = lanesByContext.get(focusTopicContextKey(row.hostId, row.id)) ?? []
    return [...new Set(lanes.flatMap(lane => laneOrigins.get(lane.id)?.contextTypes?.get(focusTopicContextKey(row.hostId, row.id)) ?? ['unknown' as const]))]
  }
  const searched = filterContexts.filter(row => searchResult.contextKeys.has(focusSearchContextKey(row.hostId, row.id, row.kind)))
  const matching = searched.filter(row => (filters.projects.length === 0 || projectsForRow(row).some(key => focusMatchesProject(key, filters.projects))) && focusMatchesTypes(typesForRow(row), filters.types))
  const matched = matching.filter(row => focusMatchesState(row, filters.states))
  const revealRow = revealedContext?.lane === 'execution' ? revealedContext.context : null
  const executionIds = new Set(executionRows.map(row => focusTopicContextKey(row.hostId, row.id)))
  const matchedExecution = matched.filter(row => executionIds.has(focusTopicContextKey(row.hostId, row.id)))
  const coordinationResults = filtering ? matched.filter(row => !executionIds.has(focusTopicContextKey(row.hostId, row.id))) : []
  const filtered = revealRow && !matchedExecution.includes(revealRow) ? [...matchedExecution, revealRow] : matchedExecution
  const revealOutsideFilters = Boolean(revealedContext && !matched.includes(revealedContext.context))
  const selected = sourceSelection?.context ?? (shownSessionId && projection?.selection[0]
    ? focusContextAtRegion(executionRows.filter(row => row.id === shownSessionId), projection.selection[0], agentRegionExecution) ?? undefined : undefined)
  const mapContext = revealedContext?.context ?? selected
  const selectedContextKey = sourceSelection ? focusContextIdentityKey(sourceSelection.context.hostId, sourceSelection.context.id) : agentReveal && revealedContext ? JSON.stringify([revealedContext.context.hostId, revealedContext.context.id]) : undefined
  const filteredIds = new Set(filtered.map(row => focusTopicContextKey(row.hostId, row.id)))
  const collectedLanes = useFocusCollectionLanes(allLanes, navigationCatalog, originContent, boardRowsRef, scanInteraction, visible)
  const orderedLanes = useFocusProjectOrder(collectedLanes, visible, boardRowsRef, scanInteraction, config?.focus?.projects, arrangeProjects)
  const boardLanes = filterFocusScanLanes(orderedLanes,
    lane => filters.projects.length === 0 || focusMatchesProject(focusLaneProjectKey(lane), filters.projects), filteredIds)
  const scansByContext = new Map<string, { scanId: string; originalId: string }[]>()
  for (const lane of boardLanes) for (const original of lane.collection?.topics ?? [lane]) for (const ref of original.contextRefs) {
    const key = focusTopicContextKey(ref.hostId, ref.id), entries = scansByContext.get(key) ?? []
    entries.push({ scanId: lane.id, originalId: original.id }); scansByContext.set(key, entries)
  }
  const displayedCurrentLaneId = currentLaneId
  const rowsByLane = new Map<string, typeof filtered>()
  for (const row of filtered) {
    for (const scanId of new Set((scansByContext.get(focusTopicContextKey(row.hostId, row.id)) ?? []).map(scan => scan.scanId))) {
    const rows = rowsByLane.get(scanId) ?? []
    rows.push(row)
    rowsByLane.set(scanId, rows)
    }
  }
  const quietLanes = new Set(boardLanes.filter(lane => !lane.locationUnconfirmed && !lane.recovery
    && focusQuietProject(rowsByLane.get(lane.id) ?? [], focusVisits, Date.now())).map(lane => lane.id))
  const protectedLanes = new Set(boardLanes.filter(lane => (rowsByLane.get(lane.id) ?? []).some(row =>
    row.bucket === 'attention' || row.bucket === 'working' || row.activitySemantic !== 'idle' || row.runUnobserved || row.detailKind === 'service')).map(lane => lane.id))
  const revealedLaneIds = new Set(agentReveal && revealedContext ? (scansByContext.get(focusTopicContextKey(revealedContext.context.hostId, revealedContext.context.id)) ?? []).map(item => item.scanId) : [])
  const filteredRetainedProjects = retainedProjects.filter(item => focusMatchesProject(item.key, filters.projects) && filters.states.length === 0 && focusMatchesTypes(['unknown'], filters.types)
    && searchResult.projectKeys.has(item.key))
  const recentProjects = filteredRetainedProjects.filter(item => item.recent)
  const pastProjects = filteredRetainedProjects.filter(item => !item.recent)
  const readProjectHistory = useCallback((at: number) => {
    if (at > 0) setHistoryWindowRequest(current => ({ at, sequence: (current?.sequence ?? 0) + 1 }))
  }, [])
  const [laneMetrics, setLaneMetrics] = useState<FocusLaneMetrics & { measured: boolean }>({ width: 0, padding: 4, gap: 2, cardGap: 2, measured: false })
  const [documentActive, setDocumentActive] = useState(document.visibilityState !== 'hidden')
  useEffect(() => {
    const observe = () => setDocumentActive(document.visibilityState !== 'hidden')
    observe(); document.addEventListener('visibilitychange', observe)
    return () => document.removeEventListener('visibilitychange', observe)
  }, [])
  const hasBoardLanes = boardLanes.length > 0 || recentProjects.length > 0
  const hasBoardCards = hasBoardLanes || pastProjects.length > 0
  useLayoutEffect(() => {
    const rows = boardRowsRef.current ?? focusLayoutRef.current?.querySelector<HTMLElement>('.focus-retained-projects__rows')
    if (!visible || !documentActive || !hasBoardCards || !rows || typeof ResizeObserver === 'undefined') return
    let active = true
    const measure: ResizeObserverCallback = entries => {
      if (!active || document.visibilityState === 'hidden') return
      // Rows stretch each lane's grid across this content box. Its RO width
      // already excludes the scroll bar and preserves fractional CSS pixels.
      // One visible initial read establishes actual columns before paint;
      // subsequent deliveries use the observer's content box directly.
      const width = entries.find(entry => entry.target === rows)?.contentRect.width ?? rows.clientWidth
      if (width <= 0) { setLaneMetrics(current => current.measured ? current : { ...current, measured: true }); return }
      const groups = rows.querySelector<HTMLElement>('.focus-project-lanes__groups')
      if (!groups) return
      const style = getComputedStyle(groups), cards = groups.querySelector<HTMLElement>('.focus-context-group__cards')
      const gap = parseFloat(style.columnGap) || 0
      const next = { width, padding: (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0), gap, cardGap: cards ? parseFloat(getComputedStyle(cards).columnGap) || 0 : gap, measured: true }
      setLaneMetrics(current => current.measured && current.width === next.width && current.padding === next.padding && current.gap === next.gap && current.cardGap === next.cardGap ? current : next)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(rows)
    measure([], observer)
    return () => { active = false; observer.disconnect() }
  }, [visible, documentActive, hasBoardCards, hasBoardLanes])
  const projectOptions = useMemo(() => {
    const options = [...new Map([...filterLanes.map(lane => ({ id: focusLaneProjectKey(lane), name: lane.labels[0]!, hostId: lane.hostId })),
      ...retainedProjects.map(item => ({ id: item.key, name: item.name, hostId: item.hostId }))].map(item => [item.id, item])).values()]
    const names = new Map<string, number>(), hosts = new Map(config?.hosts.map(host => [host.id, host.label]))
    for (const item of options) names.set(item.name, (names.get(item.name) ?? 0) + 1)
    return options.map(item => ({ ...item, name: names.get(item.name)! > 1 ? `${item.name} · ${hosts.get(item.hostId) || item.hostId}` : item.name }))
  }, [filterLanes, retainedProjects, config?.hosts])
  // Facets reuse the same supplied observations, with only their own dimension
  // excluded. No history reads, owner writes or unrelated-session queries.
  const projectCounts = new Map<string, number>(), stateCounts = new Map<import('../lib/focus-filters').FocusStateFilter, number>(), typeCounts = new Map<FocusSourceType, number>()
  for (const row of searched) {
    const keys = projectsForRow(row), types = typesForRow(row)
    const projectMatch = filters.projects.length === 0 || keys.some(key => focusMatchesProject(key, filters.projects)), typeMatch = focusMatchesTypes(types, filters.types), stateMatch = focusMatchesState(row, filters.states)
    if (typeMatch && stateMatch) for (const key of keys) projectCounts.set(key, (projectCounts.get(key) ?? 0) + 1)
    if (projectMatch && typeMatch) for (const state of FOCUS_FILTER_STATES) if (focusMatchesState(row, [state.id])) stateCounts.set(state.id, (stateCounts.get(state.id) ?? 0) + 1)
    if (projectMatch && stateMatch) for (const type of types) typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1)
  }
  const [moteChoices, setMoteChoices] = useState<{ id: string; references: WorkbenchProjectionSelection[] } | null>(null)
  const moteChoicesRef = useRef<HTMLDivElement>(null)
  const choiceFocusOrigin = useRef<Element | null>(null)
  const restoreChoiceFocus = useRef(false)
  const dismissMoteChoices = () => {
    restoreChoiceFocus.current = Boolean(moteChoicesRef.current?.contains(document.activeElement))
    setMoteChoices(null)
  }
  useLayoutEffect(() => {
    if (!moteChoices) {
      if (!restoreChoiceFocus.current) return
      restoreChoiceFocus.current = false
      if (document.activeElement !== document.body && document.activeElement?.isConnected) return
      const origin = choiceFocusOrigin.current
      if (origin instanceof HTMLElement && origin !== document.body && origin.isConnected && origin.getClientRects().length && !origin.closest('[hidden], [inert]')) origin.focus({ preventScroll: true })
      else searchRef.current?.focus({ preventScroll: true })
      return
    }
    moteChoicesRef.current?.scrollIntoView({ block: 'nearest' })
    if (document.activeElement === choiceFocusOrigin.current) moteChoicesRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [moteChoices])
  useEffect(() => { setMoteChoices(null) }, [query, filters, visible])
  const openMoteContext = (id: string, exactReference?: WorkbenchProjectionSelection) => {
    const current = useAppStore.getState()
    const session = sessionPresentationById(current.sessions).get(id)
    const topicSnapshots = scratchTopicsForConfig(current.config, current.scratchTopicSnapshots)
    const workspace = session && workspaceForSession(current.config, session, topicSnapshots)
    const topicId = session ? topicIdForSession(current.config, session, topicSnapshots) : null
    if (!topicId || focusLaneForSession(topicId, scratchTopicsForWorkspace(current.scratchTopicSnapshots, workspace)) !== 'pmo') {
      current.reportError(new Error('This context is no longer confirmed as Mote. The original work and locations remain available.'))
      return
    }
    const locations = [...new Map(workbenchSelectionCatalog(current).locations.filter(location => {
      const tab = current.tabs[location.tabId], surface = tab?.regions[location.regionId]
      return tab?.topicId === topicId && surface?.kind === 'agent' && surface.sessionId === id
    }).map(location => [JSON.stringify([location.displayWorkspaceId, location.groupId, location.tabId, location.regionId]), location])).values()]
    const held = readPmoTeamsTopicFloatingState()?.reference
    if (exactReference && !locations.some(location => sameWorkbenchProjectionSelection(location, exactReference))) {
      current.reportError(new Error('The selected original Mote location is no longer confirmed. The original work is kept.'), { kind: 'indeterminate' })
      return
    }
    const reference = exactReference ?? (held && locations.some(location => sameWorkbenchProjectionSelection(location, held))
      ? held : locations.length === 1 ? locations[0] : undefined)
    if (!reference) {
      choiceFocusOrigin.current = document.activeElement
      setMoteChoices({ id, references: locations })
      return
    }
    const tab = current.tabs[reference.tabId]!
    setMoteChoices(null)
    focusPmoSession(id)
    requestPmoTeamsTopicFloatingOpen({ targetTopicId: topicId, ...(tab ? { targetTabId: tab.id } : {}), ...(reference ? { reference } : {}), onReturnFocus: () => {
      if (useAppStore.getState().mainSurface === 'agents') searchRef.current?.focus({ preventScroll: true })
    } })
  }
  const laneRows = (lane: typeof boardLanes[number], heading: ReactNode, compact = false) => <FocusScanLaneContent lane={lane} compact={compact}
    contexts={lane.zones ? [...new Map(lane.zones.flatMap(zone => rowsByLane.get(zone.id) ?? []).map(context => [focusTopicContextKey(context.hostId, context.id), context])).values()] : rowsByLane.get(lane.id) ?? []} heading={heading} metrics={laneMetrics} replyLines={replyLines} topicPresentation={topicPresentation}
    renderCards={(grouped, columns, topics, sections) => <FocusContextCards contexts={grouped} columns={columns} layoutReady={laneMetrics.measured}
      replyLines={replyLines} topics={topics} sections={sections} visits={focusVisits} scrollRef={boardRowsRef} visible={!compact && visible && documentActive}
      selectedId={shownSessionId} selectedKey={selectedContextKey} revealRequest={agentReveal} onRevealed={finishReveal}
      goalLinks={goalLinks} identities={contextIdentities} onSelect={focusExecutionSession} />} />
  const leadingResults = coordinationResults.length || moteChoices ? <>
      {coordinationResults.length ? <section className="focus-coordination-results" aria-label="Matching Mote coordination contexts">
        <header><strong>Mote coordination</strong><span>{coordinationResults.length}</span><small>Independent coordination focus</small></header>
        <WorkbenchPresentationContext.Provider value={cardPresentation}><div>
          <FocusContextCards contexts={coordinationResults} columns={1} scrollRef={boardRowsRef} visible={visible && documentActive}
            selectedId={selectedMoteId} goalLinks={goalLinks} identities={contextIdentities} onSelect={openMoteContext} />
        </div></WorkbenchPresentationContext.Provider>
      </section> : null}
      {moteChoices ? <div ref={moteChoicesRef} className="focus-location-choices" role="group" aria-label="Choose original Mote location">
        <p>{moteChoices.references.length ? 'Choose the exact original Mote location.' : 'No original Mote location is confirmed. The context and current work are kept.'}</p>
        {moteChoices.references.map(reference => {
          const layout = layouts[reference.displayWorkspaceId], tab = tabs[reference.tabId]
          return <FocusLocationChoice key={JSON.stringify(reference)} reference={reference} tab={tab}
            workspaceName={config?.workspaces.find(workspace => workspace.id === reference.displayWorkspaceId)?.name ?? reference.displayWorkspaceId}
            groupIndex={layout ? groupIds(layout.root).indexOf(reference.groupId) : -1}
            regionIndex={tab ? regionIds(tab.layout.root).indexOf(reference.regionId) : -1}
            onSelect={() => openMoteContext(moteChoices.id, reference)} />
        })}
        <button type="button" className="small-button" onClick={dismissMoteChoices}>Dismiss location choices</button>
      </div> : null}
  </> : undefined
  return <SpaceSourceReaders><section className={`global-board-surface global-focus-surface ${showWorkspace ? 'global-board-surface--session-open' : ''}`} aria-label="Focus" data-desktop-focus-view="list" data-focus-reply-lines={replyLines} data-focus-topic-presentation={topicPresentation} hidden={!surfaceVisible} inert={!visible} aria-hidden={!surfaceVisible} style={{ ...focusSelectionStyle(config?.focus), display: surfaceVisible ? undefined : 'none', '--focus-workspace-width': `calc(${workspaceRatio * 100}% - 6px)`, '--focus-reply-lines': replyLines, '--focus-card-track-height': `${focusCardTrackHeight(replyLines)}px` } as CSSProperties}>
    <FocusToolbar onOpenCollaboration={!sourceSelection && mapContext?.kind === 'agent' ? () => useAppStore.getState().openCollaborationMap({ kind: 'focus', subject: { hostId: mapContext.control?.hostId ?? mapContext.hostId, agentSessionId: mapContext.control?.agentSessionId ?? mapContext.id }, name: mapContext.name }) : undefined} active={visible} selectedId={sourceSelection?.context.id ?? shownSessionId} selected={selected} tab={sourceSelection ? null : selectedTab} reference={projection?.selection.length === 1 ? projection.selection[0] : undefined} onReview={() => setRequestId(shownSessionId)} onCloseWorkspace={closeWorkspace} regionOnly={regionOnly} onToggleRegion={projection || sourceSelection ? onToggleRegion : undefined}>
      <div className="focus-filters">
        <div className="global-board-toolbar__controls">
          <label className="global-board-search"><ThemeActionSearchIcon size={13} /><TextInput ref={searchRef} aria-label="Search contexts" placeholder="Search text, IDs or amux links" title="Filter names, activity, paths and original object IDs or links. Enter searches case-sensitive text in retained conversations." onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); historySearch.start() } }} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <button type="button" className="small-button focus-search-history-trigger" aria-label="Search retained conversation text" title="Search retained conversation text · Enter" disabled={!query.trim()} onClick={() => historySearch.start()}><ThemeActionSearchIcon size={13} /><span>History</span></button>
          <LocalRetainedInputsPanel />
          <FocusFilters value={filters} onChange={changeFilters} onInspectChange={setInspectingFilters} visible={visible} onClear={clearLocalFilters} onHistory={() => historySearch.start()} historyAvailable={Boolean(trimmedQuery)}
            options={{ projects: projectOptions.map(option => ({ ...option, count: projectCounts.get(option.id) ?? 0 })), states: stateCounts, types: typeCounts }} />
          <button type="button" className="icon-button" aria-label="Arrange projects by recent activity" title="Arrange unpinned projects by recent activity. Otherwise project positions stay fixed." onClick={() => setArrangeProjects(value => value + 1)}><ArrangeProjectsIcon size={13} /></button>
          <FocusSourceStatus sourceError={catalogue.error} loading={catalogue.loading} laneErrors={hierarchyErrors}
            onRetrySources={catalogue.refresh} onRetryLanes={refreshHierarchy} visible={visible && documentActive} />
        </div>
      </div>
    </FocusToolbar>
    <div ref={focusLayoutRef} className="global-focus-layout">
      <div className="global-board-main global-focus-main" data-agent-reveal={agentReveal ? true : undefined}>
      {sourceFacts.readers}
      {sourceFacts.issues.map(issue => <div key={issue.key}><ServiceWindowNotice notice={{ kind: 'process-degraded', notice: { step: 'Project source could not be checked.', mode: issue.message, restore: 'Original tasks and workfaces are retained.' } }} /><button type="button" className="small-button" onClick={issue.refresh}>Refresh source</button></div>)}
      {agentReveal ? <div className="focus-agent-reveal" role="status" aria-label="Focus Agent reveal">
        <span>{revealedContext ? revealOutsideFilters ? 'Showing ' + revealedContext.context.name + ' outside current filters.' : 'Located ' + revealedContext.context.name + '.'
          : 'Original Context is unconfirmed · ' + agentReveal.hostId + ' · ' + agentReveal.agentSessionId + '. The current filters and work are kept.'}</span>{' '}
        <button type="button" className="small-button" onClick={clearReveal}>End reveal</button>
      </div> : null}
      {revealedContext && revealedContext.lane !== 'execution' ? <div className="focus-agent-reveal-card" ref={separateRevealRef} data-focus-reveal-scroll>
        <WorkbenchPresentationContext.Provider value={cardPresentation}>
          <FocusContextCards contexts={[revealedContext.context]} columns={1} scrollRef={separateRevealRef} visible={visible && documentActive}
            selectedId={null} selectedKey={selectedContextKey} revealRequest={agentReveal} onRevealed={finishReveal}
            goalLinks={goalLinks} identities={contextIdentities} onSelect={() => {}} />
        </WorkbenchPresentationContext.Provider>
      </div> : null}
      <FocusSearchLocations result={searchResult} onRead={historySearch.start}
        nameLocation={location => searchNames.locations.get(location.address)}
        nameSource={source => searchNames.sources.get(JSON.stringify([source.hostId, source.agentSessionId]))}
        nameUnplaced={object => object.kind === 'zone' ? searchNames.unplaced.get(object.id) : undefined} describeLocation={location => searchNames.descriptions.get(location.address) ?? 'Original location'} onSelect={location => onSelectLocation ? onSelectLocation(location.reference) : location.sessionId ? focusExecutionSession(location.sessionId, location.reference) : useAppStore.getState().reportError(new Error('The original location is kept. Its navigation is not confirmed in this view.'))} />
      <FocusHistorySearch search={historySearch} active={visible} />
      {pmoAttention.length ? <button type="button" className="focus-pmo-attention" onClick={() => openMoteContext(pmoAttention[0]!)}><span className="focus-pmo-attention__identity"><SpaceObjectIcon kind="mote" name={moteIdentity.name} manualIcon={moteIdentity.icon} avatarWorkspaceId={moteIdentity.avatarWorkspaceId} avatarTopicId={moteIdentity.avatarTopicId} avatarObjectKey={moteIdentity.avatarObjectKey} /><span>Mote</span><strong>{moteIdentity.name}</strong><span>· {pmoAttention.length} to review</span></span><span>Open context</span></button> : null}
      {executionRows.length === 0 && retainedProjects.length === 0 && coordinationContexts.length === 0 && !moteChoices ? <div className="global-agents-empty" role="status"><ThemeObjectTeamIcon size={20} /><strong>No execution contexts yet</strong><span>Open an Agent from a Workspace to make it appear here.</span></div> : <div className="global-board-columns" aria-label="Filtered Focus contexts">
        <div className="focus-project-board">
          <WorkbenchPresentationContext.Provider value={cardPresentation}><div className="focus-project-board__live" data-empty={!hasBoardLanes && !leadingResults || undefined}>
            {hasBoardLanes || leadingResults ? <FocusProjectLanes resourceMenus renderDiscussion={(lane, slot) => <FocusGroupDiscussion lane={lane} contexts={filterContexts} active={slot.active && visible && documentActive} container={slot.container} />} quietLanes={quietLanes} protectedLanes={protectedLanes} forceExpanded={filtering} revealedLaneIds={revealedLaneIds} leading={leadingResults} visible={visible && documentActive} origins={laneOrigins} lanes={boardLanes} recentProjects={recentProjects} cardMetrics={laneMetrics} replyLines={replyLines} onRead={readProjectHistory} selectedProjectKey={filters.projects.length === 1 ? filters.projects[0]!.id : 'all'} currentLaneId={displayedCurrentLaneId} revealRequestId={agentReveal?.pending ? agentReveal.requestId : undefined} onSelect={key => setFilters(value => ({ ...value, projects: [{ id: key, name: projectOptions.find(option => option.id === key)?.name ?? key }] }))} renderLane={laneRows} rowsRef={boardRowsRef} /> : null}
            {filtered.length === 0 && filteredRetainedProjects.length === 0 && coordinationResults.length === 0 ? <p className="focus-project-lanes__empty">
              <span>No contexts match these local filters.</span>
              {query || filters.projects.length || filters.states.length || filters.types.length ? <button type="button" className="focus-project-lanes__clear" onClick={clearLocalFilters}>Clear filters</button> : null}
            </p> : null}
          </div></WorkbenchPresentationContext.Provider>
          <FocusRetainedProjects projects={pastProjects} total={retainedProjects.filter(item => !item.recent).length} cardMetrics={laneMetrics} replyLines={replyLines} onRead={readProjectHistory} />
        </div>
      </div>}
      </div>
    {showWorkspace ? <><div
      className="focus-workspace-resize-handle"
      role="separator"
      tabIndex={0}
      aria-label="Resize Focus workspace"
      aria-orientation="vertical"
      aria-valuemin={38}
      aria-valuemax={76}
      aria-valuenow={Math.round(workspaceRatio * 100)}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        resizingFocusRef.current = true
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') { event.preventDefault(); adjustWorkspaceRatio(workspaceRatio + 0.02) }
        if (event.key === 'ArrowRight') { event.preventDefault(); adjustWorkspaceRatio(workspaceRatio - 0.02) }
        if (event.key === 'Home') { event.preventDefault(); adjustWorkspaceRatio(0.38) }
        if (event.key === 'End') { event.preventDefault(); adjustWorkspaceRatio(0.76) }
      }}
    /><aside className="global-session-workspace" aria-label="Focus workspace">
      {sourceChoices ? <div className="focus-location-choices" role="group" aria-label="Choose original workface">
        <p>Choose the exact workface for this Agent.</p>{sourceChoices.locations.map(location => <button type="button" className="small-button focus-location-choice" key={JSON.stringify(location)} onClick={() => { sourceChoices.choose(location); setSourceChoices(null) }}><strong>Tab {location.tabId}</strong><small>Region {location.regionId}</small></button>)}
        <button type="button" className="small-button" onClick={() => setSourceChoices(null)}>Dismiss location choices</button>
      </div> : projection
        ? <div className="focused-tab-workspace" data-focus-tab-id={selectedTab?.id}
          data-focus-zone-id={projection.entity.kind === 'zone' ? projection.entity.zoneId : undefined}>
          {directoryIssue || presentation?.issue ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
              step: 'Focus work surface directory', mode: [directoryIssue, presentation?.issue].filter(Boolean).join('\n'),
              restore: 'The original work surface remains available. Recheck its current location to confirm the Space and Zone.'
            } }} actions={presentation?.issue && projection.selection[0] ? <button type="button" className="small-button"
              onClick={() => (onSelectLocation ?? projection.onSelect)(projection.selection[0]!)}>Use current location</button> : null} /> : null}
          <WorkspaceWorkbench workspaceId={projection.displayWorkspaceId} projection={projection}
            viewOwnership="projection" viewTargets={viewTargets} visible={visible} />
        </div>
        : presentation?.issue || directoryIssue
          ? <div className="global-session-workspace__empty focus-location-recovery">
            <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
              step: 'Focus work surface', mode: directoryIssue ?? presentation!.issue!,
              restore: placeless
                ? `${placeless.runUnobserved ? 'The current Run state is unknown.' : `Its Run is ${placeless.processState}.`} Open the original conversation in a new Tab to read its history and review recovery. This only opens a view; its Session, Run and drafts are unchanged.`
                : 'Choose a confirmed location. The original Session and work surfaces are retained.'
            } }} actions={placeless ? <button type="button" className="small-button" data-focus-open-placeless=""
              onClick={() => openPlaceless(placeless.id)}>Open in a new Tab</button> : null} />
            {presentation?.references.length ? <div className="focus-location-choices" aria-label="Choose Focus location">{presentation.references.map(reference => {
              const layout = layouts[reference.displayWorkspaceId], tab = tabs[reference.tabId]
              const groupIndex = layout ? groupIds(layout.root).indexOf(reference.groupId) : -1
              const regionIndex = tab ? regionIds(tab.layout.root).indexOf(reference.regionId) : -1
              return <FocusLocationChoice key={JSON.stringify(reference)} reference={reference} tab={tab}
                workspaceName={config?.workspaces.find(workspace => workspace.id === reference.displayWorkspaceId)?.name ?? 'Original Space'}
                groupIndex={groupIndex} regionIndex={regionIndex}
                onSelect={() => onSelectLocation ? onSelectLocation(reference) : selectedId ? focusExecutionSession(selectedId, reference) : undefined} />
            })}</div> : null}
          </div>
          : presentation?.unselected ? <div className="global-session-workspace__empty" data-focus-unselected>
            <strong>Choose a work surface</strong><span>Select a context or Region to continue here.</span>
          </div> : <><AgentTopologySummary sessionIds={selectedSessionIds} sessions={sessions} tabs={tabs} config={config} /><SessionObservationRegions sessionIds={selectedSessionIds} contextId={`agent:${selectedId}`} /></>}
    </aside></> : null}
    </div>
    <RecentFocusTimeline projectScope={timelineProjectScope} onToggleProjectScope={!filters.projects.length && timelineProject ? () => setAllTimelineProjects(value => !value) : undefined} entries={executionHistory} currentSessionId={selectedId} currentContext={currentContext} contexts={executionRows} lanes={allLanes} hierarchy={facts} onSelect={focusExecutionSession} onSelectContext={selectTimelineContext} onReveal={revealFocusRecord} historyWindowRequest={historyWindowRequest} catalogue={catalogue} visible={visible} />
    {visible && requestId ? <AttentionRequestPanel sessionId={requestId} onClose={() => setRequestId(null)} onReturnFocus={() => {
      if (useAppStore.getState().mainSurface === 'agents') searchRef.current?.focus()
    }} onSessionChange={focusExecutionSession} /> : null}
  </section></SpaceSourceReaders>
}
