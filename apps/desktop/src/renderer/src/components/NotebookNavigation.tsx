import { useWorkbenchDocument } from '../lib/workbench-document'
import { mintObjectId } from '@agentmux/core/object-id'
import { TextInput } from '@agentmux/client-ui/input'
import { Button } from '@agentmux/client-ui/components/Button'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { DEFAULT_NOTEBOOK_ID, type Notebook, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { notebookPageRows } from '../lib/notebook-page-tree'
import { NotebookCards, NotebookGraph, NotebookViewPicker, type NotebookDirectoryView } from './NotebookViews'
import { NotebookOperationIssue, useNotebookOperation } from './NotebookOperation'
import { NotebookDirectoryContextMenu, type NoteTalkHandler } from './NotebookDirectoryContextMenu'

const ThemeActionCreateNoteIcon = semanticIconComponent('action.create-note')
const ThemeActionSearchIcon = semanticIconComponent('action.search')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')
const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')
const ThemeObjectNoteIcon = semanticIconComponent('object.note')
const ThemeActionCreateSubnoteIcon = semanticIconComponent('action.create-subnote')
const ThemeActionArchiveIcon = semanticIconComponent('action.archive')
const NotebookIcon = semanticIconComponent('object.notebook')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const RelationshipsIcon = semanticIconComponent('object.relationships')


export function NotebookNavigation({ notebooks, pages, selectedId, selectedNoteId, onSelect, onOpen, onTalk, onCreateChild, query, onQuery, onCreate, pending, actions, archived, onArchivedChange, onOpenGraph, graphActive = false }: {
  notebooks: Notebook[]; pages: NotebookPage[]; selectedId: string | null; selectedNoteId: string | null
  onSelect(notebookId: string): void; onOpen(page: NotebookPage): void; onCreateChild(page: NotebookPage): void; query: string; onQuery(query: string): void
  onCreate(): void; pending: boolean; actions: ReactNode; archived: boolean; onArchivedChange(archived: boolean): void
  onTalk?: NoteTalkHandler | undefined
  onOpenGraph?: (() => void) | undefined; graphActive?: boolean
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const book = notebooks.find(candidate => candidate.notebookId === selectedId)
  if (!book) return <p className="notebook-no-results" role="status">{selectedId ? 'Original Notebook selection kept. Refresh the directory or choose a Notebook above.' : 'Loading Notebook directory…'}</p>
  const members = pages.filter(page => page.notebookId === book.notebookId)
  const rows = notebookPageRows(pages, book.notebookId, query, collapsed, archived)
  return <div className="survey-notebook-navigation" aria-label="Notebook navigation" data-notebook-id={book.notebookId}>
    <div className="recall-directory-tools"><div className="recall-directory-destinations"><button className="recall-directory-home" aria-label={`Notebook directory: ${book.name}`} aria-current={!selectedNoteId && !graphActive ? 'page' : undefined} onClick={() => onSelect(book.notebookId)}>Pages</button>
      {onOpenGraph ? <button type="button" className="recall-directory-home recall-directory-graph" aria-label="Notebook graph" aria-pressed={graphActive} onClick={onOpenGraph}><RelationshipsIcon size={13} /><span>Graph</span></button> : null}</div>{actions}</div>
    <button className="survey-notebook-new-page" aria-label={`New page in ${book.name}`} disabled={pending} onClick={onCreate}><ThemeActionCreateNoteIcon size={14} /><span>New page</span></button>
    <NotebookDirectoryViews archived={archived} onChange={onArchivedChange} />
    {members.length ? <label className="notebook-find notebook-find--sidebar"><ThemeActionSearchIcon size={12} /><TextInput aria-label={`Find pages in ${book.name}`} placeholder="Find a page…" value={query} onChange={event => onQuery(event.target.value)} /></label> : null}
    <NotebookDirectoryContextMenu pages={rows.map(row => row.page)} onTalk={onTalk}><div className="survey-notebook-pages" aria-label={`${book.name} pages`}>
      {rows.map(({ page, depth, hasChildren, expanded }) => <div key={page.noteId} className="survey-notebook-page-row" style={{ marginLeft: Math.min(depth, 8) * 10 }}>
        {hasChildren ? <button className="notebook-tree-toggle" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${page.title}`} aria-expanded={expanded} onClick={() => setCollapsed(held => { const next = new Set(held); if (next.has(page.noteId)) next.delete(page.noteId); else next.add(page.noteId); return next })}>{expanded ? <ThemeNavigationDownIcon size={11} /> : <ThemeNavigationDisclosureIcon size={11} />}</button> : <span className="notebook-tree-spacer" />}
        <button data-note-id={page.noteId} className="survey-notebook-page" title={page.title} aria-current={selectedNoteId === page.noteId ? 'page' : undefined} data-selected={selectedNoteId === page.noteId} onClick={() => onOpen(page)}><ThemeObjectNoteIcon size={12} /><span>{page.title}</span></button>
        <button className="notebook-add-child" aria-label={`Add subpage to ${page.title}`} title="Add subpage" onClick={() => onCreateChild(page)}><ThemeActionCreateSubnoteIcon size={12} /></button>
      </div>)}
      {!rows.length ? <p className="notebook-no-results">{query ? 'No matching pages' : archived ? 'No archived pages' : 'No pages yet'}</p> : null}
    </div></NotebookDirectoryContextMenu>
  </div>
}

function NotebookDirectoryViews({ archived, onChange }: { archived: boolean; onChange(archived: boolean): void }) {
  return <div className="notebook-directory-views" role="group" aria-label="Page directory view">
    <button type="button" aria-pressed={!archived} onClick={() => onChange(false)}>Pages</button>
    <button type="button" aria-label="Archived pages" aria-pressed={archived} onClick={() => onChange(true)}><ThemeActionArchiveIcon size={12} /><span>Archived</span></button>
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
export function NotebookHome({ notebook, pages, pending, onCreate, onOpen, onOpenFile, onTalk, query, onQuery, navigationVisible = false, archived = false, onArchivedChange, view = 'tree', onViewChange, active = true }: {
  notebook: Notebook; pages: NotebookPage[]; pending: boolean; onCreate(): void; onOpen(page: NotebookPage, blockId?: string): void; query: string; onQuery?: ((query: string) => void) | undefined
  onOpenFile?: import('./NoteCanvas').NoteCanvasProps['onOpenFile']
  active?: boolean; view?: NotebookDirectoryView; onViewChange?(view: NotebookDirectoryView): void
  navigationVisible?: boolean; archived?: boolean; onArchivedChange?: ((archived: boolean) => void) | undefined
  onTalk?: NoteTalkHandler | undefined
}) {
  const rows = useMemo(() => notebookPageRows(pages, notebook.notebookId, query, new Set(), archived), [pages, notebook.notebookId, query, archived])
  const visiblePages = useMemo(() => rows.map(row => row.page), [rows])
  return <section className="survey-notebook-home" aria-label={`${notebook.name} Notebook`}>
    <div className="notebook-cover-mark"><NotebookIcon size={27} strokeWidth={1.3} /></div>
    <header><NotebookName key={notebook.notebookId} notebook={notebook} />{pages.length ? <p>{rows.length} {archived ? 'archived ' : ''}{rows.length === 1 ? 'page' : 'pages'}</p> : null}</header>
    {onViewChange ? <NotebookViewPicker value={view} onChange={onViewChange} active={active} /> : null}
    {!navigationVisible && onArchivedChange ? <NotebookDirectoryViews archived={archived} onChange={onArchivedChange} /> : null}
    {!navigationVisible || !pages.length ? <button className="notebook-create-page" disabled={pending} onClick={onCreate}><ThemeActionCreateNoteIcon size={15} /><span>New page</span></button> : null}
    {pages.length ? <>{onQuery ? <label className="notebook-find notebook-find--directory"><ThemeActionSearchIcon size={14} /><TextInput aria-label="Search notebook pages" placeholder="Find a page…" value={query} onChange={event => onQuery(event.target.value)} /></label> : null}
      {view === 'cards' ? <NotebookCards pages={visiblePages} onOpen={onOpen} onTalk={onTalk} /> : view === 'graph' ? <NotebookGraph notebookId={notebook.notebookId} pages={visiblePages} expandOnFirstView={!query.trim() && !archived} onOpen={onOpen} onOpenFile={onOpenFile} onTalk={onTalk} active={active} /> : <NotebookDirectoryContextMenu pages={visiblePages} onTalk={onTalk}><div className="notebook-page-directory" aria-label={archived ? "Archived pages" : "Saved pages"}>{rows.map(({ page, depth }) => <button key={page.noteId} data-note-id={page.noteId} style={{ paddingLeft: Math.min(depth, 8) * 16 + 3 }} onClick={() => onOpen(page)}>
        <ThemeObjectNoteIcon size={17} strokeWidth={1.5} /><span><strong>{page.title}</strong><small>{page.sources[0] ? new URL(page.sources[0].url).hostname : 'Note'} · {new Date(page.updatedAt).toLocaleDateString()}</small></span><ThemeActionOpenExternalIcon size={14} />
      </button>)}{!rows.length ? <p className="notebook-no-results">{query ? 'No matching pages' : archived ? 'No archived pages' : 'No pages yet'}</p> : null}</div></NotebookDirectoryContextMenu>} {view !== 'tree' && !rows.length ? <p className="notebook-no-results">{query ? 'No matching pages' : archived ? 'No archived pages' : 'No pages yet'}</p> : null}</> : <div className="notebook-empty"><span className="notebook-empty-line" /><p>{archived ? 'No archived pages.' : <>Start with a blank page.<br />Notes captured from webpages stay here, too.</>}</p></div>}
  </section>
}

/** Creating a container is deliberate; the original metadata operation owns uncertain receipts. */
export function NotebookCreateDialog({ open, active, onClose, onCreated, onCreateIntent, restoreFocus }: { open: boolean; active: boolean; onClose(): void; onCreated(notebookId: string): void; onCreateIntent?(): void; restoreFocus?(): void }) {
  const ownerDocument = useWorkbenchDocument()
  const [name, setName] = useState('')
  const operation = useNotebookOperation()
  const input = useRef<HTMLInputElement>(null)
  function close() { if (operation.busy) return; if (!operation.pending) setName(''); onClose() }
  async function create() {
    if (operation.busy || !name.trim()) return
    if (operation.pending) { await operation.retry(); return }
    onCreateIntent?.()
    const notebookId = mintObjectId()
    await operation.run({ kind: 'create', notebookId, name: name.trim() }, () => { setName(''); onCreated(notebookId) })
  }
  return <Dialog.Root recoveryCloseDisabled={operation.busy} open={open} onOpenChange={value => { if (!value) close() }}>
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Overlay className="dialog-scrim" />
      <Dialog.Content className="notebook-create-dialog dialog-surface" onOpenAutoFocus={event => { if (!operation.pending) { event.preventDefault(); input.current?.focus() } }} onCloseAutoFocus={event => {
        if (!active || restoreFocus) event.preventDefault()
        const stillInDialog = (event.target as Node | null)?.nodeType === 1 && (event.target as HTMLElement).contains(ownerDocument.activeElement)
        if (active && (stillInDialog || ownerDocument.activeElement === ownerDocument.body)) restoreFocus?.()
      }} onEscapeKeyDown={event => { if (operation.busy) event.preventDefault() }} onInteractOutside={event => { if (operation.busy) event.preventDefault() }}>
        <header><Dialog.Title>New notebook</Dialog.Title><IconButton type="button" aria-label="Close notebook creation" disabled={operation.busy} onClick={close}><ThemeActionCloseIcon size={15} /></IconButton></header>
        <Dialog.Description className="notebook-create-description">A home for related notes.</Dialog.Description>
        <form aria-label="Create notebook" onSubmit={event => { event.preventDefault(); void create() }}>
          <label>Name<TextInput ref={input} aria-label="New notebook name" placeholder="e.g. Reading notes" value={name} maxLength={160} disabled={operation.busy || Boolean(operation.pending)} onChange={event => setName(event.target.value)} /></label>
          {operation.issue ? <p role="status" className="notebook-create-issue">{operation.issue}</p> : null}
          <footer><Button type="button" disabled={operation.busy} onClick={close}>Cancel</Button><Button type="submit" variant="primary" disabled={operation.busy || !name.trim()}>{operation.busy ? 'Creating…' : operation.pending ? 'Retry creation' : 'Create notebook'}</Button></footer>
        </form>
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
