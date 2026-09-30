import type { AgentMuxSpaceCatalog, AgentMuxSpaceLocation, AgentMuxSpatialSave, AgentMuxZoneFact } from '@agentmux/core/control'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { ArrowUpRight, Globe2, LoaderCircle, Plus, SlidersHorizontal, X } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { browserOpenError } from '../lib/browser-open-feedback'
import { scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { presentError } from '../lib/error-presentation'
import { useReleasedBrowserRegionIds } from '../lib/surface-memory-budget-coordinator'
import { surveyInitialZoneSelection, surveySelectReference, surveySelectedBrowser, surveyZoneItems, surveyZoneTopicFacts, type SurveyZoneSelection } from '../lib/survey-workface'
import { type WorkbenchProjection, type WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { workbenchSurfaces, type WorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { SurveyBrowserTools } from './SurveyBrowserTools'
import { SurveyZoneItem } from './SurveyZoneItem'
import { SurveyTopicRelations } from './SurveyTopicRelations'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'

function saveNotice(save: AgentMuxSpatialSave): string {
  const confirmed = save.localStorageWritten && save.storageFlushRequested
  return `${confirmed ? 'Saved on this device; final disk confirmation is pending.' : 'Local changes are kept. Saving is not confirmed; retry saving in Space.'}${save.reason ? ` ${save.reason}` : ''}`
}

export const GlobalSurveySurface = memo(function GlobalSurveySurface({ visible = true, controlsCoverPage = false, unconfirmedBrowserRegionIds, catalog, projection, viewTargets }: {
  visible?: boolean
  controlsCoverPage?: boolean
  unconfirmedBrowserRegionIds?: ReadonlySet<string> | undefined
  catalog: AgentMuxSpaceCatalog | null
  projection: WorkbenchProjection | null
  viewTargets?: Parameters<typeof WorkspaceWorkbench>[0]['viewTargets']
}) {
  const config = useAppStore(state => state.config)
  const activeWorkspaceId = useAppStore(state => state.activeWorkspaceId)
  const controlNavigation = useAppStore(state => state.workbenchNavigationInputPolicy !== null)
  const selection = useAppStore(state => state.surveyZoneSelection)
  const toolsOpen = useAppStore(state => state.surveyToolsOpen)
  const setSelection = useAppStore(state => state.setSurveyZoneSelection)
  const setToolsOpen = useAppStore(state => state.setSurveyToolsOpen)
  const selectWorkspace = useAppStore(state => state.selectWorkspace)
  const topicSnapshots = useAppStore(state => state.scratchTopicSnapshots)
  const topicSnapshot = topicSnapshots[SCRATCH_WORKSPACE_ID]
  const topicsWorkspace = config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)
  const confirmedTopics = scratchTopicsForWorkspace(topicSnapshots, topicsWorkspace)
  const store = useMemo(() => ({ getState: useAppStore.getState, getInitialState: useAppStore.getInitialState,
    subscribe: visible ? useAppStore.subscribe : () => () => {} }), [visible])
  const tabs = useStore(store, state => state.tabs)
  const layouts = useStore(store, state => state.layouts)
  const currentZone = catalog?.zones.find(zone => zone.zoneId === selection?.zoneId)
  const resourceWorkspaceId = currentZone?.workspaceId ?? (!selection ? activeWorkspaceId : null)
  const workspace = config?.workspaces.find(workspace => workspace.id === resourceWorkspaceId)
  const items = useMemo(() => catalog ? surveyZoneItems(catalog, selection) : [], [catalog, selection])
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
    if (names.length === 1) return names[0]!
    const browsers = (tabsByZone.get(zone.zoneId) ?? []).flatMap(id => tabs[id] ? workbenchSurfaces(tabs[id]!).filter(surface => surface.kind === 'browser') : [])
    if (browsers.length === 1 && browsers[0]?.kind === 'browser') return browsers[0].title || (browsers[0].url === 'about:blank' ? 'New survey item' : browsers[0].url)
    return config?.workspaces.find(workspace => workspace.id === zone.workspaceId)?.name ?? 'Original work surface'
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
    return <span title={labels.map((label, index) => `${browsers[index]!.regionId}: ${label}`).join('\n')}>
      {browsers.length === 1 && !agents ? labels[0] : `${browsers.length ? `${browsers.length} browsers` : `${surfaces.length} regions`}${agents ? ` · ${agents} agents` : ''}${browsers.length ? ` · ${kinds.size === 1 ? labels[0] : 'Mixed control'}` : ''}`}
    </span>
  }

  function chooseZone(zoneId: string): void {
    if (!catalog) return
    intent.current += 1
    setSelection(surveyInitialZoneSelection(catalog, zoneId, layouts, tabs, activeWorkspaceId))
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
    for (const location of catalog?.locations ?? []) if (location.zoneId === selection?.zoneId) {
      const reference = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
      byReference.set(JSON.stringify(reference), reference)
    }
    return [...byReference.values()]
  }, [catalog, selection?.zoneId])

  return <section ref={surfaceRef} className="global-survey-surface" aria-label="Survey" hidden={!visible} inert={!visible} aria-hidden={!visible}>
    <aside className="survey-tabs" aria-label="Survey items" data-survey-workspace-id={resourceWorkspaceId ?? undefined}>
      <div className="survey-workspace" title={workspace ? `${workspace.hostId}\n${workspace.path}` : undefined}><Globe2 size={16} /><span><small>New items in</small><strong>{workspace?.name ?? 'Choose a resource workspace in Space'}</strong></span></div>
      <button type="button" className="survey-new-page" aria-label="New survey item" disabled={opening || !workspace} onClick={() => void openBrowser('about:blank', true)}>
        {opening ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}<span>New item</span>
      </button>
      <div className="survey-page-list">
        {items.map(zone => <SurveyZoneItem key={zone.zoneId} zone={zone} title={itemTitle(zone)} selected={selection?.zoneId === zone.zoneId}
          sourceWorkspace={config?.workspaces.find(workspace => workspace.id === zone.workspaceId) ?? null} relatedTopics={catalog ? surveyZoneTopicFacts(catalog, zone.zoneId).relatedTopics : null}
          activity={activity(zone)} onSelect={chooseZone} onOpenWorkspace={workspaceId => { intent.current += 1; void selectWorkspace(workspaceId) }} />)}
      </div>
      <div className="survey-controls"><button type="button" aria-label="Browser management" aria-expanded={toolsOpen} aria-controls="survey-management" disabled={!workspace} onClick={() => setToolsOpen(!toolsOpen)}><SlidersHorizontal size={14} /><span>Browser tools</span></button>
        {workspace ? <button type="button" onClick={() => { intent.current += 1; void selectWorkspace(workspace.id) }}>Return to Space</button> : null}</div>
    </aside>
    <div className="survey-content">
      <div className="survey-page-content" inert={controlsCoverPage} aria-hidden={controlsCoverPage}>
        {error ? <p className="survey-error" role="alert">{error}{failedCreation.current ? <button type="button" disabled={opening} onClick={() => void openBrowser(query.trim() ? query : 'about:blank')}>Retry original item</button> : null}</p> : null}
        {creationNotice ? <p className="survey-relation-notice">{creationNotice}</p> : null}
        {!selection ? <div className="survey-start" aria-label="Start browsing"><Globe2 size={30} aria-hidden="true" />
          <form className="survey-start-input" onSubmit={event => { event.preventDefault(); if (query.trim()) void openBrowser(query) }}>
            <input value={query} aria-label="Search or enter a web address" placeholder="Search or enter a web address" onChange={event => { setQuery(event.target.value); setError(null) }} />
            <button type="submit" aria-label="Search or open page" disabled={opening || !query.trim()}>{opening ? <LoaderCircle className="spin" size={16} /> : <ArrowUpRight size={16} />}</button></form><small>{workspace?.name ?? 'Choose a resource workspace in Space to start browsing'}</small>
        </div> : <>
          {currentZone ? <SurveyTopicRelations zone={currentZone} topics={topics} relatedTopics={related.relatedTopics} unknownRelatedSpaces={related.unknownRelatedSpaces}
            pendingSpaceId={selectedStatus?.pendingSpaceId ?? null} error={selectedStatus?.error} notice={selectedStatus?.notice || topicSnapshot?.error ? <>{selectedStatus?.notice ? <div>{selectedStatus.notice}</div> : null}{topicSnapshot?.error ? <div>{topicSnapshot.error}</div> : null}</> : null}
            onLinkChange={(spaceId, linked) => void changeRelation(spaceId, linked)} onOpenTopic={openTopic} /> : <div role="status" className="survey-restore-notice">The original Zone reference is retained while its owner restores.</div>}
          {navigationChoices.length ? <div className="survey-location-choices" aria-label="Choose Topic location">{navigationChoices.map(location => <button key={JSON.stringify(location)} type="button" onClick={() => void openLocation(location)}>{config?.workspaces.find(workspace => workspace.id === location.displayWorkspaceId)?.name ?? location.displayWorkspaceId} · {location.groupId} · {location.tabId} · {location.regionId}</button>)}</div> : null}
          {!selection.active && retainedLocations.length ? <div className="survey-location-choices" aria-label="Choose original work surface">{retainedLocations.map(reference => <button key={JSON.stringify(reference)} type="button" onClick={() => chooseReference(reference)}>{config?.workspaces.find(workspace => workspace.id === reference.displayWorkspaceId)?.name ?? reference.displayWorkspaceId} · {reference.groupId} · {reference.tabId} · {reference.regionId}</button>)}</div> : null}
          {projection ? <WorkspaceWorkbench workspaceId={projection.displayWorkspaceId} projection={projection} viewOwnership="projection" viewTargets={viewTargets} visible={visible && !controlsCoverPage} />
            : <div role="status" className="survey-restore-notice">The original work surface and precise references are kept. Choose an available location, or continue recovery in Space.</div>}
        </>}
      </div>
      {workspace && (toolsVisited || toolsOpen) ? <aside id="survey-management" className="survey-management" aria-label="Browser management controls" hidden={!toolsOpen} inert={!toolsOpen || !visible} aria-hidden={!toolsOpen || !visible}>
        <header><strong>Browser tools · {workspace.name}</strong><button type="button" aria-label="Close browser management" onClick={() => setToolsOpen(false)}><X size={14} /></button></header><SurveyBrowserTools workspace={workspace} visible={visible && toolsOpen} />
      </aside> : null}
    </div>
  </section>
})
