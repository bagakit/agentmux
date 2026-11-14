import { NOTE_FILE_EXTENSION } from '@agentmux/client-ui/note/note-format'
import { surveyThumbnailStyle } from '../../../shared/survey-thumbnail-layout'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { mintObjectId } from '@agentmux/core/object-id'
import { recordNotebookChanges, retryNotebookRecoveries, useNotebookLibrary } from '../lib/notebook-library'
import { surveyExplorationName } from '../lib/survey-exploration-name'
import { spatialCatalog } from '../lib/space-agent-control'
import { sessionPresentationById } from '../lib/session-presentation'
import type { AgentMuxSpaceCatalog, AgentMuxZoneFact, TopicKnowledgeSource } from '@agentmux/core/control'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { SurveyBrowserPreparation } from '../lib/survey-browser-creation'
import { isSurveyPage, surveyPageOwner, type SurveyPageSelection } from '../lib/survey-page-references'
import { scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { surveyBrowserControl, surveyInitialZoneSelection, surveySelectReference, surveySelectedBrowser, surveyZoneItems, type ResolvedSurveyZoneSelection } from '../lib/survey-workface'
import { workbenchProjectionSlotId, workbenchRegionProjectionSlotId, type WorkbenchProjection, type WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { workbenchSurfaces } from '../lib/workbench-tabs'
import { currentDisplayNameRevision, useAppStore } from '../store'
import { BrowserAddressInput, type BrowserAddressInputHandle } from './BrowserAddressInput'
import { BrowserToolsPanel } from './BrowserToolsPanel'
import { SurveyZoneItem, type SurveyItemNameDraft } from './SurveyZoneItem'
import { SurveyTabColumn } from './SurveyTabColumn'
import { SurveyPageItem } from './SurveyPageItem'
import { SortableSurveyPage } from './SortableSurveyPage'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { surveyPageOrderKey } from '../lib/survey-page-order'
import { SurveyPageTabHeader } from './SurveyPageTabHeader'
import { surveyPinnedReferences, surveyPinKey } from '../lib/survey-pins'
import type { AgentMuxSurveyPinReference } from '@agentmux/core/control'
import { surveyCompositionDestinations, type SurveyCompositionDestinationIntent } from '../lib/survey-composition-destinations'
import type { SurveyContentReference, SurveyCompositionDropTarget, SurveyCompositionSelectionControl } from '../lib/survey-composition-drag'
import { SurveyItemList } from './SurveyItemList'
import { useSurveyListOrganization } from '../hooks/useSurveyListOrganization'
import { moveSurveyListItem } from '../lib/survey-list'
import { BrowserStartPage } from './BrowserStartPage'
import { resolveBrowserStartPage } from '../../../shared/browser-start-page'
import { SurveyPanelChoices } from './SurveyPanelChoices'
import { groupIds, regionIds } from '@agentmux/layout'
import { resolveWorkbenchZone, sameWorkbenchProjectionSelection } from '../lib/workbench-projection'
import { SelectorPresence, type SelectorPresenceAgent } from './SelectorList'
import { SurveyItemOptions, SurveyItemContextMenu, type SurveyItemOptionsProps } from './SurveyItemOptions'
import { TopicKnowledgeCapture } from './TopicKnowledgeEditor'
import { SurveyRecallCapture } from './SurveyRecallCapture'
import type { SurveyRecallCapture as RecallCaptureTarget } from '../lib/survey-recall-capture'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import { WorkbenchZone } from './WorkbenchZone'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { SURVEY_SIDEBAR_DEFAULT_WIDTH, surveySidebarBounds } from '../lib/survey-sidebar-width'
import { clampSidebarResizeWidth, useSidebarResize } from '../hooks/useSidebarResize'
import { isMacPlatform } from '../lib/host-platform'
import { api } from '../lib/api'
import { useLauncherState } from '../lib/launcher-state'
import { directoryIdentity } from '../../../shared/space-addresses'
import { useWorkbenchTabsClose } from '../hooks/useWorkbenchTabsClose'
import { useBrowserProfiles, browserProfiles } from '../lib/browser-profiles'
import { surveyProfileReferences } from '../lib/survey-profile-view'
import { SurveyProfilePicker } from './SurveyProfilePicker'
import { SurveyMoveTabsDialog } from './SurveyMoveTabsDialog'
import { SurveyCompositionResultDialog } from './SurveyCompositionResultDialog'
import { isSurveyCompositionRecovery } from '../lib/survey-composition-recovery'
import { captureSurveyCompositionSource, type SurveyCompositionSource } from '../lib/survey-tab-composition'

const ThemeStatusUnknownIcon = semanticIconComponent('status.unknown')
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')
const ThemeObjectBrowserIcon = semanticIconComponent('object.browser')
const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')
const ThemeObjectNoteIcon = semanticIconComponent('object.note')
const ThemeFileTextIcon = semanticIconComponent('file.text')
const ThemeObjectLauncherIcon = semanticIconComponent('object.launcher')
const ThemeLayoutOpenLeftIcon = semanticIconComponent('layout.open-left')
const ThemeLayoutCloseLeftIcon = semanticIconComponent('layout.close-left')
const ThemeActionCreateBrowserIcon = semanticIconComponent('action.create-browser')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeActionCollectSourcesIcon = semanticIconComponent('action.collect-sources')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionCloseIcon = semanticIconComponent('action.close')


export const GlobalSurveySurface = memo(function GlobalSurveySurface({ visible = true, controlsCoverPage = false, unconfirmedBrowserRegionIds, catalog, projection, selection, pageSelection = null, viewTargets, onSelectReference }: {
  visible?: boolean
  controlsCoverPage?: boolean
  unconfirmedBrowserRegionIds?: ReadonlySet<string> | undefined
  catalog: AgentMuxSpaceCatalog | null
  projection: WorkbenchProjection | null
  selection: ResolvedSurveyZoneSelection | null
  pageSelection?: SurveyPageSelection | null
  onSelectReference?: (reference: WorkbenchProjectionSelection) => void
  viewTargets?: Parameters<typeof WorkspaceWorkbench>[0]['viewTargets']
}) {
  const library = useNotebookLibrary(state => state.state)
  const notebooks = useMemo(() => Object.values(library?.notebooks ?? {}), [library])
  const pages = useMemo(() => Object.values(library?.pages ?? {}), [library])
  const config = useAppStore(state => state.config)
  const browserInput = useRef<BrowserAddressInputHandle>(null)
  const [inputHistoryNotice, setInputHistoryNotice] = useState<string | null>(null)
  const [historyRevision, setHistoryRevision] = useState(0)
  const activeWorkspaceId = useAppStore(state => state.activeWorkspaceId)
  const controlNavigation = useAppStore(state => state.workbenchNavigationInputPolicy !== null)
  const explorationNames = useAppStore(state => state.surveyExplorationNames)
  const contextOrigin = useRef<HTMLElement | null>(null)
  const [contextItem, setContextItem] = useState<AgentMuxSurveyPinReference | null>(null)
  const contextZone = contextItem?.kind === 'zone' ? catalog?.zones.find(zone => zone.zoneId === contextItem.zoneId) : undefined
  const [renamingZoneId, setRenamingZoneId] = useState<string | null>(null)
  const itemNameDraft = useRef<(SurveyItemNameDraft & { zoneId: string }) | null>(null)
  function editItemName(zone: AgentMuxZoneFact, editing: boolean) {
    if (editing) { list.setRenamingGroupId(null); itemNameDraft.current = { zoneId: zone.zoneId, value: itemTitle(zone), focusOnMount: true, selection: null, revision: { revision: currentDisplayNameRevision('zone', zone.zoneId) } }; setRenamingZoneId(zone.zoneId) }
    else { itemNameDraft.current = null; setRenamingZoneId(null) }
  }
  const list = useSurveyListOrganization()
  const contextOrganization = useRef(list.stored)
  const collected = useAppStore(state => state.surveyCollectedZones)
  const profileView = useAppStore(state => state.surveyProfileView)
  const profileViewRecovery = useAppStore(state => state.surveyProfileViewReadRecovery)
  const profiles = useBrowserProfiles(visible)
  const pageReferences = useAppStore(state => state.surveyPageReferences)
  const pageReadRecovery = useAppStore(state => state.surveyPageReadRecovery)
  const pinnedItems = useAppStore(state => state.pinnedItems)
  const pinReadRecovery = useAppStore(state => state.surveyPinReadRecovery)
  const pinReferences = useMemo(() => surveyPinnedReferences({ pinnedItems, surveyPinReadRecovery: pinReadRecovery }), [pinnedItems, pinReadRecovery])
  const pinnedKeys = useMemo(() => new Set(pinReferences.map(surveyPinKey)), [pinReferences])
  const setCollected = useAppStore(state => state.setSurveyZoneCollected)
  const toolsOpen = useAppStore(state => state.surveyToolsOpen)
  const setSelection = useAppStore(state => state.setSurveyZoneSelection)
  const setToolsOpen = useAppStore(state => state.setSurveyToolsOpen)
  const sidebarCollapsed = useAppStore(state => state.surveySidebarCollapsed)
  const setSidebarCollapsed = useAppStore(state => state.setSurveySidebarCollapsed)
  const sidebarWidth = useAppStore(state => state.surveySidebarWidth)
  const setSidebarWidth = useAppStore(state => state.setSurveySidebarWidth)
  const selectWorkspace = useAppStore(state => state.selectWorkspace)
  const topicsWorkspace = config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  const store = useMemo(() => ({ getState: useAppStore.getState, getInitialState: useAppStore.getInitialState,
    subscribe: visible ? useAppStore.subscribe : () => () => {} }), [visible])
  const tabs = useStore(store, state => state.tabs)
  const layouts = useStore(store, state => state.layouts)
  const sessions = useStore(store, state => state.sessions)
  const resourceWorkspaces = useMemo(() => new Map(config?.workspaces.map(workspace => [workspace.id, workspace]) ?? []), [config?.workspaces])
  const currentZone = useMemo(() => selection ? catalog?.zones.find(zone => zone.zoneId === selection.zoneId) : undefined, [catalog, selection?.zoneId])
  const resourceWorkspaceId = currentZone?.workspaceId ?? (pageSelection
    ? surveyPageOwner(tabs, pageSelection, catalog)?.tab.workspaceId ?? null
    : !selection ? SCRATCH_WORKSPACE_ID : null)
  const workspace = resourceWorkspaceId ? resourceWorkspaces.get(resourceWorkspaceId) : undefined
  const items = useMemo(() => catalog ? surveyZoneItems(catalog, collected) : [], [catalog, collected])
  const tabsByZone = useMemo(() => {
    const result = new Map<string, string[]>()
    for (const tab of catalog?.tabs ?? []) if (tab.zoneId) {
      const members = result.get(tab.zoneId) ?? []; members.push(tab.tabId); result.set(tab.zoneId, members)
    }
    return result
  }, [catalog])
  const currentPanel = selection?.active && currentZone && catalog?.tabs.some(tab => tab.tabId === selection.active!.tabId && tab.zoneId === currentZone.zoneId)
    && catalog.regions.some(region => region.regionId === selection.active!.regionId && region.tabId === selection.active!.tabId) ? selection.active : null
  const currentBrowser = surveySelectedBrowser(tabs, selection)
  const [query, setQuery] = useState('')
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function removePageReference(page: import('@agentmux/core/control').AgentMuxSurveyPageReference) {
    const original = useAppStore.getState().surveyZoneSelection
    try {
      const report = await useAppStore.getState().setSurveyPageCollected(page, false)
      if (report.outcome === 'refused' || report.outcome === 'unknown') {
        setError(report.issues[0]?.message ?? 'The original Survey page reference is unconfirmed. Its page and selection are kept.')
        return
      }
      if (report.issues.length) setError(report.issues.map(issue => issue.message).join('\n'))
      if (useAppStore.getState().surveyZoneSelection === original && isSurveyPage(original) &&
        original.regionId === page.regionId && original.browserId === page.browserId) setSelection(null)
    } catch {
      setError('Removing this Survey reference is unconfirmed. Its original page and current selection are kept; read the original Survey list before another action.')
    }
  }
  const [creationNotice, setCreationNotice] = useState<string | null>(null)
  const [capture, setCapture] = useState<{ title: string; sources: TopicKnowledgeSource[]; noteIds: string[] } | null>(null)
  const [recallCapture, setRecallCapture] = useState<RecallCaptureTarget | null>(null)
  const [locationChoice, setLocationChoice] = useState<{ kind: 'note' | 'agent' | 'browser' | 'tab'; zoneId: string; choices: WorkbenchProjectionSelection[] } | { kind: 'close'; zoneId: string; subject: string; choices: WorkbenchProjectionSelection[] } | { kind: 'close-page'; page: SurveyPageSelection; choices: WorkbenchProjectionSelection[] } | null>(null)
  const [movingSources, setMovingSources] = useState<SurveyCompositionSource[] | null>(null)
  const [movingIntent, setMovingIntent] = useState<{ intent: SurveyCompositionDestinationIntent; requestId: string; surveyGroupId?: string | null } | null>(null)
  const [selectingContent, setSelectingContent] = useState(false)
  const [selectedSources, setSelectedSources] = useState<SurveyCompositionSource[]>([])
  const pendingCompositions = useAppStore(state => state.surveyCompositionRecoveries)
  const [reviewingComposition, setReviewingComposition] = useState<string | null>(null)
  const unresolvedCompositions = pendingCompositions.filter(isSurveyCompositionRecovery)
  const reviewingOperation = unresolvedCompositions.find(operation => operation.requestId === reviewingComposition)
  const compositionBusy = useRef(false)
  const compositionDrag = useRef<{ requestId: string; reservedZoneId: string; sources: SurveyCompositionSource[]; researchZoneId: string | null; organization: typeof list.stored; editable: typeof list.editable } | null>(null)
  const zonesForComposition = useMemo(() => new Map(catalog?.zones.map(zone => [zone.zoneId, zone]) ?? []), [catalog])
  function captureContent(reference: SurveyContentReference): SurveyCompositionSource[] | null {
    if (!catalog) return null
    const state = useAppStore.getState()
    const inputs = reference.kind === 'research' ? catalog.tabs.filter(tab => tab.zoneId === reference.zoneId).map(tab => ({ kind: 'tab' as const, tabId: tab.tabId })) : [reference]
    const sources = inputs.map(input => captureSurveyCompositionSource(state, catalog, input))
    return sources.length && sources.every(source => source !== null) ? sources : null
  }
  const sourceKey = (source: SurveyCompositionSource) => source.kind === 'tab' ? JSON.stringify(['tab', source.tab.id]) : JSON.stringify(['page', source.regionId, source.browserId])
  function selectionFor(reference: SurveyContentReference): SurveyCompositionSelectionControl | undefined {
    if (!selectingContent) return undefined
    const matches = (source: SurveyCompositionSource) => reference.kind === 'research' ? source.zoneId === reference.zoneId
      : reference.kind === 'tab' ? source.kind === 'tab' && source.tab.id === reference.tabId
        : source.kind === 'page' && source.regionId === reference.regionId && source.browserId === reference.browserId
    const checked = reference.kind === 'research' ? (tabsByZone.get(reference.zoneId) ?? []).length > 0 &&
      (tabsByZone.get(reference.zoneId) ?? []).every(id => selectedSources.some(source => source.kind === 'tab' && source.tab.id === id)) : selectedSources.some(matches)
    const overlap = selectedSources.some(source => matches(source) || reference.kind === 'tab' && source.tab.id === reference.tabId)
    return { checked, partial: !checked && overlap, toggle(value) {
      if (!value) { setSelectedSources(current => current.filter(source => !matches(source))); return }
      const sources = captureContent(reference)
      if (!sources) { setError('This original selection changed. Existing content is kept; select its current exact page or Tab again.'); return }
      setSelectedSources(current => [...current.filter(original => !sources.some(source => source.tab.id === original.tab.id &&
        (source.kind === 'tab' || original.kind === 'tab' || source.regionId === original.regionId))), ...sources])
    } }
  }
  function startComposition(reference: SurveyContentReference) {
    const captured = !compositionBusy.current && captureContent(reference)
    const selected = captured && captured.every(source => selectedSources.some(original => sourceKey(original) === sourceKey(source)))
    const sources = captured ? selected ? selectedSources : captured : null
    compositionDrag.current = sources ? { sources, requestId: mintObjectId(), reservedZoneId: mintObjectId(),
      researchZoneId: reference.kind === 'research' && captured && sources.length === captured.length && sources.every(source => captured.some(original => sourceKey(original) === sourceKey(source))) ? reference.zoneId : null,
      organization: list.stored, editable: list.editable } : null
    return sources ? `${sources.length} ${sources.every(source => source.kind === 'page') ? sources.length === 1 ? 'page' : 'pages' : sources.every(source => source.kind === 'tab') ? sources.length === 1 ? 'Tab' : 'Tabs' : 'items'}` : null
  }
  function completeResearch(sources: readonly SurveyCompositionSource[]): string | null {
    const zoneId = sources[0]?.zoneId
    if (!zoneId || !collected[zoneId] || !sources.every(source => source.kind === 'tab' && source.zoneId === zoneId)) return null
    const members = tabsByZone.get(zoneId) ?? [], sourceIds = new Set(sources.map(source => source.tab.id))
    return members.length === sourceIds.size && members.every(tabId => sourceIds.has(tabId)) ? zoneId : null
  }
  function canGroupContent(sources: readonly SurveyCompositionSource[]): boolean {
    return sources.length === 1 && sources[0]!.kind === 'tab' || completeResearch(sources) !== null
  }
  function canCompose(target: SurveyCompositionDropTarget): boolean {
    const held = compositionDrag.current
    if (!held || !catalog || !visible || controlsCoverPage) return false
    if (target.kind === 'independent') return held.researchZoneId === null && completeResearch(held.sources) === null
    if (target.kind === 'list-group') {
      if (held.researchZoneId === null && !canGroupContent(held.sources)) return false
      if (target.groupId !== null && !list.stored.groups.some(group => group.groupId === target.groupId)) return false
      const wholeZoneId = held.researchZoneId ?? completeResearch(held.sources)
      return !wholeZoneId || (list.stored.groups.find(group => group.zoneIds.includes(wholeZoneId))?.groupId ?? null) !== target.groupId
    }
    if (target.kind === 'research') {
      const zone = zonesForComposition.get(target.zoneId), resource = zone && resourceWorkspaces.get(zone.workspaceId)
      return Boolean(zone && resource && !held.sources.every(source => source.zoneId === target.zoneId))
    }
    const owner = surveyPageOwner(tabs, target, catalog)
    return Boolean(owner && resourceWorkspaces.get(owner.surface.workspaceId) && !held.sources.some(source =>
      source.kind === 'page' ? source.regionId === target.regionId : source.tab.id === owner.tab.id))
  }
  function dropComposition(target: SurveyCompositionDropTarget | null) {
    const held = compositionDrag.current
    if (!held || !target || !canCompose(target) || !catalog) { compositionDrag.current = null; return }
    compositionDrag.current = null
    let sources = held.sources
    const wholeZoneId = target.kind === 'list-group' ? held.researchZoneId ?? completeResearch(sources) : null
    if (target.kind === 'list-group' && wholeZoneId) {
      void list.commit(moveSurveyListItem(held.editable, wholeZoneId, target.groupId), held.organization)
      return
    }
    const surveyGroupId = target.kind === 'list-group' ? target.groupId : undefined
    const intent: SurveyCompositionDestinationIntent = target.kind === 'research' ? { kind: 'existing', zoneId: target.zoneId }
      : { kind: 'new-research', zoneId: held.reservedZoneId, ...(target.kind === 'page' ? { anchor: target } : {}) }
    if (target.kind === 'page') {
      const page = captureSurveyCompositionSource(useAppStore.getState(), catalog, target)
      if (!page) { setError('The original target page changed. Its content and this selection are kept; choose that same page again.'); return }
      sources = [...sources, page]
    }
    const destinations = surveyCompositionDestinations(useAppStore.getState(), catalog, sources, intent)
    if (destinations.length !== 1) {
      setMovingIntent({ intent, requestId: held.requestId, ...(surveyGroupId === undefined ? {} : { surveyGroupId }) }); setMovingSources(sources); return
    }
    compositionBusy.current = true
    void useAppStore.getState().composeSurveyTabs({ requestId: held.requestId, sources, target: destinations[0]!.target, ...(surveyGroupId === undefined ? {} : { surveyGroupId }) }).then(result => {
      if (result.outcome === 'unknown' || result.outcome === 'partial') setReviewingComposition(result.requestId)
      else if (result.issue) setError(result.issue)
      if (result.outcome === 'moved') setSelectedSources(current => current.filter(source => !sources.includes(source)))
    }).finally(() => { compositionBusy.current = false }).catch(cause => setError(presentError(cause)))
  }
  const tabClose = useWorkbenchTabsClose()
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
    surfaceRef.current?.style.setProperty('--survey-navigation-width', `${sidebarCollapsed ? 40 : clampSidebarResizeWidth(width, minWidth, maxWidth)}px`)
  }, [minWidth, maxWidth, sidebarCollapsed])
  const { containerRef: sidebarRef, isResizing, onResizeStart, onResizeReset } = useSidebarResize<HTMLElement>({
    isOpen: true, resizable: visible && !sidebarCollapsed, defaultWidth: SURVEY_SIDEBAR_DEFAULT_WIDTH, width: sidebarCollapsed ? 40 : sidebarWidth, setWidth: setSidebarWidth, deltaSign: 1, minWidth: sidebarCollapsed ? 40 : minWidth, maxWidth: sidebarCollapsed ? 40 : maxWidth, onDraftWidthChange: reportDraftWidth
  })
  const selectionKey = pageSelection ? JSON.stringify(pageSelection) : selection ? JSON.stringify([selection.zoneId, selection.active]) : null
  const profileViewKey = JSON.stringify(profileView)
  const intent = useRef(0)
  const failedCreation = useRef<SurveyBrowserPreparation | null>(null)
  const [itemBrowserRecoveries, setItemBrowserRecoveries] = useState<Record<string, { preparation: SurveyBrowserPreparation; message: string; pending: boolean }>>({})
  useLayoutEffect(() => { intent.current += 1 }, [visible, selectionKey, activeWorkspaceId, profileViewKey])
  useEffect(() => { if (toolsOpen) setToolsVisited(true) }, [toolsOpen])
  useEffect(() => {
    if (controlNavigation) return
    const surface = surfaceRef.current
    if (!visible) { if (surface?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur(); return }
    const focused = document.activeElement
    // Clearing an incompatible page can mount the start page while the person
    // is still typing in the environment select. That input intent stays put.
    if (!toolsOpen && !selection && focused instanceof HTMLElement && surface?.contains(focused) &&
        focused.matches('input, select, textarea, [contenteditable]:not([contenteditable="false"])')) return
    const findTarget = () => {
      const reference = selection?.active
      const hostId = reference && projection ? (projection.entity.kind === 'region' ? workbenchRegionProjectionSlotId : workbenchProjectionSlotId)(`${projection.presentationId}-slot`, reference) : null
      const host = hostId ? document.getElementById(hostId) : null
      const browserRegion = currentBrowser && host && surface?.contains(host) ? [...host.querySelectorAll<HTMLElement>('[data-workbench-region-id]')]
        .find(region => region.dataset.workbenchRegionId === reference?.regionId) : null
      return toolsOpen ? surface?.querySelector<HTMLElement>('[aria-label="Close browser management"]')
        : currentBrowser ? browserRegion?.querySelector<HTMLElement>(currentBrowser.url === 'about:blank' ? '[aria-label="Search or enter a web address"]' : '[aria-label="Browser address"]')
          : !selection ? surface?.querySelector<HTMLElement>('[aria-label="Search or enter a web address"]') : null
    }
    const target = findTarget()
    if (target) { target.focus(); return }
    if (!surface || (!toolsOpen && !currentBrowser && selection)) return
    // The retained portal may commit after this effect. Observe only until the input exists;
    // a newer selection, hidden surface or explicit input focus cancels this request.
    const previousFocus = document.activeElement
    const observer = new MutationObserver(() => {
      if (document.activeElement !== previousFocus && document.activeElement !== document.body) { observer.disconnect(); return }
      const mounted = findTarget()
      if (mounted) { observer.disconnect(); mounted.focus() }
    })
    observer.observe(surface, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [visible, selectionKey, toolsOpen, currentBrowser?.browserId, currentBrowser?.url === 'about:blank', controlNavigation])

  function itemTitle(zone: AgentMuxZoneFact): string {
    return surveyExplorationName(explorationNames[zone.zoneId], (tabsByZone.get(zone.zoneId) ?? []).flatMap(id => tabs[id] ? [tabs[id]!] : []))
  }

  function activity(zone: AgentMuxZoneFact) {
    const surfaces = (tabsByZone.get(zone.zoneId) ?? []).flatMap(id => tabs[id] ? workbenchSurfaces(tabs[id]!) : [])
    const browsers = surfaces.filter(surface => surface.kind === 'browser')
    const operators = new Map<string, SelectorPresenceAgent>()
    const sessionIndex = sessionPresentationById(sessions)
    const controls = browsers.map(browser => surveyBrowserControl(browser, Boolean(unconfirmedBrowserRegionIds?.has(browser.regionId))))
    const labels = browsers.map((browser, index) => {
      const control = controls[index]!
      const operation = browser.activity?.operation
      const operator = control === 'agent' && operation?.browserId === browser.browserId && operation.finishedAt === undefined && ['preparing', 'running', 'waiting'].includes(operation.phase) ? operation.operator : undefined
      if (operator && operator.id !== 'agent:unknown') {
        const candidate = sessionIndex.get(operator.id)
        const session = candidate?.kind === 'agent' ? candidate : undefined
        operators.set(operator.id, { key: operator.id, sessionId: operator.id, label: operator.name,
          providerId: session?.providerId ?? operator.providerId ?? '', executorId: session?.executorId,
          appearance: session ? config?.executors[session.executorId]?.avatar : undefined,
          state: session?.status.state })
      }
      return control === 'agent' ? `Agent operating${operator?.name ? ` · ${operator.name}` : ''}` : control === 'human' ? 'Human control' : control === 'idle' ? 'No active Agent operation'
        : control === 'parked' ? 'Page parked · loads when shown' : 'Control unknown · restoring'
    })
    const kinds = new Set(labels)
    const agents = surfaces.filter(surface => surface.kind === 'agent').length
    const description = browsers.length === 1 && !agents ? labels[0] : `${browsers.length ? `${browsers.length} browsers` : `${surfaces.length} regions`}${agents ? ` · ${agents} agents` : ''}${browsers.length ? ` · ${kinds.size === 1 ? labels[0] : 'Mixed control'}` : ''}`
    const detail = labels.map((label, index) => `${browsers[index]!.regionId}: ${label}`).join('\n')
    const unknown = controls.includes('unknown') && (tabsByZone.get(zone.zoneId)?.length ?? 0) < 2
    const operating = controls.includes('agent')
    // Normal manual control is availability, not activity; keep its facts in Details.
    const Icon = operating && operators.size === 0 ? ThemeObjectAgentIcon : null
    const hint = [description, controls.includes('unknown') ? 'Control unknown · open affected page to check' : null, ...[...operators.values()].map(operator => operator.label)].filter(Boolean).join(' · ')
    return { summary: operators.size || Icon || unknown ? <span title={hint} aria-label={description}>
      <SelectorPresence agents={[...operators.values()]} />
      {unknown ? <span className="survey-status-label" title="Page status unconfirmed · open page to check">Unconfirmed</span> : null}
      {Icon ? <Icon size={12} aria-hidden="true" /> : null}
    </span> : null,
      description: unknown ? 'Page status unconfirmed · open page to check' : undefined,
      details: <span>{description}{detail ? `\n${detail}` : ''}</span> }
  }

  function itemGlyph(zone: AgentMuxZoneFact) {
    const surfaces = (tabsByZone.get(zone.zoneId) ?? []).flatMap(id => tabs[id] ? workbenchSurfaces(tabs[id]!) : [])
    const browsers = surfaces.filter(surface => surface.kind === 'browser')
    if (surfaces.length === 1 && browsers.length === 1 && browsers[0]!.faviconDataUrl) return <span className="survey-page-favicon" aria-hidden="true"><ThemeObjectBrowserIcon size={16} /><img key={browsers[0]!.faviconDataUrl} src={browsers[0]!.faviconDataUrl} alt="" onError={event => { event.currentTarget.hidden = true }} /></span>
    const Icon = surfaces.length && surfaces.every(surface => surface.kind === 'browser') ? ThemeObjectBrowserIcon
      : surfaces.length && surfaces.every(surface => surface.kind === 'file' && surface.path.endsWith(NOTE_FILE_EXTENSION)) ? ThemeObjectNoteIcon
        : surfaces.length && surfaces.every(surface => surface.kind === 'file') ? ThemeFileTextIcon : ThemeObjectLauncherIcon
    return <Icon size={16} />
  }

  function chooseZone(zoneId: string): void {
    if (!catalog) return
    intent.current += 1
    const held = useAppStore.getState().surveyZoneSelection
    if (held?.zoneId !== zoneId) setSelection(surveyInitialZoneSelection(catalog, zoneId, layouts, tabs, activeWorkspaceId))
    setError(null)
  }

  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  useEffect(() => { if (!visible) setCreateMenuOpen(false) }, [visible])

  async function openBrowser(input = 'about:blank', newItem = false, mode?: 'private'): Promise<void> {
    if (opening) return
    if (profileViewRecovery && (newItem || !failedCreation.current)) {
      setError('Choose an environment for this new page. Default browsing and existing pages remain available.')
      return
    }
    const before = useAppStore.getState()
    const startedIntent = intent.current
    setOpening(true); setError(null)
    try {
      const preparation = await before.createSurveyBrowser({ workspaceId: newItem ? SCRATCH_WORKSPACE_ID : failedCreation.current?.zone.workspaceId ?? workspace?.id ?? SCRATCH_WORKSPACE_ID, url: input,
        ...(mode === undefined ? {} : { mode }), ...(mode !== 'private' && profileView.kind === 'profile' ? { profileId: profileView.profileId } : {}), entry: 'page', preparation: newItem ? null : failedCreation.current, onPrepared(value) { failedCreation.current = value } })
      const reference = preparation.reference, current = useAppStore.getState()
      const admission = preparation.admission
      failedCreation.current = admission?.issues.length ? preparation : null
      setCreationNotice(null)
      if (admission?.issues.length) setError('The page is available. ' + admission.issues.map(issue => issue.message).join(' '))
      const browser = current.tabs[reference.tabId]?.regions[reference.regionId]
      if (browser?.kind === 'browser' && admission?.outcome !== 'unknown' && intent.current === startedIntent &&
          current.mainSurface === 'survey' && current.surveyZoneSelection === before.surveyZoneSelection) {
        setSelection({ kind: 'page', regionId: reference.regionId, browserId: browser.browserId })
      }
    } catch (cause) { setError(`Browser could not open: ${presentError(cause)}. Your input and original work surface are kept; retry here.`) }
    finally { setOpening(false) }
  }

  function showOriginalPage(): void {
    const preparation = failedCreation.current
    const reference = preparation?.reference, expected = preparation?.createdBrowser
    const state = useAppStore.getState()
    const tab = reference && state.tabs[reference.tabId]
    const browser = reference && tab?.regions[reference.regionId]
    if (!reference || !expected || tab?.space?.zoneId !== preparation?.zone.zoneId || browser?.kind !== 'browser' ||
        browser.browserId !== expected.id || browser.mode !== expected.mode || browser.profileId !== expected.profileId ||
        browser.mode === 'normal' && !browser.profileId) {
      setError('The original page binding is unconfirmed. Its exact reference is kept; this action cannot select a replacement Browser.')
      return
    }
    intent.current += 1
    const chosen: SurveyPageSelection = { kind: 'page', regionId: reference.regionId, browserId: expected.id }
    // This explicit recovery changes only the view and selection. Membership
    // withdrawn by a later person action remains withdrawn.
    const save = browser.mode === 'normal' ? state.setSurveyProfileView({ kind: 'profile', profileId: browser.profileId! }) : null
    setSelection(chosen)
    const selected = useAppStore.getState().surveyZoneSelection
    if (save) void save.then(report => {
      if (useAppStore.getState().surveyZoneSelection === selected && report.reason) setError(report.reason)
    }).catch(() => {
      if (useAppStore.getState().surveyZoneSelection === selected) setError('The original page is shown. Saving its environment view is unconfirmed; retry the original preference save.')
    })
  }

  async function newBrowserTab(displayWorkspaceId: string, groupId: string): Promise<void> {
    if (pageSelection) { await openBrowser('about:blank', true); return }
    if (!currentZone || !selection) return
    const before = useAppStore.getState(), held = before.surveyZoneSelection, startedIntent = intent.current
    // A direct entity Group is presentation, not an original durable placement.
    if (!before.layouts[displayWorkspaceId]?.groups.some(group => group.id === groupId)) {
      displayWorkspaceId = currentZone.workspaceId
      groupId = before.layouts[displayWorkspaceId]?.activeGroupId ?? ''
    }
    const preparation = prepareItemTab(currentZone, { displayWorkspaceId, groupId }, true)
    if (!preparation) return
    setError(null)
    const created = await createItemBrowser(preparation)
    if (created && held && !isSurveyPage(held) && intent.current === startedIntent && useAppStore.getState().surveyZoneSelection === held) {
      setSelection(surveySelectReference(held, preparation.reference))
    }
  }

  function itemProjection(zoneId: string) {
    const state = useAppStore.getState()
    if (!catalog) return null
    return resolveWorkbenchZone(zoneId, catalog, state.layouts, state.tabs, 'survey-workbench', [], () => {})
  }

  function itemReferences(zoneId: string) {
    const original = itemProjection(zoneId), state = useAppStore.getState()
    const members = new Set(catalog?.tabs.filter(tab => tab.zoneId === zoneId).map(tab => tab.tabId))
    const layout = original?.composition
    return (layout ? groupIds(layout.root).flatMap(id => layout.groups.filter(group => group.id === id)) : []).flatMap(group => group.tabOrder.filter(id => members.has(id)).flatMap(tabId => {
      const tab = state.tabs[tabId]
      return tab ? regionIds(tab.layout.root).filter(regionId => !!tab.regions[regionId]).map(regionId => ({ displayWorkspaceId: original!.displayWorkspaceId, groupId: group.id, tabId, regionId })) : []
    }))
  }

  function chooseTab(zoneId: string, tabId: string) {
    const state = useAppStore.getState(), tab = state.tabs[tabId]
    const reference = itemReferences(zoneId).find(reference => reference.tabId === tabId && reference.regionId === tab?.layout.activeRegionId)
    if (!reference || !catalog) { setError('This original Tab is still restoring. Its content and reference are kept.'); return }
    intent.current += 1
    setError(null)
    const held = state.surveyZoneSelection?.zoneId === zoneId ? state.surveyZoneSelection : surveyInitialZoneSelection(catalog, zoneId, state.layouts, state.tabs, activeWorkspaceId)
    setSelection(surveySelectReference(held, reference))
  }

  function closeItem(zoneId: string) {
    setCollected(zoneId, false)
    if (useAppStore.getState().surveyZoneSelection?.zoneId === zoneId) setSelection(null)
  }

  function closeItemTab(zoneId: string, tabId: string, subject: string, chosen?: WorkbenchProjectionSelection) {
    const state = useAppStore.getState(), tab = state.tabs[tabId]
    // Zone composition can contain a synthetic unplaced Group. Only original placements authorize a close.
    const choices = (catalog?.locations ?? []).filter(location => location.zoneId === zoneId && location.tabId === tabId &&
      location.regionId === tab?.layout.activeRegionId && location.workspaceId === tab?.workspaceId &&
      state.layouts[location.displayWorkspaceId]?.groups.some(group => group.id === location.groupId && group.tabOrder.includes(tabId)) &&
      groupIds(state.layouts[location.displayWorkspaceId]!.root).includes(location.groupId))
      .filter((location, index, all) => all.findIndex(other => sameWorkbenchProjectionSelection(other, location)) === index)
    const active = state.surveyZoneSelection?.zoneId === zoneId ? state.surveyZoneSelection.active : null
    const shown = active?.tabId === tabId ? projection?.selection.filter(reference => reference.tabId === tabId && reference.regionId === active.regionId) ?? [] : []
    const reference = chosen ? choices.find(choice => sameWorkbenchProjectionSelection(choice, chosen))
      : (shown.length === 1 ? choices.find(choice => sameWorkbenchProjectionSelection(choice, shown[0]!)) : undefined) ?? (choices.length === 1 ? choices[0] : undefined)
    if (!reference && !chosen && choices.length > 1) { setLocationChoice({ kind: 'close', zoneId, subject, choices }); return }
    const group = reference && state.layouts[reference.displayWorkspaceId]?.groups.find(group => group.id === reference.groupId && group.tabOrder.includes(tabId))
    if (!reference || !group) { setError('This original Tab is still restoring. Its content and reference are kept.'); return }
    setLocationChoice(null)
    intent.current += 1
    void tabClose.request({ workspaceId: reference.displayWorkspaceId, group, tabIds: [tabId], subject })
  }

  function closePage(page: SurveyPageSelection, chosen?: WorkbenchProjectionSelection) {
    const state = useAppStore.getState(), owner = surveyPageOwner(state.tabs, page, catalog)
    if (!owner || owner.surface.kind !== 'browser') { setError('The original Browser is unconfirmed. You can remove this exact Survey reference from its menu.'); return }
    const choices = (catalog?.locations ?? []).filter(location => location.tabId === owner.tab.id && location.regionId === page.regionId &&
      state.layouts[location.displayWorkspaceId]?.groups.some(group => group.id === location.groupId && group.tabOrder.includes(owner.tab.id)) &&
      groupIds(state.layouts[location.displayWorkspaceId]!.root).includes(location.groupId))
      .filter((location, index, all) => all.findIndex(other => sameWorkbenchProjectionSelection(other, location)) === index)
    const shown = pageSelection?.regionId === page.regionId && pageSelection.browserId === page.browserId ? projection?.selection : undefined
    const reference = chosen ? choices.find(choice => sameWorkbenchProjectionSelection(choice, chosen))
      : shown?.length === 1 ? choices.find(choice => sameWorkbenchProjectionSelection(choice, shown[0]!)) : choices.length === 1 ? choices[0] : undefined
    if (!reference && !chosen && choices.length > 1) { setLocationChoice({ kind: 'close-page', page, choices }); return }
    const group = reference && state.layouts[reference.displayWorkspaceId]?.groups.find(group => group.id === reference.groupId && group.tabOrder.includes(owner.tab.id))
    if (!reference || !group) { setError('The original page location is unconfirmed. Its content and exact reference are kept; choose its current location.'); return }
    setLocationChoice(null)
    if (workbenchSurfaces(owner.tab).length > 1) {
      state.requestCloseRegion(reference.displayWorkspaceId, owner.tab.id, page.regionId, reference.groupId)
      return
    }
    void tabClose.request({ workspaceId: reference.displayWorkspaceId, group, tabIds: [owner.tab.id], subject: owner.surface.title || 'Page' })
  }

  function newItemNote(zoneId: string, chosen?: WorkbenchProjectionSelection) {
    const state = useAppStore.getState()
    const candidates = itemReferences(zoneId).filter(reference => state.tabs[reference.tabId]?.regions[reference.regionId]?.kind === 'browser')
    const active = selection?.zoneId === zoneId ? selection.active : null
    const exact = chosen ?? active
    const confirmed = exact ? candidates.find(reference => reference.displayWorkspaceId === exact.displayWorkspaceId && reference.groupId === exact.groupId && reference.tabId === exact.tabId && reference.regionId === exact.regionId) : undefined
    const reference = confirmed ?? (!chosen && candidates.length === 1 ? candidates[0] : undefined)
    if (!reference && !chosen && candidates.length > 1) { setLocationChoice({ kind: 'note', zoneId, choices: candidates }); return }
    const browser = reference ? state.tabs[reference.tabId]?.regions[reference.regionId] : null
    if (!reference || browser?.kind !== 'browser') {
      // An active Agent/File is not a Browser source; offer the original Browser choices instead.
      if (!chosen && candidates.length) { setLocationChoice({ kind: 'note', zoneId, choices: candidates }); return }
      setError('This item’s original browser source is not confirmed. Its work surface is kept; open the original page and retry.'); return
    }
    setLocationChoice(null)
    setRecallCapture({ draftId: `survey-new-note:${zoneId}:${browser.browserId}:${encodeURIComponent(browser.url)}`,
      source: { sourceId: mintObjectId(), url: browser.url, title: browser.title || itemTitle(catalog!.zones.find(zone => zone.zoneId === zoneId)!), recordedAt: Date.now(),
        position: { zoneId, tabId: reference.tabId, regionId: reference.regionId } } })
  }

  async function createItemBrowser(preparation: SurveyBrowserPreparation) {
    // Each independent creation retains its own recovery; another success cannot clear it.
    const key = JSON.stringify([preparation.zone.zoneId, preparation.reference?.tabId, preparation.reference?.regionId])
    let original = preparation
    setItemBrowserRecoveries(previous => previous[key] ? { ...previous, [key]: { ...previous[key]!, pending: true } } : previous)
    try {
      await useAppStore.getState().createSurveyBrowser({ workspaceId: preparation.zone.workspaceId, url: 'about:blank', preparation,
        onPrepared(value) { original = value } })
      setItemBrowserRecoveries(previous => { const { [key]: _recovered, ...remaining } = previous; return remaining })
      return true
    } catch (cause) {
      setItemBrowserRecoveries(previous => ({ ...previous, [key]: { preparation: original, pending: false,
        message: `Browser could not open: ${presentError(cause)}. The original page and existing content are kept.` } }))
      return false
    }
  }

  function prepareItemTab(zone: AgentMuxZoneFact, target: Pick<WorkbenchProjectionSelection, 'displayWorkspaceId' | 'groupId'>, needsEnvironment = false) {
    if (needsEnvironment && profileViewRecovery) { setError('Choose an environment for this new page. Existing research and pages are kept.'); return null }
    const id = useAppStore.getState().openLauncher({ workspaceId: zone.workspaceId, displayWorkspaceId: target.displayWorkspaceId,
      tabGroupId: target.groupId, zoneId: zone.zoneId, reveal: false })
    const tab = id ? useAppStore.getState().tabs[id] : null
    if (!tab) { setError('The original display location is still restoring. Existing content is kept.'); return null }
    return { zone, mode: 'normal' as const, url: 'about:blank', entry: 'research' as const, membership: useAppStore.getState().surveyPageReferences,
      ...(profileView.kind === 'profile' ? { profileId: profileView.profileId } : {}),
      reference: { ...target, tabId: tab.id, regionId: tab.layout.activeRegionId }, surface: tab.regions[tab.layout.activeRegionId]! }
  }

  async function newItemTab(zoneId: string, kind: 'agent' | 'browser' | 'tab', chosen?: WorkbenchProjectionSelection) {
    const before = useAppStore.getState(), zone = catalog?.zones.find(zone => zone.zoneId === zoneId)
    const candidates = itemReferences(zoneId).filter(reference => before.layouts[reference.displayWorkspaceId]?.groups.some(group => group.id === reference.groupId && group.tabOrder.includes(reference.tabId)))
    const groups = new Set(candidates.map(reference => JSON.stringify([reference.displayWorkspaceId, reference.groupId])))
    const active = selection?.zoneId === zoneId ? selection.active : null
    const exact = chosen ?? active
    const confirmed = exact ? candidates.find(reference => reference.displayWorkspaceId === exact.displayWorkspaceId && reference.groupId === exact.groupId && reference.tabId === exact.tabId && reference.regionId === exact.regionId) : undefined
    const reference = confirmed ?? (!chosen && groups.size === 1 ? candidates[0] : undefined)
    if (!reference && !chosen && candidates.length) { setLocationChoice({ kind, zoneId, choices: candidates }); return }
    const layout = zone ? before.layouts[zone.workspaceId] : undefined
    const emptyTarget = !chosen && !candidates.length && zone && layout?.groups.some(group => group.id === layout.activeGroupId && groupIds(layout.root).includes(group.id))
      ? { displayWorkspaceId: zone.workspaceId, groupId: layout.activeGroupId } : undefined
    const target = reference ?? emptyTarget
    if (!zone || !target) { setError('This item’s original display location is not confirmed. Its content is kept; restore that item and retry.'); return }
    const preparation = prepareItemTab(zone, target, kind === 'browser')
    if (!preparation) return
    setLocationChoice(null)
    if (kind === 'agent') useLauncherState.getState().setSection(zone.workspaceId, 'agents', 'expanded')
    intent.current += 1
    setError(null)
    setSelection(surveySelectReference(surveyInitialZoneSelection(catalog!, zoneId, before.layouts, before.tabs, target.displayWorkspaceId), preparation.reference))
    if (kind === 'browser') await createItemBrowser(preparation)
  }

  const newItemAgent = (zoneId: string, chosen?: WorkbenchProjectionSelection) => { void newItemTab(zoneId, 'agent', chosen) }

  function saveToTopic(zone: AgentMuxZoneFact | undefined, scope: 'research' | 'panel'): void {
    const targetPanel = selection?.zoneId === zone?.zoneId ? currentPanel : null
    if (!zone || !collected[zone.zoneId] || (scope === 'panel' && !targetPanel)) return
    const panel = targetPanel ? tabs[targetPanel.tabId]?.regions[targetPanel.regionId] : null
    // Capture original durable references once; later navigation cannot retarget this draft.
    setCapture({ title: `${scope === 'panel' ? 'Current panel' : 'Research'}: ${itemTitle(zone)}`,
      sources: [{ kind: 'survey', zoneId: zone.zoneId,
        ...(scope === 'panel' && targetPanel ? { tabId: targetPanel.tabId, regionId: targetPanel.regionId } : {}) },
        ...[...new Set((scope === 'panel' ? panel?.kind === 'browser' ? [panel] : []
          : (tabsByZone.get(zone.zoneId) ?? []).flatMap(tabId => workbenchSurfaces(tabs[tabId]!).filter(surface => surface.kind === 'browser')))
          .filter(surface => surface.url !== 'about:blank').map(surface => surface.url))].map(url => ({ kind: 'url' as const, url }))],
      noteIds: pages.filter(page => page.workface?.zoneId === zone.zoneId && (scope !== 'panel' || panel?.kind === 'file' && page.resource.workspaceId === panel.workspaceId && page.resource.path === panel.path)).map(page => page.noteId) })
  }

  function saveToRecall(): void {
    if (!currentBrowser || currentBrowser.url === 'about:blank' || !currentZone || !currentPanel) return
    setRecallCapture({ draftId: `survey-recall:${currentBrowser.browserId}:${encodeURIComponent(currentBrowser.url)}`,
      source: { sourceId: mintObjectId(), url: currentBrowser.url, title: currentBrowser.title ?? null, recordedAt: Date.now(),
        position: { zoneId: currentZone.zoneId, tabId: currentPanel.tabId, regionId: currentPanel.regionId } } })
  }

  function pinOptions(reference: AgentMuxSurveyPinReference) {
    const pinned = pinnedKeys.has(surveyPinKey(reference))
    return { pinned, onPinChange(value: boolean) {
      const requestId = mintObjectId()
      void useAppStore.getState().executeControl({ schemaVersion: 5, requestId, operation: 'space.survey-list',
        pin: { reference, pinned: value, expectedPinned: pinned } }).then(result => {
        if (result.operation !== 'space.survey-list') { setError('The original pin operation returned another result. Its item and current preferences are kept.'); return }
        if (result.issues.length) setError(`[${requestId}] ${result.issues.map(issue => issue.message + ' ' + issue.recovery).join(' ')}`)
      }).catch(cause => setError(`[${requestId}] ${presentError(cause)}`))
    } }
  }

  function itemOptionsFor(zone: AgentMuxZoneFact | undefined, activityDetails = zone ? activity(zone).details : null): SurveyItemOptionsProps {
    const bindings = zone ? catalog?.bindings.filter(binding => binding.zoneId === zone.zoneId) ?? [] : []
    const members = zone ? catalog?.tabs.filter(tab => tab.zoneId === zone.zoneId) ?? [] : []
    const moveTabId = zone?.zoneId === selection?.zoneId ? selection?.active?.tabId : members.length === 1 ? members[0]!.tabId : undefined
    return {
      onSelectContent: () => { if (sidebarCollapsed) setSidebarCollapsed(false); setSelectingContent(true) },
      visible: visible && !controlsCoverPage, title: zone ? itemTitle(zone) : selection ? 'Retained exploration' : 'New exploration',
      zone: zone ?? null, workspace: zone ? resourceWorkspaces.get(zone.workspaceId) ?? null : null,
      collected: !!zone && collected[zone.zoneId] === true,
      ...(zone && collected[zone.zoneId] ? pinOptions({ kind: 'zone', zoneId: zone.zoneId }) : {}),
      ...(zone && collected[zone.zoneId] ? { grouping: list.groupingFor(zone.zoneId) } : {}),
      relatedSpaces: zone && catalog ? bindings.flatMap(binding => catalog.spaces.filter(space => space.spaceId === binding.spaceId)) : null,
      relatedSpacesUnconfirmed: bindings.some(binding => !catalog?.spaces.some(space => space.spaceId === binding.spaceId && !space.issue)),
      activityDetails,
      currentPanelAvailable: zone?.zoneId === selection?.zoneId && Boolean(currentPanel),
      ...(moveTabId && catalog ? { onMoveTab: () => {
        const source = captureSurveyCompositionSource(useAppStore.getState(), catalog, { kind: 'tab', tabId: moveTabId })
        if (source) setMovingSources([source])
        else setError('This original Tab changed. Its content is kept; choose the current Tab before moving it.')
      } } : {}),
      onSaveToTopic: scope => saveToTopic(zone, scope),
      onCollectedChange: value => { if (zone && !setCollected(zone.zoneId, value)) setError('The original Zone resource is unconfirmed. Its content and selection are kept.') },
      onOpenWorkspace: workspaceId => { intent.current += 1; void selectWorkspace(workspaceId) },
      ...(zone ? {
        onRename: () => { setSidebarCollapsed(false); editItemName(zone, true) },
        onClose: () => closeItem(zone.zoneId),
        onNewNote: () => newItemNote(zone.zoneId), onNewAgent: () => newItemAgent(zone.zoneId),
        onNewBrowser: () => { void newItemTab(zone.zoneId, 'browser') }, onNewTab: () => { void newItemTab(zone.zoneId, 'tab') }
      } : {})
    }
  }
  const options = <SurveyItemOptions key={String(sidebarCollapsed)} {...itemOptionsFor(currentZone)} onManageBrowsers={() => setToolsOpen(!toolsOpen)} />
  const displayedItems = new Map(items.filter(zone => !((notebooks.some(book => book.workface?.zoneId === zone.zoneId) || pages.some(page => page.workface?.zoneId === zone.zoneId)) &&
            (tabsByZone.get(zone.zoneId) ?? []).length > 0 && (tabsByZone.get(zone.zoneId) ?? []).every(tabId => !!tabs[tabId] && workbenchSurfaces(tabs[tabId]!).every(surface => surface.kind === 'file' && pages.some(member => member.resource.workspaceId === surface.workspaceId && member.resource.path === surface.path))))).map(zone => [zone.zoneId, zone]))
  const defaultProfileId = profiles.profiles?.find(profile => profile.isDefault)?.id
  const profileReferences = useMemo(() => surveyProfileReferences(profileView, pageReferences, Object.keys(collected), tabs, defaultProfileId, catalog),
    [profileView, pageReferences, collected, tabs, defaultProfileId, catalog])
  const currentPageOwner = pageSelection && !pageReferences.some(page => page.regionId === pageSelection.regionId && page.browserId === pageSelection.browserId)
    ? surveyPageOwner(tabs, pageSelection, catalog) : null
  const pageHeaderOwner = pageSelection ? currentPageOwner ?? surveyPageOwner(tabs, pageSelection, catalog) : null
  const currentPageZoneId = currentPageOwner ? catalog?.tabs.find(tab => tab.tabId === currentPageOwner.tab.id)?.zoneId : null
  const itemTitles = new Map([...Object.keys(collected).filter(zoneId => !catalog?.zones.some(zone => zone.zoneId === zoneId)).map(zoneId => [zoneId, 'Retained exploration'] as const), ...[...displayedItems.values()].map(zone => [zone.zoneId, itemTitle(zone)] as const)].filter(([zoneId]) => profileReferences.zoneIds.has(zoneId)))
  const pinnedZoneIds = pinReferences.flatMap(reference => reference.kind === 'zone' && itemTitles.has(reference.zoneId) ? [reference.zoneId] : [])
  const pinnedPages = profileReferences.pages.filter(page => pinnedKeys.has(surveyPinKey({ kind: 'page', ...page })))
  const ordinaryPages = profileReferences.pages.filter(page => !pinnedKeys.has(surveyPinKey({ kind: 'page', ...page })))
  function pageOptionsFor(page: SurveyPageSelection): SurveyItemOptionsProps {
    const surface = surveyPageOwner(tabs, page, catalog)?.surface, browser = surface?.kind === 'browser' ? surface : null
    return { ...itemOptionsFor(undefined, browser ? <span>{browser.url}</span> : <span>Original Browser unconfirmed; its exact reference is retained.</span>),
      ...pinOptions(page), page, title: browser?.title || 'Retained page', workspace: browser ? resourceWorkspaces.get(browser.workspaceId) ?? null : null,
      onMovePage: () => {
        const source = catalog && captureSurveyCompositionSource(useAppStore.getState(), catalog, page)
        if (source) setMovingSources([source])
        else setError('The original page changed. Its reference is kept; inspect that same Browser before moving it.')
      },
      onClosePage: browser ? () => closePage(page) : undefined,
      onRemovePageReference: () => void removePageReference(page) }
  }
  const pageItems = (references: typeof profileReferences.pages, reorderable = false) => references.length ? <SortableContext items={reorderable ? references.map(surveyPageOrderKey) : []} strategy={verticalListSortingStrategy}><div aria-label="Saved Survey pages">{references.map(page => {
          const owner = surveyPageOwner(tabs, page, catalog), browser = owner?.surface.kind === 'browser' ? owner.surface : null
          const item = (dragHandle?: ReactNode) => <SurveyPageItem dragHandle={dragHandle} {...pinOptions({ kind: 'page', ...page })} selection={selectionFor({ kind: 'page', ...page })} key={JSON.stringify(page)} page={page} browser={browser} enabled={visible && !controlsCoverPage}
            selected={pageSelection?.regionId === page.regionId && pageSelection.browserId === page.browserId} onSelect={() => setSelection({ kind: 'page', ...page })} onClose={browser ? () => closePage({ kind: 'page', ...page }) : undefined}
            onContextMenu={button => { contextOrigin.current = button; setContextItem({ kind: 'page', ...page }) }}
            actions={<SurveyItemOptions {...pageOptionsFor({ kind: 'page', ...page })} rowAction compact />} />
          return reorderable ? <SortableSurveyPage key={JSON.stringify(page)} page={page} order={references} title={browser?.title || 'Retained page'} enabled={visible && !controlsCoverPage}>{item}</SortableSurveyPage> : item()
        })}</div></SortableContext> : null
  const selectionControls = selectingContent ? <div className="survey-composition-toolbar" role="group" aria-label="Select content to combine">
    {selectingContent ? <><span role="status">{selectedSources.length} selected</span><Menu.Root modal={false}>
      <Menu.Trigger asChild><button type="button" disabled={!selectedSources.length} aria-label="Actions for selected content">Actions</button></Menu.Trigger>
      <DocumentOverlayPortal component={Menu.Portal}><Menu.Content className="tab-context-menu" align="start" sideOffset={4}>
        <Menu.Item className="tab-context-menu__item" onSelect={() => { setMovingIntent(null); setMovingSources([...selectedSources]) }}>Move selected to research…</Menu.Item>
        <Menu.Item className="tab-context-menu__item" onSelect={() => { setMovingIntent({ intent: { kind: 'new-research', zoneId: mintObjectId() }, requestId: mintObjectId() }); setMovingSources([...selectedSources]) }}>New research from selected…</Menu.Item>
        <Menu.Sub><Menu.SubTrigger className="tab-context-menu__item" disabled={!canGroupContent(selectedSources)} title="Select one complete Tab or one complete research to organize">Move selected to list group</Menu.SubTrigger>
          <Menu.SubContent className="tab-context-menu">{[{ groupId: null, name: 'Ungrouped' }, ...list.stored.groups].map(group =>
            <Menu.Item key={JSON.stringify(['survey-list-group', group.groupId])} className="tab-context-menu__item" onSelect={() => {
              compositionDrag.current = { sources: [...selectedSources], researchZoneId: completeResearch(selectedSources), requestId: mintObjectId(), reservedZoneId: mintObjectId(), organization: list.stored, editable: list.editable }
              dropComposition({ kind: 'list-group', groupId: group.groupId })
            }}>{group.name || 'Unnamed group'}</Menu.Item>)}</Menu.SubContent>
        </Menu.Sub>
      </Menu.Content></DocumentOverlayPortal></Menu.Root>
      <button type="button" aria-label="Cancel content selection" onClick={() => { setSelectingContent(false); setSelectedSources([]) }}>Cancel</button>
    </> : null}
  </div> : null

  const windowControlsInset = isMacPlatform() ? <span className="survey-window-controls-inset" aria-hidden="true" /> : undefined

  return <section ref={surfaceRef} className="global-survey-surface" data-sidebar-collapsed={sidebarCollapsed} data-native-window-controls={isMacPlatform()}
    style={{ ...surveyThumbnailStyle(config?.browser.surveyThumbnails), '--survey-navigation-width': `${sidebarCollapsed ? 40 : effectiveSidebarWidth}px` } as CSSProperties} aria-label="Survey" hidden={!visible} inert={!visible} aria-hidden={!visible}>
    <nav ref={sidebarRef} className={`survey-navigation${isResizing ? ' survey-tabs--resizing' : ''}`} aria-label="Exploration navigation" data-collapsed={sidebarCollapsed} inert={controlsCoverPage}>
      <div className="survey-titlebar project-rail-titlebar" role="group" aria-label="Survey window controls">
        <button type="button" className="survey-icon-button" aria-label={sidebarCollapsed ? 'Show Survey items' : 'Hide Survey items'} title={sidebarCollapsed ? 'Show Survey items' : 'Hide Survey items'} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>{sidebarCollapsed ? <ThemeLayoutOpenLeftIcon size={16} /> : <ThemeLayoutCloseLeftIcon size={16} />}</button>
      </div>
      <aside className="survey-tabs" aria-label="Survey items" data-survey-workspace-id={resourceWorkspaceId ?? undefined}>
        <SurveyProfilePicker active={visible && !controlsCoverPage} value={profileView} profiles={profiles} unknown={Boolean(profileViewRecovery)} collapsed={sidebarCollapsed} onExpand={() => setSidebarCollapsed(false)}
          onChange={view => { intent.current += 1; setError(null); void useAppStore.getState().setSurveyProfileView(view).then(save => { if (save.reason) setError('The environment view is kept; saving is unconfirmed. ' + save.reason) }).catch(cause => setError(presentError(cause))) }}
          onRefresh={() => void browserProfiles.refresh()} />
        {profileViewRecovery ? <p role="status" className="survey-relation-notice">{profileViewRecovery.issue}</p> : null}
        {pinReadRecovery ? <p className="survey-relation-notice" role="status">{pinReadRecovery.issue}</p> : null}
        {pageReadRecovery ? <p className="survey-relation-notice" role="status" data-survey-page-read-recovery>
          {pageReadRecovery.issue}
          <button type="button" className="survey-tab-view" onClick={() => void useAppStore.getState().retrySurveyPagesRead()}>
            Read original page references again
          </button>
        </p> : null}
        <SurveyItemContextMenu returnFocus={() => contextOrigin.current} {...(contextItem?.kind === 'page' ? pageOptionsFor(contextItem) : itemOptionsFor(contextZone))} grouping={contextZone ? list.groupingFor(contextZone.zoneId, contextOrganization.current) : undefined}>
        {pendingCompositions.length > 0 ? <div className="survey-composition-recovery" role="status">
          {unresolvedCompositions.map(operation => <button key={operation.requestId} type="button" onClick={() => setReviewingComposition(operation.requestId)}>Review combination · {operation.sources.length} {operation.sources.every(source => source.kind === 'page') ? 'pages' : 'items'}</button>)}
          {pendingCompositions.length > unresolvedCompositions.length ? <details><summary>A saved combination record could not be read</summary><p>The original record is kept. Other content and combinations remain available.</p><pre>{JSON.stringify(pendingCompositions.filter(entry => !isSurveyCompositionRecovery(entry)), null, 2)}</pre></details> : null}
        </div> : null}
        <SurveyItemList leading={selectionControls} pinnedZoneIds={pinnedZoneIds} pinnedPages={pageItems(pinnedPages)} trailing={pageItems(ordinaryPages, true)} pageOrder={{ references: pageReferences, commit(next, expected) {
          const requestId = mintObjectId()
          void useAppStore.getState().executeControl({ schemaVersion: 5, requestId, operation: 'space.survey-list',
            collection: { pageReferences: [...next], expectedPageReferences: [...expected] } }).then(result => {
              if (result.operation !== 'space.survey-list') { setError('The original page order returned another result. Its references are kept.'); return }
              if (result.issues.length) setError(`[${requestId}] ${result.issues.map(issue => issue.message + ' ' + issue.recovery).join(' ')}`)
            }).catch(cause => setError(`[${requestId}] ${presentError(cause)}`))
        } }} composition={{ start: startComposition, canDrop: canCompose, drop: dropComposition }} model={list} titles={itemTitles} selectedZoneId={selection?.zoneId ?? currentPageZoneId ?? undefined} visible={visible && !controlsCoverPage} renderItem={(zoneId, dragHandle, compositionEnabled) => {
          const zone = displayedItems.get(zoneId)
          if (!zone) return <div className="survey-item-row" data-survey-zone-id={zoneId} data-selected={selection?.zoneId === zoneId}>
            {dragHandle}<button type="button" className="survey-item" aria-label="Show retained survey item" onClick={() => chooseZone(zoneId)}><ThemeStatusUnknownIcon size={14} /><strong>Retained exploration</strong></button>
            <span className="survey-relation-notice" role="status">Original source is not confirmed. Its reference is kept.</span>
            <div className="survey-item-shortcuts"><button type="button" className="survey-item-tab-close" aria-label="Remove retained exploration from Survey" title="Remove from Survey" onClick={() => closeItem(zoneId)}><ThemeActionCloseIcon size={12} /></button><SurveyItemOptions {...itemOptionsFor(undefined)} {...pinOptions({ kind: 'zone', zoneId })} rowAction compact title="Retained exploration" /></div>
          </div>
            const status = activity(zone)
            const itemTabs = [...new Set(itemReferences(zone.zoneId).map(reference => reference.tabId))]
            const itemOptions = itemOptionsFor(zone, status.details)
            return <SurveyZoneItem pinned={pinnedKeys.has(surveyPinKey({ kind: 'zone', zoneId }))} selection={selectionFor({ kind: 'research', zoneId: zone.zoneId })} compositionEnabled={compositionEnabled} dragHandle={dragHandle} key={zone.zoneId} zone={zone} title={itemTitle(zone)} glyph={itemGlyph(zone)} selected={selection?.zoneId === zone.zoneId || currentPageZoneId === zone.zoneId}
              showTitle={selectingContent || sidebarCollapsed || itemTabs.length < 2 || Boolean(explorationNames[zone.zoneId]?.trim())}
              tabColumns={itemTabs.length > 1 ? <div className="survey-item-tabs" aria-label={`Tabs in ${itemTitle(zone)}`}>{itemTabs.map(tabId => <SurveyTabColumn active={visible && !controlsCoverPage && !sidebarCollapsed} selection={selectionFor({ kind: 'tab', tabId })} compositionEnabled={compositionEnabled} key={tabId} tab={tabs[tabId]!} unconfirmedBrowserRegionIds={unconfirmedBrowserRegionIds} selected={selection?.zoneId === zone.zoneId && selection.active?.tabId === tabId || currentPageOwner?.tab.id === tabId} onSelect={() => chooseTab(zone.zoneId, tabId)} onClose={title => closeItemTab(zone.zoneId, tabId, title)} />)}</div> : null}
              onCloseSingleTab={itemTabs.length === 1 ? () => closeItemTab(zone.zoneId, itemTabs[0]!, itemTitle(zone)) : undefined}
              options={<SurveyItemOptions {...itemOptions} rowAction compact />}
              onContextMenu={button => { contextOrigin.current = button; contextOrganization.current = list.stored; setContextItem({ kind: 'zone', zoneId: zone.zoneId }) }} activity={status.summary} activityDescription={status.description} editing={renamingZoneId === zone.zoneId} nameDraft={itemNameDraft.current?.zoneId === zone.zoneId ? itemNameDraft.current : undefined} onEdit={editing => editItemName(zone, editing)}
              onRename={async (name, revision) => { const applied = await useAppStore.getState().setSurveyExplorationName(zone.zoneId, name, revision); if (!applied) setError('The exploration source or name revision is unconfirmed. Your name draft is kept here.'); return applied }} onSelect={chooseZone} />
        }} />
        </SurveyItemContextMenu>
      </aside>
      {locationChoice ? <SurveyPanelChoices mode="button" open visible={visible && !controlsCoverPage} choices={locationChoice.choices} facts={useAppStore.getState()}
        onOpenChange={open => { if (!open) setLocationChoice(null) }} onSelect={reference => locationChoice.kind === 'close-page' ? closePage(locationChoice.page, reference) : locationChoice.kind === 'close' ? closeItemTab(locationChoice.zoneId, reference.tabId, locationChoice.subject, reference) : locationChoice.kind === 'note' ? newItemNote(locationChoice.zoneId, reference) : void newItemTab(locationChoice.zoneId, locationChoice.kind, reference)} /> : null}
      {tabClose.dialog}
      {reviewingOperation ? <SurveyCompositionResultDialog key={reviewingOperation.requestId} operation={reviewingOperation} visible={visible && !controlsCoverPage} onClose={() => setReviewingComposition(null)} /> : null}
      {movingSources ? <SurveyMoveTabsDialog onUnconfirmed={setReviewingComposition} onMoved={() => setSelectedSources(current => current.filter(source => !movingSources.includes(source)))} {...(movingIntent ?? {})} sources={movingSources} catalog={catalog} visible={visible && !controlsCoverPage} onClose={() => { setMovingSources(null); setMovingIntent(null) }} /> : null}
      <div className="survey-sidebar-actions"><button type="button" className="survey-new-page" aria-label="New webpage" title="New browser" disabled={opening} onClick={() => void openBrowser('about:blank', true)}><ThemeActionCreateBrowserIcon size={16} /><span>New browser</span></button>
        <Menu.Root modal={false} open={visible && !controlsCoverPage && createMenuOpen} onOpenChange={setCreateMenuOpen}>
          <Menu.Trigger asChild><button type="button" className="survey-icon-button" aria-label="New browser options" title="New browser options" disabled={opening}><ThemeNavigationDisclosureIcon size={12} /></button></Menu.Trigger>
          <DocumentOverlayPortal component={Menu.Portal}><Menu.Content className="tab-context-menu" align="start" side="top" sideOffset={4} collisionPadding={8}>
            <Menu.Item className="tab-context-menu__item" onSelect={() => void openBrowser('about:blank', true, 'private')}><ThemeObjectBrowserIcon size={14} /><span>New private page</span></Menu.Item>
          </Menu.Content></DocumentOverlayPortal>
        </Menu.Root>
      </div>
      <div className="survey-item-actions" role="group" aria-label="Current exploration actions">{options}
        {currentBrowser && currentBrowser.url !== 'about:blank' && currentPanel ? <button type="button" className="survey-tab-view" aria-label="Save to Recall" title="Save this finding to Recall" onClick={saveToRecall}>
          <ThemeActionCollectSourcesIcon size={14} />{sidebarCollapsed ? null : <span>Save to Recall…</span>}
        </button> : null}
      </div>
      <div ref={resizeHandle} className="survey-width-handle" role="separator" tabIndex={0} aria-label="Resize Survey items" title="Drag to resize Survey items · Double-click or Enter to reset"
        hidden={sidebarCollapsed}
        aria-orientation="vertical" aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={effectiveSidebarWidth} onMouseDown={onResizeStart} onDoubleClick={onResizeReset}
        onKeyDown={event => {
          if (event.key === 'Enter') { onResizeReset(event); return }
          const next = event.key === 'Home' ? minWidth : event.key === 'End' ? maxWidth : event.key === 'ArrowLeft' ? effectiveSidebarWidth - 16 : event.key === 'ArrowRight' ? effectiveSidebarWidth + 16 : null
          if (next === null) return
          event.preventDefault(); event.stopPropagation(); setSidebarWidth(next)
        }} />
    </nav>
    <div className="survey-content">
      <div className="survey-page-content" inert={controlsCoverPage} aria-hidden={controlsCoverPage}>
        {error ? <div className="survey-error" role="alert">
          <span>{error}</span>
          <div className="survey-error__actions">
            {failedCreation.current?.createdBrowser ? <button type="button" className="small-button" disabled={opening} onClick={showOriginalPage}>Show original page</button> : null}
            {failedCreation.current && !failedCreation.current.admission?.issues.some(issue => issue.code === 'SURVEY_PAGE_MEMBERSHIP_SUPERSEDED') ? <button type="button" className="small-button" disabled={opening} onClick={() => void openBrowser(query.trim() ? query : 'about:blank')}>{failedCreation.current.admission ? 'Retry Survey registration' : 'Retry original item'}</button> : null}
          </div>
        </div> : null}
        {Object.entries(itemBrowserRecoveries).map(([key, recovery]) => <div key={key} className="survey-error" role="alert" data-survey-browser-recovery={recovery.preparation.reference?.regionId}>
          <span>{recovery.message}</span>
          <div className="survey-error__actions"><button type="button" className="small-button" disabled={recovery.pending} onClick={() => void createItemBrowser(recovery.preparation)}>{recovery.pending ? 'Retrying original page…' : 'Retry original page'}</button></div>
        </div>)}
        {pageSelection ? <>{pageSelection.presentationReadRecovery ? <div className="survey-relation-notice" role="status">{pageSelection.presentationReadRecovery.issue}</div> : null}
          {projection ? <WorkspaceWorkbench workspaceId={projection.displayWorkspaceId}
          projection={projection} viewOwnership="projection" viewTargets={viewTargets} visible={visible && !controlsCoverPage}
          projectionHeader={pageHeaderOwner?.surface.kind === 'browser' ? <SurveyPageTabHeader tabId={pageHeaderOwner.tab.id} browser={pageHeaderOwner.surface}
            visible={visible && !controlsCoverPage} leadingChrome={windowControlsInset} creating={opening}
            onClose={() => closePage(pageSelection)} onCreate={() => void openBrowser('about:blank', true)} /> : null}
          leadingChrome={windowControlsInset} onCreateTab={groupId => void newBrowserTab(projection.displayWorkspaceId, groupId)} />
          : <div role="status" className="survey-relation-notice">
            {pageSelection.presentation ? <>The selected Tab location is not confirmed. The original Browser and saved selection are kept.
              <button type="button" className="note-text-button" onClick={() => setSelection({ kind: 'page', regionId: pageSelection.regionId, browserId: pageSelection.browserId })}>Show original page</button></>
              : 'The original Browser Region is not confirmed. Its page reference is kept; inspect the same Region and Browser before choosing its original location.'}
          </div>}</> : !selection ? <BrowserStartPage config={resolveBrowserStartPage(config?.browser.startPage)} visible={visible && !controlsCoverPage} historyRevision={historyRevision}
          historyTarget={workspace && !profileViewRecovery && (profileView.kind === 'default' || profileView.profileId === defaultProfileId) ? { kind: 'workspace', workspaceId: workspace.id } : null}
          onChooseHistory={value => { setQuery(value); browserInput.current?.submit(value) }}>
          <form className="browser-start-page__input" onSubmit={event => { event.preventDefault(); browserInput.current?.submit() }}>
            <BrowserAddressInput ref={browserInput} value={query} aria-label="Search or enter a web address" placeholder="Search or enter a web address" disabled={opening} historyTarget={workspace && !profileViewRecovery && (profileView.kind === 'default' || profileView.profileId === defaultProfileId) ? { kind: 'workspace', workspaceId: workspace.id } : null} onValueChange={value => { setQuery(value); setError(null) }} onSubmit={value => { if (value.trim()) void openBrowser(value) }} onHistoryNotice={setInputHistoryNotice} onHistoryChange={() => setHistoryRevision(value => value + 1)} onDeferredHistoryFailure={message => useAppStore.getState().reportError(message, { kind: 'process-degraded' })} />
            <button type="submit" aria-label="Search or open page" disabled={opening || !query.trim()}>{opening ? <ThemeStatusLoadingIcon animation="spin" size={16} /> : <ThemeActionOpenExternalIcon size={16} />}</button></form>{inputHistoryNotice ? <p className="survey-relation-notice" role="status">{inputHistoryNotice}</p> : null}
        </BrowserStartPage> : <>
          {currentZone && !items.some(item => item.zoneId === currentZone.zoneId) ? <div className="survey-relation-notice" role="status">
            This work surface is outside the Survey list. Its content and selection are kept. Start an independent research from the page’s Research in Survey action.
          </div> : null}
          <WorkbenchZone zoneId={selection.zoneId} catalog={catalog} projection={projection} viewTargets={viewTargets}
            onCreateTab={(displayWorkspaceId, groupId) => void newBrowserTab(displayWorkspaceId, groupId)}
            onStartBrowsing={() => void openBrowser('about:blank', true)} leadingChrome={windowControlsInset} visible={visible && !controlsCoverPage} />
        </>}
      </div>
      {workspace && (toolsVisited || toolsOpen) ? <aside ref={managementRef} id="survey-management" className="survey-management" aria-label="Browser management controls" hidden={!toolsOpen} inert={!toolsOpen || !visible} aria-hidden={!toolsOpen || !visible}>
        <header><strong>Browser tools · {workspace.name}</strong><button type="button" aria-label="Close browser management" onClick={() => setToolsOpen(false)}><ThemeActionCloseIcon size={14} /></button></header><BrowserToolsPanel workspace={workspace} visible={visible && toolsOpen} />
      </aside> : null}
    </div>
    <SurveyRecallCapture target={visible && !controlsCoverPage ? recallCapture : null} onClose={() => setRecallCapture(null)} />
    <TopicKnowledgeCapture target={visible && !controlsCoverPage ? capture : null} onClose={() => setCapture(null)} onSaved={entry => {
      const noteIds = capture?.noteIds ?? []
      if (!noteIds.length) return
      void (async () => {
        const result = await api.topics.call('topic.inspect', { topicId: entry.topicId })
        if (!result.topic || result.topic.readError) throw new Error('Knowledge was saved. Its Topic content identity is unconfirmed; Note history is kept.')
        const topic = result.topic
        await recordNotebookChanges(noteIds.map(noteId => ({ kind: 'organize', noteId,
          topic: { topicId: entry.topicId, spaceId: directoryIdentity(topic.hostId, topic.directoryPath) } })), 'topic-knowledge:' + entry.entryId)
      })().catch(cause => setError(presentError(cause)))
    }} />
  </section>
})
