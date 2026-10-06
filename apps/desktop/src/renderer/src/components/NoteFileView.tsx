import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FileDocument } from '../../../shared/contracts'
import type { NoteBlockTarget } from '../../../shared/note-document'
import { parseNoteFile, type NoteKnowledge, type NoteSource } from '../lib/note-knowledge'
import { desktopElementVisible } from '../lib/desktop-presentation'
import { NotebookPageDetails } from './NotebookPageDetails'
import type { NotebookPage, NoteResource } from '@agentmux/core/notebook-catalog'
import { sameNoteResource, useNotebookLibrary } from '../lib/notebook-library'
import { NoteBlockEditor, type NoteEditorHandle } from './NoteBlockEditor'
import { NoteCanvas } from './NoteCanvas'
import { useWorkbenchBrowserPresentation, WorkbenchPresentationContext } from '../lib/workbench-presentation'
import { openNotebookPage } from '../lib/recall-notebooks'
import { useAppStore } from '../store'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useNoteLinkNavigation } from '../lib/use-note-link-navigation'
import { NoteLinksPanel } from './NoteLinksPanel'

/** Presentation of the original FileDocument. Invalid source remains available through Source. */
export function NoteFileView({ document, knowledge, onChange, onSave, onOpen, revealBlock, onRevealed, focusRequest, canFocus, onFocused, restoredBlock, onSelectedBlock, resource, onOpenPage }: {
  resource?: NoteResource; document: FileDocument; knowledge: NoteKnowledge; onChange: (raw: string) => void; onSave: () => void
  onOpen: (source: NoteSource, blockId: string) => void; revealBlock?: NoteBlockTarget; onRevealed?: () => void
  focusRequest?: number; canFocus?: () => boolean; onFocused?: (nonce: number) => void
  restoredBlock?: NoteBlockTarget; onSelectedBlock?: (target: NoteBlockTarget) => void
  onOpenPage?: (page: NotebookPage, blockId?: string) => Promise<void> | void
}) {
  const catalog = useNotebookLibrary(state => state.state)
  const presentation = useWorkbenchBrowserPresentation()
  const [canvasOpen, setCanvasOpen] = useState(false)
  const [canvasBlock, setCanvasBlock] = useState<NoteBlockTarget | null>(null)
  const read = useMemo(() => parseNoteFile(document), [document])
  const sourceIdentity = JSON.stringify([resource?.hostId, resource?.workspaceId, resource?.workspacePath, document.path, read.status === 'valid' ? read.note.noteId : null])
  const [issue, setIssue] = useState<string | null>(null)
  const [restoreIssue, setRestoreIssue] = useState<string | null>(null)
  const [handle, setHandle] = useState<NoteEditorHandle | null>(null)
  const registered = read.status === 'valid' && resource && catalog?.pages[read.note.noteId] && sameNoteResource(catalog.pages[read.note.noteId]!.resource, resource)
  const attachHandle = useCallback((value: NoteEditorHandle | null) => { setHandle(value) }, [])
  useEffect(() => {
    if (!restoredBlock || !handle || handle.editor.isDestroyed) { setRestoreIssue(null); return }
    if (read.status === 'valid' && read.note.noteId === restoredBlock.noteId && handle.editor.view.hasFocus()) {
      const selection = handle.editor.state.selection
      let selected = handle.editor.state.doc.nodeAt(selection.from)?.attrs.blockId
      for (let depth = selection.$from.depth; depth > 0 && !selected; depth--) selected = selection.$from.node(depth).attrs.blockId
      if (selected === restoredBlock.blockId) { setRestoreIssue(null); return }
    }
    if (read.status !== 'valid' || read.note.noteId !== restoredBlock.noteId || !handle.focusBlock(restoredBlock.blockId, false)) {
      setRestoreIssue('The saved block selection is not confirmed in this Note. Its exact target is retained. Select another block to recover.'); return
    }
    setRestoreIssue(null)
  }, [read, restoredBlock, handle])
  useEffect(() => {
    if (!revealBlock || read.status !== 'valid' || read.note.noteId !== revealBlock.noteId) return
    setCanvasOpen(false)
    if (!handle || handle.editor.isDestroyed) return
    if (handle.focusBlock(revealBlock.blockId, false)) { setIssue(null); onRevealed?.() }
    else setIssue('The requested block is not available in the original Note. Its exact target is retained.')
  }, [read, revealBlock, onRevealed, handle])
  useEffect(() => {
    if (!handle || focusRequest === undefined) return
    const editor = handle.editor
    const attempt = () => {
      if (editor.isDestroyed || !canFocus?.()) return
      if (!desktopElementVisible(editor.view.dom)) return
      editor.view.focus()
      if (editor.view.dom === window.document.activeElement || editor.view.dom.contains(window.document.activeElement)) onFocused?.(focusRequest)
    }
    attempt()
    if (!canFocus?.()) return
    const observer = new MutationObserver(() => { attempt(); if (!canFocus?.()) observer.disconnect() })
    observer.observe(window.document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert', 'hidden', 'aria-hidden'] })
    return () => observer.disconnect()
  }, [handle, focusRequest, canFocus, onFocused, read, restoredBlock, revealBlock])
  useEffect(() => {
    if (canvasOpen || !canvasBlock || !handle) return
    if (handle.focusBlock(canvasBlock.blockId, false)) setIssue(null)
    else setIssue(`Block ${canvasBlock.blockId} is not available in the current draft. Its original target is retained; check the saved source.`)
    setCanvasBlock(null)
  }, [canvasOpen, canvasBlock, handle])
  async function openCanvasPage(page: NotebookPage, blockId?: string) {
    if (read.status === 'valid' && page.noteId === read.note.noteId && resource && sameNoteResource(page.resource, resource)) {
      setCanvasOpen(false)
      if (blockId) setCanvasBlock({ noteId: page.noteId, blockId })
      else setIssue(null)
      return
    }
    try {
      const state = useAppStore.getState()
      state.setRecallNotebook(page.notebookId, page.noteId)
      state.setMainSurface('recall')
      await openNotebookPage(page, presentation.projection?.onSelect, presentation.reference,
        blockId ? { noteId: page.noteId, blockId } : undefined)
    } catch (error) { setIssue(presentError(error)); useAppStore.getState().reportError(error) }
  }
  const openLinkedPage = async (page: NotebookPage, blockId?: string) => {
    if (read.status === 'valid' && page.noteId === read.note.noteId && resource && sameNoteResource(page.resource, resource)) { await openCanvasPage(page, blockId); return }
    if (onOpenPage) await onOpenPage(page, blockId)
    else await openCanvasPage(page, blockId)
  }
  const links = useNoteLinkNavigation(openLinkedPage, catalog, presentation.active && !canvasOpen,
    (link, target) => link.referenceId ? handle?.bindLink(link, target) ?? false : true,
    sourceIdentity)
  if (read.status === 'invalid') return <div className="note-invalid" role="status"><strong>Note source needs attention</strong>
    <p>{read.message}</p><p>The original source is preserved. Use Source to inspect it; no block identities have been repaired.</p></div>
  return <div className="note-file-view">
    {restoreIssue || issue ? <div className="note-knowledge-notice" role="status">{restoreIssue || issue}</div> : null}
    {resource && catalog?.pages[read.note.noteId] && sameNoteResource(catalog.pages[read.note.noteId]!.resource, resource) ? <NotebookPageDetails key={read.note.noteId} page={catalog.pages[read.note.noteId]!} /> : null}
    {resource && catalog?.pages[read.note.noteId] && !sameNoteResource(catalog.pages[read.note.noteId]!.resource, resource) ? <p className="note-knowledge-notice" role="status">This file has a different recorded Note location. Editing stays available; recover its Notebook history or inspect the original resource.</p> : null}
    {resource && catalog?.pages[read.note.noteId] && sameNoteResource(catalog.pages[read.note.noteId]!.resource, resource) ? <div className="note-association-action">
      <button type="button" className="note-text-button" aria-expanded={canvasOpen} onClick={() => setCanvasOpen(value => !value)}>{canvasOpen ? 'Return to note' : 'Explore relationships'}</button>
    </div> : null}
    {canvasOpen ? <div className="note-association-canvas"><NoteCanvas scope={{ kind: 'note', noteId: read.note.noteId }} active={presentation.active} onOpen={openCanvasPage} /></div> : null}
    <div hidden={canvasOpen} inert={canvasOpen} className="note-original-editor">
    <WorkbenchPresentationContext.Provider value={canvasOpen ? { ...presentation, active: false } : presentation}>
    <NoteBlockEditor note={read.note} knowledge={knowledge} onChange={onChange} onSave={onSave} onOpen={onOpen} onIssue={setIssue} handleRef={attachHandle} onOpenLink={links.openLink} active={presentation.active && !canvasOpen} showBacklinks={!registered} sourceIdentity={sourceIdentity} {...(onSelectedBlock ? { onSelectedBlock } : {})} />
    </WorkbenchPresentationContext.Provider></div>
    {links.dialog}
    {registered ? <NoteLinksPanel noteId={read.note.noteId} active={presentation.active && !canvasOpen} onOpen={openLinkedPage} selectedBlockId={restoredBlock?.blockId} /> : null}
  </div>
}
