import { TextInput } from '@agentmux/client-ui/input'
import { scratchTopicsForConfig } from '../lib/scratch-topic-snapshots'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { useShallow } from 'zustand/react/shallow'
import { createFocusProjectionSelector, focusNeutralGroupSummary, FOCUS_BUCKETS, groupFocusContexts, type FocusBucket } from '../lib/focus-context'
import { FocusContextRow } from './FocusContextRow'
import { useFocusHierarchy } from '../lib/use-focus-hierarchy'
import { deriveFocusProjectLanes, deriveRetainedFocusProjects, focusProjectKey } from '../lib/focus-project-lanes'
import { useFocusHistorySources } from '../lib/focus-history-sources'
import type { ExecutionFocusPresentation } from '../lib/focus-tab-projection'
import { AttentionRequestPanel } from './AttentionRequestPanel'
import { SessionObservationRegions } from './SessionObservationRegions'
import { AgentTopologySummary } from './AgentTopologySummary'
import { FocusProjectLanes, FocusRetainedProjects } from './FocusProjectLanes'
import { FocusLaneGroups } from './FocusLaneGroups'
import { useFocusProjectOrder } from '../lib/use-focus-project-order'
import { focusLaneOrigins } from '../lib/focus-lane-origin'
import { readSurveyPresentation } from '../lib/mobile-presentation'
import type { FocusLaneCounts, FocusLaneMetrics } from '../lib/focus-lane-layout'
import { FocusToolbar } from './FocusToolbar'
import * as FilterMenu from './HoverDropdownMenu'
import { RecentFocusTimeline } from './RecentFocusTimeline'
import { requestPmoTeamsTopicFloatingOpen, readPmoTeamsTopicFloatingState } from '../lib/pmo-teams-topic-floating'
import { isMacPlatform } from '../lib/host-platform'
import { executionFocusSessionId } from '../lib/agent-focus'
import { workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { sameWorkbenchProjectionSelection } from '../lib/workbench-projection'
import { sessionPresentationById } from '../lib/session-presentation'
import { topicIdForSession, workspaceForSession, type WorkbenchTab } from '../lib/workbench-tabs'
import { recordForWorkbenchTab, useWorkbenchTabNameMetadata, useWorkbenchTabSessions } from '../lib/workbench-session-subscriptions'
import { workbenchTabDisplayName } from '../lib/workbench-tab-presentation'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import { WorkbenchPresentationContext, type WorkbenchViewTargets } from '../lib/workbench-presentation'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { groupIds, regionIds } from '@agentmux/layout'

const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeObjectInboxIcon = semanticIconComponent('object.inbox')
const ThemeStatusWorkingIcon = semanticIconComponent('status.working')
const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')
const ThemeStatusNeutralIcon = semanticIconComponent('status.neutral')
const ThemeActionSearchIcon = semanticIconComponent('action.search')
const ThemeActionFilterIcon = semanticIconComponent('action.filter')
const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
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
  const names = useAppStore(useShallow(state => recordForWorkbenchTab(state.agentNames, tab)))
  const timelines = useAppStore(useShallow(state => recordForWorkbenchTab(state.timelines, tab)))
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
  const contextSelector = useMemo(createFocusProjectionSelector, [])
  const {contexts: executionRows, laneContexts, pmoAttention} = useAppStore(useShallow(contextSelector))
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
  const topicSnapshots = useAppStore(state => state.scratchTopicSnapshots)
  const tabs = useAppStore((state) => state.tabs)
  const layouts = useAppStore(state => state.layouts)
  const selectedId = useAppStore((state) => executionFocusSessionId(state.agentFocus))
  const projection = presentation?.projection ?? null
  const selectedTab = projection?.selection.length === 1 ? tabs[projection.selection[0]!.tabId] ?? null : null
  const activeSurface = projection?.selection[0] && selectedTab?.regions[projection.selection[0].regionId]
  const shownSessionId = activeSurface && (activeSurface.kind === 'agent' || activeSurface.kind === 'terminal') ? activeSurface.sessionId : null
  const currentSurface = currentReference && tabs[currentReference.tabId]?.regions[currentReference.regionId]
  const currentContext = currentSurface && (currentSurface.kind === 'agent' || currentSurface.kind === 'terminal')
    ? executionRows.find(context => context.id === currentSurface.sessionId) ?? null : null
  const showWorkspace = workspaceOpen ?? Boolean(projection || presentation?.unselected || presentation?.issue || selectedId)
  const selectedSessionIds = useMemo(() => selectedId ? [selectedId] : [], [selectedId])
  const sessions = useAppStore(useShallow(state => selectedTab ? [] : selectedSessionIds.flatMap(id => { const session = sessionPresentationById(state.sessions).get(id); return session ? [session] : [] })))
  const executionHistory = useAppStore((state) => state.agentFocus.execution.history)
  const timelines = useAppStore(useShallow(state => {
    const held: typeof state.timelines = {}
    for (const entry of executionHistory) if (entry.identity?.kind === 'agent' && state.timelines[entry.sessionId]) held[entry.sessionId] = state.timelines[entry.sessionId]!
    return held
  }))
  const surfaceVisible = useAppStore(state => state.mainSurface === 'agents')
  const visible = hostVisible && surfaceVisible
  const catalogue = useFocusHistorySources(visible)
  const focusPmoSession = useAppStore(state => state.focusPmoSession)
  const storedFocusExecutionSession = useAppStore((state) => state.focusExecutionSession)
  const focusExecutionSession = onSelectContext ?? storedFocusExecutionSession
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('all')
  const [bucketFilter, setBucketFilter] = useState<FocusBucket | 'all'>('all')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [historyWindowRequest, setHistoryWindowRequest] = useState<{ at: number; sequence: number }>()
  const [workspaceRatio, setWorkspaceRatio] = useState(0.618)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const closeWorkspace = () => { onCloseWorkspace?.(); searchRef.current?.focus() }
  const focusLayoutRef = useRef<HTMLDivElement | null>(null)
  const resizingFocusRef = useRef(false)
  const adjustWorkspaceRatio = (next: number) => setWorkspaceRatio(Math.min(0.76, Math.max(0.38, next)))
  useEffect(() => {
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
    return () => { window.removeEventListener('pointermove', onPointerMove); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); window.removeEventListener('blur', stop) }
  }, [])
  const { facts, errors: hierarchyErrors } = useFocusHierarchy(laneContexts, config)
  const allLanes = useMemo(() => deriveFocusProjectLanes(laneContexts, config, facts, tabs, Date.now(), topicSnapshots), [laneContexts, config, facts, tabs, topicSnapshots])
  const boardRowsRef = useRef<HTMLDivElement>(null)
  const orderedLanes = useFocusProjectOrder(allLanes, visible, boardRowsRef)
  const navigationCatalog = useAppStore(workbenchSelectionCatalog)
  const survey = useAppStore(useShallow(state => ({ surveyCollectedZones: state.surveyCollectedZones, surveyExplorationNames: state.surveyExplorationNames })))
  const originContent = useAppStore(useShallow(state => ({ bindings: state.spaceZoneBindings, categories: state.topicCategories })))
  const surveyItems = useMemo(() => readSurveyPresentation({ ...survey, surveyZoneSelection: null, tabs }, navigationCatalog).items, [survey, tabs, navigationCatalog])
  const laneMembership = JSON.stringify(allLanes.map(lane => [lane.id, lane.objectKind, lane.contextIds]))
  const laneOrigins = useMemo(() => focusLaneOrigins(allLanes, navigationCatalog, tabs, surveyItems, originContent), [laneMembership, navigationCatalog, tabs, surveyItems, originContent])
  const retainedProjects = useMemo(() => deriveRetainedFocusProjects(executionHistory, allLanes, {
    timelines, sources: catalogue.sources, sourcesAvailable: catalogue.available
  }), [executionHistory, allLanes, timelines, catalogue.sources, catalogue.available])
  const trimmedQuery = query.trim()
  const search = trimmedQuery.toLocaleLowerCase()
  const laneByContext = new Map(allLanes.flatMap(lane => lane.contextIds.map(id => [id, lane] as const)))
  // The common Region choice is independent of both the project filter and Agent MRU.
  const resourceLaneIds = new Set(currentSurface && currentSurface.kind !== 'agent' && currentSurface.kind !== 'terminal'
    ? laneContexts.filter(context => context.workspace?.id === currentSurface.workspaceId
      && context.workspace.hostId === context.hostId
      && context.topicId === (tabs[currentReference!.tabId]?.topicId ?? null))
      .flatMap(context => { const lane = laneByContext.get(context.id); return lane ? [lane.id] : [] }) : [])
  const currentLaneId = currentContext ? laneByContext.get(currentContext.id)?.id ?? null
    : resourceLaneIds.size === 1 ? resourceLaneIds.values().next().value ?? null : null
  const matching = executionRows.filter(row => (project === 'all' || (() => { const lane = laneByContext.get(row.id); return lane && focusProjectKey(lane.hostId, lane.projectId) === project })()) &&
    ((row.kind === 'agent' && row.id.includes(trimmedQuery)) || `${row.name} ${row.detail} ${row.recap?.text ?? ''} ${row.stateLabel} ${row.workspacePath} ${laneByContext.get(row.id)?.name ?? row.workspaceName} ${row.providerId ?? ''}`.toLocaleLowerCase().includes(search)))
  const filtered = matching.filter(row => bucketFilter === 'all' || row.bucket === bucketFilter)
  const selected = executionRows.find(row => row.id === shownSessionId)
  const filteredIds = new Set(filtered.map(row => row.id))
  const focusProjectLanes = orderedLanes.filter(lane => lane.contextIds.some(id => filteredIds.has(id)))
  const rowsByLane = new Map<string, typeof filtered>()
  for (const row of filtered) {
    const lane = laneByContext.get(row.id)
    if (!lane) continue
    const rows = rowsByLane.get(lane.id) ?? []
    rows.push(row)
    rowsByLane.set(lane.id, rows)
  }
  const boardLanes = focusProjectLanes
  const filteredRetainedProjects = retainedProjects.filter(item => (project === 'all' || item.key === project) && bucketFilter === 'all'
    && `${item.name} ${item.identity.workspacePath} ${item.identity.branch ?? ''} ${item.identity.topicId ?? ''}`.toLocaleLowerCase().includes(search))
  const recentProjects = filteredRetainedProjects.filter(item => item.recent)
  const pastProjects = filteredRetainedProjects.filter(item => !item.recent)
  const readProjectHistory = (item: typeof retainedProjects[number]) => {
    const at = Math.max(item.lastFocusedAt ?? 0, item.lastActivityAt ?? 0)
    if (at > 0) setHistoryWindowRequest(current => ({ at, sequence: (current?.sequence ?? 0) + 1 }))
  }
  const [laneMetrics, setLaneMetrics] = useState<FocusLaneMetrics>({ width: 0, padding: 4, gap: 2, cardGap: 2 })
  const hasBoardLanes = boardLanes.length > 0 || recentProjects.length > 0
  useLayoutEffect(() => {
    const rows = boardRowsRef.current
    if (!visible || !hasBoardLanes || !rows || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const groups = rows.querySelector<HTMLElement>('.focus-project-lanes__groups')
      if (!groups || rows.clientWidth <= 0) return
      const style = getComputedStyle(groups), cards = groups.querySelector<HTMLElement>('.focus-context-group__cards')
      const gap = parseFloat(style.columnGap) || 0
      const next = { width: groups.getBoundingClientRect().width, padding: (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0), gap, cardGap: cards ? parseFloat(getComputedStyle(cards).columnGap) || 0 : gap }
      setLaneMetrics(current => current.width === next.width && current.padding === next.padding && current.gap === next.gap && current.cardGap === next.cardGap ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(rows)
    return () => observer.disconnect()
  }, [visible, hasBoardLanes])
  const matchingGroups = groupFocusContexts(matching)
  const neutralSummary = focusNeutralGroupSummary(matchingGroups.idle)
  const bucketMeta = { attention: { label: 'Attention', icon: ThemeObjectInboxIcon }, working: { label: 'Working', icon: ThemeStatusWorkingIcon }, results: { label: 'Results', icon: ThemeStatusCompletedIcon }, idle: { label: neutralSummary.label, icon: ThemeStatusNeutralIcon } }
  const buckets = FOCUS_BUCKETS
  const projectOptions = useMemo(() => {
    const options = [...new Map([...allLanes.map(lane => ({ id: focusProjectKey(lane.hostId, lane.projectId), name: lane.labels[0]!, hostId: lane.hostId })),
      ...retainedProjects.map(item => ({ id: item.key, name: item.name, hostId: item.hostId }))].map(item => [item.id, item])).values()]
    const names = new Map<string, number>(), hosts = new Map(config?.hosts.map(host => [host.id, host.label]))
    for (const item of options) names.set(item.name, (names.get(item.name) ?? 0) + 1)
    return options.map(item => ({ ...item, name: names.get(item.name)! > 1 ? `${item.name} · ${hosts.get(item.hostId) || item.hostId}` : item.name }))
  }, [allLanes, retainedProjects, config?.hosts])
  const filterSummary = `${projectOptions.find(option => option.id === project)?.name ?? 'All projects'} · ${bucketFilter === 'all' ? 'All states' : bucketMeta[bucketFilter].label}`
  const filterCount = Number(project !== 'all') + Number(bucketFilter !== 'all')
  const laneRows = (lane: typeof focusProjectLanes[number], heading: ReactNode) => {
    const rows = rowsByLane.get(lane.id) ?? []
    const groups = groupFocusContexts(rows)
    const counts: FocusLaneCounts = [groups.attention.length, groups.working.length, groups.results.length, groups.idle.length]
    const sparse = counts.reduce((total, count) => total + count, 0) === 1
    const groupHeader = (bucket: FocusBucket, inline = false) => {
      const meta = bucketMeta[bucket], Icon = meta.icon, grouped = groups[bucket]
      const neutral = bucket === 'idle' ? focusNeutralGroupSummary(grouped) : null
      const label = neutral?.label ?? meta.label
      const countDescription = neutral?.detail ?? `${label} · ${grouped.length}`
      return <header className="focus-context-group__header" data-bucket={bucket} data-visible-state={inline || undefined} title={countDescription} aria-label={countDescription} key={bucket}><span className="focus-context-group__bucket"><Icon size={12} aria-hidden="true" /><strong>{label}</strong><span className="focus-context-group__count" aria-hidden="true">{grouped.length > 99 ? '99+' : grouped.length}</span></span></header>
    }
    return <><div className="focus-project-lanes__title">{heading}<div className="focus-project-lanes__status-rail" aria-label="Context states">
      {buckets.filter(bucket => sparse || (counts.some(count => count > 0) && groups[bucket].length === 0)).map(bucket => {
        if (groups[bucket].length > 0) return groupHeader(bucket, true)
        const meta = bucketMeta[bucket], Icon = meta.icon
        return <span className="focus-context-group__header" data-bucket={bucket} title={`${meta.label} · ${groups[bucket].length}`} aria-label={`${meta.label} · ${groups[bucket].length}`} key={bucket}>
          <Icon size={12} aria-hidden="true" />
        </span>
      })}
    </div></div>{counts.some(count => count > 0) ? <FocusLaneGroups counts={counts} metrics={laneMetrics}>{layout =>
      buckets.map((bucket, index) => {
        const meta = bucketMeta[bucket], grouped = groups[bucket]
        if (grouped.length === 0) return null
        const neutral = bucket === 'idle' ? focusNeutralGroupSummary(grouped) : null
        const label = neutral?.label ?? meta.label
        return <section className="focus-context-group global-agents-group" aria-label={label} data-bucket={bucket} data-focus-sparse={sparse || undefined} style={{ '--focus-card-columns': layout.columns[index], '--focus-group-width': `${layout.widths[index]}px` } as CSSProperties} key={bucket}>
          {!sparse ? groupHeader(bucket) : null}
            <div className="focus-context-group__cards">{grouped.map(context => <FocusContextRow key={context.id} context={context} selected={shownSessionId === context.id} onSelect={focusExecutionSession} />)}</div>
        </section>
      })
    }</FocusLaneGroups> : null}</>
  }
  return <section className={`global-board-surface global-focus-surface ${showWorkspace ? 'global-board-surface--session-open' : ''}`} aria-label="Focus" style={{ '--focus-workspace-width': `calc(${workspaceRatio * 100}% - 6px)` } as CSSProperties}>
    <FocusToolbar selectedId={shownSessionId} selected={selected} tab={selectedTab} reference={projection?.selection.length === 1 ? projection.selection[0] : undefined} onReview={() => setRequestId(shownSessionId)} onCloseWorkspace={closeWorkspace} regionOnly={regionOnly} onToggleRegion={projection ? onToggleRegion : undefined}>
      <div className={`focus-filters${isMacPlatform() ? ' focus-filters--mac' : ''}`}>
        <div className="global-board-toolbar__controls">
          <label className="global-board-search"><ThemeActionSearchIcon size={13} /><TextInput ref={searchRef} aria-label="Search contexts" placeholder="Search contexts or amux ID" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <FilterMenu.Root>
            <FilterMenu.Trigger asChild><button type="button" className="focus-filter-trigger" aria-label="Focus filters" aria-description={filterSummary} title={filterSummary} data-active={filterCount > 0 ? 'true' : undefined}>
              <ThemeActionFilterIcon size={14} aria-hidden="true" /><span className="focus-filter-trigger__summary">{filterSummary}</span>{filterCount ? <span className="focus-filter-trigger__count" aria-hidden="true">{filterCount}</span> : null}
            </button></FilterMenu.Trigger>
            <FilterMenu.Portal><FilterMenu.Content className="tab-context-menu focus-filter-menu" align="end" sideOffset={4} collisionPadding={8} onCloseAutoFocus={event => {
              // Preserve a later deliberate focus; explicit Escape still returns to this trigger.
              const focused = document.activeElement
              if (focused instanceof HTMLElement && focused.isConnected && focused !== document.body
                && !focused.closest('[hidden], [inert]') && event.target instanceof HTMLElement && !event.target.contains(focused)) event.preventDefault()
            }}>
              <FilterMenu.Label className="focus-filter-menu__label">Project</FilterMenu.Label>
              <FilterMenu.RadioGroup className="focus-filter-menu__projects" aria-label="Focus project filter" value={project} onValueChange={setProject}>
                {[{ id: 'all', name: 'All projects' }, ...projectOptions].map(option => <FilterMenu.RadioItem key={option.id} value={option.id} data-focus-project={option.id} className="tab-context-menu__item focus-filter-menu__item">
                  <span className="focus-filter-menu__check"><FilterMenu.ItemIndicator><ThemeStatusSelectedIcon size={13} /></FilterMenu.ItemIndicator></span><span>{option.name}</span>
                </FilterMenu.RadioItem>)}
              </FilterMenu.RadioGroup>
              <FilterMenu.Separator className="tab-context-menu__separator" />
              <FilterMenu.Label className="focus-filter-menu__label">State</FilterMenu.Label>
              <FilterMenu.RadioGroup aria-label="Focus state filter" value={bucketFilter} onValueChange={value => setBucketFilter(value as FocusBucket | 'all')}>
                {[{ id: 'all', label: 'All states' }, ...buckets.map(bucket => ({ id: bucket, label: `${bucketMeta[bucket].label} · ${matchingGroups[bucket].length}` }))].map(option => <FilterMenu.RadioItem key={option.id} value={option.id} data-focus-state={option.id} className="tab-context-menu__item focus-filter-menu__item">
                  <span className="focus-filter-menu__check"><FilterMenu.ItemIndicator><ThemeStatusSelectedIcon size={13} /></FilterMenu.ItemIndicator></span><span>{option.label}</span>
                </FilterMenu.RadioItem>)}
              </FilterMenu.RadioGroup>
            </FilterMenu.Content></FilterMenu.Portal>
          </FilterMenu.Root>
        </div>
      </div>
    </FocusToolbar>
    <div ref={focusLayoutRef} className="global-focus-layout">
      <div className="global-board-main global-focus-main">
      {hierarchyErrors.length ? <p className="focus-hierarchy-warning" role="status" title={hierarchyErrors.join('\n')}>Some lane details could not load. Contexts remain available.</p> : null}
      {catalogue.error ? <p className="focus-hierarchy-warning" role="status" title={catalogue.error}>Project status could not be checked. Recent projects remain available; retry sources in conversation records.</p> : null}
      {pmoAttention.length ? <button type="button" className="focus-pmo-attention" onClick={() => {
        const id = pmoAttention[0]!
        const current = useAppStore.getState()
        const session = sessionPresentationById(current.sessions).get(id)
        const topicId = session ? topicIdForSession(current.config, session, scratchTopicsForConfig(current.config, current.scratchTopicSnapshots)) : null
        if (!topicId) {
          current.reportError(new Error('Mote context identity is not confirmed. The original work surface is retained.'))
          return
        }
        const locations = [...new Map(workbenchSelectionCatalog(current).locations.filter(location => {
          const tab = current.tabs[location.tabId], surface = tab?.regions[location.regionId]
          return tab?.topicId === topicId && surface?.kind === 'agent' && surface.sessionId === id
        }).map(location => [JSON.stringify([location.displayWorkspaceId, location.groupId, location.tabId, location.regionId]), location])).values()]
        const held = readPmoTeamsTopicFloatingState()?.reference
        const reference = held && locations.some(location => sameWorkbenchProjectionSelection(location, held))
          ? held : locations.length === 1 ? locations[0] : undefined
        if (!reference) {
          current.reportError(new Error('This Mote Agent has no unique confirmed location. The original work and Mote selections are kept; choose its exact discussion location.'), { kind: 'indeterminate' })
          return
        }
        const tab = current.tabs[reference.tabId]!
        focusPmoSession(id)
        requestPmoTeamsTopicFloatingOpen({ targetTopicId: topicId, ...(tab ? { targetTabId: tab.id } : {}), ...(reference ? { reference } : {}), onReturnFocus: () => {
          if (useAppStore.getState().mainSurface === 'agents') searchRef.current?.focus({ preventScroll: true })
        } })
      }}><span className="focus-pmo-attention__identity"><SpaceObjectIcon kind="mote" name={moteIdentity.name} manualIcon={moteIdentity.icon} avatarWorkspaceId={moteIdentity.avatarWorkspaceId} avatarTopicId={moteIdentity.avatarTopicId} avatarObjectKey={moteIdentity.avatarObjectKey} /><span>Mote</span><strong>{moteIdentity.name}</strong><span>· {pmoAttention.length} to review</span></span><span>Open context <ThemeActionOpenExternalIcon size={12} /></span></button> : null}
      {executionRows.length === 0 && retainedProjects.length === 0 ? <div className="global-agents-empty" role="status"><ThemeObjectTeamIcon size={20} /><strong>No execution contexts yet</strong><span>Open an Agent from a Workspace to make it appear here.</span></div> : <div className="global-board-columns" aria-label="Global execution contexts">
        <div className="focus-project-board">
          <WorkbenchPresentationContext.Provider value={{ active: visible, retainedRegionId: null }}><div className="focus-project-board__live" data-empty={!hasBoardLanes || undefined}>
            {hasBoardLanes ? <FocusProjectLanes visible={visible} origins={laneOrigins} lanes={boardLanes} recentProjects={recentProjects} onRead={readProjectHistory} selectedProjectKey={project} currentLaneId={currentLaneId} onSelect={setProject} renderLane={laneRows} rowsRef={boardRowsRef} /> : null}
            {filtered.length === 0 && filteredRetainedProjects.length === 0 ? <p className="focus-project-lanes__empty">No matching contexts</p> : null}
          </div></WorkbenchPresentationContext.Provider>
          <FocusRetainedProjects projects={pastProjects} total={retainedProjects.filter(item => !item.recent).length} onRead={readProjectHistory} />
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
      {projection
        ? <div className="focused-tab-workspace" data-focus-tab-id={selectedTab?.id}
          data-focus-zone-id={projection.entity.kind === 'zone' ? projection.entity.zoneId : undefined}>
          {directoryIssue ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
            step: 'Focus work surface directory', mode: directoryIssue,
            restore: 'The original work surface remains available. Retry its directory to confirm current positions.'
          } }} /> : null}
          <WorkspaceWorkbench workspaceId={projection.displayWorkspaceId} projection={projection}
            viewOwnership="projection" viewTargets={viewTargets} visible={visible} />
        </div>
        : presentation?.issue || directoryIssue
          ? <div className="global-session-workspace__empty focus-location-recovery">
            <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
              step: 'Focus work surface', mode: directoryIssue ?? presentation!.issue!,
              restore: 'Choose a confirmed location. The original Session and work surfaces are retained.'
            } }} />
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
    <RecentFocusTimeline entries={executionHistory} currentSessionId={selectedId} currentContext={currentContext} contexts={executionRows} lanes={allLanes} hierarchy={facts} onSelect={focusExecutionSession} historyWindowRequest={historyWindowRequest} catalogue={catalogue} visible={visible} />
    {requestId ? <AttentionRequestPanel sessionId={requestId} onClose={() => setRequestId(null)} onReturnFocus={() => {
      if (useAppStore.getState().mainSurface === 'agents') searchRef.current?.focus()
    }} onSessionChange={focusExecutionSession} /> : null}
  </section>
}
