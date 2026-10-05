import { FileText, GitBranch, LayoutGrid, ListTree } from 'lucide-react'
import { useMemo } from 'react'
import type { NotebookPage } from '@agentmux/core/notebook-catalog'
import { loadedNoteFiles, noteFilesFromDocuments, noteKnowledge } from '../lib/note-knowledge'
import { notebookPageResourceMatches } from '../lib/notebook-library'
import { notebookGraph } from '../lib/notebook-view-model'
import { useAppStore } from '../store'
import { NotebookPageContextMenu, type NoteTalkHandler } from './NotebookPageContextMenu'

export type NotebookDirectoryView = 'tree' | 'cards' | 'graph'
export function NotebookViewPicker({ value, onChange }: { value: NotebookDirectoryView; onChange(value: NotebookDirectoryView): void }) {
  return <div className="recall-view-picker" role="group" aria-label="Notebook presentation">
    {([['tree', 'Tree', ListTree], ['cards', 'Cards', LayoutGrid], ['graph', 'Graph', GitBranch]] as const).map(([view, label, Icon]) => <button key={view} type="button" aria-label={`${label} view`} aria-pressed={value === view} onClick={() => onChange(view)}><Icon size={14} /><span>{label}</span></button>)}
  </div>
}
function sourceLabel(page: NotebookPage) {
  const source = page.sources[0]
  if (!source) return 'Original note'
  try { return new URL(source.url).hostname } catch { return source.title || source.url }
}
export function NotebookCards({ pages, onOpen, onTalk }: { pages: NotebookPage[]; onOpen(page: NotebookPage): void; onTalk?: NoteTalkHandler | undefined }) {
  return <div className="recall-note-cards" aria-label="Notebook cards">{pages.map(page => <NotebookPageContextMenu key={page.noteId} page={page} onTalk={onTalk}><button className="recall-note-card" title={`${page.title}\n${sourceLabel(page)}`} data-note-id={page.noteId} onClick={() => onOpen(page)}>
    <FileText size={18} strokeWidth={1.4} /><strong>{page.title}</strong><span>{sourceLabel(page)}</span><small>{new Date(page.updatedAt).toLocaleDateString()}</small>
  </button></NotebookPageContextMenu>)}</div>
}
export function NotebookGraph({ pages, onOpen, onTalk }: { pages: NotebookPage[]; onOpen(page: NotebookPage): void; onTalk?: NoteTalkHandler | undefined }) {
  const documents = useAppStore(state => noteFilesFromDocuments(state.documents)), config = useAppStore(state => state.config)
  const knowledge = useMemo(() => noteKnowledge(loadedNoteFiles(documents), 'partial'), [documents])
  const graph = useMemo(() => notebookGraph(pages, knowledge, page => notebookPageResourceMatches(page, config)), [pages, knowledge, config])
  const positions = new Map(pages.map((page, index) => [page.noteId, { x: 28 + index % 3 * 242, y: 32 + Math.floor(index / 3) * 136 }]))
  const width = Math.min(pages.length, 3) * 242 + 30, height = Math.ceil(pages.length / 3) * 136 + 30
  return <section className="recall-graph" aria-label="Notebook graph">
    <div className="recall-graph-legend"><span><i />Directory hierarchy</span><span><i data-reference />Confirmed block reference / embed</span></div>
    <p className="recall-graph-coverage" role="status">Partial reference coverage · {graph.readPages} of {pages.length} displayed pages read. Only already-read files are indexed.{graph.unconfirmedReferences ? ` ${graph.unconfirmedReferences} references have an unread, external, missing or ambiguous target; their original references are kept.` : ''}</p>
    <div className="recall-graph-scroll"><div className="recall-graph-canvas" style={{ width, height }}>
      <svg width={width} height={height} aria-label="Confirmed Notebook relationships" role="img"><title>Directory hierarchy and confirmed references; page buttons open original Notes.</title><defs><marker id="recall-graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
        {graph.edges.map(edge => { const from = positions.get(edge.from)!, to = positions.get(edge.to)!, self = edge.from === edge.to, sameRow = from.y === to.y, right = to.x > from.x, down = to.y > from.y
          const start = { x: from.x + (sameRow ? right ? 200 : 0 : 100), y: from.y + (sameRow ? 40 : down ? 80 : 0) }, end = { x: to.x + (sameRow ? right ? 0 : 200 : 100), y: to.y + (sameRow ? 40 : down ? 0 : 80) }
          return <path key={edge.id} data-edge-kind={edge.kind} data-edge-from={edge.from} data-edge-to={edge.to} d={self ? `M ${from.x + 100} ${from.y} c -65 -30 65 -30 30 0` : `M ${start.x} ${start.y} Q ${(start.x + end.x) / 2 + (sameRow ? 0 : 28)} ${(start.y + end.y) / 2 - (sameRow ? 26 : 0)} ${end.x} ${end.y}`} markerEnd="url(#recall-graph-arrow)"><title>{edge.detail}</title></path> })}
      </svg>
      {pages.map(page => { const position = positions.get(page.noteId)!; return <NotebookPageContextMenu key={page.noteId} page={page} onTalk={onTalk}><button className="recall-graph-node" title={`${page.title}\n${sourceLabel(page)}`} data-note-id={page.noteId} style={{ left: position.x, top: position.y }} onClick={() => onOpen(page)}><FileText size={15} /><strong>{page.title}</strong><small>{sourceLabel(page)}</small></button></NotebookPageContextMenu> })}
    </div></div>
  </section>
}
