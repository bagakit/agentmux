import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
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
import { SurfaceModeSwitch } from './SurfaceModeSwitch'

/** Only an in-flight explicit reveal observes its original editor and ancestor visibility. */
function observeRevealDOM(handle: NoteEditorHandle, attempt: () => boolean): () => void {
  const observer = new MutationObserver(() => { if (attempt()) observer.disconnect() })
  observer.observe(handle.editor.view.dom, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden'] })
  for (let ancestor = handle.editor.view.dom.parentElement; ancestor; ancestor = ancestor.parentElement) observer.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden'] })
  return () => observer.disconnect()
}

/** Presentation of the original FileDocument. Invalid source remains available through Source. */
export function NoteFileView({ document, knowledge, onChange, onSave, onOpen, revealBlock, onRevealed, focusRequest, canFocus, onFocused, restoredBlock, onSelectedBlock, resource, onOpenPage, dirty, onCheckOriginal }: {
  resource?: NoteResource; document: FileDocument; knowledge: NoteKnowledge; onChange: (raw: string) => void; onSave: () => void
  onOpen: (source: NoteSource, blockId: string) => void; revealBlock?: NoteBlockTarget; onRevealed?: () => void
  focusRequest?: number; canFocus?: () => boolean; onFocused?: (nonce: number) => void
  restoredBlock?: NoteBlockTarget; onSelectedBlock?: (target: NoteBlockTarget) => void
  onOpenPage?: (page: NotebookPage, blockId?: string) => Promise<void> | void
  dirty?: boolean; onCheckOriginal?: () => void
}) {
  const catalog = useNotebookLibrary(state => state.state)
  const presentation = useWorkbenchBrowserPresentation()
  const [canvasOpen, setCanvasOpen] = useState(false)
  const [canvasBlock, setCanvasBlock] = useState<(NoteBlockTarget & { sourceIdentity: string }) | null>(null)
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
      let originalTargetPresent = false
      handle.editor.state.doc.descendants(node => { if (node.attrs.blockId === restoredBlock.blockId) originalTargetPresent = true })
      // The focused view owns its current selection, including a new block
      // without a durable ID. A canonical echo must not replay an older ID.
      if (selected === restoredBlock.blockId || originalTargetPresent && handle.editor.state.doc.eq(handle.editor.schema.nodeFromJSON(read.note.content))) { setRestoreIssue(null); return }
    }
    if (read.status !== 'valid' || read.note.noteId !== restoredBlock.noteId || !handle.focusBlock(restoredBlock.blockId, false)) {
      setRestoreIssue('The saved block selection is not confirmed in this Note. Its exact target is retained. Select another block to recover.'); return
    }
    setRestoreIssue(null)
  }, [read, restoredBlock, handle])
  useLayoutEffect(() => {
    if (!revealBlock) return
    setCanvasBlock(null)
    setCanvasOpen(false)
  }, [revealBlock])
  useLayoutEffect(() => {
    if (!revealBlock || read.status !== 'valid' || read.note.noteId !== revealBlock.noteId || canvasOpen) return
    if (!presentation.active || !handle || handle.editor.isDestroyed) return
    const attempt = () => {
      if (handle.editor.isDestroyed) return false
      if (handle.focusBlock(revealBlock.blockId, false, true)) { setIssue(null); onRevealed?.(); return true }
      setIssue('The requested original block has not been revealed yet. Its exact target is retained; keep this Note visible or check its current draft.')
      return false
    }
    if (attempt()) return
    return observeRevealDOM(handle, attempt)
  }, [read, revealBlock, onRevealed, handle, canvasOpen, presentation.active])
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
  useLayoutEffect(() => {
    if (canvasOpen || !presentation.active || !canvasBlock || !handle || revealBlock) return
    if (read.status !== 'valid' || read.note.noteId !== canvasBlock.noteId || sourceIdentity !== canvasBlock.sourceIdentity) {
      setIssue('The selected original block belongs to a different Note or file location. Its exact target is retained; return to that Note or choose another target.')
      return
    }
    const attempt = () => {
      if (handle.editor.isDestroyed) return false
      if (handle.focusBlock(canvasBlock.blockId, false, true)) { setIssue(null); setCanvasBlock(null); return true }
      setIssue('The selected original block has not been revealed yet. Its exact target is retained; keep this Note visible or check its current draft.')
      return false
    }
    if (attempt()) return
    return observeRevealDOM(handle, attempt)
  }, [canvasOpen, canvasBlock, handle, presentation.active, read, sourceIdentity, revealBlock])
  async function openCanvasPage(page: NotebookPage, blockId?: string) {
    setCanvasBlock(null)
    if (read.status === 'valid' && page.noteId === read.note.noteId && resource && sameNoteResource(page.resource, resource)) {
      setCanvasOpen(false)
      if (blockId) setCanvasBlock({ noteId: page.noteId, blockId, sourceIdentity })
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
  const attribution = document.noteWriteAttribution?.status === 'unconfirmed' ? document.noteWriteAttribution
    : document.noteProvenance?.status === 'unconfirmed' ? document.noteProvenance : null
  return <div className="note-file-view">
    {attribution ? <div className="note-knowledge-notice" role="status">{document.noteWriteAttribution?.status === 'unconfirmed' ? 'The Note was saved. ' : ''}Block authorship is unconfirmed: {attribution.reason} Your Note remains readable and editable. {onCheckOriginal ? <button className="small-button" onClick={onCheckOriginal}>Check original file</button> : null}</div> : null}
    {restoreIssue || issue ? <div className="note-knowledge-notice" role="status">{restoreIssue || issue}</div> : null}
    {resource && catalog?.pages[read.note.noteId] && sameNoteResource(catalog.pages[read.note.noteId]!.resource, resource) ? <NotebookPageDetails key={read.note.noteId} page={catalog.pages[read.note.noteId]!} /> : null}
    {resource && catalog?.pages[read.note.noteId] && !sameNoteResource(catalog.pages[read.note.noteId]!.resource, resource) ? <p className="note-knowledge-notice" role="status">This file has a different recorded Note location. Editing stays available; recover its Notebook history or inspect the original resource.</p> : null}
    {registered ? <div className="note-view-toolbar" aria-label="Note view selection">
      <SurfaceModeSwitch value={canvasOpen ? 'graph' : 'note'} onChange={view => setCanvasOpen(view === 'graph')} active={presentation.active} ariaLabel="Note presentation"
        options={[{ value: 'note', label: 'Note', ariaLabel: 'Note view' }, { value: 'graph', label: 'Graph', ariaLabel: 'Graph view' }]} />
      {canvasOpen ? <span className="note-view-snapshot" role="status">Saved relationships{dirty ? <span>Save your note to update this graph.</span> : null}</span> : null}
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
