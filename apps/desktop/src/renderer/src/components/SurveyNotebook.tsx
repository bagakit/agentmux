import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, BookOpen, ChevronDown, ChevronRight, FileText, Plus, Search } from 'lucide-react'
import { DEFAULT_NOTEBOOK_ID, type Notebook, type NotebookPage } from '@agentmux/core/notebook-catalog'
import { notebookPageRows } from '../lib/notebook-page-tree'
import { NotebookOperationIssue, useNotebookOperation } from './NotebookPageDetails'

export function NotebookNavigation({ notebooks, pages, selectedId, selectedNoteId, onSelect, onOpen, onCreateChild, query, onQuery }: {
  notebooks: Notebook[]; pages: NotebookPage[]; selectedId: string | null; selectedNoteId: string | null
  onSelect(notebookId: string): void; onOpen(page: NotebookPage): void; onCreateChild(page: NotebookPage): void; query: string; onQuery(query: string): void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  return <div className="survey-notebooks" aria-label="Notebooks">
    {notebooks.map(book => {
      const members = pages.filter(page => page.notebookId === book.notebookId)
      return <div key={book.notebookId} className="survey-notebook-group" data-notebook-id={book.notebookId}>
        <button className="survey-item survey-notebook-item" title={book.name} data-selected={selectedId === book.notebookId && !selectedNoteId} onClick={() => onSelect(book.notebookId)}>
          <BookOpen size={16} /><strong>{book.name}</strong><span className="survey-notebook-count">{members.length || ''}</span>
        </button>
        {selectedId === book.notebookId && members.length ? <>
          <label className="notebook-find notebook-find--sidebar"><Search size={12} /><input aria-label={`Find pages in ${book.name}`} placeholder="Find a page…" value={query} onChange={event => onQuery(event.target.value)} /></label>
          <div className="survey-notebook-pages" aria-label={`${book.name} pages`}>
            {notebookPageRows(pages, book.notebookId, query, collapsed).map(({ page, depth, hasChildren, expanded }) => <div key={page.noteId} className="survey-notebook-page-row" style={{ marginLeft: Math.min(depth, 8) * 10 }}>
              {hasChildren ? <button className="notebook-tree-toggle" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${page.title}`} aria-expanded={expanded} onClick={() => setCollapsed(held => { const next = new Set(held); if (next.has(page.noteId)) next.delete(page.noteId); else next.add(page.noteId); return next })}>{expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</button> : <span className="notebook-tree-spacer" />}
              <button className="survey-notebook-page" title={page.title} data-selected={selectedNoteId === page.noteId} onClick={() => onOpen(page)}><FileText size={12} /><span>{page.title}</span></button>
              <button className="notebook-add-child" aria-label={`Add subpage to ${page.title}`} title="Add subpage" onClick={() => onCreateChild(page)}><Plus size={12} /></button>
            </div>)}
            {query && !notebookPageRows(pages, book.notebookId, query).length ? <p className="notebook-no-results">No matching pages</p> : null}
          </div></> : null}
      </div>
    })}
  </div>
}
function NotebookName({ notebook }: { notebook: Notebook }) {
  const operation = useNotebookOperation(), [draft, setDraft] = useState(notebook.name), [editing, setEditing] = useState(false), cancelled = useRef(false)
  useEffect(() => { if (!editing && !operation.busy && !operation.issue) setDraft(notebook.name) }, [notebook.name, editing, operation.busy, operation.issue])
  async function save() { const name = draft.trim(); if (!name) { setDraft(notebook.name); return } if (name !== notebook.name) await operation.run({ kind: 'rename', notebookId: notebook.notebookId, name }) }
  return <><h1>{notebook.notebookId === DEFAULT_NOTEBOOK_ID ? notebook.name : <input className="notebook-name-input" aria-label="Notebook name" title="Rename notebook" value={draft} disabled={operation.busy || Boolean(operation.issue)}
    onFocus={() => setEditing(true)} onChange={event => setDraft(event.target.value)} onBlur={() => { setEditing(false); if (cancelled.current) { cancelled.current = false; return } void save() }}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { cancelled.current = true; setDraft(notebook.name); event.currentTarget.blur() } }} />}</h1><NotebookOperationIssue operation={operation} /></>
}
export function NotebookHome({ notebook, pages, pending, onCreate, onOpen, query, onQuery }: {
  notebook: Notebook; pages: NotebookPage[]; pending: boolean; onCreate(): void; onOpen(page: NotebookPage): void; query: string; onQuery?: ((query: string) => void) | undefined
}) {
  const rows = notebookPageRows(pages, notebook.notebookId, query)
  return <section className="survey-notebook-home" aria-label={`${notebook.name} Notebook`}>
    <div className="notebook-cover-mark"><BookOpen size={27} strokeWidth={1.3} /></div>
    <header><span className="notebook-eyebrow">NOTEBOOK</span><NotebookName key={notebook.notebookId} notebook={notebook} /><p>{pages.length ? `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} · Saved in this notebook.` : 'A place for thoughts worth keeping.'}</p></header>
    <button className="notebook-create-page" disabled={pending} onClick={onCreate}><Plus size={15} /><span>New page</span></button>
    {pages.length ? <>{onQuery ? <label className="notebook-find notebook-find--directory"><Search size={14} /><input aria-label="Search notebook pages" placeholder="Find a page…" value={query} onChange={event => onQuery(event.target.value)} /></label> : null}
      <div className="notebook-page-directory" aria-label="Saved pages">{rows.map(({ page, depth }) => <button key={page.noteId} style={{ paddingLeft: Math.min(depth, 8) * 16 + 3 }} onClick={() => onOpen(page)}>
        <FileText size={17} strokeWidth={1.5} /><span><strong>{page.title}</strong><small>{page.sources[0] ? new URL(page.sources[0].url).hostname : 'Note'} · {new Date(page.updatedAt).toLocaleDateString()}</small></span><ArrowUpRight size={14} />
      </button>)}{query && !rows.length ? <p className="notebook-no-results">No matching pages</p> : null}</div></> : <div className="notebook-empty"><span className="notebook-empty-line" /><p>Start with a blank page.<br />Notes captured from webpages stay here, too.</p></div>}
  </section>
}
