import { SpaceSourceReaders } from './components/SpaceSourceReaders'
import { AgentCollaborationMap } from './components/AgentCollaborationMapEntry'
import { workbenchDocuments, subscribeWorkbenchWindows, workbenchDocumentIdentity, isWorkbenchSurfaceDetached, useWorkbenchSurfaceDocument, workbenchSurfaceDocument } from './lib/workbench-window-registry'
import { useWorkbenchWindows, WorkbenchWindowNotices, focusWorkbenchWindow } from './lib/workbench-windows'
import { GitHistoryProvider } from './features/git/history/GitHistoryContext'
import { workspaceZoneContext } from './lib/workspace-zone-context'
import { observeNotebookLibrary } from './lib/notebook-library'
import { observeLastSeenBrowserFavicons } from './lib/browser-last-seen-favicons'
import { ExecutorIdentityContext } from './components/AgentAvatar'
import { SettingsNavigation, normalizeSettingsNavigationRequest, type SettingsNavigationRequest, type MoteConnectionSettingsOrigin, type ChannelSettingsOrigin } from './components/SettingsNavigation'
import { settingsCatalog, settingsModules } from './components/settings/settings-modules'
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { BrandIcon } from './components/BrandIcon'
import { useAgentAttentionNotifications } from './hooks/useAgentAttentionNotifications'
import { useSidebarResize } from './hooks/useSidebarResize'
import {
  TOOL_DOCK_MAX_WIDTH,
  TOOL_DOCK_DEFAULT_WIDTH,
  getRenderedToolDockWidth,
  getToolDockMinimumWidth
} from './lib/surface-tool-dock'
import { SettingsPanel, type SettingsPageId } from './components/SettingsPanel'
import { GlobalSystemNotices } from './components/GlobalSystemNotices'
import { ToolkitStatusBar } from './components/toolkit/ToolkitStatusBar'
import { WindowUtilityBar } from './components/WindowUtilityBar'
import { DocumentationNavigation, useDocumentationOwner } from './components/documentation/DocumentationNavigation'
import { DocumentationOverlay } from './components/documentation/DocumentationOverlay'
import { WindowOverlayHost } from './components/WindowOverlayHost'
import { AgentInformationPreviewHost } from './components/AgentInformationPreview'
import { QuickSwitcher } from './components/QuickSwitcher'
import { isEditableChordTarget, windowShortcutHandlers } from './lib/workbench-shortcuts'
import { surfaceOwnsChord } from './lib/surface-chord-owners'
import { routeWindowShortcut } from './lib/shortcut-registry'
import { SurfaceSwitch, TopRowLeadingChrome, WindowSidebarLayoutContext, useWindowSidebarLayout } from './components/TopRowChrome'
import { GlobalBoardSurface } from './components/GlobalBoardSurface'
import { GlobalFocusSurface } from './components/GlobalFocusSurface'
import { WorkbenchSurfaceHost } from './components/StableWorkbenchView'
import { SurfaceWindowButton } from './components/KnowledgeSurfaceWindow'
import { GlobalRecallSurface } from './components/GlobalRecallSurface'
import { GlobalSurveySurface } from './components/GlobalSurveySurface'
import { isSurveyPage, surveyPageOwner, surveyPageProjection, surveySelectionPresentation, type SurveySelection } from './lib/survey-page-references'
import { surveySelectionProfileMatch } from './lib/survey-profile-view'
import { browserProfiles } from './lib/browser-profiles'
import { resolveBrowserStartPage } from '../../shared/browser-start-page'
import { PmoTeamsTopicFloatingPanel } from './components/PmoTeamsTopicFloatingPanel'
import { MoteWorkface } from './components/MoteWorkface'
import { moteWorkbenchProjection } from './lib/mote-workbench-projection'
import { pmoTeamsTopicFloatingViewTargets, pmoTeamsTopicFloatingTargetTabId, pmoTeamsTopicFloatingTargetTopicId, readPmoTeamsTopicFloatingState, usePmoTeamsTopicFloatingState } from './lib/pmo-teams-topic-floating'
import { desktopSurface, DesktopFocusFailure } from './lib/desktop-focus-navigation'
import { focusTimelineCurrentReference } from './lib/focus-timeline-current'
import { installDesktopPresentationOwner, desktopPresentationCommitted, requestDesktopFocusWorkfaceReveal, type DesktopAppPresentationOwner } from './lib/desktop-presentation'
import { sameSpatialValue } from './lib/spatial-merge'
import { surfaceSwitchObservation } from './lib/surface-switch-observation'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { ProjectRail } from './components/ProjectRail'
import { SurfaceToolDock } from './components/SurfaceToolDock'
import { WorkspaceWorkbench as WorkspaceWorkbenchView } from './components/WorkspaceWorkbench'
import { WorkbenchCloseRequests } from './hooks/useWorkbenchTabsClose'
import { executionFocusSessionId } from './lib/agent-focus'
import { executionFocusPresentation, mainFocusPresentation } from './lib/focus-tab-projection'
import { api } from './lib/api'
import { fileNavigationSelection, useAppStore, currentCoreSpatialGraph } from './store'
import { originalSpaceWorkspace } from './lib/original-space-navigation'
import { observeRejectedFileExplorerDirectoryLoads } from './components/file-tree/file-explorer-report-probe'
import { isMacPlatform } from './lib/host-platform'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { useNativeOverlayChrome } from './hooks/useNativeOverlayChrome'
import { RendererResourceOwners } from './components/RendererResourceOwners'
import { FullPageLoadingSurface } from './components/FullPageLoadingSurface'
import { beginRendererStartup } from './lib/startup-progress'
import { StartupLoadingSurface } from './components/StartupLoadingSurface'
import { surveySelectReference, surveyResolvedZoneSelection, surveyInitialZoneSelection } from './lib/survey-workface'
import { spatialCatalog } from './lib/space-agent-control'
import { scratchTopicsForWorkspace } from './lib/scratch-topic-snapshots'
import { resolveWorkbenchZone, workbenchProjectionMatches, sameWorkbenchProjectionSelection, projectWorkbenchProjection, workbenchProjectionSlotId, workbenchRegionProjectionSlotId, type WorkbenchProjection, type WorkbenchProjectionSelection } from './lib/workbench-projection'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { WorkbenchViewTarget, WorkbenchViewTargets } from './lib/workbench-presentation'
import { ordinaryWorkbenchViewTargets, workbenchResourceTabs, workbenchDisplayReferenceMatches } from './lib/workbench-resource-display'
import { useWorkbenchObjectLayout } from './hooks/useWorkbenchObjectLayout'
import { workbenchNavigationTabs } from './lib/workbench-navigation-catalog'
import { mainRegionReference, workbenchZoneProjection } from './lib/desktop-focus-navigation'
import { layoutForLogicalRegionFocus } from './lib/region-focus'
import { sessionPresentationById } from './lib/session-presentation'
import { isSessionSurface } from './lib/workbench-surface-kinds'
import { SpaceContentPresentationContext, useSpaceContentPresentationOwner } from './lib/space-content-presentation'
import { MoteSpaceFrame } from './components/MoteSpaceFrame'

const WorkflowComponentGallery = lazy(() => import('./components/WorkflowComponentGallery').then(module => ({ default: module.WorkflowComponentGallery })))
const WorkspaceWorkbench = memo(WorkspaceWorkbenchView)

/** Retain equal presentation addresses; the original callbacks and projection stay authoritative. */
function useStableWorkbenchViewTargets(current: WorkbenchViewTargets): WorkbenchViewTargets {
  const previous = useRef<WorkbenchViewTargets>({})
  const next: Record<string, readonly WorkbenchViewTarget[]> = {}
  for (const [tabId, targets] of Object.entries(current)) {
    const held = previous.current[tabId]
    const equal = held?.length === targets.length && targets.every((target, index) => {
      const old = held[index]!
      const keys = Object.keys(target) as (keyof WorkbenchViewTarget)[]
      return keys.length === Object.keys(old).length && keys.every(key => Object.hasOwn(old, key) &&
        (key === 'reference' && target.reference && old.reference
          ? sameWorkbenchProjectionSelection(target.reference, old.reference) : Object.is(target[key], old[key])))
    })
    next[tabId] = equal ? held! : targets
  }
  if (Object.keys(previous.current).length === Object.keys(next).length &&
    Object.keys(next).every(tabId => previous.current[tabId] === next[tabId])) return previous.current
  previous.current = next
  return next
}

export function App() { return <SpaceSourceReaders><AppBody /></SpaceSourceReaders> }

function AppBody() {
  useEffect(() => observeNotebookLibrary(), [])
  useEffect(() => observeLastSeenBrowserFavicons(), [])
  const workflowComponentGallery = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('agentmux-component-gallery') === '1'
  if (workflowComponentGallery) return <Suspense fallback={<FullPageLoadingSurface scope="region" phase="loading" title="Loading gallery" detail="Preparing component previews" />}><WorkflowComponentGallery /></Suspense>
  return <DesktopApp />
}

