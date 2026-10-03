import { DEFAULT_NOTEBOOK_ID, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { NotebookHome, NotebookNavigation } from './SurveyNotebook'
import { changeNotebook, refreshNotebookLibrary, recordNotebookChanges, retryNotebookRecoveries, useNotebookLibrary, type NoteNotebookContext } from '../lib/notebook-library'
import { openNotebookPage, prepareNotebookWorkface } from '../lib/survey-notebooks'
import { surveyExplorationName } from '../lib/survey-exploration-name'
import { spatialCatalog } from '../lib/space-agent-control'
import { useLauncherState } from '../lib/launcher-state'
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
import { SelectorPresence, type SelectorPresenceAgent } from './SelectorList'
import { SurveyItemOptions } from './SurveyItemOptions'
import { TopicKnowledgeCapture } from './TopicKnowledgeEditor'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import { WorkbenchZone } from './WorkbenchZone'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { surveySidebarBounds } from '../lib/survey-sidebar-width'
import { clampSidebarResizeWidth, useSidebarResize } from '../hooks/useSidebarResize'
import { isMacPlatform } from '../lib/host-platform'
import { api } from '../lib/api'
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
  const [pageQuery, setPageQuery] = useState('')
  const library = useNotebookLibrary(state => state.state)
  const libraryIssue = useNotebookLibrary(state => state.issue)
  const notebookRecoveries = useAppStore(state => state.notebookRecoveries)
  const [recoveringHistory, setRecoveringHistory] = useState(false)
  const notebookId = useAppStore(state => state.surveyNotebookId)
  useEffect(() => setPageQuery(''), [notebookId])
  const noteId = useAppStore(state => state.surveyNoteId)
  const activeNotebook = notebookId ? library?.notebooks[notebookId] : undefined
  const notebooks = useMemo(() => Object.values(library?.notebooks ?? {}), [library])
  const pages = useMemo(() => Object.values(library?.pages ?? {}), [library])
  const newNotebookIntent = useRef<{ notebookId: string; name: string; operationId: string } | null>(null)
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
  const currentZone = catalog?.zones.find(zone => zone.zoneId === (selection?.zoneId ?? activeNotebook?.workface?.zoneId))
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
    isOpen: !sidebarCollapsed, width: sidebarWidth, setWidth: setSidebarWidth, deltaSign: 1, minWidth, maxWidth, onDraftWidthChange: reportDraftWidth
  })
  const selectionKey = selection ? JSON.stringify([selection.zoneId, selection.active]) : null
  const intent = useRef(0)
  const pendingNote = useRef<{ zoneId: string; workspaceId: string; displayWorkspaceId: string; groupId: string; reference: WorkbenchProjectionSelection | null; notebook?: NoteNotebookContext; notebookPage?: boolean; draft?: { launcherId: string; value: string } } | null>(null)
  const [noteRecovery, setNoteRecovery] = useState(false)
  const failedCreation = useRef<SurveyBrowserPreparation | null>(null)
  useLayoutEffect(() => { intent.current += 1 }, [visible, selectionKey, activeWorkspaceId, notebookId, noteId])
  useEffect(() => { if (toolsOpen) setToolsVisited(true) }, [toolsOpen])
  useEffect(() => {
    if (controlNavigation || notebookId) return
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
  }, [visible, selectionKey, toolsOpen, currentBrowser?.browserId, currentBrowser?.url === 'about:blank', controlNavigation, notebookId])

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
    useAppStore.getState().setSurveyNotebook(null)

    if (!catalog) return
    intent.current += 1
    const held = useAppStore.getState().surveyZoneSelection
    if (held?.zoneId !== zoneId) setSelection(surveyInitialZoneSelection(catalog, zoneId, layouts, tabs, activeWorkspaceId))
    setError(null)
  }

  function chooseNotebook(id: string): void {
    intent.current += 1
    const state = useAppStore.getState()
    state.setSurveyNotebook(id); state.setSurveyZoneSelection(null); setError(null)
  }
  async function newNotebook(): Promise<void> {
    if (opening) return
    const started = intent.current
    setOpening(true); setError(null)
    const prepared = newNotebookIntent.current ?? { notebookId: crypto.randomUUID(), name: 'Untitled notebook', operationId: crypto.randomUUID() }
    newNotebookIntent.current = prepared
    try {
      await changeNotebook({ kind: 'create', notebookId: prepared.notebookId, name: prepared.name }, prepared.operationId)
      newNotebookIntent.current = null; if (intent.current === started) chooseNotebook(prepared.notebookId)
    } catch (cause) { setError('Notebook could not be saved. Retry this same creation; existing pages are kept. ' + presentError(cause)) }
    finally { setOpening(false) }
  }
  async function showNotebookPage(page: NotebookPage): Promise<void> {
    intent.current += 1
    useAppStore.getState().setSurveyNotebook(page.notebookId, page.noteId)
    setError(null)
    try { await openNotebookPage(page, onSelectReference, selection?.active) } catch (cause) { setError(presentError(cause)) }
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
      if (intent.current === startedIntent && current.mainSurface === 'survey' && current.surveyZoneSelection === before.surveyZoneSelection) { current.setSurveyNotebook(null); setSelection({ zoneId: preparation.zone.zoneId, selection: [reference], active: reference }) }
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

  async function openNote(newExploration: boolean, recover = false, notebookPage = false, parentNoteId: string | null = null): Promise<void> {
    if (opening) return
    const before = useAppStore.getState()
    let heldSelection = before.surveyZoneSelection
    setOpening(true); setError(null)
    try {
      let prepared = recover ? pendingNote.current : null
      if (!prepared) {
        const noteWorkspace = notebookPage && activeNotebook?.workface ? resourceWorkspaces.get(activeNotebook.workface.workspaceId) : workspace
        if (!noteWorkspace) throw new Error('Choose the original resource workspace to start a note.')
        const selected = !newExploration && !notebookPage ? selection?.active : null
        if (!newExploration && !notebookPage && !currentZone) throw new Error('This research is unavailable. Your note draft is kept.')
        const active = selected && before.layouts[selected.displayWorkspaceId]?.groups.some(group => group.id === selected.groupId && group.tabOrder.includes(selected.tabId)) ? selected : null
        const displayWorkspaceId = active?.displayWorkspaceId ?? noteWorkspace.id
        const groupId = active?.groupId ?? before.layouts[displayWorkspaceId]?.activeGroupId
        if (!groupId) throw new Error('The original display Group is still restoring. No note was created.')
        const zoneId = notebookPage && activeNotebook ? (await prepareNotebookWorkface(activeNotebook, noteWorkspace.id, face => { pendingNote.current = { zoneId: face.zoneId, workspaceId: face.workspaceId, displayWorkspaceId, groupId, reference: null, notebook: { notebookId: activeNotebook.notebookId, parentNoteId }, notebookPage: true } })).zoneId
          : newExploration ? (await before.createWorkbenchZone({ workspaceId: noteWorkspace.id, spaceIds: [] })).zone.zoneId : currentZone!.zoneId
        if (!useAppStore.getState().setSurveyZoneCollected(zoneId, true)) throw new Error('The exploration resource is unconfirmed. Its original target is kept.')
        // Adding content keeps the current exploration's visible name through later Tab changes.
        const existingTitle = !newExploration && currentZone ? itemTitle(currentZone) : null
        if (existingTitle && existingTitle !== 'Untitled exploration' && !before.surveyExplorationNames[zoneId]) before.setSurveyExplorationName(zoneId, existingTitle)
        let reference = active
        const retainedDraft = active ? useLauncherState.getState().drafts[`region:${active.regionId}`]?.note : undefined
        if (active && before.tabs[active.tabId]?.regions[active.regionId]?.kind !== 'launcher') {
          before.splitRegion(noteWorkspace.id, active.tabId, active.regionId, 'right')
          const split = useAppStore.getState().tabs[active.tabId]
          const regionId = split?.layout.activeRegionId
          if (!regionId || regionId === active.regionId || split?.regions[regionId]?.kind !== 'launcher') throw new Error('The note pane could not open. Your page and draft are kept; try again.')
          reference = { ...active, regionId }
        }
        prepared = { zoneId, workspaceId: noteWorkspace.id, displayWorkspaceId, groupId, reference: reference ?? null, notebookPage,
          notebook: { notebookId: activeNotebook?.notebookId ?? DEFAULT_NOTEBOOK_ID, ...(notebookPage ? { parentNoteId } : {}), ...(currentBrowser && currentBrowser.url !== 'about:blank' && currentZone && selection?.active && !notebookPage ? { source: { sourceId: crypto.randomUUID(), url: currentBrowser.url, title: currentBrowser.title ?? null, recordedAt: Date.now(), position: { zoneId: currentZone.zoneId, tabId: selection.active.tabId, regionId: selection.active.regionId } } } : {}) },
          ...(active && retainedDraft ? { draft: { launcherId: `region:${active.regionId}`, value: retainedDraft } } : {}) }
        pendingNote.current = prepared
      }
      if (!prepared) throw new Error('The original Note preparation is unavailable. No replacement was created.')
      if (recover && prepared.notebookPage && prepared.notebook?.notebookId) {
        await changeNotebook({ kind: 'bind', notebookId: prepared.notebook.notebookId, workface: { zoneId: prepared.zoneId, workspaceId: prepared.workspaceId } }, 'notebook-workface:' + prepared.notebook.notebookId + ':' + prepared.zoneId)
      }
      if (!prepared.reference) {
        const tabId = before.openLauncher({ workspaceId: prepared.workspaceId, displayWorkspaceId: prepared.displayWorkspaceId, tabGroupId: prepared.groupId, zoneId: prepared.zoneId, reveal: false })
        const launcher = tabId ? useAppStore.getState().tabs[tabId] : undefined
        if (!launcher) throw new Error('The original display Group is still restoring. The exploration is kept; recover this same note.')
        prepared.reference = { displayWorkspaceId: prepared.displayWorkspaceId, groupId: prepared.groupId, tabId: launcher.id, regionId: launcher.layout.activeRegionId }
      }
      if (!recover && heldSelection?.zoneId === prepared.zoneId && prepared.reference) {
        setSelection(surveySelectReference(heldSelection, prepared.reference))
        heldSelection = useAppStore.getState().surveyZoneSelection
      }
      const { reference, zoneId } = prepared, current = useAppStore.getState()
      const freshCatalog = spatialCatalog(current, scratchTopicsForWorkspace(current.scratchTopicSnapshots, topicsWorkspace) ?? [])
      let displayed = false
      const scope: WorkbenchProjection = { entity: { kind: 'zone', zoneId }, presentationId: 'survey-workbench',
        displayWorkspaceId: reference.displayWorkspaceId, catalog: freshCatalog, selection: [reference], onSelect(next) {
          const latest = useAppStore.getState()
          if (latest.mainSurface !== 'survey' || latest.surveyZoneSelection !== heldSelection) return
          const facts = spatialCatalog(latest, scratchTopicsForWorkspace(latest.scratchTopicSnapshots, topicsWorkspace) ?? [])
          const original = heldSelection?.zoneId === zoneId ? heldSelection : surveyInitialZoneSelection(facts, zoneId, latest.layouts, latest.tabs, next.displayWorkspaceId)
          displayed = true; setSelection(surveySelectReference(original, next)); onSelectReference?.(next)
        } }
      const launcherId = `region:${reference.regionId}`
      const retained = useLauncherState.getState().drafts[launcherId]?.noteCreation
      const receipt = recover && retained ? await (retained.status === 'error' ? current.retryCreatedNote(launcherId, scope) : current.revealCreatedNote(launcherId, scope))
        : await current.createNote(reference.groupId, { tabId: reference.tabId, regionId: reference.regionId }, prepared.draft?.value, scope, undefined, prepared.notebook)
      if (!receipt || receipt.status !== 'written' || !receipt.revealed || !displayed) {
        setNoteRecovery(true)
        throw new Error(receipt?.issue ?? (receipt?.status === 'written' ? 'The Note is saved. Open this same note when ready; later navigation was kept.' : 'The Note creation or display is unconfirmed. Check this same note; its original target is kept.'))
      }
      if (prepared.notebookPage && prepared.notebook?.notebookId) useAppStore.getState().setSurveyNotebook(prepared.notebook.notebookId, receipt.noteId)
      pendingNote.current = receipt.notebookIssue ? prepared : null; setNoteRecovery(!!receipt.notebookIssue)
      setCreationNotice(receipt.notebookIssue ?? null)
      if (prepared.draft && receipt.draft === prepared.draft.value && useLauncherState.getState().drafts[prepared.draft.launcherId]?.note === prepared.draft.value) {
        useLauncherState.getState().setDraft(prepared.draft.launcherId, 'note', '')
      }
    } catch (cause) { if (pendingNote.current) setNoteRecovery(true); setError(`Note could not open: ${presentError(cause)}`) }
    finally { setOpening(false) }
  }

  function saveToTopic(scope: 'research' | 'panel'): void {
    if (activeNotebook && !selection) {
      setCapture({ title: activeNotebook.name, sources: [{ kind: 'notebook', notebookId: activeNotebook.notebookId }],
        noteIds: pages.filter(page => page.notebookId === activeNotebook.notebookId).map(page => page.noteId) })
      return
    }
    if (!currentZone || !collected[currentZone.zoneId] || (scope === 'panel' && !currentPanel)) return
    const panel = currentPanel ? tabs[currentPanel.tabId]?.regions[currentPanel.regionId] : null
    // Capture original durable references once; later navigation cannot retarget this draft.
    setCapture({ title: `${scope === 'panel' ? 'Current panel' : 'Research'}: ${itemTitle(currentZone)}`,
      sources: [{ kind: 'survey', zoneId: currentZone.zoneId,
        ...(scope === 'panel' && currentPanel ? { tabId: currentPanel.tabId, regionId: currentPanel.regionId } : {}) }],
      noteIds: pages.filter(page => page.workface?.zoneId === currentZone.zoneId && (scope !== 'panel' || panel?.kind === 'file' && page.resource.workspaceId === panel.workspaceId && page.resource.path === panel.path)).map(page => page.noteId) })
  }

  async function recoverHistory(): Promise<void> {
    setRecoveringHistory(true)
    try { await retryNotebookRecoveries() } catch (cause) { setError(presentError(cause)) }
    finally { setRecoveringHistory(false) }
  }

  const options = <SurveyItemOptions compact={!!activeNotebook} key={String(sidebarCollapsed)} visible={visible && !controlsCoverPage} title={activeNotebook ? activeNotebook.name : currentZone ? itemTitle(currentZone) : selection ? 'Retained exploration' : 'New exploration'}
    zone={currentZone ?? null} workspace={workspace ?? null} collected={activeNotebook && !selection ? true : !!selection && collected[selection.zoneId] === true} relatedSpaces={related.spaces} relatedSpacesUnconfirmed={related.unconfirmed}
    activityDetails={currentZone ? activity(currentZone).details : null}
    onSaveToTopic={saveToTopic} currentPanelAvailable={Boolean(currentPanel)}
    {...(currentZone && !activeNotebook ? { onRename: () => { setSidebarCollapsed(false); setRenamingZoneId(currentZone.zoneId) } } : {})}
    onCollectedChange={value => { if (selection && !setCollected(selection.zoneId, value)) setError('The original Zone resource is unconfirmed. Its content and selection are kept.') }}
    onManageBrowsers={activeNotebook ? undefined : () => setToolsOpen(!toolsOpen)} onOpenWorkspace={workspaceId => { intent.current += 1; void selectWorkspace(workspaceId) }} />
  const windowControlsInset = isMacPlatform() ? <span className="survey-window-controls-inset" aria-hidden="true" /> : undefined

  return <section ref={surfaceRef} className="global-survey-surface" data-sidebar-collapsed={sidebarCollapsed} data-native-window-controls={isMacPlatform()}
    style={{ '--survey-navigation-width': `${sidebarCollapsed ? 40 : effectiveSidebarWidth}px` } as CSSProperties} aria-label="Survey" hidden={!visible} inert={!visible} aria-hidden={!visible}>
    <nav ref={sidebarRef} className={`survey-navigation${isResizing ? ' survey-tabs--resizing' : ''}`} aria-label="Exploration navigation" data-collapsed={sidebarCollapsed} inert={controlsCoverPage}>
      <div className="survey-titlebar project-rail-titlebar" role="group" aria-label="Survey window controls">
        <button type="button" className="survey-icon-button" aria-label={sidebarCollapsed ? 'Show Survey items' : 'Hide Survey items'} title={sidebarCollapsed ? 'Show Survey items' : 'Hide Survey items'} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>{sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
      </div>
      <aside className="survey-tabs" aria-label="Survey items" hidden={sidebarCollapsed} inert={sidebarCollapsed} data-survey-workspace-id={resourceWorkspaceId ?? undefined}>
        {!activeNotebook ? <div className="survey-sidebar-actions"><button type="button" className="survey-new-page" aria-label="New webpage" title="New webpage" disabled={opening} onClick={() => void openBrowser('about:blank', true)}>
          <Globe2 size={14} /><span>Webpage</span>
        </button><button type="button" className="survey-new-page" aria-label="New notebook" title="New notebook" disabled={opening} onClick={() => void newNotebook()}><NotebookPen size={14} /><span>Notebook</span></button></div> : null}
        <div className="survey-page-list" data-notebook-view={!!activeNotebook}>
          <NotebookNavigation notebooks={notebooks} pages={pages} selectedId={notebookId} selectedNoteId={noteId} onSelect={chooseNotebook} onOpen={page => void showNotebookPage(page)} query={pageQuery} onQuery={setPageQuery} onCreateChild={page => { setPageQuery(''); void openNote(false, false, true, page.noteId) }}
            onBack={() => { intent.current += 1; useAppStore.getState().setSurveyNotebook(null); setSelection(null); setError(null) }}
            onCreate={() => void openNote(false, false, true)} pending={opening} actions={options} />
          {!activeNotebook ? <>
          {Object.keys(collected).filter(zoneId => !catalog?.zones.some(zone => zone.zoneId === zoneId)).map(zoneId => <div key={zoneId} className="survey-item-row" data-survey-zone-id={zoneId} data-selected={selection?.zoneId === zoneId}>
            <button type="button" className="survey-item" aria-label="Show retained survey item" onClick={() => chooseZone(zoneId)}><CircleHelp size={14} /><strong>Retained exploration</strong></button>
            <span className="survey-relation-notice" role="status">Original source is not confirmed. Its reference is kept.</span>
          </div>)}
          {items.filter(zone => !notebooks.some(book => book.workface?.zoneId === zone.zoneId) && !pages.some(page => page.workface?.zoneId === zone.zoneId &&
            (tabsByZone.get(zone.zoneId) ?? []).length > 0 && (tabsByZone.get(zone.zoneId) ?? []).every(tabId => !!tabs[tabId] && workbenchSurfaces(tabs[tabId]!).every(surface => surface.kind === 'file' && pages.some(member => member.resource.workspaceId === surface.workspaceId && member.resource.path === surface.path))))).map(zone => {
            const status = activity(zone)
            return <SurveyZoneItem key={zone.zoneId} zone={zone} title={itemTitle(zone)} glyph={itemGlyph(zone)} selected={selection?.zoneId === zone.zoneId}
              activity={status.summary} editing={renamingZoneId === zone.zoneId} onEdit={editing => setRenamingZoneId(editing ? zone.zoneId : null)}
              onRename={name => { const applied = useAppStore.getState().setSurveyExplorationName(zone.zoneId, name); if (!applied) setError('The exploration source is unconfirmed. Your name draft is kept here.'); return applied }} onSelect={chooseZone} />
          })}
          </> : null}
        </div>
      </aside>
      {!activeNotebook || sidebarCollapsed ? <div className="survey-item-actions" role="group" aria-label="Current exploration actions">
        {activeNotebook ? <button className="survey-tab-view" onClick={() => chooseNotebook(activeNotebook.notebookId)}><NotebookPen size={14} /><span>Pages</span></button> : options}
        {activeNotebook ? options : null}
        {activeNotebook ? <button type="button" className="survey-tab-view" disabled={opening} onClick={() => void openNote(false, false, true)}><Plus size={14} /><span>New page</span></button> : selection && collected[selection.zoneId] ? <button type="button" className="survey-tab-view" aria-label="Add note to this exploration" title={selection.active ? 'Write a note alongside this page' : 'Choose the original location before adding a note'} disabled={opening || !selection.active || !workspace} onClick={() => void openNote(false)}><NotebookPen size={14} /><span>Add note</span></button> : null}
      </div> : null}
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
        {noteRecovery && !creationNotice ? <p className="survey-relation-notice" role="status">The original Note target is kept. <button type="button" className="survey-tab-view" disabled={opening} onClick={() => void openNote(false, true)}>Recover same note</button></p> : null}
        {creationNotice ? <p className="survey-relation-notice" role="status">{creationNotice}{noteRecovery ? <button className="survey-tab-view" disabled={opening} onClick={() => void openNote(false, true)}>Retry Notebook registration</button> : null}</p> : null}
        {notebookRecoveries.length ? <p className="survey-history-recovery" role="status"><span>History update pending. Your notes are saved.</span><button className="note-text-button" disabled={recoveringHistory} onClick={() => void recoverHistory()}>Retry history</button></p> : null}
        {libraryIssue && !creationNotice ? <p className="survey-relation-notice" role="status">Notebook directory is unconfirmed. Saved pages and browsing are kept. <button onClick={() => void refreshNotebookLibrary().catch(() => {})}>Refresh</button><details><summary>Details</summary>{libraryIssue}</details></p> : null}
        {activeNotebook && !selection ? <NotebookHome query={pageQuery} onQuery={sidebarCollapsed ? setPageQuery : undefined} navigationVisible={!sidebarCollapsed} notebook={activeNotebook} pages={pages.filter(page => page.notebookId === activeNotebook.notebookId)} pending={opening} onCreate={() => void openNote(false, false, true)} onOpen={page => void showNotebookPage(page)} /> : !selection ? <div className="survey-start" aria-label="New browser tab"><div className="survey-start-heading"><h1>Survey</h1><p>Search or open a page.</p></div>
          <form className="survey-start-input" onSubmit={event => { event.preventDefault(); browserInput.current?.submit() }}>
            <BrowserAddressInput ref={browserInput} value={query} aria-label="Search or enter a web address" placeholder="Search or enter a web address" disabled={opening} historyTarget={workspace ? { kind: 'workspace', workspaceId: workspace.id } : null} onValueChange={value => { setQuery(value); setError(null) }} onSubmit={value => { if (value.trim()) void openBrowser(value) }} onHistoryNotice={setInputHistoryNotice} onDeferredHistoryFailure={message => useAppStore.getState().reportError(message, { kind: 'process-degraded' })} />
            <button type="submit" aria-label="Search or open page" disabled={opening || !query.trim()}>{opening ? <LoaderCircle className="spin" size={16} /> : <ArrowUpRight size={16} />}</button></form><button type="button" className="survey-start-note" disabled={opening || !workspace} onClick={() => void newNotebook()}><NotebookPen size={16} /><span>Start a notebook</span></button>{inputHistoryNotice ? <p className="survey-relation-notice" role="status">{inputHistoryNotice}</p> : null}
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
    <TopicKnowledgeCapture target={capture} onClose={() => setCapture(null)} onSaved={entry => {
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
