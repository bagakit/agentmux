import type { AgentMuxSpaceCatalog, AgentMuxSpaceLocation, AgentMuxSpatialSave, AgentMuxZoneFact } from '@agentmux/core/control'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { ArrowUpRight, Bot, CircleHelp, FileText, Folder, Globe2, PanelsTopLeft, PanelLeftClose, PanelLeftOpen, NotebookPen, LoaderCircle, MousePointer2, Plus, SlidersHorizontal, X } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { browserOpenError } from '../lib/browser-open-feedback'
import { scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { presentError } from '../lib/error-presentation'
import { useReleasedBrowserRegionIds } from '../lib/surface-memory-budget-coordinator'
import { surveyInitialZoneSelection, surveySelectReference, surveySelectedBrowser, surveyZoneItems, surveyZoneTopicFacts, type SurveyZoneSelection } from '../lib/survey-workface'
import { type WorkbenchProjection, type WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { workbenchSurfaces, type WorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { BrowserAddressInput, type BrowserAddressInputHandle } from './BrowserAddressInput'
import * as DropdownMenu from './HoverDropdownMenu'
import { SurveyBrowserTools } from './SurveyBrowserTools'
import { SurveyZoneItem } from './SurveyZoneItem'
import { SurveyTopicRelations } from './SurveyTopicRelations'
import { SurveyPanelChoices } from './SurveyPanelChoices'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import { projectWorkspaces } from '../lib/workspace-projects'
import { surveySidebarBounds } from '../lib/survey-sidebar-width'
import { clampSidebarResizeWidth, useSidebarResize } from '../hooks/useSidebarResize'

function saveNotice(save: AgentMuxSpatialSave): string {
  const confirmed = save.localStorageWritten && save.storageFlushRequested
  return `${confirmed ? 'Saved on this device; final disk confirmation is pending.' : 'Local changes are kept. Saving is not confirmed; retry saving in Space.'}${save.reason ? ` ${save.reason}` : ''}`
}

export const GlobalSurveySurface = memo(function GlobalSurveySurface({ visible = true, controlsCoverPage = false, unconfirmedBrowserRegionIds, catalog, projection, viewTargets, tabViewControl }: {
  visible?: boolean
  controlsCoverPage?: boolean
  unconfirmedBrowserRegionIds?: ReadonlySet<string> | undefined
  catalog: AgentMuxSpaceCatalog | null
  projection: WorkbenchProjection | null
  viewTargets?: Parameters<typeof WorkspaceWorkbench>[0]['viewTargets']
  tabViewControl?: { active: boolean; available: boolean; onToggle: () => void }
}) {
  const config = useAppStore(state => state.config)
  const browserInput = useRef<BrowserAddressInputHandle>(null)
  const [inputHistoryNotice, setInputHistoryNotice] = useState<string | null>(null)
  const activeWorkspaceId = useAppStore(state => state.activeWorkspaceId)
  const controlNavigation = useAppStore(state => state.workbenchNavigationInputPolicy !== null)
  const selection = useAppStore(state => state.surveyZoneSelection)
  const collected = useAppStore(state => state.surveyCollectedZones)
  const setCollected = useAppStore(state => state.setSurveyZoneCollected)
  const toolsOpen = useAppStore(state => state.surveyToolsOpen)
  const setSelection = useAppStore(state => state.setSurveyZoneSelection)
  const setToolsOpen = useAppStore(state => state.setSurveyToolsOpen)
  const sidebarCollapsed = useAppStore(state => state.surveySidebarCollapsed)
  const setSidebarCollapsed = useAppStore(state => state.setSurveySidebarCollapsed)
  const sidebarWidth = useAppStore(state => state.surveySidebarWidth)
  const setSidebarWidth = useAppStore(state => state.setSurveySidebarWidth)
  const selectWorkspace = useAppStore(state => state.selectWorkspace)
  const topicSnapshots = useAppStore(state => state.scratchTopicSnapshots)
  const topicSnapshot = topicSnapshots[SCRATCH_WORKSPACE_ID]
  const topicsWorkspace = config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  const confirmedTopics = scratchTopicsForWorkspace(topicSnapshots, topicsWorkspace)
  const store = useMemo(() => ({ getState: useAppStore.getState, getInitialState: useAppStore.getInitialState,
    subscribe: visible ? useAppStore.subscribe : () => () => {} }), [visible])
  const tabs = useStore(store, state => state.tabs)
  const layouts = useStore(store, state => state.layouts)
  const resourceWorkspaces = useMemo(() => new Map(config?.workspaces.map(workspace => [workspace.id, workspace]) ?? []), [config?.workspaces])
  const currentZone = catalog?.zones.find(zone => zone.zoneId === selection?.zoneId)
  const resourceWorkspaceId = currentZone?.workspaceId ?? (!selection ? activeWorkspaceId : null)
  const workspace = resourceWorkspaceId ? resourceWorkspaces.get(resourceWorkspaceId) : undefined
  const items = useMemo(() => catalog ? surveyZoneItems(catalog, collected) : [], [catalog, collected])
  const groups = useMemo(() => {
    const workspaces = config?.workspaces ?? []
    const projects = projectWorkspaces(workspaces.filter(workspace => !isScratchWorkspaceId(workspace.id)))
    const byWorkspace = new Map(projects.flatMap(project => project.workspaces.map(workspace => [workspace.id, project] as const)))
    const grouped = new Map<string, { id: string; name: string; workspaceId: string | null; description: string; zones: AgentMuxZoneFact[] }>()
    for (const zone of items) {
      const resource = resourceWorkspaces.get(zone.workspaceId)
      const project = resource ? byWorkspace.get(resource.id) : undefined
      const scratch = resource && isScratchWorkspaceId(resource.id)
      const id = scratch ? 'scratch' : project?.id ?? 'unknown'
      let group = grouped.get(id)
      if (!group) {
        group = { id, name: scratch ? 'Scratch' : project?.name ?? 'Unknown source', workspaceId: scratch ? resource.id : project?.preferredWorkspaceId ?? null,
          description: scratch ? `${resource.hostId}\n${resource.path}` : project ? `${project.hostId}\n${project.repoPath}` : 'The original resource Workspace is not confirmed. Items and references are kept.', zones: [] }
        grouped.set(id, group)
      }
      group.zones.push(zone)
    }
    return [...grouped.values()]
  }, [config?.workspaces, items, resourceWorkspaces])
  const tabsByZone = useMemo(() => {
    const result = new Map<string, string[]>()
    for (const tab of catalog?.tabs ?? []) if (tab.zoneId) {
      const members = result.get(tab.zoneId) ?? []; members.push(tab.tabId); result.set(tab.zoneId, members)
    }
    return result
  }, [catalog])
  const topics = confirmedTopics === null ? null : catalog?.spaces.filter(space => space.kind === 'topic') ?? null
  const related = currentZone && catalog ? surveyZoneTopicFacts(catalog, currentZone.zoneId) : { relatedTopics: null, unknownRelatedSpaces: [] }
  const releasedBrowserRegionIds = useReleasedBrowserRegionIds()
  const currentBrowser = surveySelectedBrowser(tabs, selection)
  const [query, setQuery] = useState('')
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creationNotice, setCreationNotice] = useState<string | null>(null)
  const [relationStatus, setRelationStatus] = useState<{ zoneId: string; pendingSpaceId: string | null; error: string | null; notice: string | null } | null>(null)
  const [navigationChoices, setNavigationChoices] = useState<AgentMuxSpaceLocation[]>([])
  const [toolsVisited, setToolsVisited] = useState(toolsOpen)
  const surfaceRef = useRef<HTMLElement>(null)
  const managementRef = useRef<HTMLElement>(null)
  const resizeHandle = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(0)
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (!visible || !surface) return
    const measure = () => {
      const width = surface.getBoundingClientRect().width
      if (!width) return
      const management = toolsOpen ? managementRef.current : null
      const occupied = management && getComputedStyle(management).position !== 'absolute' ? management.getBoundingClientRect().width : 0
      setAvailableWidth(width - occupied)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(surface)
    if (managementRef.current) observer.observe(managementRef.current)
    return () => observer.disconnect()
  }, [visible, toolsOpen, controlsCoverPage])
  const { minWidth, maxWidth } = surveySidebarBounds(availableWidth)
  const effectiveSidebarWidth = clampSidebarResizeWidth(sidebarWidth, minWidth, maxWidth)
  const reportDraftWidth = useCallback((width: number) => {
    resizeHandle.current?.setAttribute('aria-valuenow', String(clampSidebarResizeWidth(width, minWidth, maxWidth)))
  }, [minWidth, maxWidth])
  const { containerRef: sidebarRef, isResizing, onResizeStart } = useSidebarResize<HTMLElement>({
    isOpen: !sidebarCollapsed, width: sidebarWidth, setWidth: setSidebarWidth, deltaSign: 1, minWidth, maxWidth, onDraftWidthChange: reportDraftWidth
  })
  const intent = useRef(0)
  const failedCreation = useRef<{ zone: AgentMuxZoneFact; reference: WorkbenchProjectionSelection | null; surface: WorkbenchSurface | null } | null>(null)
  useLayoutEffect(() => { intent.current += 1 }, [visible, selection, activeWorkspaceId])
  useEffect(() => { if (toolsOpen) setToolsVisited(true) }, [toolsOpen])
  useEffect(() => {
    if (visible) void useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID)
  }, [visible])
  useEffect(() => {
    if (controlNavigation) return
    const surface = surfaceRef.current
    if (!visible) { if (surface?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur(); return }
    const browserRegion = currentBrowser ? [...surface?.querySelectorAll<HTMLElement>('[data-workbench-region-id]') ?? []]
      .find(region => region.dataset.workbenchRegionId === selection?.active?.regionId) : null
    const target = toolsOpen ? surface?.querySelector<HTMLElement>('[aria-label="Close browser management"]')
      : currentBrowser ? browserRegion?.querySelector<HTMLElement>(currentBrowser.url === 'about:blank' ? '[aria-label="Search or enter a web address"]' : '[aria-label="Browser address"]')
        : !selection ? surface?.querySelector<HTMLElement>('[aria-label="Search or enter a web address"]') : null
    target?.focus()
  }, [visible, selection, toolsOpen, currentBrowser?.browserId, currentBrowser?.url === 'about:blank', controlNavigation])

  function itemTitle(zone: AgentMuxZoneFact): string {
    const names = (tabsByZone.get(zone.zoneId) ?? []).flatMap(id => tabs[id]?.name ? [tabs[id]!.name!] : [])
    if (names.length > 0) return names.join(' · ')
    const surfaces = (tabsByZone.get(zone.zoneId) ?? []).flatMap(id => tabs[id] ? workbenchSurfaces(tabs[id]!) : [])
    const browsers = surfaces.filter(surface => surface.kind === 'browser')
    if (surfaces.length === 1 && browsers[0]?.kind === 'browser') return browsers[0].title || (browsers[0].url === 'about:blank' ? 'New survey item' : browsers[0].url)
    if (surfaces.length === 1 && surfaces[0]?.kind === 'file') return surfaces[0].path.split('/').at(-1)!
    return browsers.length ? `${browsers.length} ${browsers.length === 1 ? 'page' : 'pages'}` : `${tabsByZone.get(zone.zoneId)?.length ?? 0} tabs`
  }

  function activity(zone: AgentMuxZoneFact) {
    const surfaces = (tabsByZone.get(zone.zoneId) ?? []).flatMap(id => tabs[id] ? workbenchSurfaces(tabs[id]!) : [])
    const browsers = surfaces.filter(surface => surface.kind === 'browser')
    const labels = browsers.map(browser => {
      const control = releasedBrowserRegionIds.has(browser.regionId) || unconfirmedBrowserRegionIds?.has(browser.regionId) || browser.nativeOwnerUnavailable || !browser.navigationId
        ? 'unknown' : browser.driving ? 'agent' : browser.activity?.control === 'human' ? 'human' : browser.activity ? 'idle' : 'unknown'
      const operation = browser.activity?.operation
      const operator = control === 'agent' && operation?.browserId === browser.browserId && operation.finishedAt === undefined && ['preparing', 'running', 'waiting'].includes(operation.phase) ? operation.operator : undefined
      return control === 'agent' ? `Agent operating${operator?.name ? ` · ${operator.name}` : ''}` : control === 'human' ? 'Human control' : control === 'idle' ? 'No active Agent operation' : 'Control unknown · restoring'
    })
    const kinds = new Set(labels)
    const agents = surfaces.filter(surface => surface.kind === 'agent').length
    const description = browsers.length === 1 && !agents ? labels[0] : `${browsers.length ? `${browsers.length} browsers` : `${surfaces.length} regions`}${agents ? ` · ${agents} agents` : ''}${browsers.length ? ` · ${kinds.size === 1 ? labels[0] : 'Mixed control'}` : ''}`
    const detail = labels.map((label, index) => `${browsers[index]!.regionId}: ${label}`).join('\n')
    const unknown = labels.some(label => label.startsWith('Control unknown'))
    const operating = labels.some(label => label.startsWith('Agent operating'))
    const human = browsers.length > 0 && kinds.size === 1 && labels[0] === 'Human control' && !agents
    const Icon = operating ? Bot : unknown ? CircleHelp : human ? MousePointer2 : null
    return { summary: Icon ? <span title={detail} aria-label={description}><Icon size={12} aria-hidden="true" /></span> : null,
      details: <span>{description}{detail ? `\n${detail}` : ''}</span> }
  }

  function itemGlyph(zone: AgentMuxZoneFact) {
    const surfaces = (tabsByZone.get(zone.zoneId) ?? []).flatMap(id => tabs[id] ? workbenchSurfaces(tabs[id]!) : [])
    const Icon = surfaces.length && surfaces.every(surface => surface.kind === 'browser') ? Globe2
      : surfaces.length && surfaces.every(surface => surface.kind === 'file' && surface.path.endsWith('.note.json')) ? NotebookPen
        : surfaces.length && surfaces.every(surface => surface.kind === 'file') ? FileText : PanelsTopLeft
    return <Icon size={16} />
  }

  function chooseZone(zoneId: string): void {
    if (!catalog) return
    intent.current += 1
    const held = useAppStore.getState().surveyZoneSelection
    if (held?.zoneId !== zoneId) setSelection(surveyInitialZoneSelection(catalog, zoneId, layouts, tabs, activeWorkspaceId))
    setError(null); setNavigationChoices([])
  }
  function chooseReference(reference: WorkbenchProjectionSelection): void {
    const current = useAppStore.getState().surveyZoneSelection
    if (!current) return
    intent.current += 1; setSelection(surveySelectReference(current, reference)); setNavigationChoices([])
  }

  async function openBrowser(input = 'about:blank', newItem = false): Promise<void> {
    if (opening) return
    const before = useAppStore.getState(), layout = workspace ? before.layouts[workspace.id] : undefined
    if (!workspace || !layout?.activeGroupId) { setError(browserOpenError(undefined)); return }
    const startedIntent = intent.current
    setOpening(true); setError(null)
    try {
      let preparation = newItem ? null : failedCreation.current
      if (preparation && preparation.zone.workspaceId !== workspace.id) throw new Error('The previous creation still belongs to its original resource workspace. Review that exact item, or explicitly create a new item here.')
      if (!preparation) {
        const created = await before.createWorkbenchZone({ workspaceId: workspace.id, spaceIds: [] })
        preparation = { zone: created.zone, reference: null, surface: null }
        failedCreation.current = preparation
        if (!useAppStore.getState().setSurveyZoneCollected(created.zone.zoneId, true)) {
          throw new Error('The original exploration was created, but its resource is now unconfirmed. Its exact target is kept.')
        }
        setCreationNotice(`Item created locally. ${saveNotice(created.save)}${created.issues.length ? ` ${created.issues.map(issue => issue.message).join(' ')}` : ''}`)
      }
      if (!preparation.reference) {
        const tabId = before.openLauncher({ workspaceId: preparation.zone.workspaceId, zoneId: preparation.zone.zoneId, tabGroupId: layout.activeGroupId, reveal: false })
        const launcher = tabId ? useAppStore.getState().tabs[tabId] : undefined
        if (!launcher) throw new Error('The original resource Group is still restoring. This Zone is kept; retry here.')
        preparation.reference = { displayWorkspaceId: workspace.id, groupId: layout.activeGroupId, tabId: launcher.id, regionId: launcher.layout.activeRegionId }
        preparation.surface = launcher.regions[preparation.reference.regionId]!
      }
      const reference = preparation.reference, launcher = useAppStore.getState().tabs[reference.tabId]
      const attached = launcher?.regions[reference.regionId]
      const confirmedBrowser = attached?.kind === 'browser' && attached.browserId === reference.regionId && launcher?.space?.zoneId === preparation.zone.zoneId
      if (!confirmedBrowser) {
        if (!launcher || Object.keys(launcher.regions).length !== 1 || attached !== preparation.surface || preparation.surface?.kind !== 'launcher') throw new Error('The original preparation is unavailable or has changed. Its content and exact reference are kept; review it before retrying.')
        await before.createBrowser(reference.groupId, { tabId: reference.tabId, regionId: reference.regionId }, input)
      }
      const current = useAppStore.getState(), surface = current.tabs[reference.tabId]?.regions[reference.regionId]
      if (surface?.kind !== 'browser' || surface.browserId !== reference.regionId) throw new Error('The original Browser owner has not confirmed attachment.')
      failedCreation.current = null
      if (intent.current === startedIntent && current.mainSurface === 'survey' && current.surveyZoneSelection === before.surveyZoneSelection) setSelection({ zoneId: preparation.zone.zoneId, selection: [reference], active: reference })
    } catch (cause) { setError(`Browser could not open: ${presentError(cause)}. Your input and original work surface are kept; retry here.`) }
    finally { setOpening(false) }
  }

  async function changeRelation(spaceId: string, linked: boolean): Promise<void> {
    if (!currentZone || relationStatus?.pendingSpaceId) return
    const zoneId = currentZone.zoneId
    setRelationStatus({ zoneId, pendingSpaceId: spaceId, error: null, notice: null })
    try {
      const report = await useAppStore.getState().setZoneSpaceRelation(zoneId, spaceId, linked)
      setRelationStatus({ zoneId, pendingSpaceId: null, error: report.outcome === 'unknown' ? report.issues.map(issue => `${issue.message} ${issue.recovery}`).join(' ') || 'The relation owner could not confirm this change. Existing content is kept.' : null,
        notice: `${report.outcome === 'unchanged' ? 'Link unchanged.' : report.outcome === 'linked' ? 'Link added locally.' : report.outcome === 'unlinked' ? 'Link removed locally.' : 'Link status is unconfirmed.'} ${saveNotice(report.save)}` })
    } catch (cause) { setRelationStatus({ zoneId, pendingSpaceId: null, error: presentError(cause), notice: 'Existing content and links are kept. Retry this exact relation when its owner is available.' }) }
  }
  async function openLocation(location: AgentMuxSpaceLocation): Promise<void> {
    intent.current += 1
    try {
      const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: `survey-focus:${crypto.randomUUID()}`, operation: 'focus',
        target: { kind: 'space', ...(location.spaceId ? { spaceId: location.spaceId } : {}), ...(location.zoneId ? { zoneId: location.zoneId } : {}),
          displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }, inputPolicy: 'target' })
      if (result.operation !== 'focus') throw new Error('The navigation owner returned a different operation.')
      if (result.navigation.state === 'rejected' || result.navigation.state === 'unconfirmed') setError(result.issues.map(issue => `${issue.message} ${issue.recovery}`).join(' ') || 'This exact location is unconfirmed. Its content is kept.')
    } catch (cause) { setError(presentError(cause)) }
  }
  function openTopic(spaceId: string): void {
    if (!catalog || !currentZone) return
    const candidates = catalog.locations.filter(location => location.spaceId === spaceId && location.zoneId === currentZone.zoneId)
    const exact = selection?.active && candidates.find(location => location.displayWorkspaceId === selection.active!.displayWorkspaceId && location.groupId === selection.active!.groupId && location.tabId === selection.active!.tabId && location.regionId === selection.active!.regionId)
    if (exact) { void openLocation(exact); return }
    if (!candidates.length) { setError('This linked Topic has no confirmed location for the original Zone. Its relation and content are kept.'); return }
    setNavigationChoices(candidates)
  }

  const selectedStatus = relationStatus?.zoneId === currentZone?.zoneId ? relationStatus : null
  const retainedLocations = useMemo(() => {
    const byReference = new Map<string, WorkbenchProjectionSelection>()
    for (const reference of selection?.selection ?? []) byReference.set(JSON.stringify(reference), reference)
    for (const location of catalog?.locations ?? []) if (location.zoneId === selection?.zoneId) {
      const reference = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
      byReference.set(JSON.stringify(reference), reference)
    }
    return [...byReference.values()]
  }, [catalog, selection])

  return <section ref={surfaceRef} className="global-survey-surface" data-sidebar-collapsed={sidebarCollapsed} aria-label="Survey" hidden={!visible} inert={!visible} aria-hidden={!visible}>
    <aside ref={sidebarRef} className={`survey-tabs${isResizing ? ' survey-tabs--resizing' : ''}`} aria-label="Survey items" hidden={sidebarCollapsed} inert={sidebarCollapsed} data-survey-workspace-id={resourceWorkspaceId ?? undefined}>
      <div className="survey-sidebar-actions"><button type="button" className="survey-new-page" aria-label="New survey item" title={workspace ? `New item in ${workspace.name}` : 'Choose a resource workspace in Space'} disabled={opening || !workspace} onClick={() => void openBrowser('about:blank', true)}>
        {opening ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}<span>New item</span>
      </button><button type="button" className="survey-icon-button" aria-label="Hide Survey items" title="Hide Survey items" onClick={() => setSidebarCollapsed(true)}><PanelLeftClose size={16} /></button></div>
      <div className="survey-page-list">
        {Object.keys(collected).filter(zoneId => !catalog?.zones.some(zone => zone.zoneId === zoneId)).map(zoneId => <div key={zoneId} className="survey-item-row" data-survey-zone-id={zoneId} data-selected={selection?.zoneId === zoneId}>
          <button type="button" className="survey-item" aria-label="Show retained survey item" onClick={() => chooseZone(zoneId)}><CircleHelp size={14} /><strong>Retained exploration</strong></button>
          <span className="survey-relation-notice" role="status">Original source is not confirmed. Its reference is kept.</span>
        </div>)}
        {groups.map(group => <section key={group.id} className="survey-project-group" data-survey-project-id={group.id} aria-label={`Survey project: ${group.name}`}>
          <header>{group.workspaceId ? <button type="button" className="survey-project-source" aria-label={`Open source project: ${group.name}, ${group.description.replaceAll('\n', ', ')}`} title={group.description}
            onClick={() => { intent.current += 1; void selectWorkspace(group.workspaceId!) }}><Folder size={13} aria-hidden="true" /><span>{group.name}</span><ArrowUpRight size={11} aria-hidden="true" /></button> : <span title={group.description}>{group.name}</span>}</header>
          {group.zones.map(zone => {
            const status = activity(zone)
            return <SurveyZoneItem key={zone.zoneId} zone={zone} title={itemTitle(zone)} glyph={itemGlyph(zone)} selected={selection?.zoneId === zone.zoneId}
              sourceWorkspace={resourceWorkspaces.get(zone.workspaceId) ?? null} relatedTopics={catalog ? surveyZoneTopicFacts(catalog, zone.zoneId).relatedTopics : null}
              collected={collected[zone.zoneId] === true} onCollectedChange={value => { if (!setCollected(zone.zoneId, value)) setError('The original Zone resource is unconfirmed. Its content and selection are kept.') }}
              activity={status.summary} activityDetails={status.details} onSelect={chooseZone} onOpenWorkspace={workspaceId => { intent.current += 1; void selectWorkspace(workspaceId) }} />
          })}
        </section>)}
      </div>

      <div ref={resizeHandle} className="survey-width-handle" role="separator" tabIndex={0} aria-label="Resize Survey items" title="Resize Survey items"
        aria-orientation="vertical" aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={effectiveSidebarWidth} onMouseDown={onResizeStart}
        onKeyDown={event => {
          const next = event.key === 'Home' ? minWidth : event.key === 'End' ? maxWidth : event.key === 'ArrowLeft' ? effectiveSidebarWidth - 16 : event.key === 'ArrowRight' ? effectiveSidebarWidth + 16 : null
          if (next === null) return
          event.preventDefault(); event.stopPropagation(); setSidebarWidth(next)
        }} />
    </aside>
    <div className="survey-content">
      <div className="survey-page-content" inert={controlsCoverPage} aria-hidden={controlsCoverPage}>
        <header className="survey-context">
          {sidebarCollapsed ? <button type="button" className="survey-icon-button" aria-label="Show Survey items" title="Show Survey items" onClick={() => setSidebarCollapsed(false)}><PanelLeftOpen size={16} /></button> : null}
          <div className="survey-context-title">{currentZone ? <><span title={workspace ? `${workspace.hostId} · ${workspace.path}` : 'Original resource is not confirmed'}>{workspace?.name ?? 'Unknown resource'}</span><span className="survey-context-scope">{tabViewControl?.active ? 'Tab view' : <>{tabsByZone.get(currentZone.zoneId)?.length ?? 0} {(tabsByZone.get(currentZone.zoneId)?.length ?? 0) === 1 ? 'tab' : 'tabs'}</>}</span></> : <span>{selection ? 'Retained exploration' : 'New exploration'}</span>}</div>
          {selection && tabViewControl ? <button type="button" className="survey-tab-view" aria-label={tabViewControl.active ? 'Show full Survey item' : 'View current Survey Tab'}
            title={tabViewControl.active ? 'Return to all Tabs and Groups, with the original layout and controls' : tabViewControl.available ? 'View this exact Tab without changing the Item layout' : 'Choose a confirmed panel to view its Tab'}
            disabled={!tabViewControl.active && !tabViewControl.available} onClick={tabViewControl.onToggle}><PanelsTopLeft size={14} /><span>{tabViewControl.active ? 'Full item' : 'View Tab'}</span></button> : null}
          {navigationChoices.length ? <SurveyPanelChoices choices={navigationChoices} facts={{ config, layouts, tabs }} topic open onOpenChange={open => { if (!open) setNavigationChoices([]) }} onSelect={location => void openLocation(location)} />
            : selection && retainedLocations.length ? <SurveyPanelChoices choices={retainedLocations} facts={{ config, layouts, tabs }} onSelect={chooseReference} /> : null}
          {currentZone ? <SurveyTopicRelations zone={currentZone} topics={topics} relatedTopics={related.relatedTopics} unknownRelatedSpaces={related.unknownRelatedSpaces}
            pendingSpaceId={selectedStatus?.pendingSpaceId ?? null} error={selectedStatus?.error} notice={selectedStatus?.notice || topicSnapshot?.error ? <>{selectedStatus?.notice ? <div>{selectedStatus.notice}</div> : null}{topicSnapshot?.error ? <div>{topicSnapshot.error}</div> : null}</> : null}
            onLinkChange={(spaceId, linked) => void changeRelation(spaceId, linked)} onOpenTopic={openTopic} /> : null}
          <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" className="survey-icon-button" aria-label="Survey workspace options" title="Workspace options"><SlidersHorizontal size={16} /></button></DropdownMenu.Trigger>
            <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu survey-topic-menu" align="end" sideOffset={6} collisionPadding={8}>
              <DropdownMenu.Item className="tab-context-menu__item" aria-label="Browser management" disabled={!workspace} onSelect={() => setToolsOpen(!toolsOpen)}><SlidersHorizontal size={14} />Browser tools</DropdownMenu.Item>
              {workspace ? <DropdownMenu.Item className="tab-context-menu__item" aria-label="Return to Space" onSelect={() => { intent.current += 1; void selectWorkspace(workspace.id) }}><ArrowUpRight size={14} />Open resource in Space</DropdownMenu.Item> : null}
            </DropdownMenu.Content></DropdownMenu.Portal>
          </DropdownMenu.Root>
        </header>
        {error ? <p className="survey-error" role="alert">{error}{failedCreation.current ? <button type="button" disabled={opening} onClick={() => void openBrowser(query.trim() ? query : 'about:blank')}>Retry original item</button> : null}</p> : null}
        {creationNotice ? <p className="survey-relation-notice">{creationNotice}</p> : null}
        {!selection ? <div className="survey-start" aria-label="Start browsing"><div className="survey-start-mark"><Globe2 size={24} aria-hidden="true" /></div>
          <form className="survey-start-input" onSubmit={event => { event.preventDefault(); browserInput.current?.submit() }}>
            <BrowserAddressInput ref={browserInput} value={query} aria-label="Search or enter a web address" placeholder="Search or enter a web address" disabled={opening} historyTarget={workspace ? { kind: 'workspace', workspaceId: workspace.id } : null} onValueChange={value => { setQuery(value); setError(null) }} onSubmit={value => { if (value.trim()) void openBrowser(value) }} onHistoryNotice={setInputHistoryNotice} onDeferredHistoryFailure={message => useAppStore.getState().reportError(message, { kind: 'process-degraded' })} />
            <button type="submit" aria-label="Search or open page" disabled={opening || !query.trim()}>{opening ? <LoaderCircle className="spin" size={16} /> : <ArrowUpRight size={16} />}</button></form>{inputHistoryNotice ? <p className="survey-relation-notice" role="status">{inputHistoryNotice}</p> : null}<small>{workspace?.name ?? 'Choose a resource workspace in Space to start browsing'}</small>
        </div> : <>
          {currentZone && !items.some(item => item.zoneId === currentZone.zoneId) ? <div className="survey-relation-notice" role="status">
            This work surface is outside the Survey list. Its content and selection are kept.
            <button type="button" className="small-button" onClick={() => { if (!setCollected(currentZone.zoneId, true)) setError('The original Zone resource is unconfirmed. Its content and selection are kept.') }}>Keep in Survey</button>
          </div> : null}
          {!currentZone ? <div role="status" className="survey-restore-notice">The original Zone reference is retained while its owner restores.</div> : null}
          {!selection.active && retainedLocations.length ? <p className="survey-relation-notice" role="status">The active panel is not confirmed. Original references are kept; choose a panel to continue here.</p> : null}
          {projection ? <WorkspaceWorkbench workspaceId={projection.displayWorkspaceId} projection={projection} viewOwnership="projection" viewTargets={viewTargets} visible={visible && !controlsCoverPage} />
            : <div role="status" className="survey-restore-notice">The original work surface and precise references are kept. Choose an available location, or continue recovery in Space.</div>}
        </>}
      </div>
      {workspace && (toolsVisited || toolsOpen) ? <aside ref={managementRef} id="survey-management" className="survey-management" aria-label="Browser management controls" hidden={!toolsOpen} inert={!toolsOpen || !visible} aria-hidden={!toolsOpen || !visible}>
        <header><strong>Browser tools · {workspace.name}</strong><button type="button" aria-label="Close browser management" onClick={() => setToolsOpen(false)}><X size={14} /></button></header><SurveyBrowserTools workspace={workspace} visible={visible && toolsOpen} />
      </aside> : null}
    </div>
  </section>
})
