import { ArrowUpRight, Globe2, LoaderCircle, Plus, SlidersHorizontal, X } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { browserOpenError } from '../lib/browser-open-feedback'
import { presentError } from '../lib/error-presentation'
import { useReleasedBrowserRegionIds } from '../lib/surface-memory-budget-coordinator'
import { closeSurveyBrowserPage, sameSurveyBrowserSelection, surveyBrowserPages, surveyBrowserSurface, type SurveyBrowserSelection } from '../lib/survey-browser'
import { projectWorkspaces } from '../lib/workspace-projects'
import type { WorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { SurveyBrowserTools } from './SurveyBrowserTools'

export const GlobalSurveySurface = memo(function GlobalSurveySurface({ visible = true, controlsCoverPage = false, unconfirmedBrowserRegionIds }: { visible?: boolean; controlsCoverPage?: boolean; unconfirmedBrowserRegionIds?: ReadonlySet<string> | undefined }) {
  const config = useAppStore((state) => state.config)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const controlNavigation = useAppStore(state => state.workbenchNavigationInputPolicy !== null)
  const selection = useAppStore((state) => state.surveyBrowserSelection)
  const toolsOpen = useAppStore((state) => state.surveyToolsOpen)
  const setSelection = useAppStore((state) => state.setSurveyBrowserSelection)
  const setToolsOpen = useAppStore((state) => state.setSurveyToolsOpen)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const store = useMemo(() => ({ getState: useAppStore.getState, getInitialState: useAppStore.getInitialState,
    subscribe: visible ? useAppStore.subscribe : () => () => {} }), [visible])
  const tabs = useStore(store, (state) => state.tabs)
  const layouts = useStore(store, (state) => state.layouts)
  const workspaceId = selection?.workspaceId ?? activeWorkspaceId
  const workspace = config?.workspaces.find(({ id }) => id === workspaceId)
  const pages = useMemo(() => surveyBrowserPages(tabs, config?.workspaces ?? [], layouts), [tabs, layouts, config?.workspaces])
  const projectsByWorkspace = useMemo(() => new Map(projectWorkspaces(config?.workspaces ?? [])
    .flatMap(project => project.workspaces.map(item => [item.id, project] as const))), [config?.workspaces])
  const releasedBrowserRegionIds = useReleasedBrowserRegionIds()
  const currentPage = surveyBrowserSurface(tabs, selection)
  const [query, setQuery] = useState('')
  const [opening, setOpening] = useState(false)
  const [closingRegionId, setClosingRegionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toolsVisited, setToolsVisited] = useState(toolsOpen)
  const surfaceRef = useRef<HTMLElement>(null)
  const intent = useRef(0)
  const failedLauncher = useRef<{ reference: SurveyBrowserSelection; surface: WorkbenchSurface } | null>(null)
  useLayoutEffect(() => { intent.current += 1 }, [visible, selection, activeWorkspaceId])
  useEffect(() => { if (toolsOpen) setToolsVisited(true) }, [toolsOpen])
  useEffect(() => {
    // The existing Control input policy authorizes neither an automatic handoff nor blur.
    if (controlNavigation) return
    const surface = surfaceRef.current
    if (!visible) {
      if (surface?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
      return
    }
    const pageRegion = currentPage ? [...surface?.querySelectorAll<HTMLElement>('[data-workbench-region-id]') ?? []]
      .find(region => region.dataset.workbenchRegionId === selection?.regionId) : null
    const target = toolsOpen ? surface?.querySelector<HTMLElement>('[aria-label="Close browser management"]')
      : currentPage ? pageRegion?.querySelector<HTMLElement>(currentPage.url === 'about:blank'
        ? '[aria-label="Search or enter a web address"]' : '[aria-label="Browser address"]')
      : !selection ? surface?.querySelector<HTMLElement>('[aria-label="Search or enter a web address"]') : null
    target?.focus()
  }, [visible, selection, toolsOpen, currentPage?.browserId, currentPage?.url === 'about:blank', controlNavigation])

  function choosePage(page: SurveyBrowserSelection): void {
    intent.current += 1
    setSelection({ workspaceId: page.workspaceId, tabId: page.tabId, regionId: page.regionId })
    setError(null)
  }

  async function showProject(reference: SurveyBrowserSelection): Promise<void> {
    const before = useAppStore.getState()
    if (!surveyBrowserSurface(before.tabs, reference)) { setError('The original page is still restoring. Its project target is retained.'); return }
    const placement = before.layouts[reference.workspaceId]?.groups.find(group => group.tabOrder.includes(reference.tabId))
    if (!placement) { setError('The original page placement is still restoring. Retry after it is available.'); return }
    intent.current += 1
    await selectWorkspace(reference.workspaceId)
    const current = useAppStore.getState()
    if (!surveyBrowserSurface(current.tabs, reference) || !current.layouts[reference.workspaceId]?.groups
      .some(group => group.id === placement.id && group.tabOrder.includes(reference.tabId))) return
    current.activateTab(reference.workspaceId, placement.id, reference.tabId)
    current.focusRegion(reference.workspaceId, reference.tabId, reference.regionId, 'keyboard')
  }

  async function openBrowser(input = 'about:blank'): Promise<void> {
    if (opening) return
    const before = useAppStore.getState()
    const layout = workspace ? before.layouts[workspace.id] : undefined
    if (!workspace || !layout?.activeGroupId) { setError(browserOpenError(undefined)); return }
    const startedIntent = intent.current
    setOpening(true)
    setError(null)
    try {
      const retry = failedLauncher.current
      const retryTab = retry && before.tabs[retry.reference.tabId]
      const reusable = retry && retry.reference.workspaceId === workspace.id && retryTab?.regions[retry.reference.regionId] === retry.surface
        && retry.surface.kind === 'launcher' && Object.keys(retryTab.regions).length === 1
        && layout.groups.some(group => group.tabOrder.includes(retryTab.id))
      const tabId = reusable ? retry.reference.tabId : before.openLauncher({ workspaceId: workspace.id, tabGroupId: layout.activeGroupId, reveal: false })
      const launcher = tabId ? useAppStore.getState().tabs[tabId] : undefined
      if (!launcher) throw new Error('The Workspace placement is unavailable. Retry after it is restored.')
      const reference = { workspaceId: workspace.id, tabId: launcher.id, regionId: launcher.layout.activeRegionId }
      const launcherSurface = launcher.regions[reference.regionId]!
      failedLauncher.current = { reference, surface: launcherSurface }
      const group = useAppStore.getState().layouts[workspace.id]?.groups.find(item => item.tabOrder.includes(launcher.id))
      if (!group) throw new Error('The original page placement is still restoring. Retry after it is available.')
      // Main owns URL/search handling. Creation attaches to this exact original Launcher.
      await before.createBrowser(group.id, { tabId: reference.tabId, regionId: reference.regionId }, input)
      const current = useAppStore.getState()
      if (!surveyBrowserSurface(current.tabs, reference)) throw new Error('The original page owner disappeared before it could attach.')
      failedLauncher.current = null
      if (intent.current === startedIntent && current.mainSurface === 'survey' && current.surveyBrowserSelection === before.surveyBrowserSelection) {
        setSelection(reference)
      }
    } catch (cause) {
      setError(`Browser could not open: ${presentError(cause)}. Your input is kept; retry here.`)
    } finally { setOpening(false) }
  }

  async function closePage(reference: SurveyBrowserSelection): Promise<void> {
    if (closingRegionId) return
    setClosingRegionId(reference.regionId)
    setError(null)
    try {
      await closeSurveyBrowserPage(reference, useAppStore.getState)
      const selected = useAppStore.getState().surveyBrowserSelection
      if (sameSurveyBrowserSelection(selected, reference)) setSelection(null)
    } catch (cause) { setError(presentError(cause)) }
    finally { setClosingRegionId(null) }
  }

  return <section ref={surfaceRef} className="global-survey-surface" aria-label="Survey" hidden={!visible} inert={!visible} aria-hidden={!visible}>
    <aside className="survey-tabs" aria-label="Browser pages" data-survey-workspace-id={workspaceId ?? undefined}>
      <div className="survey-workspace" title={workspace ? `${workspace.hostId}\n${workspace.path}` : undefined}><Globe2 size={16} /><span><small>Open and manage in</small><strong>{workspace?.name ?? 'Select a workspace in Space'}</strong></span></div>
      <button type="button" className="survey-new-page" aria-label="New Browser" title={opening ? 'Opening Browser…' : 'New Browser'} disabled={opening || !workspace} onClick={() => void openBrowser()}>
        {opening ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}<span>New page</span>
      </button>
      <div className="survey-page-list">
        {pages.map(page => {
          const selected = sameSurveyBrowserSelection(selection, page)
          const title = page.surface.title || (page.surface.url === 'about:blank' ? 'New browser tab' : page.surface.url)
          const project = projectsByWorkspace.get(page.workspaceId)!
          const pageWorkspace = config!.workspaces.find(item => item.id === page.workspaceId)!
          const control = releasedBrowserRegionIds.has(page.regionId) || unconfirmedBrowserRegionIds?.has(page.regionId) || page.surface.nativeOwnerUnavailable || !page.surface.navigationId
            ? 'unknown' : page.surface.driving ? 'agent' : page.surface.activity?.control === 'human' ? 'human' : page.surface.activity ? 'idle' : 'unknown'
          const operation = page.surface.activity?.operation
          const operator = control === 'agent' && operation?.browserId === page.surface.browserId && operation.finishedAt === undefined
            && ['preparing', 'running', 'waiting'].includes(operation.phase) ? operation.operator : undefined
          const controlLabel = control === 'agent' ? `Agent operating${operator?.name ? ` · ${operator.name}` : ''}`
            : control === 'human' ? 'Human control' : control === 'idle' ? 'No active Agent operation' : 'Control unknown · restoring'
          return <div key={`${page.workspaceId}:${page.tabId}:${page.regionId}`} className="survey-page-row" data-survey-region-id={page.regionId} data-survey-tab-id={page.tabId} data-survey-workspace-id={page.workspaceId} data-selected={selected} data-survey-control={control}>
            <button type="button" className="survey-page" data-survey-select-region-id={page.regionId} aria-label={`Show page: ${title}`} aria-pressed={selected} title={`${title}\n${page.surface.url}${page.surface.error ? `\n${page.surface.error}` : ''}`} onClick={() => choosePage(page)}>
              {page.surface.loading ? <LoaderCircle className="spin" size={14} /> : <Globe2 size={14} />}
              <span><strong>{title}</strong><small>{page.surface.error || (page.surface.url === 'about:blank' ? 'New page' : page.surface.url)}</small></span>
            </button>
            <button type="button" className="survey-page-close" data-survey-close-region-id={page.regionId} aria-label={`Close page: ${title}`} title="Close this page" disabled={closingRegionId !== null} onClick={() => void closePage(page)}><X size={12} /></button>
            <div className="survey-page-meta"><button type="button" className="survey-page-project" data-survey-project-region-id={page.regionId} aria-label={`Show project: ${project.name}`} title={`${project.name}\n${project.hostId}\n${project.repoPath}\nWorkspace: ${pageWorkspace.name}\n${pageWorkspace.path}`} onClick={() => void showProject(page)}>{project.name}<ArrowUpRight size={10} /></button><small className="survey-page-control" title={controlLabel}>{controlLabel}</small></div>
          </div>
        })}
      </div>
      <div className="survey-controls">
        <button type="button" aria-label="Browser management" aria-expanded={toolsOpen} aria-controls="survey-management" disabled={!workspace} onClick={() => setToolsOpen(!toolsOpen)}><SlidersHorizontal size={14} /><span>Browser tools</span></button>
        {workspace ? <button type="button" onClick={() => { intent.current += 1; void selectWorkspace(workspace.id) }}>Return to Space</button> : null}
      </div>
    </aside>
    <div className="survey-content">
      <div className="survey-page-content" inert={controlsCoverPage} aria-hidden={controlsCoverPage}>
        {error ? <p className="survey-error" role="alert">{error}</p> : null}
        {!selection ? <div className="survey-start" aria-label="Start browsing">
          <Globe2 size={30} aria-hidden="true" />
          <form className="survey-start-input" onSubmit={event => { event.preventDefault(); if (query.trim()) void openBrowser(query) }}>
            <input value={query} aria-label="Search or enter a web address" placeholder="Search or enter a web address" onChange={event => { setQuery(event.target.value); setError(null) }} />
            <button type="submit" aria-label="Search or open page" disabled={opening || !query.trim()}>{opening ? <LoaderCircle className="spin" size={16} /> : <ArrowUpRight size={16} />}</button>
          </form>
          <small>{workspace?.name ?? 'Select a workspace in Space to start browsing'}</small>
        </div> : !currentPage ? <div className="survey-restore-notice" role="status"><strong>Your selected page is retained</strong><p>Its original Workspace and page owner are still restoring. Return to Space to review recovery, or choose a page explicitly.</p></div> : null}
        <div id="survey-browser-slot" className="survey-browser-slot" hidden={!currentPage} data-survey-active-tab-id={currentPage ? selection?.tabId : undefined} data-survey-active-region-id={currentPage?.regionId} data-survey-active-browser-id={currentPage?.browserId} />
      </div>
      {workspace && (toolsVisited || toolsOpen) ? <aside id="survey-management" className="survey-management" aria-label="Browser management controls" hidden={!toolsOpen} inert={!toolsOpen || !visible} aria-hidden={!toolsOpen || !visible}>
        <header><strong>Browser tools</strong><button type="button" aria-label="Close browser management" onClick={() => setToolsOpen(false)}><X size={14} /></button></header>
        <SurveyBrowserTools workspace={workspace} visible={visible && toolsOpen} />
      </aside> : null}
    </div>
  </section>
})
