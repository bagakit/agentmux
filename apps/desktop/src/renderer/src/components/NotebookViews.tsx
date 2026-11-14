import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useState } from 'react'
import type { NotebookPage } from '@agentmux/core/notebook-catalog'
import { NotebookDirectoryContextMenu, type NoteTalkHandler } from './NotebookDirectoryContextMenu'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import type { NoteCanvas, NoteCanvasProps } from './NoteCanvas'

const ThemeObjectTreeIcon = semanticIconComponent('object.tree')
const ThemeLayoutGridIcon = semanticIconComponent('layout.grid')
const ThemeObjectBranchIcon = semanticIconComponent('object.branch')
const ThemeObjectNoteIcon = semanticIconComponent('object.note')


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
    <ThemeObjectNoteIcon size={18} strokeWidth={1.4} /><strong>{page.title}</strong><span>{sourceLabel(page)}</span><small>{new Date(page.updatedAt).toLocaleDateString()}</small>
  </button>)}</div></NotebookDirectoryContextMenu>
}
export function NotebookGraph({ notebookId, pages, onOpen, onOpenFile, onTalk, active = true, expandOnFirstView = true }: { notebookId: string; pages: NotebookPage[]; onOpen(page: NotebookPage, blockId?: string): void; onOpenFile?: NoteCanvasProps['onOpenFile']; onTalk?: NoteTalkHandler | undefined; active?: boolean; expandOnFirstView?: boolean }) {
  const [Canvas, setCanvas] = useState<typeof NoteCanvas>()
  const [loadFailed, setLoadFailed] = useState(false)
  useEffect(() => {
    if (!active || Canvas || loadFailed) return
    let current = true
    void import('./NoteCanvas').then(({ NoteCanvas }) => {
      if (current) setCanvas(() => NoteCanvas)
    }, () => { if (current) setLoadFailed(true) })
    return () => { current = false }
  }, [active, Canvas, loadFailed])

  if (!Canvas) return active ? <section className="note-canvas" aria-label="Notebook graph">
    <div className="note-canvas-stage">
      <div className="note-canvas-empty" role="status">
        <ThemeObjectBranchIcon size={24} aria-hidden="true" />
        <strong>{loadFailed ? 'Could not open the Notebook graph.' : 'Opening Notebook graph…'}</strong>
        {loadFailed ? <button type="button" onClick={() => setLoadFailed(false)}>Retry graph</button> : null}
      </div>
    </div>
  </section> : null

  return <Canvas scope={{ kind: 'notebook', notebookId }} seedNoteIds={pages.map(page => page.noteId)} expandOnFirstView={expandOnFirstView} active={active} onOpen={onOpen} onOpenFile={onOpenFile} onTalk={onTalk} />
}
