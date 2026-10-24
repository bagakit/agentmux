import { NoteFileContext, NoteFileLinkContext, useNoteFileResource } from '@agentmux/client-ui/components/NoteFileContext'
import { useDesktopNoteLinkOpener } from '../lib/note-file-link'
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { NoteViewToolbarContext } from '../lib/note-view-toolbar'
import { documentKey } from '../lib/workbench-tabs'
import type { FileDocument } from '../../../shared/contracts'
import { serializeNoteDocument, type NoteBlockTarget } from '../../../shared/note-document'
import { parseNoteFile, type NoteKnowledge, type NoteSource } from '../lib/note-knowledge'
import { desktopElementVisible } from '../lib/desktop-presentation'
import { NotebookPageDetails } from './NotebookPageDetails'
import { noteSavedEditors } from './NoteParticipants'
import type { NotebookPage, NoteResource } from '@agentmux/core/notebook-catalog'
import { sameNoteResource, useNotebookLibrary } from '../lib/notebook-library'
import { NoteBlockEditor, type NoteEditorHandle } from './NoteBlockEditor'
import { useWorkbenchBrowserPresentation } from '../lib/workbench-presentation'
import { openNotebookPage } from '../lib/recall-notebooks'
import { useAppStore } from '../store'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useNoteLinkNavigation } from '../lib/use-note-link-navigation'
import { NoteLinksPanel } from './NoteLinksPanel'
import { NoteFileIdentity } from './NoteFileIdentity'
import type { NoteFileTarget } from '../lib/file-document-consumers'

