import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, ChevronRight, FolderInput, History, Link, Save } from 'lucide-react'
import { notebookFingerprint, type NotebookChange, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { changeNotebook, useNotebookLibrary } from '../lib/notebook-library'
import { notebookDescendants, notebookPageRows } from '../lib/notebook-page-tree'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import type { SurveyBrowserPreparation } from '../lib/survey-browser-creation'

/** Retain the exact metadata operation until its original owner confirms the result. */
export function useNotebookOperation() {
  const held = useRef<{ operationId: string; change: NotebookChange; complete?: () => void } | null>(null), running = useRef(false)
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<string | null>(null)
  async function run(change: NotebookChange, complete?: () => void): Promise<boolean> {
    if (running.current) return false
    if (held.current && notebookFingerprint(held.current.change) !== notebookFingerprint(change)) { setIssue('The previous change is unconfirmed. Retry it before changing this metadata again. Your Note is kept.'); return false }
    const original = held.current ?? { operationId: crypto.randomUUID(), change, ...(complete ? { complete } : {}) }; held.current = original
    running.current = true; setBusy(true); setIssue(null)
    try { await changeNotebook(original.change, original.operationId); held.current = null; original.complete?.(); return true }
    catch (error) { setIssue(presentError(error)); return false }
    finally { running.current = false; setBusy(false) }
  }
  return { run, busy, issue, pending: held.current, retry: () => held.current ? run(held.current.change) : Promise.resolve(false) }
}
export function NotebookOperationIssue({ operation }: { operation: ReturnType<typeof useNotebookOperation> }) {
  return operation.issue ? <div className="notebook-change-issue" role="status">{operation.issue}<button className="note-text-button" disabled={operation.busy} onClick={() => void operation.retry()}>Retry change</button></div> : null
}

export function NotebookPageDetails({ page }: { page: NotebookPage }) {
  const library = useNotebookLibrary(state => state.state), book = library?.notebooks[page.notebookId]
  const operation = useNotebookOperation(), [title, setTitle] = useState(page.title), [editing, setEditing] = useState(false)
  const [panel, setPanel] = useState<'move' | 'sources' | 'history' | null>(null)
  const [destination, setDestination] = useState(page.notebookId), [parentId, setParentId] = useState(page.parentNoteId ?? '')
  const [sourceIssue, setSourceIssue] = useState<string | null>(null)
  const cancelTitle = useRef(false)
  const sourceCreation = useRef<{ sourceId: string; prepared: SurveyBrowserPreparation | null } | null>(null)
  useEffect(() => { if (!editing && !operation.busy && !operation.issue) setTitle(page.title) }, [page.title, editing, operation.busy, operation.issue])
  const allPages = Object.values(library?.pages ?? {}), excluded = notebookDescendants(allPages, page.noteId)
  async function rename() {
    const value = title.trim(); if (!value) { setTitle(page.title); return }
    if (value === page.title) return
    await operation.run({ kind: 'rename-page', noteId: page.noteId, title: value })
  }
  async function move() {
    await operation.run({ kind: 'move', noteId: page.noteId, notebookId: destination, parentNoteId: parentId || null }, () => {
      const state = useAppStore.getState()
      if (state.surveyNoteId === page.noteId) state.setSurveyNotebook(destination, page.noteId)
      setPanel(null)
    })
  }
  async function openSource(source: NotebookPage['sources'][number]) {
    const before = useAppStore.getState(), heldSelection = before.surveyZoneSelection
    if (sourceCreation.current && sourceCreation.current.sourceId !== source.sourceId) { setSourceIssue('The previous source page is still opening. Retry that same source; your Note and links are kept.'); return }
    sourceCreation.current ??= { sourceId: source.sourceId, prepared: null }; setSourceIssue(null)
    try {
      const created = await before.createSurveyBrowser({ workspaceId: page.resource.workspaceId, url: source.url, preparation: sourceCreation.current.prepared,
        onPrepared(prepared) { sourceCreation.current = { sourceId: source.sourceId, prepared } } })
      sourceCreation.current = null
      const now = useAppStore.getState()
      if (now.mainSurface !== before.mainSurface || now.surveyZoneSelection !== heldSelection || now.surveyNoteId !== before.surveyNoteId) return
      now.setSurveyNotebook(null); now.setMainSurface('survey'); now.setSurveyZoneSelection({ zoneId: created.zone.zoneId, selection: [created.reference], active: created.reference })
    } catch (error) { setSourceIssue(presentError(error)) }
  }
  const events = library?.trail.filter(event => event.noteId === page.noteId).slice().reverse() ?? []
  const labels = { created: 'Created', moved: 'Moved', renamed: 'Renamed', 'source-added': 'Source added', organized: 'Added to Topic', relocated: 'File moved' }
  return <header className="notebook-page-heading" aria-label="Page details">
    <button className="notebook-breadcrumb" onClick={() => { const state = useAppStore.getState(); state.setSurveyNotebook(page.notebookId); state.setSurveyZoneSelection(null); state.setMainSurface('survey') }}>{book?.name ?? page.notebookId}<ChevronRight size={12} /></button>
    <input className="notebook-page-title" aria-label="Page title" value={title} placeholder="Untitled note" disabled={operation.busy || Boolean(operation.issue)}
      onFocus={() => setEditing(true)} onChange={event => setTitle(event.target.value)} onBlur={() => { setEditing(false); if (cancelTitle.current) { cancelTitle.current = false; return } void rename() }}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } if (event.key === 'Escape') { cancelTitle.current = true; setTitle(page.title); event.currentTarget.blur() } }} />
    <div className="notebook-page-actions">{(['move', 'sources', 'history'] as const).map(kind => {
      const Icon = kind === 'move' ? FolderInput : kind === 'sources' ? Link : History
      return <button className="note-text-button" key={kind} aria-label={kind === 'move' ? 'Move page' : kind === 'sources' ? 'Page sources' : 'Page history'} aria-expanded={panel === kind}
        onClick={() => { if (kind === 'move') { setDestination(page.notebookId); setParentId(page.parentNoteId ?? '') } setPanel(panel === kind ? null : kind) }}><Icon size={13} /><span>{kind === 'move' ? 'Move' : kind === 'sources' ? `Sources${page.sources.length ? ` · ${page.sources.length}` : ''}` : 'History'}</span></button>
    })}</div>
    <NotebookOperationIssue operation={operation} />
    {panel === 'move' ? <form className="notebook-page-panel notebook-move" aria-label="Move Note page" onSubmit={event => { event.preventDefault(); void move() }}>
      <label>Notebook<select aria-label="Destination notebook" value={destination} disabled={operation.busy || Boolean(operation.issue)} onChange={event => { setDestination(event.target.value); setParentId('') }}>
        {Object.values(library?.notebooks ?? {}).map(book => <option key={book.notebookId} value={book.notebookId}>{book.name}</option>)}</select></label>
      <label>Under page<select aria-label="Parent page" value={parentId} disabled={operation.busy || Boolean(operation.issue)} onChange={event => setParentId(event.target.value)}><option value="">Notebook root</option>
        {notebookPageRows(allPages, destination).filter(row => !excluded.has(row.page.noteId)).map(row => <option key={row.page.noteId} value={row.page.noteId}>{'　'.repeat(row.depth)}{row.page.title}</option>)}</select></label>
      <div><button className="note-text-button" type="submit" disabled={operation.busy || Boolean(operation.issue)}><Save size={13} />Move page</button><button className="note-text-button" type="button" onClick={() => setPanel(null)}>Cancel</button></div>
    </form> : null}
    {panel === 'sources' ? <section className="notebook-page-panel" aria-label="Saved web sources">
      {page.sources.length ? page.sources.map(source => <button className="notebook-source" key={source.sourceId} onClick={() => void openSource(source)} aria-label={`Open source ${source.title || source.url}`}>
        <Link size={14} /><span><strong>{source.title || source.url}</strong><small>{source.url}</small><small>{new Date(source.recordedAt).toLocaleString()}{source.operator ? ` · ${source.operator.kind} · ${source.operator.id}` : ''}</small></span><ArrowUpRight size={13} /></button>) : <p>No webpage was attached to this note.</p>}
      {sourceIssue ? <p role="status">{sourceIssue} Retry the same source above.</p> : null}
    </section> : null}
    {panel === 'history' ? <section className="notebook-page-panel notebook-history" aria-label="Note history">{events.map(event => <div key={event.eventId}>
      <span className="notebook-history-dot" /><div><strong>{labels[event.action]}</strong><small>{new Date(event.at).toLocaleString()} · {event.actor.kind} · {event.actor.id}</small>
        {event.before && (event.before.notebookId !== event.after.notebookId || event.before.parentNoteId !== event.after.parentNoteId) ? <p>{library?.notebooks[event.before.notebookId]?.name ?? event.before.notebookId} / {event.before.parentNoteId ? library?.pages[event.before.parentNoteId]?.title ?? event.before.parentNoteId : 'Root'} → {library?.notebooks[event.after.notebookId]?.name ?? event.after.notebookId} / {event.after.parentNoteId ? library?.pages[event.after.parentNoteId]?.title ?? event.after.parentNoteId : 'Root'}</p> : null}
        {event.before && event.before.title !== event.after.title ? <p>{event.before.title} → {event.after.title}</p> : null}
        {event.before && notebookFingerprint(event.before.resource) !== notebookFingerprint(event.after.resource) ? <p>{event.before.resource.hostId} · {event.before.resource.path} → {event.after.resource.hostId} · {event.after.resource.path}</p> : null}
        {event.source ? <p>{event.source.url}</p> : null}{event.topic ? <p>{event.topic.spaceId}</p> : null}
      </div></div>)}</section> : null}
  </header>
}
