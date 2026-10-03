import { observeNotebookLibrary } from './lib/notebook-library'
import { ExecutorIdentityContext } from './components/AgentAvatar'
import { SettingsNavigation, type SettingsNavigationRequest } from './components/SettingsNavigation'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { BrandIcon } from './components/BrandIcon'
import { useAgentAttentionNotifications } from './hooks/useAgentAttentionNotifications'
import { useSidebarResize } from './hooks/useSidebarResize'
import {
  TOOL_DOCK_MAX_WIDTH,
  getRenderedToolDockWidth,
  getToolDockMinimumWidth
} from './lib/surface-tool-dock'
import { SettingsPanel, type SettingsPageId } from './components/SettingsPanel'
import { GlobalSystemNotices } from './components/GlobalSystemNotices'
import { ToolkitStatusBar } from './components/toolkit/ToolkitStatusBar'
import { WindowUtilityBar } from './components/WindowUtilityBar'
import { WindowOverlayHost } from './components/WindowOverlayHost'
import { QuickSwitcher } from './components/QuickSwitcher'
import { isEditableChordTarget, windowShortcutHandlers } from './lib/workbench-shortcuts'
import { routeWindowShortcut } from './lib/shortcut-registry'
import { SurfaceSwitch, TopRowLeadingChrome, WindowSidebarLayoutContext, useWindowSidebarLayout } from './components/TopRowChrome'
import { GlobalBoardSurface } from './components/GlobalBoardSurface'
import { GlobalFocusSurface } from './components/GlobalFocusSurface'
import { GlobalSurveySurface } from './components/GlobalSurveySurface'
import { PmoTeamsTopicFloatingPanel } from './components/PmoTeamsTopicFloatingPanel'
import { MoteWorkface } from './components/MoteWorkface'
import { moteWorkbenchProjection } from './lib/mote-workbench-projection'
import { pmoTeamsTopicFloatingViewTargets, pmoTeamsTopicFloatingTargetTabId, pmoTeamsTopicFloatingTargetTopicId, readPmoTeamsTopicFloatingState, usePmoTeamsTopicFloatingState } from './lib/pmo-teams-topic-floating'
import { desktopSurface } from './lib/desktop-focus-navigation'
import { installDesktopPresentationOwner, desktopPresentationCommitted, type DesktopAppPresentationOwner } from './lib/desktop-presentation'
import { SCRATCH_WORKSPACE_ID } from '../../shared/scratch-topics'
import { ProjectRail } from './components/ProjectRail'
import { SurfaceToolDock } from './components/SurfaceToolDock'
import { TransientErrorNotice } from './components/TransientErrorNotice'
import { WorkspaceWorkbench as WorkspaceWorkbenchView } from './components/WorkspaceWorkbench'
import { executionFocusSessionId } from './lib/agent-focus'
import { executionFocusPresentation } from './lib/focus-tab-projection'
import { api } from './lib/api'
import { fileNavigationSelection, useAppStore } from './store'
import { observeRejectedFileExplorerDirectoryLoads } from './components/file-tree/file-explorer-report-probe'
import { isMacPlatform } from './lib/host-platform'
import { applyAppAppearance } from './lib/app-appearance'
import { useNativeOverlayChrome } from './hooks/useNativeOverlayChrome'
import { RendererResourceOwners } from './components/RendererResourceOwners'
import { WorkflowComponentGallery } from './components/WorkflowComponentGallery'
import { FullPageLoadingSurface } from './components/FullPageLoadingSurface'
import { beginRendererStartup, startupProgressDetail } from './lib/startup-progress'
import { surveySelectReference, surveyResolvedZoneSelection } from './lib/survey-workface'
import { spatialCatalog } from './lib/space-agent-control'
import { scratchTopicsForWorkspace } from './lib/scratch-topic-snapshots'
import { resolveWorkbenchZone, sameWorkbenchProjectionSelection, projectWorkbenchProjection, workbenchProjectionSlotId, workbenchRegionProjectionSlotId, type WorkbenchProjection, type WorkbenchProjectionSelection } from './lib/workbench-projection'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { WorkbenchViewTarget, WorkbenchViewTargets } from './lib/workbench-presentation'
import { ordinaryWorkbenchViewTargets, workbenchResourceTabs, workbenchDisplayReferenceMatches } from './lib/workbench-resource-display'
import { useWorkbenchObjectLayout } from './hooks/useWorkbenchObjectLayout'
import { layoutForLogicalRegionFocus } from './lib/region-focus'
import { sessionPresentationById } from './lib/session-presentation'
import { isSessionSurface } from './lib/workbench-surface-kinds'

const WorkspaceWorkbench = memo(WorkspaceWorkbenchView)

export function App() {
  useEffect(() => observeNotebookLibrary(), [])
  const workflowComponentGallery = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('agentmux-component-gallery') === '1'
  if (workflowComponentGallery) return <WorkflowComponentGallery />
  return <DesktopApp />
}

