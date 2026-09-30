import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FileDocument } from '../../../shared/contracts'
import type { NoteBlockTarget } from '../../../shared/note-document'
import { parseNoteFile, type NoteKnowledge, type NoteSource } from '../lib/note-knowledge'
import { desktopElementVisible } from '../lib/desktop-presentation'
import { NoteBlockEditor, type NoteEditorHandle } from './NoteBlockEditor'

/** Presentation of the original FileDocument. Invalid source remains available through Source. */
export function NoteFileView({ document, knowledge, onChange, onSave, onOpen, revealBlock, onRevealed, focusRequest, canFocus, onFocused, restoredBlock, onSelectedBlock }: {
  document: FileDocument; knowledge: NoteKnowledge; onChange: (raw: string) => void; onSave: () => void
  onOpen: (source: NoteSource, blockId: string) => void; revealBlock?: NoteBlockTarget; onRevealed?: () => void
  focusRequest?: number; canFocus?: () => boolean; onFocused?: (nonce: number) => void
  restoredBlock?: NoteBlockTarget; onSelectedBlock?: (target: NoteBlockTarget) => void
}) {
  const read = useMemo(() => parseNoteFile(document), [document])
  const [issue, setIssue] = useState<string | null>(null)
  const [restoreIssue, setRestoreIssue] = useState<string | null>(null)
  const [handle, setHandle] = useState<NoteEditorHandle | null>(null)
  const attachHandle = useCallback((value: NoteEditorHandle | null) => { setHandle(value) }, [])
  useEffect(() => {
    if (!restoredBlock || !handle) { setRestoreIssue(null); return }
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
    if (!handle) return
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
  if (read.status === 'invalid') return <div className="note-invalid" role="status"><strong>Note source needs attention</strong>
    <p>{read.message}</p><p>The original source is preserved. Use Source to inspect it; no block identities have been repaired.</p></div>
  return <div className="note-file-view">
    {restoreIssue || issue ? <div className="note-knowledge-notice" role="status">{restoreIssue || issue}</div> : null}
    <NoteBlockEditor note={read.note} knowledge={knowledge} onChange={onChange} onSave={onSave} onOpen={onOpen} onIssue={setIssue} handleRef={attachHandle} {...(onSelectedBlock ? { onSelectedBlock } : {})} />
  </div>
}
