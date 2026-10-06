import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { NotebookPage } from '@agentmux/core/notebook-catalog'
import { NotebookDirectoryContextMenu, type NoteTalkHandler } from './NotebookDirectoryContextMenu'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import { NoteCanvas } from './NoteCanvas'

const ThemeObjectTreeIcon = semanticIconComponent('object.tree')
const ThemeLayoutGridIcon = semanticIconComponent('layout.grid')
const ThemeObjectBranchIcon = semanticIconComponent('object.branch')
const ThemeFileTextIcon = semanticIconComponent('file.text')


export type NotebookDirectoryView = 'tree' | 'cards' | 'graph'
export function NotebookViewPicker({ value, onChange, active }: { value: NotebookDirectoryView; onChange(value: NotebookDirectoryView): void; active: boolean }) {
  return <div className="recall-view-picker">
    <SurfaceModeSwitch value={value} onChange={onChange} active={active} ariaLabel="Notebook presentation"
      options={([['tree', 'Tree', ThemeObjectTreeIcon], ['cards', 'Cards', ThemeLayoutGridIcon], ['graph', 'Graph', ThemeObjectBranchIcon]] as const).map(([view, label, Icon]) => ({
        value: view, ariaLabel: `${label} view`, label: <><Icon size={14} aria-hidden="true" /><span>{label}</span></>
      }))} />
  </div>
}
function sourceLabel(page: NotebookPage) {
  const source = page.sources[0]
  if (!source) return 'Original note'
  try { return new URL(source.url).hostname } catch { return source.title || source.url }
}
export function NotebookCards({ pages, onOpen, onTalk }: { pages: NotebookPage[]; onOpen(page: NotebookPage): void; onTalk?: NoteTalkHandler | undefined }) {
  return <NotebookDirectoryContextMenu pages={pages} onTalk={onTalk}><div className="recall-note-cards" aria-label="Notebook cards">{pages.map(page => <button key={page.noteId} className="recall-note-card" title={`${page.title}\n${sourceLabel(page)}`} data-note-id={page.noteId} onClick={() => onOpen(page)}>
    <ThemeFileTextIcon size={18} strokeWidth={1.4} /><strong>{page.title}</strong><span>{sourceLabel(page)}</span><small>{new Date(page.updatedAt).toLocaleDateString()}</small>
  </button>)}</div></NotebookDirectoryContextMenu>
}
export function NotebookGraph({ notebookId, pages, onOpen, onTalk, active = true }: { notebookId: string; pages: NotebookPage[]; onOpen(page: NotebookPage, blockId?: string): void; onTalk?: NoteTalkHandler | undefined; active?: boolean }) {
  return <NoteCanvas scope={{ kind: 'notebook', notebookId }} seedNoteIds={pages.map(page => page.noteId)} active={active} onOpen={onOpen} onTalk={onTalk} />
}
