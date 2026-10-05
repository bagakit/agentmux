import { mintObjectId } from '@agentmux/core/object-id'
import { TextInput } from '@agentmux/client-ui/input'
import * as Dialog from '@radix-ui/react-dialog'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Archive, ArrowUpRight, BookOpen, ChevronDown, ChevronRight, FileText, Plus, Search, X } from 'lucide-react'
import { DEFAULT_NOTEBOOK_ID, type Notebook, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { notebookPageRows } from '../lib/notebook-page-tree'
import { NotebookOperationIssue, useNotebookOperation } from './NotebookOperation'

export function NotebookNavigation({ notebooks, pages, selectedId, selectedNoteId, onSelect, onOpen, onCreateChild, query, onQuery, onCreate, pending, actions, archived, onArchivedChange }: {
  notebooks: Notebook[]; pages: NotebookPage[]; selectedId: string | null; selectedNoteId: string | null
  onSelect(notebookId: string): void; onOpen(page: NotebookPage): void; onCreateChild(page: NotebookPage): void; query: string; onQuery(query: string): void
  onCreate(): void; pending: boolean; actions: ReactNode; archived: boolean; onArchivedChange(archived: boolean): void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const book = notebooks.find(candidate => candidate.notebookId === selectedId)
  if (!book) return <p className="notebook-no-results" role="status">{selectedId ? 'Original Notebook selection kept. Refresh the directory or choose a Notebook above.' : 'Loading Notebook directory…'}</p>
  const members = pages.filter(page => page.notebookId === book.notebookId)
  const rows = notebookPageRows(pages, book.notebookId, query, collapsed, archived)
  return <div className="survey-notebook-navigation" aria-label="Notebook navigation" data-notebook-id={book.notebookId}>
    <div className="recall-directory-tools"><button className="recall-directory-home" aria-label={`Notebook directory: ${book.name}`} aria-current={!selectedNoteId ? 'page' : undefined} onClick={() => onSelect(book.notebookId)}>Pages</button>{actions}</div>
    <button className="survey-notebook-new-page" aria-label={`New page in ${book.name}`} disabled={pending} onClick={onCreate}><Plus size={14} /><span>New page</span></button>
    <NotebookDirectoryViews archived={archived} onChange={onArchivedChange} />
    {members.length ? <label className="notebook-find notebook-find--sidebar"><Search size={12} /><TextInput aria-label={`Find pages in ${book.name}`} placeholder="Find a page…" value={query} onChange={event => onQuery(event.target.value)} /></label> : null}
    <div className="survey-notebook-pages" aria-label={`${book.name} pages`}>
      {rows.map(({ page, depth, hasChildren, expanded }) => <div key={page.noteId} className="survey-notebook-page-row" style={{ marginLeft: Math.min(depth, 8) * 10 }}>
        {hasChildren ? <button className="notebook-tree-toggle" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${page.title}`} aria-expanded={expanded} onClick={() => setCollapsed(held => { const next = new Set(held); if (next.has(page.noteId)) next.delete(page.noteId); else next.add(page.noteId); return next })}>{expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</button> : <span className="notebook-tree-spacer" />}
        <button className="survey-notebook-page" title={page.title} aria-current={selectedNoteId === page.noteId ? 'page' : undefined} data-selected={selectedNoteId === page.noteId} onClick={() => onOpen(page)}><FileText size={12} /><span>{page.title}</span></button>
        <button className="notebook-add-child" aria-label={`Add subpage to ${page.title}`} title="Add subpage" onClick={() => onCreateChild(page)}><Plus size={12} /></button>
      </div>)}
      {!rows.length ? <p className="notebook-no-results">{query ? 'No matching pages' : archived ? 'No archived pages' : 'No pages yet'}</p> : null}
    </div>
  </div>
}

function NotebookDirectoryViews({ archived, onChange }: { archived: boolean; onChange(archived: boolean): void }) {
  return <div className="notebook-directory-views" role="group" aria-label="Page directory view">
    <button type="button" aria-pressed={!archived} onClick={() => onChange(false)}>Pages</button>
    <button type="button" aria-label="Archived pages" aria-pressed={archived} onClick={() => onChange(true)}><Archive size={12} /><span>Archived</span></button>
  </div>
}

function NotebookName({ notebook }: { notebook: Notebook }) {
  const operation = useNotebookOperation(), [draft, setDraft] = useState(notebook.name), [editing, setEditing] = useState(false), cancelled = useRef(false)
  useEffect(() => { if (!editing && !operation.busy && !operation.issue) setDraft(notebook.name) }, [notebook.name, editing, operation.busy, operation.issue])
  async function save() { const name = draft.trim(); if (!name) { setDraft(notebook.name); return } if (name !== notebook.name) await operation.run({ kind: 'rename', notebookId: notebook.notebookId, name }) }
  return <><h1>{notebook.notebookId === DEFAULT_NOTEBOOK_ID ? notebook.name : <TextInput className="notebook-name-input" aria-label="Notebook name" title="Rename notebook" value={draft} disabled={operation.busy || Boolean(operation.issue)}
    onFocus={() => setEditing(true)} onChange={event => setDraft(event.target.value)} onBlur={() => { setEditing(false); if (cancelled.current) { cancelled.current = false; return } void save() }}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { cancelled.current = true; setDraft(notebook.name); event.currentTarget.blur() } }} />}</h1><NotebookOperationIssue operation={operation} /></>
}
export function NotebookHome({ notebook, pages, pending, onCreate, onOpen, query, onQuery, navigationVisible = false, archived = false, onArchivedChange }: {
  notebook: Notebook; pages: NotebookPage[]; pending: boolean; onCreate(): void; onOpen(page: NotebookPage): void; query: string; onQuery?: ((query: string) => void) | undefined
  navigationVisible?: boolean; archived?: boolean; onArchivedChange?: ((archived: boolean) => void) | undefined
}) {
  const rows = notebookPageRows(pages, notebook.notebookId, query, new Set(), archived)
  return <section className="survey-notebook-home" aria-label={`${notebook.name} Notebook`}>
    <div className="notebook-cover-mark"><BookOpen size={27} strokeWidth={1.3} /></div>
    <header><NotebookName key={notebook.notebookId} notebook={notebook} />{pages.length ? <p>{rows.length} {archived ? 'archived ' : ''}{rows.length === 1 ? 'page' : 'pages'}</p> : null}</header>
    {!navigationVisible && onArchivedChange ? <NotebookDirectoryViews archived={archived} onChange={onArchivedChange} /> : null}
    {!navigationVisible || !pages.length ? <button className="notebook-create-page" disabled={pending} onClick={onCreate}><Plus size={15} /><span>New page</span></button> : null}
    {pages.length ? <>{onQuery ? <label className="notebook-find notebook-find--directory"><Search size={14} /><TextInput aria-label="Search notebook pages" placeholder="Find a page…" value={query} onChange={event => onQuery(event.target.value)} /></label> : null}
      <div className="notebook-page-directory" aria-label={archived ? "Archived pages" : "Saved pages"}>{rows.map(({ page, depth }) => <button key={page.noteId} style={{ paddingLeft: Math.min(depth, 8) * 16 + 3 }} onClick={() => onOpen(page)}>
        <FileText size={17} strokeWidth={1.5} /><span><strong>{page.title}</strong><small>{page.sources[0] ? new URL(page.sources[0].url).hostname : 'Note'} · {new Date(page.updatedAt).toLocaleDateString()}</small></span><ArrowUpRight size={14} />
      </button>)}{!rows.length ? <p className="notebook-no-results">{query ? 'No matching pages' : archived ? 'No archived pages' : 'No pages yet'}</p> : null}</div></> : <div className="notebook-empty"><span className="notebook-empty-line" /><p>{archived ? 'No archived pages.' : <>Start with a blank page.<br />Notes captured from webpages stay here, too.</>}</p></div>}
  </section>
}

/** Creating a container is deliberate; the original metadata operation owns uncertain receipts. */
export function NotebookCreateDialog({ open, active, onClose, onCreated, onCreateIntent, restoreFocus }: { open: boolean; active: boolean; onClose(): void; onCreated(notebookId: string): void; onCreateIntent?(): void; restoreFocus?(): void }) {
  const [name, setName] = useState('')
  const operation = useNotebookOperation()
  const input = useRef<HTMLInputElement>(null)
  function close() { if (operation.busy) return; if (!operation.pending) setName(''); onClose() }
  async function create() {
    if (operation.busy || !name.trim()) return
    if (operation.pending) { await operation.retry(); return }
    onCreateIntent?.()
    const notebookId = crypto.randomUUID()
    await operation.run({ kind: 'create', notebookId, name: name.trim() }, () => { setName(''); onCreated(notebookId) })
  }
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) close() }}>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="dialog-scrim" />
      <Dialog.Content className="notebook-create-dialog dialog-surface" onOpenAutoFocus={event => { if (!operation.pending) { event.preventDefault(); input.current?.focus() } }} onCloseAutoFocus={event => {
        if (!active || restoreFocus) event.preventDefault()
        const stillInDialog = event.target instanceof HTMLElement && event.target.contains(document.activeElement)
        if (active && (stillInDialog || document.activeElement === document.body)) restoreFocus?.()
      }} onEscapeKeyDown={event => { if (operation.busy) event.preventDefault() }} onInteractOutside={event => { if (operation.busy) event.preventDefault() }}>
        <header><Dialog.Title>New notebook</Dialog.Title><button type="button" className="icon-button" aria-label="Close notebook creation" disabled={operation.busy} onClick={close}><X size={15} /></button></header>
        <Dialog.Description className="notebook-create-description">A home for related notes.</Dialog.Description>
        <form aria-label="Create notebook" onSubmit={event => { event.preventDefault(); void create() }}>
          <label>Name<TextInput ref={input} aria-label="New notebook name" placeholder="e.g. Reading notes" value={name} maxLength={160} disabled={operation.busy || Boolean(operation.pending)} onChange={event => setName(event.target.value)} /></label>
          {operation.issue ? <p role="status" className="notebook-create-issue">{operation.issue}</p> : null}
          <footer><button type="button" className="small-button" disabled={operation.busy} onClick={close}>Cancel</button><button type="submit" className="primary-button" disabled={operation.busy || !name.trim()}>{operation.busy ? 'Creating…' : operation.pending ? 'Retry creation' : 'Create notebook'}</button></footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