function DesktopApp() {
  const [settingsRoute, setSettingsRoute] = useState<SettingsNavigationRequest | null>(null)
  const openSettings = useCallback((section: SettingsPageId, executorId?: string): void => setSettingsRoute({ section, executorId }), [])
  const closeSettings = useCallback((): void => setSettingsRoute(null), [])
  const openToolkit = useCallback((toolId: string): void => setSettingsRoute({ section: 'toolkit', toolId }), [])
  const settingsNavigation = useMemo(() => ({ open: openSettings, openToolkit }), [openSettings, openToolkit])
  const [windowResizeActive, setWindowResizeActive] = useState(false)
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false)
  const quickSwitchOrigin = useRef<{ element: HTMLElement | null; navigation: string } | null>(null)
  const initialize = useAppStore((state) => state.initialize)
  const loading = useAppStore((state) => state.loading)
  const startupProgress = useAppStore((state) => state.startupProgress)
  const error = useAppStore((state) => state.error)
  const lastError = useAppStore((state) => state.lastError)
  const errorDismissed = useAppStore((state) => state.errorDismissed)
  const errorNoticeKind = useAppStore((state) => state.errorNoticeContext?.kind ?? 'indeterminate')
  const errorSummary = useAppStore((state) => state.errorNoticeContext?.summary)
  const lifecycleError = useAppStore((state) => state.errorNoticeContext?.lifecycle !== undefined)
  const dismissError = useAppStore((state) => state.dismissError)
  const reopenError = useAppStore((state) => state.reopenError)
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const layouts = useAppStore((state) => state.layouts)
  const tabs = useAppStore((state) => state.tabs)
  const resourceWorkspaces = useMemo(() => workbenchResourceTabs(tabs), [tabs])
  const workbenchSpaceSelection = useAppStore(state => state.workbenchSpaceSelection)
  const topicCategories = useAppStore(state => state.topicCategories)
  const [moteFloating, setMoteFloating] = usePmoTeamsTopicFloatingState()
  const agentFocus = useAppStore((state) => state.agentFocus)

  const mainSurface = useAppStore((state) => state.mainSurface)
  const presentationRef = useRef<DesktopAppPresentationOwner>({ loading: true,
    overlays: { settings: false, quickSwitcher: false },
    floating: null })
  useLayoutEffect(() => installDesktopPresentationOwner(() => presentationRef.current), [])
  useLayoutEffect(() => {
    const floating = readPmoTeamsTopicFloatingState()
    presentationRef.current = { loading,
      overlays: { settings: Boolean(settingsRoute), quickSwitcher: quickSwitchOpen },
      floating: floating ? { state: floating.open ? 'pinned' : floating.preview ? 'preview' : 'closed',
        topicId: pmoTeamsTopicFloatingTargetTopicId(floating, tabs),
        tabId: pmoTeamsTopicFloatingTargetTabId(floating, tabs, layouts[SCRATCH_WORKSPACE_ID], agentFocus.pmo.sessionId) ?? null } : null }
    desktopPresentationCommitted()
  })
  const surveySelection = useAppStore((state) => state.surveyZoneSelection)
  const surveyNotebookId = useAppStore(state => state.surveyNotebookId)
  const surveyNoteId = useAppStore(state => state.surveyNoteId)
  const surveyToolsOpen = useAppStore((state) => state.surveyToolsOpen)
  const [unconfirmedBrowserRegionIds, setUnconfirmedBrowserRegionIds] = useState<ReadonlySet<string>>(() => new Set())
  const onBrowserControlConfirmation = useCallback((regionId: string, unconfirmed: boolean) => {
    setUnconfirmedBrowserRegionIds(current => {
      if (current.has(regionId) === unconfirmed) return current
      const next = new Set(current)
      if (unconfirmed) next.add(regionId); else next.delete(regionId)
      return next
    })
  }, [])
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  const narrowControls = windowWidth <= 1100
  useEffect(() => {
    const resized = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', resized)
    return () => window.removeEventListener('resize', resized)
  }, [])
  const surveyVisible = mainSurface === 'survey' && !settingsRoute
  const focusVisible = mainSurface === 'agents' && !settingsRoute
  const surveyBindings = useAppStore(state => state.spaceZoneBindings)
  const surveyTopicSnapshots = useAppStore(state => state.scratchTopicSnapshots)
  const surveySessionIds = useMemo(() => [...new Set(Object.values(tabs).flatMap(tab =>
    Object.values(tab.regions).flatMap(surface => isSessionSurface(surface) ? [surface.sessionId] : [])))], [tabs])
  // The spatial directory reads execution identity, never status/output clocks.
  const surveySessions = useAppStore(useShallow(state => {
    if ((!surveyVisible && !focusVisible && !moteFloating.open && !moteFloating.preview) || surveySessionIds.length === 0) return []
    const byId = sessionPresentationById(state.sessions)
    return surveySessionIds.flatMap(id => {
      const session = byId.get(id)
      return [id, session?.control.run.runId ?? null, session?.hostId ?? null, session?.workspacePath ?? null]
    })
  }))
  const topicsWorkspace = config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  const surveyTopics = scratchTopicsForWorkspace(surveyTopicSnapshots, topicsWorkspace)
  const retainedSurveyCatalog = useRef<AgentMuxSpaceCatalog | null>(null)
  const spatialDirectory = useMemo(() => {
    if (!surveyVisible && !focusVisible && !moteFloating.open && !moteFloating.preview) return { catalog: retainedSurveyCatalog.current, issue: null }
    try {
      const catalog = spatialCatalog(useAppStore.getState(), surveyTopics ?? [])
      retainedSurveyCatalog.current = catalog
      return { catalog, issue: null }
    } catch (error) {
      // Directory validation is a presentation failure, never a reason to stop a healthy Session.
      return { catalog: retainedSurveyCatalog.current, issue: `The work surface directory could not be confirmed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }, [surveyVisible, focusVisible, moteFloating.open, moteFloating.preview, config, tabs, layouts, surveyBindings, surveySessions, surveyTopics])
  const surveyCatalog = spatialDirectory.catalog
  const selectMoteReference = useCallback<WorkbenchProjection['onSelect']>(reference => {
    const state = useAppStore.getState(), current = readPmoTeamsTopicFloatingState(), tab = state.tabs[reference.tabId]
    const topicId = pmoTeamsTopicFloatingTargetTopicId(current ?? moteFloating, state.tabs)
    if (!tab?.regions[reference.regionId] || tab.topicId !== topicId ||
      !workbenchDisplayReferenceMatches(state.layouts[reference.displayWorkspaceId], reference)) {
      state.reportError(new Error('This exact discussion location is no longer confirmed. Its original content is kept; choose its current location.'))
      return
    }
    state.focusRegion(reference.displayWorkspaceId, reference.tabId, reference.regionId, 'floating-pointer', reference.groupId)
    setMoteFloating({ targetTabId: reference.tabId, reference })
  }, [setMoteFloating, moteFloating])
  const moteProjection = useMemo(() => {
    const id = pmoTeamsTopicFloatingTargetTabId(moteFloating, tabs, layouts[SCRATCH_WORKSPACE_ID], agentFocus.pmo.sessionId)
    return moteWorkbenchProjection(surveyCatalog, id ? tabs[id] : undefined, moteFloating, selectMoteReference, layouts)
  }, [surveyCatalog, moteFloating.targetTabId, moteFloating.targetTopicId, moteFloating.reference, tabs, layouts, agentFocus.pmo.sessionId, selectMoteReference])
  const moteViewTargets = useMemo(() => {
    const targets = pmoTeamsTopicFloatingViewTargets(
      moteFloating, tabs, layouts[SCRATCH_WORKSPACE_ID], agentFocus.pmo.sessionId, moteProjection.projection)
    const held = moteFloating.reference, tab = held ? tabs[held.tabId] : undefined
    // A stale Region does not invalidate its still-confirmed exact parent. Only an
    // actual local selection supplies the new Region; an unknown parent stays unconfirmed.
    if (!moteProjection.projection && held && tab && targets?.[tab.id]?.length === 1 &&
      held.tabId === pmoTeamsTopicFloatingTargetTabId(moteFloating, tabs, layouts[SCRATCH_WORKSPACE_ID], agentFocus.pmo.sessionId) &&
      tab.topicId === pmoTeamsTopicFloatingTargetTopicId(moteFloating, tabs) &&
      workbenchDisplayReferenceMatches(layouts[held.displayWorkspaceId], held)) {
      return { ...targets, [tab.id]: targets[tab.id]!.map(target => ({ ...target,
        onSelectRegion: (regionId: string) => selectMoteReference({ ...held, regionId }) })) }
    }
    return targets
  }, [moteFloating.open, moteFloating.preview, moteFloating.targetTopicId, moteFloating.targetTabId, moteFloating.reference,
    tabs, layouts, agentFocus.pmo.sessionId, moteProjection, selectMoteReference])
  const selectFocusReference = useCallback<WorkbenchProjection['onSelect']>(reference => {
    useAppStore.getState().selectExecutionFocusReference(reference, agentFocus.execution)
  }, [agentFocus.execution])
  const [focusRegionOnly, setFocusRegionOnly] = useState(false)
  useEffect(() => setFocusRegionOnly(false), [agentFocus.execution.sessionId])
  const focusPresentation = useMemo(() => mainSurface === 'agents'
    ? executionFocusPresentation(agentFocus.execution, tabs, surveyCatalog, selectFocusReference, focusRegionOnly ? 'region' : 'tab')
    : { projection: null, issue: null, references: [] },
  [mainSurface, agentFocus.execution, tabs, surveyCatalog, selectFocusReference, focusRegionOnly])
  const focusProjection = focusPresentation.projection
  const focusTab = focusProjection?.selection.length === 1 ? tabs[focusProjection.selection[0]!.tabId] : null
  const surveyOccurrence = useRef<WorkbenchProjectionSelection | null>(null)
  const selectSurveyReference = useCallback<WorkbenchProjection['onSelect']>(reference => {
    const state = useAppStore.getState()
    if (!state.surveyZoneSelection) return
    const currentTopics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)) ?? []
    const currentCatalog = spatialCatalog(state, currentTopics)
    const tab = state.tabs[reference.tabId]
    const scope = resolveWorkbenchZone(state.surveyZoneSelection.zoneId, currentCatalog, state.layouts, state.tabs, 'survey-workbench', [], () => {})
    const layout = scope?.composition ?? state.layouts[reference.displayWorkspaceId]
    if (!tab?.regions[reference.regionId] || !layout?.groups.some(group => group.id === reference.groupId && group.tabOrder.includes(tab.id)) ||
      !currentCatalog.tabs.some(member => member.tabId === tab.id && member.zoneId === state.surveyZoneSelection!.zoneId)) return
    surveyOccurrence.current = reference
    state.setSurveyZoneSelection(surveySelectReference(state.surveyZoneSelection, reference))
  }, [])
  const surveyProjection = useMemo(() => {
    if (!surveySelection || !surveyCatalog) return null
    const projection = resolveWorkbenchZone(surveySelection.zoneId, surveyCatalog, layouts, tabs, 'survey-workbench',
      surveySelection.active ? [...surveySelection.selection, surveySelection.active] : surveySelection.selection, selectSurveyReference)
    const active = surveySelection.active
    const surface = active ? tabs[active.tabId]?.regions[active.regionId] : undefined
    if (!projection || !surveyNotebookId || !surveyNoteId || !active || surface?.kind !== 'file') return projection
    const references = projection.selection.filter(reference => reference.tabId === active.tabId && reference.regionId === active.regionId)
    const reference = references.find(value => surveyOccurrence.current && sameWorkbenchProjectionSelection(value, surveyOccurrence.current))
      // The original File owner may change a legacy path-based Tab ID. The same immutable Region
      // in this exact display/Group remains the original occurrence; never choose another Group.
      ?? references.find(value => surveyOccurrence.current && value.regionId === surveyOccurrence.current.regionId &&
        value.displayWorkspaceId === surveyOccurrence.current.displayWorkspaceId && value.groupId === surveyOccurrence.current.groupId)
      ?? (references.length === 1 ? references[0] : undefined)
    return reference ? { ...projection, entity: { kind: 'region' as const, regionId: reference.regionId }, selection: [reference] } : projection
  }, [surveySelection, surveyCatalog, layouts, tabs, selectSurveyReference, surveyNotebookId, surveyNoteId])
  const surveyCurrentSelection = useMemo(() => surveySelection ? surveyResolvedZoneSelection(surveySelection, surveyProjection, surveyOccurrence.current) : null,
    [surveySelection, surveyProjection])
  const retainedSpatialFocus = useAppStore(state => state.retainedSpatialFocus)
  const currentOrdinaryLayout = activeWorkspaceId ? layouts[activeWorkspaceId] : undefined
  const retainedOrdinaryLayout = useRef<{ workspaceId: string; layout: NonNullable<typeof currentOrdinaryLayout> } | null>(null)
  if (currentOrdinaryLayout && activeWorkspaceId) retainedOrdinaryLayout.current = { workspaceId: activeWorkspaceId, layout: currentOrdinaryLayout }
  const ordinaryLayout = currentOrdinaryLayout ?? (retainedOrdinaryLayout.current?.workspaceId === activeWorkspaceId ? retainedOrdinaryLayout.current.layout : undefined)
  const ordinaryObject = useWorkbenchObjectLayout(activeWorkspaceId ?? '', ordinaryLayout)
  const ordinaryTargets = useMemo(() => {
    const layout = ordinaryObject.layout
    if (!layout || !activeWorkspaceId) return {}
    const held = retainedSpatialFocus?.displayWorkspaceId === activeWorkspaceId ? retainedSpatialFocus : null
    const displayed = layoutForLogicalRegionFocus(layout, tabs, held)
    const targets = ordinaryWorkbenchViewTargets(displayed, tabs, activeWorkspaceId)
    return Object.fromEntries(Object.entries(targets).map(([id, occurrences]) => [id, occurrences.map(target => ({ ...target, visible: target.visible !== false && mainSurface === 'workbench' && !settingsRoute }))]))
  }, [activeWorkspaceId, ordinaryObject.layout, tabs, mainSurface, settingsRoute, retainedSpatialFocus])
  const viewTargets = useMemo<WorkbenchViewTargets>(() => {
    const targets: Record<string, WorkbenchViewTarget[]> = {}
    const append = (tabId: string, target: WorkbenchViewTarget) => (targets[tabId] ??= []).push(target)
    for (const [tabId, occurrences] of Object.entries(ordinaryTargets)) for (const target of occurrences) append(tabId, target)
    for (const [tabId, occurrences] of Object.entries(moteViewTargets ?? {})) for (const target of occurrences) append(tabId, target)
    if (surveyVisible && surveyProjection) {
      const projection = surveyProjection
      const projected = projectWorkbenchProjection(layouts[projection.displayWorkspaceId], tabs, projection)
      for (const reference of projected.selection) {
        if (projected.unsupportedTabIds.has(reference.tabId)) continue
        append(reference.tabId, { hostId: (projection.entity.kind === 'region' ? workbenchRegionProjectionSlotId : workbenchProjectionSlotId)(`${projection.presentationId}-slot`, reference),
          active: !(surveyToolsOpen && narrowControls) && (surveyCurrentSelection?.active?.tabId !== reference.tabId ||
            sameWorkbenchProjectionSelection(surveyCurrentSelection.active, reference)), visible: !(surveyToolsOpen && narrowControls), surface: 'survey', controlsOpen: surveyToolsOpen,
          projection, reference, retainedRegionId: reference.regionId, onSelectRegion: regionId => selectSurveyReference({ ...reference, regionId }) })
      }
    }
    if (mainSurface === 'agents' && focusProjection && focusTab) {
      const reference = focusProjection.selection[0]!
      append(focusTab.id, {
        hostId: focusProjection.entity.kind === 'region' ? workbenchRegionProjectionSlotId(`${focusProjection.presentationId}-slot`, reference) : workbenchProjectionSlotId(`${focusProjection.presentationId}-slot`, reference),
        active: focusVisible, visible: focusVisible, surface: 'focus', retainedRegionId: reference.regionId,
        headerPortalTargetId: 'focus-workspace-slot-header', projection: focusProjection, reference,
        onSelectRegion: regionId => selectFocusReference({ ...reference, regionId })
      })
    }
    return targets
  }, [moteViewTargets, surveyVisible, surveyProjection, surveyCurrentSelection, layouts, tabs, surveyToolsOpen, narrowControls, selectSurveyReference,
    focusVisible, focusProjection, focusTab, selectFocusReference, ordinaryTargets])
  const [surveyVisited, setSurveyVisited] = useState(mainSurface === 'survey')
  useEffect(() => {
    if (mainSurface === 'survey') setSurveyVisited(true)
  }, [mainSurface])
  const compactSidebars = windowWidth <= 760 && mainSurface === 'workbench' && Boolean(config?.workspaces.some(item => item.id === activeWorkspaceId))
  const windowSidebars = useWindowSidebarLayout(compactSidebars)
  const { projectRailOpen, toolsOpen } = windowSidebars
  const globalSurfaceOwnsProjectRail = mainSurface === 'board' || mainSurface === 'agents' || mainSurface === 'survey'
  const toolDockWidth = useAppStore((state) => state.toolDockWidth)
  const setToolDockWidth = useAppStore((state) => state.setToolDockWidth)
  const acquireNativeSurfaceOverlay = useAppStore((state) => state.acquireNativeSurfaceOverlay)
  const releaseNativeSurfaceOverlay = useAppStore((state) => state.releaseNativeSurfaceOverlay)
  const onAgentPanelVisibilityChange = useCallback((visible: boolean) => {
    if (visible) acquireNativeSurfaceOverlay()
    else releaseNativeSurfaceOverlay()
  }, [acquireNativeSurfaceOverlay, releaseNativeSurfaceOverlay])
  const executorIdentity = useMemo(() => ({ config, onPanelVisibilityChange: onAgentPanelVisibilityChange }), [config, onAgentPanelVisibilityChange])
  const nativeOverlayWarning = useNativeOverlayChrome()
  const workspace = config?.workspaces.find((item) => item.id === activeWorkspaceId)
  useEffect(() => applyAppAppearance(config?.appearance.appAppearance), [config?.appearance.appAppearance])
  useEffect(() => api.config.onChange((committed) => useAppStore.getState().setConfig(committed)), [])
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const fileEditingProbe = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('agentmux-file-editing-report') === '1'
  useEffect(() => {
    if (!fileEditingProbe) return
    let total = 0
    const byWorkspace: Record<string, number> = {}
    const rejectedDirectoryLoads: Array<{
      workspaceId: string
      path: string
      epoch: number
      operationId: number
      kind: 'rejected'
      observedAt: number
    }> = []
    const publish = () => {
      document.documentElement.dataset.fileEditingExplorerEvidence = JSON.stringify({
        mountId: 'app', total, byWorkspace, rejectedDirectoryLoads
      })
    }
    const unsubscribeStore = useAppStore.subscribe((state, previous) => {
      if (state.fileExplorerStates === previous.fileExplorerStates) return
      total += 1
      for (const id of new Set([...Object.keys(state.fileExplorerStates), ...Object.keys(previous.fileExplorerStates)])) {
        if (state.fileExplorerStates[id] !== previous.fileExplorerStates[id]) byWorkspace[id] = (byWorkspace[id] ?? 0) + 1
      }
      publish()
    })
    const unsubscribeRejectedLoads = observeRejectedFileExplorerDirectoryLoads((receipt) => {
      rejectedDirectoryLoads.push(receipt)
      publish()
    })
    publish()
    return () => { unsubscribeStore(); unsubscribeRejectedLoads() }
  }, [fileEditingProbe])
  const projectedVisibleTabIds = useMemo(() => new Set([
    ...Object.entries(viewTargets).flatMap(([tabId, targets]) => targets.some(target => target.visible !== false && target.projection?.entity.kind !== 'region') ? [tabId] : [])
  ]), [viewTargets])
  const projectedVisibleRegionIds = useMemo(() => new Set(Object.values(viewTargets).flat().flatMap(target =>
    target.visible !== false && target.projection?.entity.kind === 'region' && target.reference?.regionId === target.projection.entity.regionId
      ? [target.reference.regionId] : [])), [viewTargets])
  // A Workbench is a window-owned surface, not a route component. Keep only Workspaces the user has
  // a persisted surface for (plus the active one during its first layout frame) mounted: switching
  // back then changes visibility instead of destroying SessionPane/xterm/ctxmux attachments, while an
  // untouched configured workspace does not allocate a hidden launcher/editor/browser tree at startup.
  // Scratch is a real wiki-first workspace with Topic Tabs and Regions, so it follows the same
  // registry rule as a project instead of being filtered out after a Topic click.
  const mountedWorkspaces = config?.workspaces.filter((candidate) => (
    fileEditingProbe || candidate.id === activeWorkspaceId || resourceWorkspaces.has(candidate.id) || candidate.id === focusTab?.workspaceId || candidate.id === surveyCatalog?.zones.find(zone => zone.zoneId === surveySelection?.zoneId)?.workspaceId || layouts[candidate.id]?.groups.some((group) => group.tabOrder.length > 0)
  )) ?? []
  const toolsAvailable = mainSurface === 'workbench' && Boolean(workspace)
  const topicCategoryOverview = workbenchSpaceSelection?.workspaceId === SCRATCH_WORKSPACE_ID && workbenchSpaceSelection.zoneId === null &&
    topicCategories.some(category => category.spaceId === workbenchSpaceSelection.spaceId)
  // The Category directory lives in the main page; entering a Topic restores its secondary Chats directory.
  const toolsVisible = toolsAvailable && toolsOpen && !topicCategoryOverview
  const toolDockMinimumWidth = getToolDockMinimumWidth(projectRailOpen)
  const toolDockMaximumWidth = compactSidebars ? Math.max(toolDockMinimumWidth, Math.min(TOOL_DOCK_MAX_WIDTH, windowWidth - 320)) : TOOL_DOCK_MAX_WIDTH
  const renderedToolDockWidth = Math.min(toolDockMaximumWidth, getRenderedToolDockWidth(toolDockWidth, projectRailOpen))
  // MERGE：workbench + workspace 时顶行下沉进 pane（root tabbar / chromeline），
  // 主区不再占用独立 topbar 行；Board 与欢迎页仍走顶栏。
  const mergedTopRow = mainSurface === 'agents' || mainSurface === 'survey' || (mainSurface === 'workbench' && Boolean(workspace))
  const workbenchVisible = mainSurface === 'workbench' && !settingsRoute
  const terminalParkingMeasurement = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('agentmux-resource-probe')
  const { containerRef, isResizing, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: toolsVisible,
    width: toolDockWidth,
    minWidth: toolDockMinimumWidth,
    maxWidth: toolDockMaximumWidth,
    deltaSign: 1,
    setWidth: setToolDockWidth
  })

  // rendererUpdateReady is reported from inside beginRendererStartup below — it fires
  // announceReady before awaiting initialize(), so a mounted interface is announced ready even
  // while workspace recovery is still running (the intent 1b4fdabb landed). A separate useEffect
  // here that also called rendererUpdateReady doubled the report; `ready` was called twice with
  // the same token and the handshake test caught it. Route through beginRendererStartup only.

  useEffect(() => {
    let cancelled = false
    let dispose = () => {}
    const updateToken = new URLSearchParams(window.location.search).get('renderer-update')
    void beginRendererStartup(
      initialize,
      updateToken ? () => api.ui.rendererUpdateReady(updateToken) : undefined,
      (error) => useAppStore.getState().reportError(error)
    ).then((value) => {
      if (cancelled) value()
      else dispose = value
    })
    return () => {
      cancelled = true
      dispose()
    }
  }, [initialize])

  useEffect(() => api.ui.onWindowResize(({ active }) => setWindowResizeActive(active)), [])

  // Background Agents announce themselves: a completion, a request, or a failure the user is not looking
  // at raises a native notification that routes back to that Session.
  useAgentAttentionNotifications()

  // The window's global keyboard router. One capture-phase keydown listener owns every window-scope
  // binding — the quick switcher and the workbench actions — so there is exactly one place the focused
  // xterm textarea is beaten to the keystroke. The whole decision (match the chord against the registry,
  // gate on the editable-target fact, dispatch to the id's handler, report whether it was consumed) lives
  // in the pure routeWindowShortcut + windowShortcutHandlers, read against a fresh Store snapshot each
  // keypress; this shell has NO branches of its own — it derives the editable fact, calls the router, and
  // preventDefaults iff a binding consumed the key. (Cmd+W reaches us rather than closing the native
  // window because the main process installs a menu binding no Cmd+W — a renderer preventDefault cannot
  // cancel a native menu accelerator. See main/application-menu.ts.)
  useEffect(() => {
    const isMac = isMacPlatform()
    const onKeyDown = (event: KeyboardEvent): void => {
      // 在编辑控件或终端/TUI 里输入时，带 `not-in-editable` 门的绑定（Cmd+D 分屏、Cmd+W 关格）先放行；
      // 全局导航（quick switch）不带门，照常触发。终端焦点不再被工作台快捷键抢走——capture 仍只负责把
      // 未被作用域门挡住的全局动作路由到正确 owner。判定是纯函数，这里只把 DOM 事实（标签名、contentEditable、是否在 .xterm
      // 子树内）折成一个布尔喂进去。
      const target = event.target
      const editableTarget = target instanceof HTMLElement && isEditableChordTarget({
        tagName: target.tagName,
        isContentEditable: target.isContentEditable,
        insideTerminal: target.closest('.xterm') !== null
      })
      const handlers = windowShortcutHandlers(useAppStore.getState(), {
        toggleQuickSwitch: () => {
          if (!presentationRef.current.overlays.quickSwitcher) quickSwitchOrigin.current = {
            element: document.activeElement instanceof HTMLElement ? document.activeElement : null,
            navigation: fileNavigationSelection(useAppStore.getState())
          }
          setQuickSwitchOpen(current => !current)
        },
        openShortcuts: () => openSettings('keyboard-shortcuts')
      })
      if (routeWindowShortcut(event, isMac, editableTarget, handlers)) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  if (loading) {
    return <FullPageLoadingSurface scope="app" phase="loading" eyebrow="AgentMux startup" title="Restoring your workspace" detail={startupProgressDetail(startupProgress)} />
  }

  if (!config && error) {
    return <FullPageLoadingSurface scope="app" phase="failed" eyebrow="AgentMux startup" title="Runtime connection failed" detail={error} actions={<button className="small-button" onClick={() => window.location.reload()}>Retry startup</button>} />
  }

  return (
    <SettingsNavigation.Provider value={settingsNavigation}>
    <WindowSidebarLayoutContext.Provider value={windowSidebars}>
    <ExecutorIdentityContext.Provider value={executorIdentity}>
      <RendererResourceOwners workbenchVisible={workbenchVisible} projectedVisibleTabIds={projectedVisibleTabIds} projectedVisibleRegionIds={projectedVisibleRegionIds} measurementActive={terminalParkingMeasurement}>
      <div
        className={`app-shell ${globalSurfaceOwnsProjectRail || !projectRailOpen ? 'app-shell--project-rail-collapsed' : ''}`}
      >
      <div className="app-shell__workspace" aria-hidden={settingsRoute ? true : undefined} inert={Boolean(settingsRoute)}>
      {!globalSurfaceOwnsProjectRail && projectRailOpen ? (
        <ProjectRail visible={!settingsRoute} />
      ) : globalSurfaceOwnsProjectRail ? null : (
        null
      )}
      <main className={`main-shell ${mergedTopRow ? 'main-shell--merged' : ''}`}>
        {!mergedTopRow ? (
          <header className="topbar">
            <TopRowLeadingChrome />
          </header>
        ) : null}
        <div className="workbench-shell">
            {toolsVisible ? (
              <div
                ref={containerRef}
                className={`surface-tool-dock ${isResizing ? 'surface-tool-dock--resizing' : ''}`}
                data-surface-tool-dock
              >
                <SurfaceToolDock workspace={workspace} visible={workbenchVisible} />
                <div
                  className="surface-tool-width-handle"
                  role="separator"
                  aria-label="Resize surface tools"
                  aria-orientation="vertical"
                  aria-valuemin={toolDockMinimumWidth}
                  aria-valuemax={toolDockMaximumWidth}
                  aria-valuenow={renderedToolDockWidth}
                  tabIndex={0}
                  onMouseDown={onResizeStart}
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                    event.preventDefault()
                    setToolDockWidth(
                      Math.min(toolDockMaximumWidth, Math.max(toolDockMinimumWidth, renderedToolDockWidth + (event.key === 'ArrowRight' ? 16 : -16)))
                    )
                  }}
                />
              </div>
            ) : null}
            <section className="workspace-main-surface" data-desktop-surface={desktopSurface[mainSurface]}>
              {!workspace && mainSurface === 'workbench' ? (
                <section className="welcome">
                  <span className="brand-mark brand-mark--large"><BrandIcon size={34} /></span>
                  <div className="eyebrow">Terminal-first agent workbench</div>
                  <h1>Bring a workspace.<br />Keep the agents visible.</h1>
                  <p>Add a local folder from the sidebar, or configure an SSH host and remote path.</p>
                  <button className="primary-button" onClick={() => setSettingsRoute({ section: 'hosts' })}>Configure a host</button>
                </section>
              ) : null}
              {surveyVisited || mainSurface === 'survey' ? <GlobalSurveySurface onSelectReference={selectSurveyReference} visible={surveyVisible} controlsCoverPage={surveyToolsOpen && narrowControls} unconfirmedBrowserRegionIds={unconfirmedBrowserRegionIds} catalog={surveyCatalog} projection={surveyProjection} selection={surveyCurrentSelection} viewTargets={viewTargets}
                /> : null}
              {mainSurface === 'agents' ? <GlobalFocusSurface visible={focusVisible} regionOnly={focusRegionOnly} onToggleRegion={() => setFocusRegionOnly(value => !value)} presentation={focusPresentation} directoryIssue={spatialDirectory.issue} viewTargets={viewTargets} /> : null}
              {mainSurface === 'board' ? <GlobalBoardSurface /> : null}
              {config && mountedWorkspaces.length > 0 ? (
                <div
                  className={`workspace-workbench-registry ${workbenchVisible || focusTab ? '' : 'workspace-workbench-registry--parked'}`}
                  aria-hidden={!workbenchVisible && !focusTab}
                  inert={!workbenchVisible && !focusTab}
                  >
                  {mountedWorkspaces.map((candidate) => {
                    const visible = workbenchVisible && candidate.id === activeWorkspaceId
                    const focusSource = Boolean(focusVisible && focusTab && focusTab.workspaceId === candidate.id)
                    const mounted = visible || focusSource
                    return (
                      <div
                        key={candidate.id}
                        className={`workspace-workbench-slot ${mounted ? '' : 'workspace-workbench-slot--parked'} ${focusSource ? 'workspace-workbench-slot--focus-source' : ''}`}
                        data-workspace-id={candidate.id}
                        data-desktop-zone-id={workbenchSpaceSelection?.workspaceId === candidate.id ? workbenchSpaceSelection.zoneId : undefined}
                        data-visible={mounted ? 'true' : 'false'}
                        aria-hidden={!mounted}
                        inert={!mounted}
                      >
                        <MoteWorkface workspaceId={candidate.id} visible={visible}
                          topicId={workbenchSpaceSelection?.workspaceId === candidate.id ? workbenchSpaceSelection.topicId ?? undefined : undefined}>
                        <WorkspaceWorkbench
                          workspaceId={candidate.id}
                          {...(candidate.id === SCRATCH_WORKSPACE_ID && workbenchSpaceSelection?.workspaceId === candidate.id && workbenchSpaceSelection.topicId
                            ? { topicId: workbenchSpaceSelection.topicId, topicIsolation: 'bound-only' as const } : {})}
                          visible={visible}
                          viewTargets={viewTargets}
                          onBrowserControlConfirmation={onBrowserControlConfirmation}
                          interactiveResize={windowResizeActive || isResizing}
                        />
                        </MoteWorkface>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </section>
          </div>
        <div className="main-shell__notices">
          <TransientErrorNotice
            error={lifecycleError ? null : error}
            dismissed={errorDismissed}
            lastError={lifecycleError ? null : lastError}
            kind={errorNoticeKind}
            summary={errorSummary}
            onDismiss={dismissError}
            onReopen={reopenError}
          />
        </div>
      </main>
      </div>
      <PmoTeamsTopicFloatingPanel floating={moteFloating} setFloating={setMoteFloating} projectionState={moteProjection} />
      {settingsRoute ? (
        <SettingsPanel
          navigationRequest={settingsRoute}
          initialSection={settingsRoute.section}
          executorId={settingsRoute.executorId}
          toolId={settingsRoute.toolId}
          onClose={closeSettings}
        />
      ) : null}
      <footer className="window-status-bar">
        <div className="window-status-bar__surface-switch"><SurfaceSwitch settingsOpen={Boolean(settingsRoute)} onCloseSettings={closeSettings} /></div>
        <div className="window-status-bar__right">
          <GlobalSystemNotices nativeOverlayWarning={nativeOverlayWarning} />
          <WindowUtilityBar toolkit={<ToolkitStatusBar />} />
        </div>
      </footer>
      <QuickSwitcher open={quickSwitchOpen} onClose={() => setQuickSwitchOpen(false)} returnFocus={() => {
        const original = quickSwitchOrigin.current
        return original?.navigation === fileNavigationSelection(useAppStore.getState()) ? original.element : null
      }} />
      </div>
      <WindowOverlayHost />
      </RendererResourceOwners>
    </ExecutorIdentityContext.Provider>
    </WindowSidebarLayoutContext.Provider>
    </SettingsNavigation.Provider>
  )
}
