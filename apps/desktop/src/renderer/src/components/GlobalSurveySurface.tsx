import { mintObjectId } from '@agentmux/core/object-id'
import { recordNotebookChanges, retryNotebookRecoveries, useNotebookLibrary } from '../lib/notebook-library'
import { surveyExplorationName } from '../lib/survey-exploration-name'
import { spatialCatalog } from '../lib/space-agent-control'
import { sessionPresentationById } from '../lib/session-presentation'
import type { AgentMuxSpaceCatalog, AgentMuxZoneFact, TopicKnowledgeSource } from '@agentmux/core/control'
import { ArrowUpRight, Bot, CircleHelp, FileText, Globe2, PanelsTopLeft, PanelLeftClose, PanelLeftOpen, NotebookPen, LoaderCircle, Plus, X } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useStore } from 'zustand'
import type { SurveyBrowserPreparation } from '../lib/survey-browser-creation'
import { scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useReleasedBrowserRegionIds } from '../lib/surface-memory-budget-coordinator'
import { surveyInitialZoneSelection, surveySelectReference, surveySelectedBrowser, surveyZoneItems, type ResolvedSurveyZoneSelection } from '../lib/survey-workface'
import { workbenchProjectionSlotId, workbenchRegionProjectionSlotId, type WorkbenchProjection, type WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { workbenchSurfaces } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { BrowserAddressInput, type BrowserAddressInputHandle } from './BrowserAddressInput'
import { BrowserToolsPanel } from './BrowserToolsPanel'
import { SurveyZoneItem } from './SurveyZoneItem'
import { SurveyStartBrand } from './SurveyStartBrand'
import { resolveWorkbenchZone } from '../lib/workbench-projection'
import { SelectorPresence, type SelectorPresenceAgent } from './SelectorList'
import { SurveyItemOptions } from './SurveyItemOptions'
import { TopicKnowledgeCapture } from './TopicKnowledgeEditor'
import { SurveyRecallCapture } from './SurveyRecallCapture'
import type { SurveyRecallCapture as RecallCaptureTarget } from '../lib/survey-recall-capture'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import { WorkbenchZone } from './WorkbenchZone'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { surveySidebarBounds } from '../lib/survey-sidebar-width'
import { clampSidebarResizeWidth, useSidebarResize } from '../hooks/useSidebarResize'
import { isMacPlatform } from '../lib/host-platform'
import { api } from '../lib/api'
import { useLauncherState } from '../lib/launcher-state'
import { directoryIdentity } from '../../../shared/space-addresses'

export const GlobalSurveySurface = memo(function GlobalSurveySurface({ visible = true, controlsCoverPage = false, unconfirmedBrowserRegionIds, catalog, projection, selection, viewTargets, onSelectReference }: {
  visible?: boolean
  controlsCoverPage?: boolean
  unconfirmedBrowserRegionIds?: ReadonlySet<string> | undefined
  catalog: AgentMuxSpaceCatalog | null
  projection: WorkbenchProjection | null
  selection: ResolvedSurveyZoneSelection | null
  onSelectReference?: (reference: WorkbenchProjectionSelection) => void
  viewTargets?: Parameters<typeof WorkspaceWorkbench>[0]['viewTargets']
}) {
  const library = useNotebookLibrary(state => state.state)
  const notebooks = useMemo(() => Object.values(library?.notebooks ?? {}), [library])
  const pages = useMemo(() => Object.values(library?.pages ?? {}), [library])
  const config = useAppStore(state => state.config)
  const browserInput = useRef<BrowserAddressInputHandle>(null)
  const [inputHistoryNotice, setInputHistoryNotice] = useState<string | null>(null)
  const activeWorkspaceId = useAppStore(state => state.activeWorkspaceId)
  const controlNavigation = useAppStore(state => state.workbenchNavigationInputPolicy !== null)
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
  const topicsWorkspace = config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  const store = useMemo(() => ({ getState: useAppStore.getState, getInitialState: useAppStore.getInitialState,
    subscribe: visible ? useAppStore.subscribe : () => () => {} }), [visible])
  const tabs = useStore(store, state => state.tabs)
  const layouts = useStore(store, state => state.layouts)
  const sessions = useStore(store, state => state.sessions)
  const resourceWorkspaces = useMemo(() => new Map(config?.workspaces.map(workspace => [workspace.id, workspace]) ?? []), [config?.workspaces])
  const currentZone = catalog?.zones.find(zone => zone.zoneId === (selection?.zoneId))
  const resourceWorkspaceId = currentZone?.workspaceId ?? (!selection ? SCRATCH_WORKSPACE_ID : null)
  const workspace = resourceWorkspaceId ? resourceWorkspaces.get(resourceWorkspaceId) : undefined
  const items = useMemo(() => catalog ? surveyZoneItems(catalog, collected) : [], [catalog, collected])
  const tabsByZone = useMemo(() => {
    const result = new Map<string, string[]>()
    for (const tab of catalog?.tabs ?? []) if (tab.zoneId) {
      const members = result.get(tab.zoneId) ?? []; members.push(tab.tabId); result.set(tab.zoneId, members)
    }
    return result
  }, [catalog])
  const related = useMemo(() => {
    if (!currentZone || !catalog) return { spaces: null, unconfirmed: false }
    const spaces = new Map(catalog.spaces.map(space => [space.spaceId, space]))
    const bindings = catalog.bindings.filter(binding => binding.zoneId === currentZone.zoneId)
    return { spaces: bindings.flatMap(binding => spaces.has(binding.spaceId) ? [spaces.get(binding.spaceId)!] : []),
      unconfirmed: bindings.some(binding => !spaces.has(binding.spaceId) || spaces.get(binding.spaceId)?.issue) }
  }, [catalog, currentZone])
  const currentPanel = selection?.active && currentZone && catalog?.tabs.some(tab => tab.tabId === selection.active!.tabId && tab.zoneId === currentZone.zoneId)
    && catalog.regions.some(region => region.regionId === selection.active!.regionId && region.tabId === selection.active!.tabId) ? selection.active : null
  const releasedBrowserRegionIds = useReleasedBrowserRegionIds()
  const currentBrowser = surveySelectedBrowser(tabs, selection)
  const [query, setQuery] = useState('')
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creationNotice, setCreationNotice] = useState<string | null>(null)
  const [capture, setCapture] = useState<{ title: string; sources: TopicKnowledgeSource[]; noteIds: string[] } | null>(null)
  const [recallCapture, setRecallCapture] = useState<RecallCaptureTarget | null>(null)
  const [locationChoice, setLocationChoice] = useState<{ kind: 'note' | 'agent'; zoneId: string; choices: WorkbenchProjectionSelection[] } | null>(null)
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
  const { containerRef: sidebarRef, isResizing, onResizeStart } = useSidebarResize<HTMLElement>({
    isOpen: true, width: sidebarCollapsed ? 40 : sidebarWidth, setWidth: setSidebarWidth, deltaSign: 1, minWidth: sidebarCollapsed ? 40 : minWidth, maxWidth: sidebarCollapsed ? 40 : maxWidth, onDraftWidthChange: reportDraftWidth
  })
  const selectionKey = selection ? JSON.stringify([selection.zoneId, selection.active]) : null
  const intent = useRef(0)
  const failedCreation = useRef<SurveyBrowserPreparation | null>(null)
  useLayoutEffect(() => { intent.current += 1 }, [visible, selectionKey, activeWorkspaceId])
  useEffect(() => { if (toolsOpen) setToolsVisited(true) }, [toolsOpen])
  useEffect(() => {
    if (controlNavigation) return
    const surface = surfaceRef.current
    if (!visible) { if (surface?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur(); return }
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
    const labels = browsers.map(browser => {
      const control = releasedBrowserRegionIds.has(browser.regionId) || unconfirmedBrowserRegionIds?.has(browser.regionId) || browser.nativeOwnerUnavailable || !browser.navigationId
        ? 'unknown' : browser.driving ? 'agent' : browser.activity?.control === 'human' ? 'human' : browser.activity ? 'idle' : 'unknown'
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
      return control === 'agent' ? `Agent operating${operator?.name ? ` · ${operator.name}` : ''}` : control === 'human' ? 'Human control' : control === 'idle' ? 'No active Agent operation' : 'Control unknown · restoring'
    })
    const kinds = new Set(labels)
    const agents = surfaces.filter(surface => surface.kind === 'agent').length
    const description = browsers.length === 1 && !agents ? labels[0] : `${browsers.length ? `${browsers.length} browsers` : `${surfaces.length} regions`}${agents ? ` · ${agents} agents` : ''}${browsers.length ? ` · ${kinds.size === 1 ? labels[0] : 'Mixed control'}` : ''}`
    const detail = labels.map((label, index) => `${browsers[index]!.regionId}: ${label}`).join('\n')
    const unknown = labels.some(label => label.startsWith('Control unknown'))
    const operating = labels.some(label => label.startsWith('Agent operating'))
    // Normal manual control is availability, not activity; keep its facts in Details.
    const Icon = unknown ? CircleHelp : operating && operators.size === 0 ? Bot : null
    return { summary: operators.size || Icon ? <span title={detail} aria-label={description}>
      <SelectorPresence agents={[...operators.values()]} />
      {Icon ? <Icon size={12} aria-hidden="true" /> : null}
    </span> : null,
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
    setError(null)
  }

  async function openBrowser(input = 'about:blank', newItem = false): Promise<void> {
    if (opening) return
    const before = useAppStore.getState()
    const startedIntent = intent.current
    setOpening(true); setError(null)
    try {
      const preparation = await before.createSurveyBrowser({ workspaceId: newItem ? SCRATCH_WORKSPACE_ID : workspace?.id ?? SCRATCH_WORKSPACE_ID, url: input,
        preparation: newItem ? null : failedCreation.current, onPrepared(value) { failedCreation.current = value } })
      const reference = preparation.reference, current = useAppStore.getState()
      failedCreation.current = null
      setCreationNotice(null)
      if (intent.current === startedIntent && current.mainSurface === 'survey' && current.surveyZoneSelection === before.surveyZoneSelection) { setSelection({ zoneId: preparation.zone.zoneId, selection: [reference], active: reference }) }
    } catch (cause) { setError(`Browser could not open: ${presentError(cause)}. Your input and original work surface are kept; retry here.`) }
    finally { setOpening(false) }
  }

  async function newBrowserTab(displayWorkspaceId: string, groupId: string): Promise<void> {
    if (opening || !currentZone || !selection) return
    const before = useAppStore.getState(), held = before.surveyZoneSelection, startedIntent = intent.current
    // Direct entity display does not pretend to be an original durable placement.
    if (!before.layouts[displayWorkspaceId]?.groups.some(group => group.id === groupId)) {
      displayWorkspaceId = currentZone.workspaceId
      groupId = before.layouts[displayWorkspaceId]?.activeGroupId ?? ''
    }
    setOpening(true); setError(null)
    try {
      const tabId = before.openLauncher({ workspaceId: currentZone.workspaceId, displayWorkspaceId, tabGroupId: groupId, zoneId: currentZone.zoneId, reveal: false })
      const tab = tabId ? useAppStore.getState().tabs[tabId] : undefined
      if (!tab) throw new Error('This exact display Group is still restoring. Existing pages are kept.')
      const reference = { displayWorkspaceId, groupId, tabId: tab.id, regionId: tab.layout.activeRegionId }
      failedCreation.current = { zone: currentZone, reference, surface: tab.regions[reference.regionId]! }
      await before.createSurveyBrowser({ workspaceId: currentZone.workspaceId, url: 'about:blank', preparation: failedCreation.current, onPrepared(value) { failedCreation.current = value } })
      failedCreation.current = null
      if (held && intent.current === startedIntent && useAppStore.getState().surveyZoneSelection === held) setSelection(surveySelectReference(held, reference))
    } catch (cause) { setError(`Browser could not open: ${presentError(cause)}. Recover this same page; existing content is kept.`) }
    finally { setOpening(false) }
  }

  function itemProjection(zoneId: string) {
    const state = useAppStore.getState()
    if (!catalog) return null
    return resolveWorkbenchZone(zoneId, catalog, state.layouts, state.tabs, 'survey-workbench', [], () => {})
  }

  function newItemNote(zoneId: string) {
    const original = itemProjection(zoneId), state = useAppStore.getState()
    const active = state.surveyZoneSelection?.zoneId === zoneId ? state.surveyZoneSelection.active : null
    const candidates = original?.selection.filter(reference => state.tabs[reference.tabId]?.regions[reference.regionId]?.kind === 'browser') ?? []
    const reference = candidates.find(reference => reference.tabId === active?.tabId && reference.regionId === active.regionId) ?? candidates[0]
    const browser = reference ? state.tabs[reference.tabId]?.regions[reference.regionId] : null
    if (!reference || browser?.kind !== 'browser') { setError('This item’s original browser source is not confirmed. Its work surface is kept; open the original page and retry.'); return }
    setRecallCapture({ draftId: `survey-new-note:${zoneId}:${browser.browserId}:${encodeURIComponent(browser.url)}`,
      source: { sourceId: crypto.randomUUID(), url: browser.url, title: browser.title || itemTitle(catalog!.zones.find(zone => zone.zoneId === zoneId)!), recordedAt: Date.now(),
        position: { zoneId, tabId: reference.tabId, regionId: reference.regionId } } })
  }

  function newItemAgent(zoneId: string) {
    const original = itemProjection(zoneId), before = useAppStore.getState()
    const zone = catalog?.zones.find(zone => zone.zoneId === zoneId)
    const reference = original?.selection.find(reference => reference.groupId === original.composition?.activeGroupId) ?? original?.selection[0]
    if (!original || !zone || !reference) { setError('This item’s original display location is not confirmed. Its content is kept; restore that item and retry.'); return }
    const id = before.openLauncher({ workspaceId: zone.workspaceId, displayWorkspaceId: reference.displayWorkspaceId,
      tabGroupId: reference.groupId, zoneId, reveal: false })
    const tab = id ? useAppStore.getState().tabs[id] : null
    if (!tab) { setError('The original Agent location is still restoring. Existing content is kept.'); return }
    useLauncherState.getState().setSection(zone.workspaceId, 'agents', 'expanded')
    intent.current += 1
    setError(null)
    setSelection(surveySelectReference(surveyInitialZoneSelection(catalog!, zoneId, before.layouts, before.tabs, reference.displayWorkspaceId),
      { tabId: tab.id, regionId: tab.layout.activeRegionId }))
  }

  function saveToTopic(scope: 'research' | 'panel'): void {
    if (!currentZone || !collected[currentZone.zoneId] || (scope === 'panel' && !currentPanel)) return
    const panel = currentPanel ? tabs[currentPanel.tabId]?.regions[currentPanel.regionId] : null
    // Capture original durable references once; later navigation cannot retarget this draft.
    setCapture({ title: `${scope === 'panel' ? 'Current panel' : 'Research'}: ${itemTitle(currentZone)}`,
      sources: [{ kind: 'survey', zoneId: currentZone.zoneId,
        ...(scope === 'panel' && currentPanel ? { tabId: currentPanel.tabId, regionId: currentPanel.regionId } : {}) },
        ...[...new Set((scope === 'panel' ? panel?.kind === 'browser' ? [panel] : []
          : (tabsByZone.get(currentZone.zoneId) ?? []).flatMap(tabId => workbenchSurfaces(tabs[tabId]!).filter(surface => surface.kind === 'browser')))
          .filter(surface => surface.url !== 'about:blank').map(surface => surface.url))].map(url => ({ kind: 'url' as const, url }))],
      noteIds: pages.filter(page => page.workface?.zoneId === currentZone.zoneId && (scope !== 'panel' || panel?.kind === 'file' && page.resource.workspaceId === panel.workspaceId && page.resource.path === panel.path)).map(page => page.noteId) })
  }

  function saveToRecall(): void {
    if (!currentBrowser || currentBrowser.url === 'about:blank' || !currentZone || !currentPanel) return
    setRecallCapture({ draftId: `survey-recall:${currentBrowser.browserId}:${encodeURIComponent(currentBrowser.url)}`,
      source: { sourceId: mintObjectId(), url: currentBrowser.url, title: currentBrowser.title ?? null, recordedAt: Date.now(),
        position: { zoneId: currentZone.zoneId, tabId: currentPanel.tabId, regionId: currentPanel.regionId } } })
  }

  const options = <SurveyItemOptions key={String(sidebarCollapsed)} visible={visible && !controlsCoverPage} title={currentZone ? itemTitle(currentZone) : selection ? 'Retained exploration' : 'New exploration'}
    zone={currentZone ?? null} workspace={workspace ?? null} collected={!!selection && collected[selection.zoneId] === true} relatedSpaces={related.spaces} relatedSpacesUnconfirmed={related.unconfirmed}
    activityDetails={currentZone ? activity(currentZone).details : null}
    onSaveToTopic={saveToTopic} currentPanelAvailable={Boolean(currentPanel)}
    {...(currentZone ? { onRename: () => { setSidebarCollapsed(false); setRenamingZoneId(currentZone.zoneId) } } : {})}
    onCollectedChange={value => { if (selection && !setCollected(selection.zoneId, value)) setError('The original Zone resource is unconfirmed. Its content and selection are kept.') }}
    onManageBrowsers={() => setToolsOpen(!toolsOpen)} onOpenWorkspace={workspaceId => { intent.current += 1; void selectWorkspace(workspaceId) }} />
  const windowControlsInset = isMacPlatform() ? <span className="survey-window-controls-inset" aria-hidden="true" /> : undefined

  return <section ref={surfaceRef} className="global-survey-surface" data-sidebar-collapsed={sidebarCollapsed} data-native-window-controls={isMacPlatform()}
    style={{ '--survey-navigation-width': `${sidebarCollapsed ? 40 : effectiveSidebarWidth}px` } as CSSProperties} aria-label="Survey" hidden={!visible} inert={!visible} aria-hidden={!visible}>
    <nav ref={sidebarRef} className={`survey-navigation${isResizing ? ' survey-tabs--resizing' : ''}`} aria-label="Exploration navigation" data-collapsed={sidebarCollapsed} inert={controlsCoverPage}>
      <div className="survey-titlebar project-rail-titlebar" role="group" aria-label="Survey window controls">
        <button type="button" className="survey-icon-button" aria-label={sidebarCollapsed ? 'Show Survey items' : 'Hide Survey items'} title={sidebarCollapsed ? 'Show Survey items' : 'Hide Survey items'} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>{sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
      </div>
      <aside className="survey-tabs" aria-label="Survey items" data-survey-workspace-id={resourceWorkspaceId ?? undefined}>
        <div className="survey-page-list">
          {Object.keys(collected).filter(zoneId => !catalog?.zones.some(zone => zone.zoneId === zoneId)).map(zoneId => <div key={zoneId} className="survey-item-row" data-survey-zone-id={zoneId} data-selected={selection?.zoneId === zoneId}>
            <button type="button" className="survey-item" aria-label="Show retained survey item" onClick={() => chooseZone(zoneId)}><CircleHelp size={14} /><strong>Retained exploration</strong></button>
            <span className="survey-relation-notice" role="status">Original source is not confirmed. Its reference is kept.</span>
          </div>)}
          {items.filter(zone => !((notebooks.some(book => book.workface?.zoneId === zone.zoneId) || pages.some(page => page.workface?.zoneId === zone.zoneId)) &&
            (tabsByZone.get(zone.zoneId) ?? []).length > 0 && (tabsByZone.get(zone.zoneId) ?? []).every(tabId => !!tabs[tabId] && workbenchSurfaces(tabs[tabId]!).every(surface => surface.kind === 'file' && pages.some(member => member.resource.workspaceId === surface.workspaceId && member.resource.path === surface.path))))).map(zone => {
            const status = activity(zone)
            return <SurveyZoneItem key={zone.zoneId} zone={zone} title={itemTitle(zone)} glyph={itemGlyph(zone)} selected={selection?.zoneId === zone.zoneId}
              onNewNote={newItemNote} onNewAgent={newItemAgent} activity={status.summary} editing={renamingZoneId === zone.zoneId} onEdit={editing => setRenamingZoneId(editing ? zone.zoneId : null)}
              onRename={async (name, revision) => { const applied = await useAppStore.getState().setSurveyExplorationName(zone.zoneId, name, revision); if (!applied) setError('The exploration source or name revision is unconfirmed. Your name draft is kept here.'); return applied }} onSelect={chooseZone} />
          })}
        </div>
      </aside>
      <div className="survey-sidebar-actions"><button type="button" className="survey-new-page" aria-label="New webpage" title="New browser" disabled={opening} onClick={() => void openBrowser('about:blank', true)}><Plus size={16} /><span>New browser</span></button></div>
      <div className="survey-item-actions" role="group" aria-label="Current exploration actions">{options}
        {currentBrowser && currentBrowser.url !== 'about:blank' && currentPanel ? <button type="button" className="survey-tab-view" aria-label="Save to Recall" title="Save this finding to Recall" onClick={saveToRecall}>
          <ArrowUpRight size={14} />{sidebarCollapsed ? null : <span>Save to Recall…</span>}
        </button> : null}
      </div>
      <div ref={resizeHandle} className="survey-width-handle" role="separator" tabIndex={0} aria-label="Resize Survey items" title="Resize Survey items"
        hidden={sidebarCollapsed}
        aria-orientation="vertical" aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={effectiveSidebarWidth} onMouseDown={onResizeStart}
        onKeyDown={event => {
          const next = event.key === 'Home' ? minWidth : event.key === 'End' ? maxWidth : event.key === 'ArrowLeft' ? effectiveSidebarWidth - 16 : event.key === 'ArrowRight' ? effectiveSidebarWidth + 16 : null
          if (next === null) return
          event.preventDefault(); event.stopPropagation(); setSidebarWidth(next)
        }} />
    </nav>
    <div className="survey-content">
      <div className="survey-page-content" inert={controlsCoverPage} aria-hidden={controlsCoverPage}>
        {error ? <p className="survey-error" role="alert">{error}{failedCreation.current ? <button type="button" disabled={opening} onClick={() => void openBrowser(query.trim() ? query : 'about:blank')}>Retry original item</button> : null}</p> : null}
        {!selection ? <div className="survey-start" aria-label="New browser tab"><SurveyStartBrand />
          <form className="survey-start-input" onSubmit={event => { event.preventDefault(); browserInput.current?.submit() }}>
            <BrowserAddressInput ref={browserInput} value={query} aria-label="Search or enter a web address" placeholder="Search or enter a web address" disabled={opening} historyTarget={workspace ? { kind: 'workspace', workspaceId: workspace.id } : null} onValueChange={value => { setQuery(value); setError(null) }} onSubmit={value => { if (value.trim()) void openBrowser(value) }} onHistoryNotice={setInputHistoryNotice} onDeferredHistoryFailure={message => useAppStore.getState().reportError(message, { kind: 'process-degraded' })} />
            <button type="submit" aria-label="Search or open page" disabled={opening || !query.trim()}>{opening ? <LoaderCircle className="spin" size={16} /> : <ArrowUpRight size={16} />}</button></form>{inputHistoryNotice ? <p className="survey-relation-notice" role="status">{inputHistoryNotice}</p> : null}
        </div> : <>
          {currentZone && !items.some(item => item.zoneId === currentZone.zoneId) ? <div className="survey-relation-notice" role="status">
            This work surface is outside the Survey list. Its content and selection are kept. Start an independent research from the page’s Research in Survey action.
          </div> : null}
          <WorkbenchZone zoneId={selection.zoneId} catalog={catalog} projection={projection} viewTargets={viewTargets}
            onCreateTab={(displayWorkspaceId, groupId) => void newBrowserTab(displayWorkspaceId, groupId)}
            onStartBrowsing={() => void openBrowser('about:blank', true)} leadingChrome={windowControlsInset} visible={visible && !controlsCoverPage} />
        </>}
      </div>
      {workspace && (toolsVisited || toolsOpen) ? <aside ref={managementRef} id="survey-management" className="survey-management" aria-label="Browser management controls" hidden={!toolsOpen} inert={!toolsOpen || !visible} aria-hidden={!toolsOpen || !visible}>
        <header><strong>Browser tools · {workspace.name}</strong><button type="button" aria-label="Close browser management" onClick={() => setToolsOpen(false)}><X size={14} /></button></header><BrowserToolsPanel workspace={workspace} visible={visible && toolsOpen} />
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
