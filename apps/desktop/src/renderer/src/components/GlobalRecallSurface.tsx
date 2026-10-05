import { DEFAULT_NOTEBOOK_ID, notebookPageArchiveRoot, type Notebook, type NotebookPage } from '@agentmux/core/notebook-catalog'
import type { AgentMuxSpaceCatalog, TopicKnowledgeSource } from '@agentmux/core/control'
import { BookOpen, CircleHelp, PanelLeftClose, PanelLeftOpen, Plus, Trash2 } from 'lucide-react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { NotebookHome, NotebookNavigation, NotebookCreateDialog } from './NotebookNavigation'
import { NotebookSelector } from './NotebookSelector'
import '../styles/recall.css'
import { ConfirmationDialog } from './ConfirmationDialog'
import { useNotebookOperation } from './NotebookOperation'
import { changeNotebook, refreshNotebookLibrary, recordNotebookChanges, retryNotebookRecoveries, useNotebookLibrary, type NoteNotebookContext } from '../lib/notebook-library'
import { openNotebookPage, prepareNotebookWorkface } from '../lib/recall-notebooks'
import { spatialCatalog } from '../lib/space-agent-control'
import { useLauncherState } from '../lib/launcher-state'
import { scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { surveyInitialZoneSelection, surveySelectReference, type ResolvedSurveyZoneSelection } from '../lib/survey-workface'
import type { WorkbenchProjection, WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { useAppStore } from '../store'
import { WorkspaceWorkbench } from './WorkspaceWorkbench'
import { TopicKnowledgeCapture } from './TopicKnowledgeEditor'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { NOTES_WORKSPACE_ID } from '../../../shared/notes-library'
import { surveySidebarBounds } from '../lib/survey-sidebar-width'
import { clampSidebarResizeWidth, useSidebarResize } from '../hooks/useSidebarResize'
import { isMacPlatform } from '../lib/host-platform'
import { api } from '../lib/api'
import { directoryIdentity } from '../../../shared/space-addresses'

/** Recall only presents the existing Notebook directory and original file owners. */
export const GlobalRecallSurface = memo(function GlobalRecallSurface({ visible = true, catalog, projection, selection, viewTargets, onSelectReference }: {
  visible?: boolean; catalog: AgentMuxSpaceCatalog | null; projection: WorkbenchProjection | null; selection: ResolvedSurveyZoneSelection | null
  onSelectReference?: (reference: WorkbenchProjectionSelection) => void
  viewTargets?: Parameters<typeof WorkspaceWorkbench>[0]['viewTargets']
}) {
  const library = useNotebookLibrary(state => state.state), libraryIssue = useNotebookLibrary(state => state.issue)
  const notebookId = useAppStore(state => state.recallNotebookId), noteId = useAppStore(state => state.recallNoteId)
  const config = useAppStore(state => state.config), recoveries = useAppStore(state => state.notebookRecoveries)
  const sidebarCollapsed = useAppStore(state => state.recallSidebarCollapsed), sidebarWidth = useAppStore(state => state.recallSidebarWidth)
  const setSidebarCollapsed = useAppStore(state => state.setRecallSidebarCollapsed), setSidebarWidth = useAppStore(state => state.setRecallSidebarWidth)
  const activeNotebook = notebookId ? library?.notebooks[notebookId] : undefined
  const notebooks = useMemo(() => Object.values(library?.notebooks ?? {}), [library]), pages = useMemo(() => Object.values(library?.pages ?? {}), [library])
  const [query, setQuery] = useState(''), [archived, setArchived] = useState(false)
  useEffect(() => {
    // Only first entry chooses a default. An original saved selection is never replaced.
    if (visible && library && !libraryIssue && notebookId === null && !noteId && !selection && library.notebooks[DEFAULT_NOTEBOOK_ID])
      useAppStore.getState().setRecallNotebook(DEFAULT_NOTEBOOK_ID)
  }, [visible, library, libraryIssue, notebookId, noteId, selection])
  const archiveRoot = noteId && library ? notebookPageArchiveRoot(library.pages, noteId)?.noteId : undefined
  useEffect(() => { setQuery(''); setArchived(false) }, [notebookId])
  useEffect(() => { if (noteId && library) setArchived(Boolean(archiveRoot)) }, [notebookId, noteId, archiveRoot])
  const [opening, setOpening] = useState(false), [error, setError] = useState<string | null>(null), [creationNotice, setCreationNotice] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false), [deleteOpen, setDeleteOpen] = useState(false)
  const notebookTrigger = useRef<HTMLButtonElement>(null)
  const [deleteTarget, setDeleteTarget] = useState<(Notebook & { pageCount: number }) | null>(null)
  const deletion = useNotebookOperation(), intent = useRef(0), createIntent = useRef(0), active = useRef(visible)
  active.current = visible
  useLayoutEffect(() => { intent.current += 1 }, [visible, notebookId, noteId, selection?.zoneId, selection?.active])
  const [recovering, setRecovering] = useState(false), [noteRecovery, setNoteRecovery] = useState(false)
  const pendingNote = useRef<{ zoneId: string; workspaceId: string; displayWorkspaceId: string; groupId: string; reference: WorkbenchProjectionSelection | null; notebook: NoteNotebookContext & { notebookId: string } } | null>(null)
  const [capture, setCapture] = useState<{ title: string; sources: TopicKnowledgeSource[]; noteIds: string[] } | null>(null)
  const surfaceRef = useRef<HTMLElement>(null), resizeHandle = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const surface = surfaceRef.current; if (!visible || !surface) return
    const measure = () => { const next = surface.getBoundingClientRect().width; if (next) setWidth(next) }
    measure(); const observer = new ResizeObserver(measure); observer.observe(surface); return () => observer.disconnect()
  }, [visible])
  const { minWidth, maxWidth } = surveySidebarBounds(width), effectiveWidth = clampSidebarResizeWidth(sidebarWidth, minWidth, maxWidth)
  const draftWidth = useCallback((value: number) => {
    resizeHandle.current?.setAttribute('aria-valuenow', String(clampSidebarResizeWidth(value, minWidth, maxWidth)))
    surfaceRef.current?.style.setProperty('--survey-navigation-width', `${sidebarCollapsed ? 40 : clampSidebarResizeWidth(value, minWidth, maxWidth)}px`)
  }, [minWidth, maxWidth, sidebarCollapsed])
  const { containerRef, isResizing, onResizeStart } = useSidebarResize<HTMLElement>({ isOpen: !sidebarCollapsed, width: sidebarWidth, setWidth: setSidebarWidth, deltaSign: 1, minWidth, maxWidth, onDraftWidthChange: draftWidth })
  function chooseNotebook(id: string | null) {
    intent.current += 1; const state = useAppStore.getState(); state.setRecallNotebook(id); state.setRecallZoneSelection(null); setError(null)
  }
  async function showPage(page: NotebookPage) {
    intent.current += 1; useAppStore.getState().setRecallNotebook(page.notebookId, page.noteId); setError(null)
    try { await openNotebookPage(page, onSelectReference, selection?.active) } catch (cause) { setError(presentError(cause)) }
  }
  async function removeNotebook() {
    if (!deleteTarget) return
    const id = deleteTarget.notebookId
    await deletion.run({ kind: 'delete', notebookId: id }, () => {
      setDeleteOpen(false); setDeleteTarget(null); const state = useAppStore.getState()
      if (state.recallNotebookId === id) state.setRecallNotebook(DEFAULT_NOTEBOOK_ID, state.recallNoteId)
    })
  }
  async function createPage(parentNoteId: string | null = null, recover = false) {
    if (opening || (!activeNotebook && !recover)) return
    const before = useAppStore.getState(); let held = before.recallZoneSelection
    setOpening(true); setError(null)
    try {
      let prepared = recover ? pendingNote.current : null
      if (!prepared) {
        const notebook = activeNotebook!
        const workspaceId = NOTES_WORKSPACE_ID
        const workspace = config?.workspaces.find(candidate => candidate.id === workspaceId)
        if (!workspace) throw new Error('The original Notes folder is unavailable. Its Notebook and existing pages are kept; reconnect it and retry.')
        const groupId = before.prepareWorkbenchLayout(workspace.id).activeGroupId
        const context = { notebookId: notebook.notebookId, parentNoteId }
        const face = notebook.workface && notebook.workface.workspaceId !== workspace.id
          ? { zoneId: (await before.createWorkbenchZone({ workspaceId: workspace.id, spaceIds: [] })).zone.zoneId, workspaceId: workspace.id }
          : await prepareNotebookWorkface(notebook, workspace.id, workface => { pendingNote.current = { ...workface, displayWorkspaceId: workspace.id, groupId, reference: null, notebook: context } })
        prepared = { ...face, displayWorkspaceId: workspace.id, groupId, reference: null, notebook: context }; pendingNote.current = prepared
      }
      if (recover && (!library?.notebooks[prepared.notebook.notebookId]?.workface || library.notebooks[prepared.notebook.notebookId]!.workface!.zoneId === prepared.zoneId)) await changeNotebook({ kind: 'bind', notebookId: prepared.notebook.notebookId, workface: { zoneId: prepared.zoneId, workspaceId: prepared.workspaceId } }, 'notebook-workface:' + prepared.notebook.notebookId + ':' + prepared.zoneId)
      if (!prepared.reference) {
        const id = before.openLauncher({ workspaceId: prepared.workspaceId, displayWorkspaceId: prepared.displayWorkspaceId, tabGroupId: prepared.groupId, zoneId: prepared.zoneId, reveal: false })
        const tab = id ? useAppStore.getState().tabs[id] : undefined
        if (!tab) throw new Error('The original page location is restoring. Recover this same page here.')
        prepared.reference = { displayWorkspaceId: prepared.displayWorkspaceId, groupId: prepared.groupId, tabId: tab.id, regionId: tab.layout.activeRegionId }
      }
      const { reference, zoneId } = prepared, current = useAppStore.getState()
      const topics = scratchTopicsForWorkspace(current.scratchTopicSnapshots, current.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)) ?? []
      let displayed = false
      const scope: WorkbenchProjection = { entity: { kind: 'zone', zoneId }, presentationId: 'recall-workbench', displayWorkspaceId: reference.displayWorkspaceId,
        catalog: spatialCatalog(current, topics), selection: [reference], onSelect(next) {
          const latest = useAppStore.getState()
          if (latest.mainSurface !== 'recall' || latest.recallZoneSelection !== held || latest.recallNotebookId !== prepared!.notebook.notebookId) return
          const facts = spatialCatalog(latest, scratchTopicsForWorkspace(latest.scratchTopicSnapshots, latest.config?.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)) ?? [])
          const original = held?.zoneId === zoneId ? held : surveyInitialZoneSelection(facts, zoneId, latest.layouts, latest.tabs, next.displayWorkspaceId)
          displayed = true; latest.setRecallZoneSelection(surveySelectReference(original, next)); onSelectReference?.(next)
        } }
      const launcherId = `region:${reference.regionId}`, retained = useLauncherState.getState().drafts[launcherId]?.noteCreation
      const receipt = recover && retained ? await (retained.status === 'error' ? current.retryCreatedNote(launcherId, scope) : current.revealCreatedNote(launcherId, scope))
        : await current.createNote(reference.groupId, { tabId: reference.tabId, regionId: reference.regionId }, '', scope, undefined, prepared.notebook)
      if (!receipt || receipt.status !== 'written' || !receipt.revealed || !displayed) {
        setNoteRecovery(true)
        throw new Error(receipt?.issue ?? (receipt?.status === 'written' ? 'The page is saved. Open this same page when ready; later navigation was kept.' : 'This page creation is unconfirmed. Recover this same page here.'))
      }
      useAppStore.getState().setRecallNotebook(prepared.notebook.notebookId, receipt.noteId)
      pendingNote.current = receipt.notebookIssue ? prepared : null; setNoteRecovery(Boolean(receipt.notebookIssue)); setCreationNotice(receipt.notebookIssue ?? null)
    } catch (cause) { if (pendingNote.current) setNoteRecovery(true); setError(`Page could not open: ${presentError(cause)}`) }
    finally { setOpening(false) }
  }
  const actions = activeNotebook ? <div className="recall-notebook-actions">
    <button className="survey-icon-button" aria-label="Save notebook to Topic" title="Save notebook to Topic" onClick={() => setCapture({ title: activeNotebook.name, sources: [{ kind: 'notebook', notebookId: activeNotebook.notebookId }], noteIds: pages.filter(page => page.notebookId === activeNotebook.notebookId).map(page => page.noteId) })}><Plus size={14} /></button>
    {activeNotebook.notebookId !== DEFAULT_NOTEBOOK_ID ? <button className="survey-icon-button" aria-label="Delete notebook" title="Delete notebook" onClick={() => { if (!deletion.pending) setDeleteTarget({ ...activeNotebook, pageCount: pages.filter(page => page.notebookId === activeNotebook.notebookId).length }); setDeleteOpen(true) }}><Trash2 size={14} /></button> : null}
  </div> : null
  return <section ref={surfaceRef} className="global-recall-surface" aria-label="Recall" hidden={!visible} inert={!visible} aria-hidden={!visible} data-sidebar-collapsed={sidebarCollapsed} data-native-window-controls={isMacPlatform()} style={{ '--survey-navigation-width': `${sidebarCollapsed ? 40 : effectiveWidth}px` } as CSSProperties}>
    <NotebookCreateDialog active={visible} open={visible && createOpen} onClose={() => setCreateOpen(false)} restoreFocus={() => notebookTrigger.current?.focus()} onCreateIntent={() => { createIntent.current = intent.current }} onCreated={id => { setCreateOpen(false); if (active.current && intent.current === createIntent.current) chooseNotebook(id) }} />
    <ConfirmationDialog open={visible && deleteOpen} title="Delete notebook?" subject={deleteTarget?.name ?? ''} description={deleteTarget?.pageCount ? `${deleteTarget.pageCount} ${deleteTarget.pageCount === 1 ? 'page will' : 'pages will'} move to 随手记. Contents, page hierarchy and archived status stay intact.` : 'This empty notebook will be removed.'} confirmLabel={deletion.pending ? 'Retry deletion' : 'Delete notebook'} busy={deletion.busy} onCancel={() => setDeleteOpen(false)} onConfirm={() => void removeNotebook()} feedback={deletion.issue ? <p className="notebook-create-issue" role="status">{deletion.issue}</p> : null} />
    <nav ref={containerRef} className={`survey-navigation${isResizing ? ' survey-tabs--resizing' : ''}`} aria-label="Recall navigation" data-collapsed={sidebarCollapsed}>
      <div className="survey-titlebar project-rail-titlebar" role="group" aria-label="Recall window controls"><button className="survey-icon-button" aria-label={sidebarCollapsed ? 'Show Recall items' : 'Hide Recall items'} title={sidebarCollapsed ? 'Show Recall items' : 'Hide Recall items'} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>{sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button></div>
      {deletion.issue && !deleteOpen ? <div className="notebook-change-issue" role="status">{!sidebarCollapsed ? <span>Deletion of “{deleteTarget?.name}” is unconfirmed. {deletion.issue}</span> : null}<button className="note-text-button" aria-label="Check notebook deletion" onClick={() => setDeleteOpen(true)}>{sidebarCollapsed ? <CircleHelp size={15} /> : 'Check deletion'}</button></div> : null}
      <aside className="survey-tabs" aria-label="Recall items" hidden={sidebarCollapsed} inert={sidebarCollapsed}>
        <NotebookSelector active={visible && !sidebarCollapsed} triggerRef={notebookTrigger} notebooks={notebooks} selectedId={notebookId} onSelect={chooseNotebook} pending={opening} onCreate={() => setCreateOpen(true)} />
        <div className="survey-page-list" data-notebook-view={Boolean(activeNotebook)}><NotebookNavigation notebooks={notebooks} pages={pages} selectedId={notebookId} selectedNoteId={noteId} onSelect={chooseNotebook} onOpen={page => void showPage(page)} query={query} onQuery={setQuery} onCreateChild={page => { setQuery(''); void createPage(page.noteId) }} onCreate={() => void createPage()} pending={opening} actions={actions} archived={archived} onArchivedChange={value => { setArchived(value); setQuery('') }} /></div>
      </aside>
      {sidebarCollapsed && activeNotebook ? <div className="survey-item-actions"><button className="survey-icon-button" aria-label="Show notebook directory" onClick={() => chooseNotebook(activeNotebook.notebookId)}><BookOpen size={14} /></button>{actions}<button className="survey-icon-button" aria-label="New page" disabled={opening} onClick={() => void createPage()}><Plus size={14} /></button></div> : null}
      <div ref={resizeHandle} className="survey-width-handle" role="separator" tabIndex={0} aria-label="Resize Recall items" hidden={sidebarCollapsed} aria-orientation="vertical" aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={effectiveWidth} onMouseDown={onResizeStart} onKeyDown={event => { const next = event.key === 'Home' ? minWidth : event.key === 'End' ? maxWidth : event.key === 'ArrowLeft' ? effectiveWidth - 16 : event.key === 'ArrowRight' ? effectiveWidth + 16 : null; if (next === null) return; event.preventDefault(); setSidebarWidth(next) }} />
    </nav>
    <div className="survey-content"><div className="survey-page-content">
      {error ? <p className="survey-error" role="alert">{error}</p> : null}
      {noteRecovery ? <p className="survey-relation-notice" role="status">The original page and target are kept. <button className="note-text-button" disabled={opening} onClick={() => void createPage(null, true)}>Recover same note</button></p> : null}
      {creationNotice ? <p className="survey-relation-notice" role="status">{creationNotice}</p> : null}
      {recoveries.length ? <p className="survey-history-recovery" role="status"><span>History update pending. Your notes are saved.</span><button disabled={recovering} onClick={() => { setRecovering(true); void retryNotebookRecoveries().catch(cause => setError(presentError(cause))).finally(() => setRecovering(false)) }}>Retry history</button></p> : null}
      {libraryIssue ? <p className="survey-relation-notice" role="status">Notebook directory is unconfirmed. Original pages are kept. <button onClick={() => void refreshNotebookLibrary().catch(() => {})}>Refresh</button><details><summary>Details</summary>{libraryIssue}</details></p> : null}
      {selection ? projection ? <WorkspaceWorkbench workspaceId={projection.displayWorkspaceId} projection={projection} viewOwnership="projection" viewTargets={viewTargets} onCreateTab={() => void createPage()} leadingChrome={isMacPlatform() ? <span className="survey-window-controls-inset" aria-hidden="true" /> : undefined} visible={visible} /> : <div className="workbench-zone-state" role="status"><h2>The original page is kept</h2><p>Its work surface is still restoring. Reopen this same page from its Notebook.</p><button className="note-text-button" onClick={() => noteId && library?.pages[noteId] ? void showPage(library.pages[noteId]!) : chooseNotebook(notebookId)}>Reopen page</button></div>
        : activeNotebook ? <NotebookHome query={query} onQuery={sidebarCollapsed ? setQuery : undefined} navigationVisible={!sidebarCollapsed} archived={archived} onArchivedChange={sidebarCollapsed ? value => { setArchived(value); setQuery('') } : undefined} notebook={activeNotebook} pages={pages.filter(page => page.notebookId === activeNotebook.notebookId)} pending={opening} onCreate={() => void createPage()} onOpen={page => void showPage(page)} />
          : <div className="recall-directory-state" role="status"><BookOpen size={24} strokeWidth={1.4} /><h2>{notebookId ? 'Your Notebook selection is kept' : 'Loading your Notebook'}</h2><p>{notebookId ? 'This Notebook is not confirmed in the current directory. Refresh or choose another Notebook above; original pages and work remain available.' : 'Your pages will appear when the directory is confirmed.'}</p><button className="note-text-button" onClick={() => void refreshNotebookLibrary().catch(() => {})}>Refresh notebooks</button></div>}
    </div></div>
    <TopicKnowledgeCapture target={capture} onClose={() => setCapture(null)} onSaved={entry => {
      const noteIds = capture?.noteIds ?? []; if (!noteIds.length) return
      void (async () => { const result = await api.topics.call('topic.inspect', { topicId: entry.topicId }); if (!result.topic || result.topic.readError) throw new Error('Knowledge was saved. Its Topic identity is unconfirmed; Note history is kept.'); const topic = result.topic; await recordNotebookChanges(noteIds.map(noteId => ({ kind: 'organize' as const, noteId, topic: { topicId: topic.topicId, spaceId: directoryIdentity(topic.hostId, topic.directoryPath) } })), `topic-knowledge:${entry.entryId}`) })().catch(cause => setError(presentError(cause)))
    }} />
  </section>
})