const desktopSettingsSectionIds = ['overview', ...settingsModules.map(module => module.id)]

function DesktopApp() {
  const documentation = useDocumentationOwner()
  const [settingsRoute, setSettingsRoute] = useState<SettingsNavigationRequest | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInputPolicy, setSettingsInputPolicy] = useState<'preserve' | 'target'>('target')
  const settingsObservation = useRef<{ sectionId: string; visible: boolean; hostId?: string | null } | null>(null)
  const navigateSettings = useCallback((request: SettingsNavigationRequest, inputPolicy: 'preserve' | 'target' = 'target'): void => {
    setSettingsInputPolicy(inputPolicy)
    setSettingsRoute(normalizeSettingsNavigationRequest(request, useAppStore.getState().config?.hosts ?? []))
    setSettingsOpen(true)
  }, [])
  const openSettings = useCallback((section: SettingsPageId, executorId?: string, field?: string, hostId?: string): void => navigateSettings({ section, executorId, field, ...(hostId === undefined ? {} : { hostId }) }), [navigateSettings])
  const closeSettings = useCallback((): void => setSettingsOpen(false), [])
  const openToolkit = useCallback((toolId: string): void => navigateSettings({ section: 'toolkit', toolId }), [navigateSettings])
  const openHostExecutors = useCallback((hostId: string): void => navigateSettings({ section: 'agents', field: 'host-executors', hostId }), [navigateSettings])
  const openHostSettings = useCallback((hostId: string): void => navigateSettings({ section: 'hosts', hostId }), [navigateSettings])
  const openChannel = useCallback((channelOrigin: ChannelSettingsOrigin): void => {
    const { connection } = channelOrigin
    const presentation = settingsCatalog.channelPresentation(connection.application, connection.adapterId)
    navigateSettings({ section: presentation?.section ?? 'overview', channelOrigin })
  }, [navigateSettings])
  const openMoteConnection = useCallback((moteConnectionOrigin: MoteConnectionSettingsOrigin): void => {
    const connection = moteConnectionOrigin.connection
    const section = connection ? settingsCatalog.channelPresentation(connection.application, connection.adapterId)?.section : moteConnectionOrigin.section
    if (section) navigateSettings({ section, moteConnectionOrigin })
  }, [navigateSettings])
  const [windowResizeActive, setWindowResizeActive] = useState(false)
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false)
  const sessionLocationRequestId = useAppStore(state => state.sessionLocationRequest?.requestId)
  const quickSwitchVisible = quickSwitchOpen || Boolean(sessionLocationRequestId)
  // Local presentation/input intent only; never an Agent input-permission fact.
  const quickSwitchFocusEpoch = useRef(0)
  useLayoutEffect(() => { quickSwitchFocusEpoch.current++ }, [quickSwitchVisible, sessionLocationRequestId])
  const chooseAgent = useCallback(() => { setSettingsOpen(false); setQuickSwitchOpen(true) }, [])
  const settingsNavigation = useMemo(() => ({ open: openSettings, openToolkit, openHost: openHostSettings, openHostExecutors, openChannel, channelPresentation: settingsCatalog.channelPresentation, channelEntries: settingsCatalog.channelEntries, openMoteConnection, chooseAgent }), [openSettings, openToolkit, openHostSettings, openHostExecutors, openChannel, openMoteConnection, chooseAgent])
  const quickSwitchOrigin = useRef<{ element: HTMLElement | null; navigation: string } | null>(null)
  const initialize = useAppStore((state) => state.initialize)
  const loading = useAppStore((state) => state.loading)
  const startupProgress = useAppStore((state) => state.startupProgress)
  const runtimeEndpointWarnings = useAppStore((state) => state.loading ? state.runtimeEndpointWarnings : undefined)
  const error = useAppStore((state) => state.error)
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const layouts = useAppStore((state) => state.layouts)
  const tabs = useAppStore((state) => workbenchNavigationTabs(state.tabs))
  const resourceWorkspaces = useMemo(() => workbenchResourceTabs(tabs), [tabs])
  const workbenchSpaceSelection = useAppStore(state => state.workbenchSpaceSelection)
  const spaceContent = useSpaceContentPresentationOwner()
  const [moteFloating, setMoteFloating] = usePmoTeamsTopicFloatingState()
  const agentFocus = useAppStore((state) => state.agentFocus)
  const focusCanonicalSessionId = useAppStore(state => {
    const original = sessionPresentationById(state.sessions).get(state.agentFocus.execution.sessionId ?? '')
    return original?.control.kind === 'agent' ? original.control.agentSessionId : original?.id ?? state.agentFocus.execution.sessionId
  })

  const mainSurface = useAppStore((state) => state.mainSurface)
  const focusMode = useAppStore(state => state.focusView)
  const mapTarget = useAppStore(state => state.collaborationMapTarget)
  const mapVisible = mainSurface === 'agents' && focusMode === 'map' && !settingsOpen
  const [mapVisited, setMapVisited] = useState(focusMode === 'map')
  useEffect(() => { if (mapVisible) setMapVisited(true) }, [mapVisible])
  const presentationRef = useRef<DesktopAppPresentationOwner>({ loading: true,
    overlays: { settings: false, quickSwitcher: false },
    floating: null })
  useLayoutEffect(() => installDesktopPresentationOwner(() => presentationRef.current), [])
  useLayoutEffect(() => {
    const observe = () => surfaceSwitchObservation.observe()
    document.addEventListener('visibilitychange', observe)
    return () => { document.removeEventListener('visibilitychange', observe); surfaceSwitchObservation.ownerDeparted() }
  }, [])
  useLayoutEffect(() => {
    const floating = readPmoTeamsTopicFloatingState()
    presentationRef.current = { loading, contentExpanded: spaceContent.expanded,
      overlays: { settings: settingsOpen, quickSwitcher: quickSwitchVisible },
      settings: { sectionIds: desktopSettingsSectionIds,
        read: () => settingsObservation.current,
        open: (sectionId, hostId) => navigateSettings({ section: sectionId as SettingsPageId,
          ...(hostId === undefined ? {} : { hostId, ...(sectionId === 'hosts' ? { field: 'resources' } : {}) }) }, 'preserve'),
        close: () => { setSettingsInputPolicy('preserve'); closeSettings() } },
      survey: { select: selectSurveyTarget },
      focusWorkface: { reveal: (expected, intent) => {
        if (!sameSpatialValue(useAppStore.getState().workbenchSpaceSelection, expected)) return false
        setFocusWorkfaceView(value => {
          if (intent === 'surface-return') return value === 'unconfirmed' ? 'tab' : value
          return value === 'region' ? 'region' : 'tab'
        })
        return true
      } },
      floating: floating ? { state: floating.open ? 'pinned' : floating.preview ? 'preview' : 'closed',
        topicId: pmoTeamsTopicFloatingTargetTopicId(floating, tabs),
        tabId: pmoTeamsTopicFloatingTargetTabId(floating, tabs, layouts[SCRATCH_WORKSPACE_ID], agentFocus.pmo.sessionId) ?? null,
        regionId: floating.reference?.regionId ?? null } : null }
    desktopPresentationCommitted()
    surfaceSwitchObservation.committed(desktopSurface[mainSurface], !loading && !settingsOpen && !quickSwitchVisible)
  })
  const recallSelection = useAppStore(state => state.recallZoneSelection)
  const surveySelection = useAppStore((state) => state.surveyZoneSelection)
  const recallNotebookId = useAppStore(state => state.recallNotebookId)
  const recallNoteId = useAppStore(state => state.recallNoteId)
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
  const surveyDocument = useWorkbenchSurfaceDocument('survey')
  const surveyDetached = surveyDocument !== document
  const recallDocument = useWorkbenchSurfaceDocument('recall')
  const recallDetached = recallDocument !== document
  const surveyWindow = surveyDetached ? surveyDocument.defaultView : null
  const [childControlsCoverPage, setChildControlsCoverPage] = useState(false)
  useLayoutEffect(() => {
    if (!surveyWindow) return
    const media = surveyWindow.matchMedia('(max-width: 1100px)')
    const sync = () => setChildControlsCoverPage(media.matches)
    sync(); media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [surveyWindow])
  const narrowControls = surveyWindow ? childControlsCoverPage : windowWidth <= 1100
  useEffect(() => {
    const resized = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', resized)
    return () => window.removeEventListener('resize', resized)
  }, [])
  const recallVisible = recallDetached || mainSurface === 'recall' && !settingsOpen
  const surveyVisible = surveyDetached || mainSurface === 'survey' && !settingsOpen
  const previousWorkSurface = useRef<'agents' | 'workbench' | 'board'>('agents')
  const previousDetached = useRef({ survey: false, recall: false })
  useLayoutEffect(() => {
    const previous = previousDetached.current
    previousDetached.current = { survey: surveyDetached, recall: recallDetached }
    if (mainSurface !== 'survey' && mainSurface !== 'recall') previousWorkSurface.current = mainSurface
    else if (!previous[mainSurface] && previousDetached.current[mainSurface]) useAppStore.getState().setMainSurface(previousWorkSurface.current)
  }, [mainSurface, surveyDetached, recallDetached])
  const focusVisible = mainSurface === 'agents' && focusMode === 'list' && !settingsOpen
  const [focusVisited, setFocusVisited] = useState(false)
  useEffect(() => { if (mainSurface === 'agents') setFocusVisited(true) }, [mainSurface])
  const surveyBindings = useAppStore(state => state.spaceZoneBindings)
  const surveyTopicSnapshots = useAppStore(state => state.scratchTopicSnapshots)
  const surveySessionIds = useMemo(() => [...new Set(Object.values(tabs).flatMap(tab =>
    Object.values(tab.regions).flatMap(surface => isSessionSurface(surface) ? [surface.sessionId] : [])))], [tabs])
  // The spatial directory reads execution identity, never status/output clocks.
  const surveySessions = useAppStore(useShallow(state => {
    if ((!surveyVisible && !recallVisible && !focusVisible && !moteFloating.open && !moteFloating.preview) || surveySessionIds.length === 0) return []
    const byId = sessionPresentationById(state.sessions)
    return surveySessionIds.flatMap(id => {
      const session = byId.get(id)
      return [id, session?.control.kind === 'agent' ? session.control.agentSessionId : null, session?.control.run.runId ?? null, session?.hostId ?? null, session?.workspacePath ?? null]
    })
  }))
  const topicsWorkspace = config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  const surveyTopics = scratchTopicsForWorkspace(surveyTopicSnapshots, topicsWorkspace)
  const retainedSurveyCatalog = useRef<AgentMuxSpaceCatalog | null>(null)
  const spatialDirectory = useMemo(() => {
    if (!surveyVisible && !recallVisible && !focusVisible && !moteFloating.open && !moteFloating.preview) return { catalog: retainedSurveyCatalog.current, issue: null }
    try {
      const catalog = spatialCatalog(useAppStore.getState(), surveyTopics ?? [])
      retainedSurveyCatalog.current = catalog
      return { catalog, issue: null }
    } catch (error) {
      // Directory validation is a presentation failure, never a reason to stop a healthy Session.
      return { catalog: retainedSurveyCatalog.current, issue: `The work surface directory could not be confirmed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }, [surveyVisible, recallVisible, focusVisible, moteFloating.open, moteFloating.preview, config, tabs, layouts, surveyBindings, surveySessions, surveyTopics])
  const surveyCatalog = spatialDirectory.catalog
  const selectMoteReference = useCallback<WorkbenchProjection['onSelect']>(reference => {
    const state = useAppStore.getState(), current = readPmoTeamsTopicFloatingState(), tab = state.tabs[reference.tabId]
    // A retained callback cannot reopen or retarget a later sidecar View choice.
    // Async Region completion checks the original Tab's current local Region.
    if (current && (current.open !== moteFloating.open || current.targetTabId !== moteFloating.targetTabId ||
      current.targetTopicId !== moteFloating.targetTopicId || JSON.stringify(current.reference) !== JSON.stringify(moteFloating.reference))) return
    const topicId = pmoTeamsTopicFloatingTargetTopicId(current ?? moteFloating, state.tabs)
    const placed = workbenchDisplayReferenceMatches(state.layouts[reference.displayWorkspaceId], reference)
    let scope: WorkbenchProjection | null = null
    if (!placed) {
      const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)) ?? []
      scope = moteWorkbenchProjection(spatialCatalog(state, topics), state.tabs, current ?? moteFloating, () => {}, state.layouts).projection
    }
    const composition = scope?.composition ?? state.layouts[reference.displayWorkspaceId]
    const zoneId = scope?.entity.kind === 'zone' ? scope.entity.zoneId : undefined
    const member = zoneId && scope?.selectionMode === undefined &&
      composition?.groups.some(group => group.id === reference.groupId && group.tabOrder.includes(reference.tabId)) &&
      scope?.catalog.tabs.some(item => item.tabId === reference.tabId && item.zoneId === zoneId)
    if (!tab?.regions[reference.regionId] || !current?.agentTarget && tab.topicId !== topicId || !placed && !member) {
      state.reportError(new Error('This exact discussion location is no longer confirmed. Its original content is kept; choose its current location.'))
      return
    }
    if (placed) state.focusRegion(reference.displayWorkspaceId, reference.tabId, reference.regionId, 'floating-pointer', reference.groupId)
    setMoteFloating({ targetTabId: reference.tabId, reference: placed ? reference : undefined, ...(current?.agentTarget ? { agentTarget: current.agentTarget, targetAgent: current.targetAgent } : {}) })
  }, [setMoteFloating, moteFloating])
  const moteProjection = useMemo(() => {
    return moteWorkbenchProjection(surveyCatalog, tabs, moteFloating, selectMoteReference, layouts)
  }, [surveyCatalog, moteFloating.targetTabId, moteFloating.targetTopicId, moteFloating.reference, moteFloating.targetAgent, tabs, layouts, agentFocus.pmo.sessionId, selectMoteReference])
  const retainedMoteViews = useRef<{ owner: string; targets: WorkbenchViewTargets }>({ owner: '', targets: {} })
  const moteViewTargets = useMemo(() => {
    const owner = JSON.stringify([moteFloating.targetTopicId, moteFloating.agentTarget])
    const retain = (current: WorkbenchViewTargets | undefined): WorkbenchViewTargets => {
      const previous = retainedMoteViews.current.owner === owner ? retainedMoteViews.current.targets : {}
      const merged: Record<string, readonly WorkbenchViewTarget[]> = { ...current }
      for (const [tabId, occurrences] of Object.entries(previous)) {
        if (!tabs[tabId]) continue
        const next = merged[tabId] ?? []
        const parked = occurrences.filter(old => !next.some(target => target.hostId === old.hostId) &&
          (!old.reference || Boolean(tabs[tabId]?.regions[old.reference.regionId])))
          .map(target => ({ ...target, active: false, visible: false }))
        if (parked.length) merged[tabId] = [...next, ...parked]
      }
      retainedMoteViews.current = { owner, targets: merged }
      return merged
    }
    const targets = pmoTeamsTopicFloatingViewTargets(
      moteFloating, tabs, layouts[SCRATCH_WORKSPACE_ID], agentFocus.pmo.sessionId, moteProjection.projection)
    const held = moteFloating.reference, tab = held ? tabs[held.tabId] : undefined
    // A stale Region does not invalidate its still-confirmed exact parent. Only an
    // actual local selection supplies the new Region; an unknown parent stays unconfirmed.
    if (!moteProjection.projection && held && tab && targets?.[tab.id]?.length === 1 &&
      held.tabId === pmoTeamsTopicFloatingTargetTabId(moteFloating, tabs, layouts[SCRATCH_WORKSPACE_ID], agentFocus.pmo.sessionId) &&
      tab.topicId === pmoTeamsTopicFloatingTargetTopicId(moteFloating, tabs) &&
      workbenchDisplayReferenceMatches(layouts[held.displayWorkspaceId], held)) {
      return retain({ ...targets, [tab.id]: targets[tab.id]!.map(target => ({ ...target,
        onSelectRegion: (regionId: string) => selectMoteReference({ ...held, regionId }) })) })
    }
    return retain(targets)
  }, [moteFloating.open, moteFloating.preview, moteFloating.targetTopicId, moteFloating.targetTabId, moteFloating.reference, moteFloating.agentTarget, moteFloating.targetAgent, moteFloating.conversationIntent, moteFloating.conversationEntry,
    tabs, layouts, agentFocus.pmo.sessionId, moteProjection, selectMoteReference])
  const [focusWorkfaceView, setFocusWorkfaceView] = useState<'tab' | 'region' | 'closed' | 'unconfirmed'>('tab')
  const selectFocusReference = useCallback<WorkbenchProjection['onSelect']>(reference => {
    if (!useAppStore.getState().selectMainRegion(reference, workbenchSpaceSelection)) return false
    setFocusWorkfaceView(value => value === 'region' ? 'region' : 'tab')
    return true
  }, [workbenchSpaceSelection])
  const selectFocusContext = useCallback((id: string, reference?: WorkbenchProjectionSelection) => {
    setFocusWorkfaceView(useAppStore.getState().focusExecutionSession(id, reference) ? 'tab' : 'unconfirmed')
  }, [])
  const focusRegionOnly = focusWorkfaceView === 'region'
  // The exact main choice survives closing only its Focus presentation.
  const mainFocus = useMemo(() => mainFocusPresentation(workbenchSpaceSelection, tabs, surveyCatalog, selectFocusReference, focusRegionOnly ? 'region' : 'tab'),
  [workbenchSpaceSelection, tabs, surveyCatalog, selectFocusReference, focusRegionOnly])
  const focusPresentation = useMemo(() => focusWorkfaceView !== 'closed'
    ? focusWorkfaceView === 'unconfirmed'
      ? executionFocusPresentation(agentFocus.execution, tabs, surveyCatalog, reference => selectFocusContext(agentFocus.execution.sessionId!, reference), 'tab', focusCanonicalSessionId)
      : mainFocus
    : { projection: null, issue: null, references: [] },
  [focusWorkfaceView, mainFocus, agentFocus.execution, tabs, surveyCatalog, selectFocusContext, focusCanonicalSessionId])
  const timelineCurrentReference = useMemo(() => focusTimelineCurrentReference(workbenchSpaceSelection,
    workbenchSpaceSelection ? layouts[workbenchSpaceSelection.workspaceId] : undefined, tabs, surveyCatalog),
  [workbenchSpaceSelection, layouts, tabs, surveyCatalog])
  const focusProjection = mainSurface === 'agents' && focusMode === 'list' ? focusPresentation.projection : null
  const focusTab = focusProjection?.selection.length === 1 ? tabs[focusProjection.selection[0]!.tabId] : null
  const surveyOccurrence = useRef<WorkbenchProjectionSelection | null>(null)
  function selectSurveyTarget(target: Extract<import('@agentmux/core/control').AgentMuxDesktopFocusTarget, { kind: 'survey' }>) {
    const state = useAppStore.getState(), chosen = target.selection, reference = target.reference
    const fail = (message: string): never => { throw new DesktopFocusFailure({ step: 'target', code: 'SURVEY_TARGET_UNCONFIRMED', message,
      recovery: 'Keep the original page and input. Read space survey-list and space ls --presentation, then choose that exact saved reference.' }) }
    const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)) ?? []
    const catalog = spatialCatalog(state, topics)
    let selected: SurveySelection
    if (chosen.kind === 'page') {
      if (!state.surveyPageReferences.some(page => page.regionId === chosen.regionId && page.browserId === chosen.browserId)) fail('This exact Browser/Region is not a saved Survey page. Navigation does not collect it.')
      selected = { kind: 'page', regionId: chosen.regionId, browserId: chosen.browserId }
      if (reference) {
        const scope = surveyPageProjection(selected, catalog, state.tabs, () => {}, reference)
        if (reference.regionId !== chosen.regionId || !scope?.selection.some(member => sameWorkbenchProjectionSelection(member, reference))) fail('The exact saved page is not at this requested occurrence. Its current page and selection are kept.')
      }
    } else {
      if (!state.surveyCollectedZones[chosen.zoneId]) fail('This original research is not saved in Survey. Navigation does not collect it.')
      selected = state.surveyZoneSelection && !isSurveyPage(state.surveyZoneSelection) && state.surveyZoneSelection.zoneId === chosen.zoneId
        ? state.surveyZoneSelection : surveyInitialZoneSelection(catalog, chosen.zoneId, state.layouts, state.tabs, state.activeWorkspaceId)
      if (reference) {
        const scope = resolveWorkbenchZone(chosen.zoneId, catalog, state.layouts, state.tabs, 'survey-workbench', [reference], () => {})
        if (!scope?.catalog.locations.some(member => workbenchProjectionMatches(scope, member) && sameWorkbenchProjectionSelection(member, reference))) fail('This occurrence is not a member of the requested original research.')
        selected = surveySelectReference(selected, reference)
      }
    }
    const normalProfile = (surface: (typeof state.tabs)[string]['regions'][string] | undefined) =>
      surface?.kind === 'browser' && surface.mode === 'normal' && !surface.capsuleId ? surface.profileId : undefined
    let profileId: string | null | undefined
    if (isSurveyPage(selected)) profileId = normalProfile(surveyPageOwner(state.tabs, selected, catalog)?.surface)
    else {
      const members = catalog.tabs.filter(tab => tab.zoneId === selected.zoneId)
      const active = selected.active && members.some(tab => tab.tabId === selected.active!.tabId)
        ? state.tabs[selected.active.tabId]?.regions[selected.active.regionId] : undefined
      const browsers = members.flatMap(tab => Object.values(state.tabs[tab.tabId]?.regions ?? {}))
        .filter(surface => surface.kind === 'browser' && surface.mode === 'normal' && !surface.capsuleId)
      const profiles = new Set(browsers.map(normalProfile))
      profileId = normalProfile(active) ?? (members.every(tab => state.tabs[tab.tabId]) && profiles.size === 1 && !profiles.has(undefined)
        ? profiles.values().next().value : undefined)
    }
    const defaultProfileId = browserProfiles.get().profiles?.find(profile => profile.isDefault)?.id
    if (profileId && surveySelectionProfileMatch(state.surveyProfileView, selected, state.tabs, defaultProfileId, catalog) === 'other') {
      // Navigation selects an actual environment view; it never rebinds or reloads a member.
      void state.setSurveyProfileView({ kind: 'profile', profileId })
    }
    surveyOccurrence.current = reference ?? null
    state.setSurveyZoneSelection(selected)
    state.setMainSurface('survey')
  }
  const selectSurveyReference = useCallback<WorkbenchProjection['onSelect']>(reference => {
    const state = useAppStore.getState()
    if (!state.surveyZoneSelection || JSON.stringify(state.surveyZoneSelection) !== JSON.stringify(surveySelection)) return
    const currentTopics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)) ?? []
    const currentCatalog = spatialCatalog(state, currentTopics)
    if (isSurveyPage(state.surveyZoneSelection)) {
      const scope = surveyPageProjection(state.surveyZoneSelection, currentCatalog, state.tabs, () => {}, reference)
      if (!scope || !(scope.entity.kind === 'tab'
        ? scope.catalog.locations.some(member => sameWorkbenchProjectionSelection(member, reference))
        : scope.selection.some(member => sameWorkbenchProjectionSelection(member, reference)))) return
      surveyOccurrence.current = reference
      if (state.surveyZoneSelection.presentation) {
        state.setSurveyZoneSelection({ kind: 'page', regionId: state.surveyZoneSelection.regionId, browserId: state.surveyZoneSelection.browserId,
          presentation: { kind: 'tab', ...reference } })
        const surface = state.tabs[reference.tabId]?.regions[reference.regionId]
        if (surface && isSessionSurface(surface)) state.focusExecutionSession(surface.sessionId, reference, { navigate: false })
      }
      return
    }
    const tab = state.tabs[reference.tabId]
    const scope = resolveWorkbenchZone(state.surveyZoneSelection.zoneId, currentCatalog, state.layouts, state.tabs, 'survey-workbench', [], () => {})
    const layout = scope?.composition ?? state.layouts[reference.displayWorkspaceId]
    if (!tab?.regions[reference.regionId] || !layout?.groups.some(group => group.id === reference.groupId && group.tabOrder.includes(tab.id)) ||
      !currentCatalog.tabs.some(member => member.tabId === tab.id && member.zoneId === state.surveyZoneSelection!.zoneId)) return
    const surface = tab.regions[reference.regionId]
    if (surface && isSessionSurface(surface)) state.focusExecutionSession(surface.sessionId, reference, { navigate: false })
    surveyOccurrence.current = reference
    state.setSurveyZoneSelection(surveySelectReference(state.surveyZoneSelection, reference))
  }, [surveySelection])
  const restoreWindowContext = useCallback((context: import('../../shared/workbench-windows').WorkbenchReturnContext) => {
    const state = useAppStore.getState(), reference = context.reference
    if (context.surface === 'survey') {
      const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)) ?? []
      const catalog = spatialCatalog(state, topics), selected = context.selection
      const scope = 'zoneId' in selected
        ? resolveWorkbenchZone(selected.zoneId, catalog, state.layouts, state.tabs, 'survey-workbench', [reference], () => {})
        : surveyPageProjection(selected, catalog, state.tabs, () => {}, reference)
      if (!scope?.catalog.locations.some(member => workbenchProjectionMatches(scope, member) && sameWorkbenchProjectionSelection(member, reference))) {
        // Only this explicit return target is stale; retain the original shell and content.
        throw new Error('The original Survey return location is unconfirmed. The window and Browser are kept; choose its exact location before returning.')
      }
      surveyOccurrence.current = reference
      state.setSurveyZoneSelection(selected)
      if (!isWorkbenchSurfaceDetached('survey')) state.setMainSurface('survey')
      return
    }
    if (!state.selectMainRegion(reference)) throw new Error('The original return Region is no longer confirmed. Its window and content are kept.')
    if (context.surface === 'focus') {
      setFocusWorkfaceView(context.view)
      state.setFocusView('list')
      state.setMainSurface('agents')
    } else state.setMainSurface('workbench')
  }, [])
  const focusWindowNavigationStamp = useMemo(() => ({}), [focusWorkfaceView])
  const workbenchWindows = useWorkbenchWindows(!loading, restoreWindowContext, focusWindowNavigationStamp, surface => {
    closeSettings()
    useAppStore.getState().setMainSurface(surface)
  })
  const surveyProjection = useMemo(() => {
    if (!surveySelection || !surveyCatalog) return null
    if (isSurveyPage(surveySelection)) {
      return surveyPageProjection(surveySelection, surveyCatalog, tabs, selectSurveyReference, surveyOccurrence.current)
    }
    const projection = resolveWorkbenchZone(surveySelection.zoneId, surveyCatalog, layouts, tabs, 'survey-workbench',
      surveySelection.active ? [...surveySelection.selection, surveySelection.active] : surveySelection.selection, selectSurveyReference)
    return projection
  }, [surveySelection, surveyCatalog, layouts, tabs, selectSurveyReference])
  const surveyCurrentSelection = useMemo(() => surveySelection && !isSurveyPage(surveySelection) ? surveyResolvedZoneSelection(surveySelection, surveyProjection, surveyOccurrence.current) : null,
    [surveySelection, surveyProjection])
  const recallOccurrence = useRef<WorkbenchProjectionSelection | null>(null)
  const selectRecallReference = useCallback<WorkbenchProjection['onSelect']>(reference => {
    const state = useAppStore.getState()
    if (!state.recallZoneSelection || JSON.stringify(state.recallZoneSelection) !== JSON.stringify(recallSelection)) return
    const currentTopics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, state.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)) ?? []
    const currentCatalog = spatialCatalog(state, currentTopics)
    const tab = state.tabs[reference.tabId]
    const scope = resolveWorkbenchZone(state.recallZoneSelection.zoneId, currentCatalog, state.layouts, state.tabs, 'recall-workbench', [], () => {})
    const layout = scope?.composition ?? state.layouts[reference.displayWorkspaceId]
    if (!tab?.regions[reference.regionId] || !layout?.groups.some(group => group.id === reference.groupId && group.tabOrder.includes(tab.id)) ||
      !currentCatalog.tabs.some(member => member.tabId === tab.id && member.zoneId === state.recallZoneSelection!.zoneId)) return
    const surface = tab.regions[reference.regionId]
    if (surface && isSessionSurface(surface)) state.focusExecutionSession(surface.sessionId, reference, { navigate: false })
    recallOccurrence.current = reference
    state.setRecallZoneSelection(surveySelectReference(state.recallZoneSelection, reference))
  }, [recallSelection])
  const recallProjection = useMemo(() => {
    if (!recallSelection || !surveyCatalog) return null
    const projection = resolveWorkbenchZone(recallSelection.zoneId, surveyCatalog, layouts, tabs, 'recall-workbench',
      recallSelection.active ? [...recallSelection.selection, recallSelection.active] : recallSelection.selection, selectRecallReference)
    const active = recallSelection.active
    const surface = active ? tabs[active.tabId]?.regions[active.regionId] : undefined
    if (!projection || !recallNotebookId || !recallNoteId || !active || surface?.kind !== 'file') return projection
    const references = projection.selection.filter(reference => reference.tabId === active.tabId && reference.regionId === active.regionId)
    const reference = references.find(value => recallOccurrence.current && sameWorkbenchProjectionSelection(value, recallOccurrence.current))
      // The original File owner may change a legacy path-based Tab ID. The same immutable Region
      // in this exact display/Group remains the original occurrence; never choose another Group.
      ?? references.find(value => recallOccurrence.current && value.regionId === recallOccurrence.current.regionId &&
        value.displayWorkspaceId === recallOccurrence.current.displayWorkspaceId && value.groupId === recallOccurrence.current.groupId)
      ?? (references.length === 1 ? references[0] : undefined)
    return reference ? { ...projection, entity: { kind: 'region' as const, regionId: reference.regionId }, selection: [reference] } : projection
  }, [recallSelection, surveyCatalog, layouts, tabs, selectRecallReference, recallNotebookId, recallNoteId])
  const recallCurrentSelection = useMemo(() => recallSelection ? surveyResolvedZoneSelection(recallSelection, recallProjection, recallOccurrence.current) : null,
    [recallSelection, recallProjection])
  const retainedSpatialFocus = useAppStore(state => state.retainedSpatialFocus)
  const currentOrdinaryLayout = activeWorkspaceId ? layouts[activeWorkspaceId] : undefined
  const retainedOrdinaryLayout = useRef<{ workspaceId: string; layout: NonNullable<typeof currentOrdinaryLayout> } | null>(null)
  if (currentOrdinaryLayout && activeWorkspaceId) retainedOrdinaryLayout.current = { workspaceId: activeWorkspaceId, layout: currentOrdinaryLayout }
  const ordinaryLayout = currentOrdinaryLayout ?? (retainedOrdinaryLayout.current?.workspaceId === activeWorkspaceId ? retainedOrdinaryLayout.current.layout : undefined)
  const ordinaryObject = useWorkbenchObjectLayout(activeWorkspaceId ?? '', ordinaryLayout)
  const ordinaryScope = JSON.stringify([activeWorkspaceId, workbenchSpaceSelection?.spaceId, workbenchSpaceSelection?.zoneId])
  const [ordinaryMembers, setOrdinaryMembers] = useState<{ scope: string; selection: Pick<WorkbenchProjectionSelection, 'tabId' | 'regionId'>[] }>({ scope: '', selection: [] })
  const currentOrdinaryMembers = useRef(ordinaryMembers)
  useLayoutEffect(() => { currentOrdinaryMembers.current = ordinaryMembers }, [ordinaryMembers])
  const selectOrdinaryMember = useCallback<WorkbenchProjection['onSelect']>(reference => {
    const state = useAppStore.getState(), choice = state.workbenchSpaceSelection
    if (state.mainSurface !== 'workbench' || choice !== workbenchSpaceSelection || currentOrdinaryMembers.current !== ordinaryMembers ||
      JSON.stringify([state.activeWorkspaceId, choice?.spaceId, choice?.zoneId]) !== ordinaryScope) return
    const projection = workbenchZoneProjection(state, choice, [], () => {})
    const tab = state.tabs[reference.tabId]
    const zoneId = projection?.entity.kind === 'zone' ? projection.entity.zoneId : undefined
    if (!zoneId || reference.displayWorkspaceId !== projection?.displayWorkspaceId || !tab?.regions[reference.regionId] ||
      !projection.catalog.tabs.some(member => member.tabId === reference.tabId && member.zoneId === zoneId) ||
      !projection.composition?.groups.some(group => group.id === reference.groupId && group.tabOrder.includes(reference.tabId))) return
    if (workbenchDisplayReferenceMatches(state.layouts[reference.displayWorkspaceId], reference)) {
      if (!state.selectMainRegion(reference, choice)) return
    } else if (choice?.tabId) {
      useAppStore.setState({ workbenchSpaceSelection: { ...choice, tabId: null, groupId: null, regionId: null }, retainedSpatialFocus: null })
    }
    setOrdinaryMembers(previous => previous.scope === ordinaryScope && previous.selection.length === 1 &&
      previous.selection[0]?.tabId === reference.tabId && previous.selection[0]?.regionId === reference.regionId ? previous
      : { scope: ordinaryScope, selection: [{ tabId: reference.tabId, regionId: reference.regionId }] })
  }, [ordinaryScope, workbenchSpaceSelection, ordinaryMembers])
  const ordinaryProjection = useMemo(() => activeWorkspaceId && workbenchSpaceSelection?.workspaceId === activeWorkspaceId
    ? workbenchZoneProjection(useAppStore.getState(), workbenchSpaceSelection,
      ordinaryMembers.scope === ordinaryScope ? ordinaryMembers.selection : [], selectOrdinaryMember) : null,
  [activeWorkspaceId, workbenchSpaceSelection, ordinaryScope, ordinaryMembers, selectOrdinaryMember, ordinaryObject.choice, config, tabs, layouts, surveyBindings, surveyTopics])
  const ordinaryTargets = useStableWorkbenchViewTargets(useMemo(() => {
    if (ordinaryProjection) {
      const projected = projectWorkbenchProjection(ordinaryLayout, tabs, ordinaryProjection, null, 'owner')
      const selected = mainRegionReference(workbenchSpaceSelection)
      const targets = ordinaryWorkbenchViewTargets(projected.layout ?? undefined, tabs, ordinaryProjection.displayWorkspaceId, undefined, selected)
      return Object.fromEntries(Object.entries(targets).map(([id, occurrences]) => [id, occurrences.map(target => {
        const reference = projected.selection.find(reference => reference.groupId === target.reference?.groupId && reference.tabId === id) ?? target.reference!
        return { ...target, reference, visible: target.visible !== false && mainSurface === 'workbench' && !settingsOpen && !spaceContent.expanded, projection: ordinaryProjection,
          retainedRegionId: reference.regionId, onSelectRegion: (regionId: string) => selectOrdinaryMember({ ...reference, regionId }) }
      })]))
    }
    const layout = ordinaryObject.layout
    if (!layout || !activeWorkspaceId) return {}
    const reference = mainRegionReference(workbenchSpaceSelection)
    const held = reference?.displayWorkspaceId === activeWorkspaceId ? reference : retainedSpatialFocus?.displayWorkspaceId === activeWorkspaceId ? retainedSpatialFocus : null
    const displayed = layoutForLogicalRegionFocus(layout, tabs, held)
    const targets = ordinaryWorkbenchViewTargets(displayed, tabs, activeWorkspaceId, undefined, held)
    return Object.fromEntries(Object.entries(targets).map(([id, occurrences]) => [id, occurrences.map(target => ({ ...target, visible: target.visible !== false && mainSurface === 'workbench' && !settingsOpen && !spaceContent.expanded }))]))
  }, [activeWorkspaceId, ordinaryObject.layout, tabs, mainSurface, settingsOpen, retainedSpatialFocus, workbenchSpaceSelection, ordinaryProjection, ordinaryLayout, selectOrdinaryMember, spaceContent.expanded]))
  const viewTargets = useMemo<WorkbenchViewTargets>(() => {
    const targets: Record<string, readonly WorkbenchViewTarget[]> = { ...ordinaryTargets }
    const append = (tabId: string, target: WorkbenchViewTarget) => { targets[tabId] = [...targets[tabId] ?? [], target] }
    for (const [tabId, occurrences] of Object.entries(moteViewTargets ?? {})) {
      targets[tabId] = targets[tabId] ? [...targets[tabId]!, ...occurrences] : occurrences
    }
    if (surveyVisible && surveyProjection) {
      const projection = surveyProjection
      const projected = projectWorkbenchProjection(layouts[projection.displayWorkspaceId], tabs, projection)
      for (const reference of projected.selection) {
        if (projected.unsupportedTabIds.has(reference.tabId)) continue
        append(reference.tabId, { hostId: (projection.entity.kind === 'region' ? workbenchRegionProjectionSlotId : workbenchProjectionSlotId)(`${projection.presentationId}-slot`, reference),
          active: !(surveyToolsOpen && narrowControls) && (surveyCurrentSelection?.active?.tabId !== reference.tabId ||
            sameWorkbenchProjectionSelection(surveyCurrentSelection.active, reference)), visible: !(surveyToolsOpen && narrowControls), surface: 'survey', returnSelection: surveySelectionPresentation(surveySelection) ?? undefined, browserStartPage: resolveBrowserStartPage(config?.browser.startPage), controlsOpen: surveyToolsOpen,
          projection, reference, retainedRegionId: reference.regionId, onSelectRegion: regionId => selectSurveyReference({ ...reference, regionId }) })
      }
    }
    if (recallVisible && recallProjection) {
      const projection = recallProjection
      const projected = projectWorkbenchProjection(layouts[projection.displayWorkspaceId], tabs, projection)
      for (const reference of projected.selection) {
        if (projected.unsupportedTabIds.has(reference.tabId)) continue
        append(reference.tabId, { hostId: (projection.entity.kind === 'region' ? workbenchRegionProjectionSlotId : workbenchProjectionSlotId)(`${projection.presentationId}-slot`, reference),
          active: true && (recallCurrentSelection?.active?.tabId !== reference.tabId ||
            sameWorkbenchProjectionSelection(recallCurrentSelection.active, reference)), visible: true, surface: 'recall', controlsOpen: false,
          projection, reference, retainedRegionId: reference.regionId, onSelectRegion: regionId => selectRecallReference({ ...reference, regionId }) })
      }
    }
    if (focusProjection && focusTab) {
      const reference = focusProjection.selection[0]!
      append(focusTab.id, {
        hostId: focusProjection.entity.kind === 'region' ? workbenchRegionProjectionSlotId(`${focusProjection.presentationId}-slot`, reference) : workbenchProjectionSlotId(`${focusProjection.presentationId}-slot`, reference),
        active: focusVisible, visible: focusVisible, surface: 'focus', retainedRegionId: reference.regionId,
        projection: focusProjection, reference,
        onSelectRegion: regionId => selectFocusReference({ ...reference, regionId })
      })
    }
    return targets
  }, [config?.browser.startPage, moteViewTargets, surveyVisible, surveyProjection, surveySelection, surveyCurrentSelection, layouts, tabs, surveyToolsOpen, narrowControls, selectSurveyReference,
    focusVisible, focusProjection, focusTab, selectFocusReference, ordinaryTargets, recallVisible, recallProjection, recallCurrentSelection, selectRecallReference])
  const [recallVisited, setRecallVisited] = useState(mainSurface === 'recall')
  useEffect(() => { if (recallVisible) setRecallVisited(true) }, [recallVisible])
  const [surveyVisited, setSurveyVisited] = useState(mainSurface === 'survey')
  useEffect(() => { if (surveyVisible) setSurveyVisited(true) }, [surveyVisible])
  const compactSidebars = windowWidth <= 760 && mainSurface === 'workbench' && Boolean(config?.workspaces.some(item => item.id === activeWorkspaceId))
  const windowSidebars = useWindowSidebarLayout(compactSidebars)
  const { projectRailOpen, toolsOpen } = windowSidebars
  const contentSidebars = { ...windowSidebars, toolsOpen: toolsOpen || spaceContent.expanded,
    toggleTools: () => {
      if (spaceContent.expanded) { spaceContent.collapse(); if (toolsOpen) windowSidebars.toggleTools() }
      else windowSidebars.toggleTools()
    } }
  const globalSurfaceOwnsProjectRail = mainSurface === 'board' || mainSurface === 'agents' || mainSurface === 'survey' || mainSurface === 'recall'
  const toolDockWidth = useAppStore((state) => state.toolDockWidth)
  const setToolDockWidth = useAppStore((state) => state.setToolDockWidth)
  const executorIdentity = useMemo(() => ({ config }), [config])
  const nativeOverlayWarning = useNativeOverlayChrome()
  const sourceInputs = useAppStore(state => state.mountedSpaceInputs)
  const workspace = useMemo(() => originalSpaceWorkspace(useAppStore.getState(), activeWorkspaceId, currentCoreSpatialGraph()),
    [config, activeWorkspaceId, workbenchSpaceSelection, sourceInputs, surveyBindings])
  const gitWorkspace = useAppStore(state => workspace ? workspaceZoneContext(state, workspace).resource : null)
  const initialTheme = api.ui.initialTheme
  useLayoutEffect(() => {
    const saved = useAppStore.getState().config?.appearance
    const observed = initialTheme?.status === 'available'
      ? { kind: 'observed' as const, document: initialTheme.document, appearance: initialTheme.appearance }
      : undefined
    return mountThemeRuntime(window, saved ?? observed ?? {})
  }, [])
  useLayoutEffect(() => {
    if (config) updateThemeSelection(config.appearance)
  }, [config?.appearance.appAppearance, config?.appearance.themeId, config?.appearance.customThemes])
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
  const mountedWorkspaceIds = useMemo(() => {
    if (!config) return []
    const ids = new Set<string>()
    for (const candidate of config.workspaces) {
      if (fileEditingProbe || candidate.id === activeWorkspaceId) ids.add(candidate.id)
    }
    if (workspace) ids.add(workspace.id)
    for (const id of resourceWorkspaces.keys()) ids.add(id)
    for (const [id, layout] of Object.entries(layouts)) {
      if (layout.groups.some(group => group.tabOrder.length > 0)) ids.add(id)
    }
    if (focusTab) ids.add(focusTab.workspaceId)
    const surveyWorkspaceId = surveyCatalog?.zones.find(zone => zone.zoneId === surveySelection?.zoneId)?.workspaceId
    if (surveyWorkspaceId) ids.add(surveyWorkspaceId)
    return [...ids]
  }, [config, activeWorkspaceId, workspace, resourceWorkspaces, layouts, focusTab, surveyCatalog, surveySelection, fileEditingProbe])
  const toolsAvailable = mainSurface === 'workbench' && Boolean(workspace)
  const toolsVisible = toolsAvailable && (toolsOpen || spaceContent.expanded)
  const toolDockMinimumWidth = getToolDockMinimumWidth(projectRailOpen)
  const toolDockMaximumWidth = compactSidebars ? Math.max(toolDockMinimumWidth, Math.min(TOOL_DOCK_MAX_WIDTH, windowWidth - 320)) : TOOL_DOCK_MAX_WIDTH
  const renderedToolDockWidth = Math.min(toolDockMaximumWidth, getRenderedToolDockWidth(toolDockWidth, projectRailOpen))
  // MERGE：workbench + workspace 时顶行下沉进 pane（root tabbar / chromeline），
  // 主区不再占用独立 topbar 行；Board 与欢迎页仍走顶栏。
  const mergedTopRow = mainSurface === 'agents' || mainSurface === 'survey' || mainSurface === 'recall' || (mainSurface === 'workbench' && Boolean(workspace))
  const workbenchVisible = mainSurface === 'workbench' && !settingsOpen
  const workfaceVisible = workbenchVisible && !spaceContent.expanded
  const terminalParkingMeasurement = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('agentmux-resource-probe')
  const { containerRef, isResizing, onResizeStart, onResizeReset } = useSidebarResize<HTMLDivElement>({
    isOpen: toolsAvailable && toolsOpen,
    resizable: toolsVisible && workbenchVisible && !spaceContent.expanded,
    width: toolDockWidth,
    defaultWidth: TOOL_DOCK_DEFAULT_WIDTH,
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
    const onInputIntent = (): void => { quickSwitchFocusEpoch.current++ }
    const onKeyDown = (event: KeyboardEvent): void => {
      onInputIntent()
      // 在编辑控件或终端/TUI 里输入时，带 `not-in-editable` 门的绑定（Cmd+D 分屏、Cmd+W 关格）先放行；
      // 全局导航（quick switch）不带门，照常触发。终端焦点不再被工作台快捷键抢走——capture 仍只负责把
      // 未被作用域门挡住的全局动作路由到正确 owner。判定是纯函数，这里只把 DOM 事实（标签名、contentEditable、是否在 .xterm
      // 子树内）折成一个布尔喂进去。
      const target = event.target
      const sourceDocument = event.currentTarget as Document
      const element = target && (target as Node).nodeType === 1 ? target as HTMLElement : null
      const editableTarget = element !== null && isEditableChordTarget({
        tagName: element.tagName,
        isContentEditable: element.isContentEditable,
        insideTerminal: element.closest('.xterm') !== null,
        surfaceOwnsChord: surfaceOwnsChord(element, event)
      })
      const handlers = windowShortcutHandlers(useAppStore.getState(), {
        ...(sourceDocument === document ? {} : { originWindow: workbenchDocumentIdentity(sourceDocument),
          workbenchCommands: sourceDocument !== workbenchSurfaceDocument('survey') && sourceDocument !== workbenchSurfaceDocument('recall') }),
        onWorkfaceNavigation: reference => {
          const choice = useAppStore.getState().workbenchSpaceSelection
          if (choice && sameWorkbenchProjectionSelection(mainRegionReference(choice), reference)) requestDesktopFocusWorkfaceReveal(choice)
        },
        toggleQuickSwitch: () => {
          const request = useAppStore.getState().sessionLocationRequest
          if (request) { useAppStore.getState().dismissSessionLocationRequest(request.requestId); setQuickSwitchOpen(false); return }
          const epoch = quickSwitchFocusEpoch.current
          const sourceInput = sourceDocument.activeElement
          const navigation = fileNavigationSelection(useAppStore.getState())
          if (!presentationRef.current.overlays.quickSwitcher) quickSwitchOrigin.current = {
            element: sourceDocument.activeElement?.nodeType === 1 ? sourceDocument.activeElement as HTMLElement : null, navigation
          }
          const show = () => {
            if (epoch === quickSwitchFocusEpoch.current && sourceDocument.activeElement === sourceInput &&
                !useAppStore.getState().sessionLocationRequest && navigation === fileNavigationSelection(useAppStore.getState())) setQuickSwitchOpen(current => !current)
          }
          if (sourceDocument === document) show()
          else {
            const main = workbenchDocumentIdentity(document), source = workbenchDocumentIdentity(sourceDocument)
            if (main && source) void focusWorkbenchWindow(main).then(confirmed => {
              if (confirmed && workbenchDocumentIdentity(document) === main && workbenchDocumentIdentity(sourceDocument) === source) show()
            })
          }
        },
        openShortcuts: () => {
          if (sourceDocument === document) openSettings('keyboard-shortcuts')
          else {
            const main = workbenchDocumentIdentity(document), navigation = fileNavigationSelection(useAppStore.getState())
            if (main) void focusWorkbenchWindow(main).then(confirmed => { if (confirmed && navigation === fileNavigationSelection(useAppStore.getState())) openSettings('keyboard-shortcuts') })
          }
        }
      })
      if (routeWindowShortcut(event, isMac, editableTarget, handlers)) event.preventDefault()
    }
    const attached = new Set<Document>()
    const sync = () => {
      const current = new Set([document, ...workbenchDocuments()])
      for (const doc of attached) if (!current.has(doc)) {
        doc.removeEventListener('keydown', onKeyDown, true)
        doc.removeEventListener('pointerdown', onInputIntent, true)
        doc.removeEventListener('beforeinput', onInputIntent, true)
        attached.delete(doc)
      }
      for (const doc of current) if (!attached.has(doc)) {
        doc.addEventListener('keydown', onKeyDown, true)
        doc.addEventListener('pointerdown', onInputIntent, true)
        doc.addEventListener('beforeinput', onInputIntent, true)
        attached.add(doc)
      }
    }
    sync()
    const unsubscribe = subscribeWorkbenchWindows(sync)
    return () => {
      unsubscribe()
      quickSwitchFocusEpoch.current++
      for (const doc of attached) {
        doc.removeEventListener('keydown', onKeyDown, true)
        doc.removeEventListener('pointerdown', onInputIntent, true)
        doc.removeEventListener('beforeinput', onInputIntent, true)
      }
    }
  }, [])

  if (loading) {
    return <StartupLoadingSurface progress={startupProgress} runtimeEndpointWarnings={runtimeEndpointWarnings}
      detailSuffix={!config && initialTheme?.status === 'unavailable' ? '\n' + initialTheme.message : ''} />
  }

  if (!config && error) {
    return <FullPageLoadingSurface scope="app" phase="failed" eyebrow="AgentMux startup" title="Runtime connection failed" detail={error} actions={<button className="small-button" onClick={() => window.location.reload()}>Retry startup</button>} />
  }

  return (
    <GitHistoryProvider workspace={gitWorkspace}>
    <SettingsNavigation.Provider value={settingsNavigation}>
    <DocumentationNavigation.Provider value={documentation.navigation}>
    <SpaceContentPresentationContext.Provider value={spaceContent}>
    <WindowSidebarLayoutContext.Provider value={contentSidebars}>
    <ExecutorIdentityContext.Provider value={executorIdentity}>
      <RendererResourceOwners workbenchVisible={workfaceVisible} projectedVisibleTabIds={projectedVisibleTabIds} projectedVisibleRegionIds={projectedVisibleRegionIds} measurementActive={terminalParkingMeasurement}>
      <div
        className={`app-shell ${globalSurfaceOwnsProjectRail || !projectRailOpen ? 'app-shell--project-rail-collapsed' : ''}`}
      >
      <div className="app-shell__workspace" aria-hidden={settingsOpen ? true : undefined} inert={settingsOpen}>
      {!globalSurfaceOwnsProjectRail && projectRailOpen ? (
        <ProjectRail visible={!settingsOpen} />
      ) : globalSurfaceOwnsProjectRail ? null : (
        null
      )}
      <main className={`main-shell ${mergedTopRow ? 'main-shell--merged' : ''}`}>
        {!mergedTopRow ? (
          <header className="topbar">
            <TopRowLeadingChrome />
          </header>
        ) : null}
        <MoteSpaceFrame workspaceId={workspace?.id} active={workbenchVisible}>
        <div className="workbench-shell">
              <div
                ref={containerRef}
                hidden={!toolsVisible}
                className={`surface-tool-dock ${isResizing ? 'surface-tool-dock--resizing' : ''}`}
                data-surface-tool-dock
                data-content-expanded={spaceContent.expanded ? 'true' : 'false'}
                data-tools-collapsed={!toolsOpen ? 'true' : 'false'}
              >
                <SurfaceToolDock workspace={workspace} visible={workbenchVisible && toolsVisible} />
                <div
                  className="surface-tool-width-handle"
                  hidden={spaceContent.expanded}
                  role="separator"
                  aria-label="Resize surface tools"
                  title="Drag to resize · Double-click or Enter to reset"
                  aria-orientation="vertical"
                  aria-valuemin={toolDockMinimumWidth}
                  aria-valuemax={toolDockMaximumWidth}
                  aria-valuenow={renderedToolDockWidth}
                  tabIndex={0}
                  onMouseDown={onResizeStart} onDoubleClick={onResizeReset}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { onResizeReset(event); return }
                    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                    event.preventDefault()
                    setToolDockWidth(
                      Math.min(toolDockMaximumWidth, Math.max(toolDockMinimumWidth, renderedToolDockWidth + (event.key === 'ArrowRight' ? 16 : -16)))
                    )
                  }}
                />
              </div>
            <section className="workspace-main-surface" data-desktop-surface={desktopSurface[mainSurface]}
              aria-hidden={spaceContent.expanded || undefined} inert={spaceContent.expanded}>
              {!workspace && mainSurface === 'workbench' ? (
                <section className="welcome">
                  <span className="brand-mark brand-mark--large"><BrandIcon size={34} /></span>
                  <div className="eyebrow">Terminal-first agent workbench</div>
                  <h1>Bring a workspace.<br />Keep the agents visible.</h1>
                  <p>Add a local folder from the sidebar, or configure an SSH host and remote path.</p>
                  <button className="primary-button" onClick={() => openSettings('hosts')}>Configure a host</button>
                </section>
              ) : null}
              <div id="survey-surface-home" className="knowledge-surface-home" hidden={mainSurface !== 'survey'}>
                <WorkbenchSurfaceHost surface="survey" homeId="survey-surface-home" visible={surveyVisible}>
                  {surveyVisited || surveyVisible ? <GlobalSurveySurface
                    windowAction={surveyDetached ? null : <SurfaceWindowButton surface="survey" />}
                    visible={surveyVisible} controlsCoverPage={surveyToolsOpen && narrowControls}
                    onSelectReference={selectSurveyReference} unconfirmedBrowserRegionIds={unconfirmedBrowserRegionIds}
                    catalog={surveyCatalog} projection={surveyProjection} selection={surveyCurrentSelection}
                    pageSelection={isSurveyPage(surveySelection) ? surveySelection : null} viewTargets={viewTargets} /> : null}
                </WorkbenchSurfaceHost>
              </div>
              <div id="recall-surface-home" className="knowledge-surface-home" hidden={mainSurface !== 'recall'}>
                <WorkbenchSurfaceHost surface="recall" homeId="recall-surface-home" visible={recallVisible}>
                  {recallVisited || recallVisible ? <GlobalRecallSurface
                    windowAction={recallDetached ? null : <SurfaceWindowButton surface="recall" />}
                    visible={recallVisible} onSelectReference={selectRecallReference} catalog={surveyCatalog}
                    projection={recallProjection} selection={recallCurrentSelection} viewTargets={viewTargets} /> : null}
                </WorkbenchSurfaceHost>
              </div>
              {mainSurface === 'agents' || focusVisited ? <GlobalFocusSurface visible={focusVisible} workspaceOpen={focusWorkfaceView !== 'closed' && Boolean(workbenchSpaceSelection || focusWorkfaceView === 'unconfirmed')} onCloseWorkspace={() => setFocusWorkfaceView('closed')} onSelectContext={selectFocusContext} onSelectLocation={focusWorkfaceView === 'unconfirmed' ? undefined : selectFocusReference} regionOnly={focusRegionOnly} onToggleRegion={() => setFocusWorkfaceView(value => value === 'region' ? 'tab' : 'region')} presentation={focusPresentation} currentReference={timelineCurrentReference} directoryIssue={spatialDirectory.issue} viewTargets={viewTargets} /> : null}
              {mainSurface === 'board' ? <GlobalBoardSurface /> : null}
              {mapVisited || mapVisible ? <AgentCollaborationMap request={mapTarget} active={mapVisible} onViewInFocus={(subject, presentationSessionId) => useAppStore.getState().revealFocusAgent(subject, presentationSessionId)} onOpen={(context, reference) => { if (useAppStore.getState().focusExecutionSession(context.id, reference)) useAppStore.getState().setMainSurface('workbench') }} /> : null}
              {config && mountedWorkspaceIds.length > 0 ? (
                <div
                  className={`workspace-workbench-registry ${workbenchVisible || focusTab ? '' : 'workspace-workbench-registry--parked'}`}
                  aria-hidden={!workbenchVisible && !focusTab}
                  inert={!workbenchVisible && !focusTab}
                  >
                  {mountedWorkspaceIds.map((workspaceId) => {
                    const selected = workbenchVisible && workspaceId === activeWorkspaceId
                    const visible = selected && !spaceContent.expanded
                    const focusSource = Boolean(focusVisible && focusTab && focusTab.workspaceId === workspaceId)
                    const mounted = selected || focusSource
                    return (
                      <div
                        key={workspaceId}
                        className={`workspace-workbench-slot ${mounted ? '' : 'workspace-workbench-slot--parked'} ${focusSource ? 'workspace-workbench-slot--focus-source' : ''}`}
                        data-workspace-id={workspaceId}
                        data-desktop-zone-id={workbenchSpaceSelection?.workspaceId === workspaceId ? workbenchSpaceSelection.zoneId : undefined}
                        data-visible={mounted ? 'true' : 'false'}
                        aria-hidden={!mounted}
                        inert={!mounted}
                      >
                        <MoteWorkface workspaceId={workspaceId} visible={selected}
                          topicId={workbenchSpaceSelection?.workspaceId === workspaceId ? workbenchSpaceSelection.topicId ?? undefined : undefined}>
                        <WorkspaceWorkbench
                          projection={selected ? ordinaryProjection ?? undefined : undefined}
                          workspaceId={workspaceId}
                          {...(workspaceId === SCRATCH_WORKSPACE_ID && workbenchSpaceSelection?.workspaceId === workspaceId && workbenchSpaceSelection.topicId
                            ? { topicId: workbenchSpaceSelection.topicId, topicIsolation: 'bound-only' as const } : {})}
                          visible={visible}
                          viewTargets={viewTargets}
                          windowTargets={workbenchWindows}
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
        </MoteSpaceFrame>
      </main>
      </div>
      <PmoTeamsTopicFloatingPanel floating={moteFloating} setFloating={setMoteFloating} projectionState={moteProjection} />
      {settingsRoute ? (
        <SettingsPanel
          visible={settingsOpen}
          observationRef={settingsObservation}
          inputPolicy={settingsInputPolicy}
          navigationRequest={settingsRoute}
          initialSection={settingsRoute.section}
          executorId={settingsRoute.executorId}
          toolId={settingsRoute.toolId}
          onClose={closeSettings}
        />
      ) : null}
      {documentation.opening ? <DocumentationOverlay target={documentation.opening.target} opener={documentation.opening.opener} onClose={documentation.close} /> : null}
      <footer className="window-status-bar">
        <div className="window-status-bar__surface-switch"><SurfaceSwitch settingsOpen={settingsOpen} onCloseSettings={closeSettings} /></div>
        <div className="window-status-bar__right">
          <WorkbenchWindowNotices />
          <GlobalSystemNotices nativeOverlayWarning={nativeOverlayWarning} />
          <WindowUtilityBar toolkit={<ToolkitStatusBar />} />
        </div>
      </footer>
      <QuickSwitcher open={quickSwitchOpen} onClose={() => setQuickSwitchOpen(false)} returnFocus={() => {
        const original = quickSwitchOrigin.current
        if (original?.navigation !== fileNavigationSelection(useAppStore.getState()) || !original.element?.isConnected) return null
        const target = original.element, ownerDocument = target.ownerDocument, identity = workbenchDocumentIdentity(ownerDocument)
        if (ownerDocument === document) return target
        const epoch = quickSwitchFocusEpoch.current, mainInput = document.activeElement, sourceInput = ownerDocument.activeElement
        if (identity) void focusWorkbenchWindow(identity).then(confirmed => {
          const currentIdentity = workbenchDocumentIdentity(ownerDocument)
          if (confirmed && epoch === quickSwitchFocusEpoch.current && quickSwitchOrigin.current === original &&
              !presentationRef.current.overlays.quickSwitcher && !useAppStore.getState().sessionLocationRequest &&
              document.activeElement === mainInput && ownerDocument.activeElement === sourceInput &&
              target.isConnected && target.ownerDocument === ownerDocument && original.navigation === fileNavigationSelection(useAppStore.getState()) &&
              currentIdentity?.windowId === identity.windowId && currentIdentity.documentGeneration === identity.documentGeneration) target.focus({ preventScroll: true })
        })
        return null
      }} />
      </div>
      <WindowOverlayHost><WorkbenchCloseRequests /><AgentInformationPreviewHost /></WindowOverlayHost>
      </RendererResourceOwners>
    </ExecutorIdentityContext.Provider>
    </WindowSidebarLayoutContext.Provider>
    </SpaceContentPresentationContext.Provider>
    </DocumentationNavigation.Provider>
    </SettingsNavigation.Provider>
    </GitHistoryProvider>
  )
}
