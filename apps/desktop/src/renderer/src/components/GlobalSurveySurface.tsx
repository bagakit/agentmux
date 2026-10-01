import { surveyExplorationName } from '../lib/survey-exploration-name'
import { spatialCatalog } from '../lib/space-agent-control'
import { useLauncherState } from '../lib/launcher-state'
import type { AgentMuxSpaceCatalog, AgentMuxSpaceLocation, AgentMuxSpatialSave, AgentMuxZoneFact } from '@agentmux/core/control'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { ArrowUpRight, Bot, CircleHelp, FileText, Globe2, PanelsTopLeft, PanelLeftClose, PanelLeftOpen, NotebookPen, LoaderCircle, MousePointer2, Plus, X } from 'lucide-react'
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
import { SurveyBrowserTools } from './SurveyBrowserTools'
import { SurveyZoneItem } from './SurveyZoneItem'
import { SurveyItemOptions } from './SurveyItemOptions'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { SurveyPanelChoices } from './SurveyPanelChoices'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
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
  const explorationNames = useAppStore(state => state.surveyExplorationNames)
  const [renamingZoneId, setRenamingZoneId] = useState<string | null>(null)
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
  const pendingNote = useRef<{ zoneId: string; workspaceId: string; displayWorkspaceId: string; groupId: string; reference: WorkbenchProjectionSelection | null; surface: WorkbenchSurface | null } | null>(null)
  const [noteRecovery, setNoteRecovery] = useState(false)
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
    return surveyExplorationName(explorationNames[zone.zoneId], (tabsByZone.get(zone.zoneId) ?? []).flatMap(id => tabs[id] ? [tabs[id]!] : []))
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

  async function openNote(newExploration: boolean, recover = false): Promise<void> {
    if (opening) return
    const before = useAppStore.getState(), startedIntent = intent.current
    const heldSelection = before.surveyZoneSelection
    setOpening(true); setError(null)
    try {
      let prepared = recover ? pendingNote.current : null
      if (!prepared) {
        if (!workspace) throw new Error('Choose a resource workspace in Space to start a note.')
        const active = !newExploration ? heldSelection?.active : null
        if (!newExploration && (!active || !currentZone || !catalog?.locations.some(location => location.zoneId === currentZone.zoneId &&
          location.displayWorkspaceId === active.displayWorkspaceId && location.groupId === active.groupId && location.tabId === active.tabId && location.regionId === active.regionId))) {
          throw new Error('Choose the original location for this exploration before adding a note. Its content is kept.')
        }
        const displayWorkspaceId = active?.displayWorkspaceId ?? workspace.id
        const groupId = active?.groupId ?? before.layouts[displayWorkspaceId]?.activeGroupId
        if (!groupId) throw new Error('The original display Group is still restoring. No note was created.')
        const zoneId = newExploration ? (await before.createWorkbenchZone({ workspaceId: workspace.id, spaceIds: [] })).zone.zoneId : currentZone!.zoneId
        if (!useAppStore.getState().setSurveyZoneCollected(zoneId, true)) throw new Error('The exploration resource is unconfirmed. Its original target is kept.')
        prepared = { zoneId, workspaceId: workspace.id, displayWorkspaceId, groupId, reference: null, surface: null }
        pendingNote.current = prepared
      }
      if (!prepared) throw new Error('The original Note preparation is unavailable. No replacement was created.')
      if (!prepared.reference) {
        const tabId = before.openLauncher({ workspaceId: prepared.workspaceId, displayWorkspaceId: prepared.displayWorkspaceId, tabGroupId: prepared.groupId, zoneId: prepared.zoneId, reveal: false })
        const launcher = tabId ? useAppStore.getState().tabs[tabId] : undefined
        if (!launcher) throw new Error('The original display Group is still restoring. The exploration is kept; recover this same note.')
        prepared.reference = { displayWorkspaceId: prepared.displayWorkspaceId, groupId: prepared.groupId, tabId: launcher.id, regionId: launcher.layout.activeRegionId }
        prepared.surface = launcher.regions[prepared.reference.regionId]!
      }
      const { reference, zoneId } = prepared, current = useAppStore.getState()
      const freshCatalog = spatialCatalog(current, scratchTopicsForWorkspace(current.scratchTopicSnapshots, topicsWorkspace) ?? [])
      let displayed = false
      const scope: WorkbenchProjection = { entity: { kind: 'zone', zoneId }, presentationId: 'survey-workbench',
        displayWorkspaceId: reference.displayWorkspaceId, catalog: freshCatalog, selection: [reference], onSelect(next) {
          const latest = useAppStore.getState()
          if (intent.current !== startedIntent || latest.mainSurface !== 'survey' || latest.surveyZoneSelection !== heldSelection) return
          const facts = spatialCatalog(latest, scratchTopicsForWorkspace(latest.scratchTopicSnapshots, topicsWorkspace) ?? [])
          const original = heldSelection?.zoneId === zoneId ? heldSelection : surveyInitialZoneSelection(facts, zoneId, latest.layouts, latest.tabs, next.displayWorkspaceId)
          displayed = true; setSelection(surveySelectReference(original, next))
        } }
      const launcherId = `region:${reference.regionId}`
      const retained = useLauncherState.getState().drafts[launcherId]?.noteCreation
      const receipt = recover && retained ? await (retained.status === 'error' ? current.retryCreatedNote(launcherId, scope) : current.revealCreatedNote(launcherId, scope))
        : await current.createNote(reference.groupId, { tabId: reference.tabId, regionId: reference.regionId }, undefined, scope)
      if (!receipt || receipt.status !== 'written' || !receipt.revealed || !displayed) {
        setNoteRecovery(true)
        throw new Error(receipt?.issue ?? (receipt?.status === 'written' ? 'The Note is saved. Open this same note when ready; later navigation was kept.' : 'The Note creation or display is unconfirmed. Check this same note; its original target is kept.'))
      }
      pendingNote.current = null; setNoteRecovery(false)
      // Only discard this action's unchanged, empty preparation; all other content is preserved.
      const latest = useAppStore.getState(), launcher = latest.tabs[reference.tabId]
      const locations = spatialCatalog(latest, scratchTopicsForWorkspace(latest.scratchTopicSnapshots, topicsWorkspace) ?? []).locations.filter(location => location.tabId === reference.tabId)
      const solePreparation = locations.length > 0 && locations.every(location => location.displayWorkspaceId === reference.displayWorkspaceId && location.groupId === reference.groupId)
      if (solePreparation && !launcher?.name && launcher?.space?.zoneId === zoneId && Object.keys(launcher.regions).length === 1 && launcher.regions[reference.regionId] === prepared.surface) {
        await latest.closeTab(reference.displayWorkspaceId, reference.groupId, reference.tabId)
      }
    } catch (cause) { if (pendingNote.current) setNoteRecovery(true); setError(`Note could not open: ${presentError(cause)}`) }
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

  const options = <SurveyItemOptions key={String(sidebarCollapsed)} visible={visible && !controlsCoverPage} title={currentZone ? itemTitle(currentZone) : selection ? 'Retained exploration' : 'New exploration'}
    zone={currentZone ?? null} workspace={workspace ?? null} collected={!!selection && collected[selection.zoneId] === true} relatedTopics={related.relatedTopics}
    activityDetails={currentZone ? activity(currentZone).details : null} panels={selection && retainedLocations.length ? { choices: retainedLocations, facts: { config, layouts, tabs }, onSelect: chooseReference } : null}
    relations={currentZone ? { zone: currentZone, topics, relatedTopics: related.relatedTopics, unknownRelatedSpaces: related.unknownRelatedSpaces,
      pendingSpaceId: selectedStatus?.pendingSpaceId ?? null, error: selectedStatus?.error,
      notice: selectedStatus?.notice || topicSnapshot?.error ? <>{selectedStatus?.notice}{topicSnapshot?.error}</> : null,
      onLinkChange: (spaceId, linked) => void changeRelation(spaceId, linked), onOpenTopic: openTopic } : null}
    {...(selection && tabViewControl ? { tabViewControl } : {})}
    {...(currentZone ? { onRename: () => setRenamingZoneId(currentZone.zoneId) } : {})}
    onCollectedChange={value => { if (selection && !setCollected(selection.zoneId, value)) setError('The original Zone resource is unconfirmed. Its content and selection are kept.') }}
    onManageBrowsers={() => setToolsOpen(!toolsOpen)} onOpenWorkspace={workspaceId => { intent.current += 1; void selectWorkspace(workspaceId) }} />
  const panelUnconfirmed = !!selection && !selection.active && retainedLocations.length > 0
  const relationMessage = [selectedStatus?.error, selectedStatus?.notice, topicSnapshot?.error].filter(Boolean).join('\n')

  return <section ref={surfaceRef} className="global-survey-surface" data-sidebar-collapsed={sidebarCollapsed} aria-label="Survey" hidden={!visible} inert={!visible} aria-hidden={!visible}>
    <aside ref={sidebarRef} className={`survey-tabs${isResizing ? ' survey-tabs--resizing' : ''}`} aria-label="Survey items" hidden={sidebarCollapsed} inert={sidebarCollapsed} data-survey-workspace-id={resourceWorkspaceId ?? undefined}>
      <div className="survey-sidebar-actions"><button type="button" className="survey-new-page" aria-label="New exploration" title={workspace ? `Start browsing in ${workspace.name}` : 'Choose a resource workspace in Space'} disabled={opening || !workspace} onClick={() => void openBrowser('about:blank', true)}>
        {opening ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}<span>Explore</span>
      </button><button type="button" className="survey-icon-button" aria-label="New note exploration" title="Start with a note" disabled={opening || !workspace} onClick={() => void openNote(true)}><NotebookPen size={16} /></button><button type="button" className="survey-icon-button" aria-label="Hide Survey items" title="Hide Survey items" onClick={() => setSidebarCollapsed(true)}><PanelLeftClose size={16} /></button></div>
      <div className="survey-page-list">
        {Object.keys(collected).filter(zoneId => !catalog?.zones.some(zone => zone.zoneId === zoneId)).map(zoneId => <div key={zoneId} className="survey-item-row" data-survey-zone-id={zoneId} data-selected={selection?.zoneId === zoneId}>
          <button type="button" className="survey-item" aria-label="Show retained survey item" onClick={() => chooseZone(zoneId)}><CircleHelp size={14} /><strong>Retained exploration</strong></button>
          <span className="survey-relation-notice" role="status">Original source is not confirmed. Its reference is kept.</span>
        </div>)}
        {items.map(zone => {
          const status = activity(zone)
          return <SurveyZoneItem key={zone.zoneId} zone={zone} title={itemTitle(zone)} glyph={itemGlyph(zone)} selected={selection?.zoneId === zone.zoneId}
            activity={status.summary} editing={renamingZoneId === zone.zoneId} onEdit={editing => setRenamingZoneId(editing ? zone.zoneId : null)}
            onRename={name => { const applied = useAppStore.getState().setSurveyExplorationName(zone.zoneId, name); if (!applied) setError('The exploration source is unconfirmed. Your name draft is kept here.'); return applied }} onSelect={chooseZone} />
        })}
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
        <header className="survey-view-controls" >
          {sidebarCollapsed ? <button type="button" className="survey-icon-button" aria-label="Show Survey items" title="Show Survey items" onClick={() => setSidebarCollapsed(false)}><PanelLeftOpen size={16} /></button> : null}
          {options}
          {selection ? <button type="button" className="survey-tab-view" aria-label="Add note to this exploration" title={selection.active ? 'Add a note in this exploration' : 'Choose the original location before adding a note'} disabled={opening || !selection.active || !workspace} onClick={() => void openNote(false)}><NotebookPen size={14} /><span>Add note</span></button> : null}
          {tabViewControl?.active ? <button type="button" className="survey-tab-view" aria-label="Show full Survey item" title="Return to all original Tabs and Groups" onClick={tabViewControl.onToggle}><PanelsTopLeft size={14} /><span>All tabs</span></button> : null}
          {navigationChoices.length ? <SurveyPanelChoices choices={navigationChoices} facts={{ config, layouts, tabs }} mode="button" visible={visible && !controlsCoverPage} topic open onOpenChange={open => { if (!open) setNavigationChoices([]) }} onSelect={location => void openLocation(location)} /> : null}
          {panelUnconfirmed ? <div className="survey-panel-status"><span role="status">Panel not confirmed</span>
            <SurveyPanelChoices choices={retainedLocations} facts={{ config, layouts, tabs }} mode="button" visible={visible && !controlsCoverPage} onSelect={chooseReference} />
            <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: 'The active panel is not confirmed.', mode: 'Original references and content are kept.', restore: 'Choose an original panel, or continue recovery in Space. Technical references are available in the panel menu.' } }}
              title="Details" disclosure={{ scope: JSON.stringify(['survey-panel', selection?.zoneId]), id: 'active-panel', occurrence: JSON.stringify(selection?.selection), visible: visible && !controlsCoverPage }} />
          </div> : null}
          {selectedStatus?.pendingSpaceId != null ? <span className="survey-status" role="status">Updating Topic link…</span> : null}
          {relationMessage ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: 'Topic status', mode: relationMessage, restore: 'Original content and applied relationships are kept. Open Organize to inspect the exact Topic; use the original Space save action when saving is unconfirmed.' } }}
            disclosure={{ scope: JSON.stringify(['survey-topics', selection?.zoneId]), id: 'topic-state', visible: visible && !controlsCoverPage }} /> : null}
        </header>
        {error ? <p className="survey-error" role="alert">{error}{failedCreation.current ? <button type="button" disabled={opening} onClick={() => void openBrowser(query.trim() ? query : 'about:blank')}>Retry original item</button> : null}</p> : null}
        {noteRecovery ? <p className="survey-relation-notice" role="status">The original Note target is kept. <button type="button" className="survey-tab-view" disabled={opening} onClick={() => void openNote(false, true)}>Recover same note</button></p> : null}
        {creationNotice ? <p className="survey-relation-notice">{creationNotice}</p> : null}
        {!selection ? <div className="survey-start" aria-label="Start exploring"><div className="survey-start-heading"><h1>Explore an idea</h1><p>Browse, take notes, and connect what you find.</p></div>
          <form className="survey-start-input" onSubmit={event => { event.preventDefault(); browserInput.current?.submit() }}>
            <BrowserAddressInput ref={browserInput} value={query} aria-label="Search or enter a web address" placeholder="Search or enter a web address" disabled={opening} historyTarget={workspace ? { kind: 'workspace', workspaceId: workspace.id } : null} onValueChange={value => { setQuery(value); setError(null) }} onSubmit={value => { if (value.trim()) void openBrowser(value) }} onHistoryNotice={setInputHistoryNotice} onDeferredHistoryFailure={message => useAppStore.getState().reportError(message, { kind: 'process-degraded' })} />
            <button type="submit" aria-label="Search or open page" disabled={opening || !query.trim()}>{opening ? <LoaderCircle className="spin" size={16} /> : <ArrowUpRight size={16} />}</button></form><button type="button" className="survey-start-note" disabled={opening || !workspace} onClick={() => void openNote(true)}><NotebookPen size={16} /><span>Start with a note</span></button>{inputHistoryNotice ? <p className="survey-relation-notice" role="status">{inputHistoryNotice}</p> : null}<small>{workspace?.name ?? 'Choose a resource workspace in Space to start browsing'}</small>
        </div> : <>
          {currentZone && !items.some(item => item.zoneId === currentZone.zoneId) ? <div className="survey-relation-notice" role="status">
            This work surface is outside the Survey list. Its content and selection are kept.
            <button type="button" className="small-button" onClick={() => { if (!setCollected(currentZone.zoneId, true)) setError('The original Zone resource is unconfirmed. Its content and selection are kept.') }}>Keep in Survey</button>
          </div> : null}
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