/** Only an in-flight explicit reveal observes its original editor and ancestor visibility. */
function observeRevealDOM(handle: NoteEditorHandle, attempt: () => boolean): () => void {
  let stopNavigation = () => {}
  const retry = () => { if (attempt()) { observer.disconnect(); stopNavigation() } }
  const observer = new MutationObserver(retry)
  stopNavigation = handle.onNavigationReady?.(retry) ?? (() => {})
  observer.observe(handle.editor.view.dom, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden'] })
  for (let ancestor = handle.editor.view.dom.parentElement; ancestor; ancestor = ancestor.parentElement) observer.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden'] })
  return () => { observer.disconnect(); stopNavigation() }
}

/** Presentation of the original FileDocument. Invalid source remains available through Source. */
export function NoteFileView({ document, knowledge, onChange, onSave, onOpen, revealBlock, onRevealed, focusRequest, canFocus, onFocused, restoredBlock, onSelectedBlock, resource, onOpenPage, onOpenOriginal, dirty, onCheckOriginal, onCompositionChange, onSnapshotIssue, onKeepDisplayedDraft, sourceCoverage }: {
  resource?: NoteResource; document: FileDocument; knowledge: NoteKnowledge; onChange: (raw: string, editorBefore?: string) => void; onSave: () => void
  onOpen: (source: NoteSource, blockId: string) => void; revealBlock?: NoteBlockTarget; onRevealed?: () => void
  focusRequest?: number; canFocus?: () => boolean; onFocused?: (nonce: number) => void
  restoredBlock?: NoteBlockTarget; onSelectedBlock?: (target: NoteBlockTarget) => void
  onOpenPage?: (page: NotebookPage, blockId?: string, signal?: AbortSignal) => Promise<void> | void
  onOpenOriginal?: (target: NoteFileTarget, blockId?: string, signal?: AbortSignal) => Promise<void>
  dirty?: boolean; onCheckOriginal?: () => void; sourceCoverage?: ReactNode
  onCompositionChange?: (composing: boolean) => void
  onSnapshotIssue?: (displayedRaw: string, incomingRaw: string, reason: string) => void
  onKeepDisplayedDraft?: (displayedRaw: string, incomingRaw: string) => void
}) {
  const catalog = useNotebookLibrary(state => state.state)
  const presentation = useWorkbenchBrowserPresentation()
  const openAttachment = useDesktopNoteLinkOpener()
  const toolbar = useContext(NoteViewToolbarContext)
  const [pendingBlock, setPendingBlock] = useState<(NoteBlockTarget & { sourceIdentity: string }) | null>(null)
  const read = useMemo(() => parseNoteFile(document), [document])
  const parentResource = useNoteFileResource()
  const savedEditors = useMemo(() => noteSavedEditors(document, read.status === 'valid' ? read.note.noteId : '', resource),
    [document.noteProvenance, document.path, document.revision, read.status === 'valid' ? read.note.noteId : null, resource?.hostId, resource?.workspaceId, resource?.workspacePath, resource?.path])
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
      // Local input and a pending canonical echo can differ for a moment. Neither
      // is a new navigation request: the focused view keeps its actual caret.
      setRestoreIssue(selected === restoredBlock.blockId || originalTargetPresent ? null : 'The saved block selection is not confirmed in this Note. Its exact target is retained. Select another block to recover.')
      return
    }
    if (read.status !== 'valid' || read.note.noteId !== restoredBlock.noteId || !handle.focusBlock(restoredBlock.blockId, false)) {
      setRestoreIssue('The saved block selection is not confirmed in this Note. Its exact target is retained. Select another block to recover.')
      return handle.onNavigationReady?.(() => { if (!handle.editor.isDestroyed && !handle.editor.view.hasFocus() && read.status === 'valid' && read.note.noteId === restoredBlock.noteId && handle.focusBlock(restoredBlock.blockId, false)) setRestoreIssue(null) })
    }
    setRestoreIssue(null)
  }, [read, restoredBlock, handle])
  useLayoutEffect(() => {
    if (!revealBlock) return
    setPendingBlock(null)
  }, [revealBlock])
  useLayoutEffect(() => {
    if (!revealBlock || read.status !== 'valid' || read.note.noteId !== revealBlock.noteId) return
    if (!presentation.active || !handle || handle.editor.isDestroyed) return
    const attempt = () => {
      if (handle.editor.isDestroyed) return false
      if (handle.focusBlock(revealBlock.blockId, false, true)) { setIssue(null); onRevealed?.(); return true }
      setIssue('The requested original block has not been revealed yet. Its exact target is retained; keep this Note visible or check its current draft.')
      return false
    }
    if (attempt()) return
    return observeRevealDOM(handle, attempt)
  }, [read, revealBlock, onRevealed, handle, presentation.active])
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
    if (!presentation.active || !pendingBlock || !handle || revealBlock) return
    if (read.status !== 'valid' || read.note.noteId !== pendingBlock.noteId || sourceIdentity !== pendingBlock.sourceIdentity) {
      setIssue('The selected original block belongs to a different Note or file location. Its exact target is retained; return to that Note or choose another target.')
      return
    }
    const attempt = () => {
      if (handle.editor.isDestroyed) return false
      if (handle.focusBlock(pendingBlock.blockId, false, true)) { setIssue(null); setPendingBlock(null); return true }
      setIssue('The selected original block has not been revealed yet. Its exact target is retained; keep this Note visible or check its current draft.')
      return false
    }
    if (attempt()) return
    return observeRevealDOM(handle, attempt)
  }, [pendingBlock, handle, presentation.active, read, sourceIdentity, revealBlock])
  const openLinkedPage = async (page: NotebookPage, blockId?: string, signal?: AbortSignal) => {
    setPendingBlock(null)
    if (read.status === 'valid' && page.noteId === read.note.noteId && resource && sameNoteResource(page.resource, resource)) {
      if (blockId) setPendingBlock({ noteId: page.noteId, blockId, sourceIdentity })
      else setIssue(null)
      return
    }
    try {
      if (onOpenPage) { await onOpenPage(page, blockId, signal); return }
      const state = useAppStore.getState()
      state.setRecallNotebook(page.notebookId, page.noteId)
      state.setMainSurface('recall')
      await openNotebookPage(page, presentation.projection?.onSelect, presentation.reference,
        blockId ? { noteId: page.noteId, blockId } : undefined, undefined, signal)
    } catch (error) { setIssue(presentError(error)); useAppStore.getState().reportError(error) }
  }
  const links = useNoteLinkNavigation(openLinkedPage, catalog, presentation.active,
    (link, target) => link.referenceId ? handle?.bindLink(link, target) ?? false : true,
    sourceIdentity, onOpenOriginal)
  const hasLinkedReferences = registered || read.status === 'valid' && read.note.kind === 'shared-block' && Boolean(resource)
  const footer = hasLinkedReferences || sourceCoverage ? <footer className="note-reading-footer" aria-label="Note references and sources">
    {read.status === 'valid' && hasLinkedReferences ? <NoteLinksPanel noteId={read.note.noteId} active={presentation.active} onOpen={openLinkedPage} onOpenFile={onOpenOriginal} selectedBlockId={restoredBlock?.blockId} /> : null}
    {sourceCoverage}
  </footer> : null
  if (read.status === 'invalid') return <div className="note-file-view"><div className="note-invalid" role="status"><strong>Note source needs attention</strong>
    <p>{read.message}</p><p>The original source is preserved. Use Source to inspect it; no block identities have been repaired.</p></div>{footer}</div>
  const identityIcon = <NoteFileIdentity key={sourceIdentity} scope={sourceIdentity} document={document} resource={resource} dirty={dirty} active={presentation.active} />
  return <NoteFileLinkContext.Provider value={openAttachment}><NoteFileContext.Provider value={resource ?? parentResource}><div className="note-file-view">
    {restoreIssue || issue ? <div className="note-knowledge-notice" role="status">{restoreIssue || issue}</div> : null}
    {resource && catalog?.pages[read.note.noteId] && sameNoteResource(catalog.pages[read.note.noteId]!.resource, resource) ? <NotebookPageDetails key={read.note.noteId} page={catalog.pages[read.note.noteId]!} savedEditors={savedEditors}
      {...(read.note.title === undefined ? {} : { sourceTitle: read.note.title })} {...(dirty === undefined ? {} : { sourceDirty: dirty })} {...(onCheckOriginal ? { onCheckOriginal } : {})} /> : null}
    {!registered ? <header className="notebook-page-heading"><h1 title={document.path} aria-description={`Original file: ${document.path}`}>{identityIcon} {read.note.title ?? 'Untitled note'}</h1></header> : null}
    {resource && catalog?.pages[read.note.noteId] && !sameNoteResource(catalog.pages[read.note.noteId]!.resource, resource) ? <p className="note-knowledge-notice" role="status">This file has a different recorded Note location. Editing stays available; recover its Notebook history or inspect the original resource.</p> : null}
    {resource && registered && toolbar && toolbar.documentKey === documentKey(resource.workspaceId, document.path) ? createPortal(identityIcon, toolbar.element) : null}
    <div className="note-original-editor">
    <NoteBlockEditor note={read.note} knowledge={knowledge} onChange={onChange} onSave={onSave} onOpen={onOpen} onIssue={setIssue} handleRef={attachHandle} onOpenLink={links.openLink} active={presentation.active} showBacklinks={!hasLinkedReferences} sourceIdentity={sourceIdentity} {...(onSelectedBlock ? { onSelectedBlock } : {})} {...(onCompositionChange ? { onCompositionChange } : {})}
      {...(onSnapshotIssue ? { onSnapshotIssue: (displayedRaw: string, incomingRaw: string, reason: string) => {
        // The PM snapshot is canonical, while a file edited outside the app may
        // use different Markdown whitespace. Fence the canonical target, then
        // pass the exact current source to the original document owner.
        if (incomingRaw === serializeNoteDocument(read.note)) onSnapshotIssue(displayedRaw, document.content, reason)
      } } : {})}
      {...(onKeepDisplayedDraft ? { onKeepDisplayedDraft: (displayedRaw: string, incomingRaw: string) => {
        if (incomingRaw === serializeNoteDocument(read.note)) onKeepDisplayedDraft(displayedRaw, document.content)
      } } : {})} />
    </div>
    {links.dialog}
    {footer}
  </div></NoteFileContext.Provider></NoteFileLinkContext.Provider>
}
