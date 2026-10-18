import { NoteFileContext } from '@agentmux/client-ui/components/NoteFileContext'
import type { Editor } from '@tiptap/core'
import { notePendingSharePreview } from '../lib/note-pending-share-preview'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FileReadParams } from '@agentmux/core/files'
import type { NoteInclude } from '../../../shared/note-document'
import { closeHistory } from '../../../shared/note-content-schema'
import { parseNoteFile, type NoteKnowledge, type NoteSource } from '../lib/note-knowledge'
import type { NoteFileTarget } from '../lib/file-document-consumers'
import { NoteSharedContext, type NoteEditorAttachments } from '../lib/note-shared-context'
import { clearPendingNoteShares, copyNoteBlock, focusIncludedNoteDraft, noteNodeAtPath, pendingNoteShares, readNoteShareClipboard, stageNoteShare, writeNoteShareClipboard } from '../lib/note-share-staging'
import { documentKey } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { setNoteComposition } from '../lib/note-live-merge'
import { NoteBlockEditor, ReadOnlyBlock } from './NoteBlockEditor'
import { useNoteCanvasObservation } from '../lib/use-note-canvas-observation'
import { noteShareUndoRecoveryMessage } from '../lib/note-share-removal'
import { NoteSharedDetails } from './NoteSharedDetails'
import { noteSharedRelations } from '../lib/note-shared-relations'
import { useNoteLinkNavigation } from '../lib/use-note-link-navigation'

type EditorOwner = { focusedEditor: Editor | null; focusedAttachments?: NoteEditorAttachments | undefined; focusEditor(editor: Editor, attachments?: NoteEditorAttachments): void }
type Observation = ReturnType<typeof useNoteCanvasObservation>
type Scope = { include?: NoteInclude; target: NoteFileTarget; read?: FileReadParams | undefined; occurrence: string; active: boolean; knowledge: NoteKnowledge; onOpen(source: NoteSource, blockId: string): void; onOpenOriginal?(target: NoteFileTarget, blockId?: string, signal?: AbortSignal): Promise<void> }
/** One graph observation for all includes on this Note; typing never rescans the workspace. */
export function NoteSharedFileEditing({ children, hasIncludes, ...scope }: Scope & { children: ReactNode; hasIncludes: boolean }) {
  const graph = useNoteCanvasObservation(scope.active && hasIncludes, false)
  const fileRevision = useAppStore(state => state.workspaceFileRevisions[scope.target.workspaceId] ?? 0), previousRevision = useRef(fileRevision)
  useEffect(() => { if (previousRevision.current !== fileRevision) { previousRevision.current = fileRevision; graph.refresh() } }, [fileRevision, graph.refresh])
  const [focused, setFocused] = useState<{ editor: Editor; attachments?: NoteEditorAttachments | undefined } | null>(null)
  const focusEditor = useCallback((editor: Editor, attachments?: NoteEditorAttachments) => setFocused(current =>
    current?.editor === editor && current.attachments?.importFiles === attachments?.importFiles && current.attachments?.pending === attachments?.pending
      ? current : { editor, attachments }), [])
  const trail = useMemo(() => [scope.target.noteId], [scope.target.noteId])
  const confirmedIncludes = useMemo(() => graph.snapshot?.graph.observations.flatMap(value => value.status === 'read' && value.kind === 'shared-block' && value.fileIdentity === 'confirmed' ? [{ noteId: value.noteId, workspaceId: value.resource.workspaceId, path: value.resource.path, revision: value.revision }] : []) ?? [], [graph.snapshot])
  const knowledge = useMemo(() => ({ ...scope.knowledge, confirmedIncludes }), [scope.knowledge, confirmedIncludes])
  return <SharedScope {...scope} knowledge={knowledge} owner={{ focusedEditor: focused?.editor ?? null, focusedAttachments: focused?.attachments, focusEditor }} graph={graph} trail={trail}>{children}</SharedScope>
}
function SharedScope({ children, graph, trail, owner, ...scope }: Scope & { children: ReactNode; graph: Observation; trail: readonly string[]; owner: EditorOwner }) {
  const current = useRef(scope); current.current = scope
  const value = useMemo(() => ({
    ...owner,
    knowledge: scope.knowledge,
    occurrence: scope.occurrence,
    fileKey: documentKey(scope.target.workspaceId, scope.target.path),
    focusIncludedBlock(include: NoteInclude, blockId: string, focus: boolean, reveal: boolean) {
      const originals = graph.snapshot?.graph.observations.filter(value => value.noteId === include.noteId && value.status === 'read' && value.kind === 'shared-block' && value.fileIdentity === 'confirmed') ?? []
      if (originals.length !== 1 || graph.snapshot?.graph.duplicateNoteIds.includes(include.noteId)) return false
      const original = originals[0]!
      return focusIncludedNoteDraft(`${scope.occurrence}/${include.referenceId}`, documentKey(original.resource.workspaceId, original.resource.path), blockId, focus, reveal)
    },
    renderInclude: (include: NoteInclude, remove: () => void, readOnly = false) => <SharedFile readOnly={readOnly} remove={remove} include={include} scope={scope} graph={graph} trail={trail} owner={owner} />,
    async copyBlock(editor: import('@tiptap/core').Editor, position: number) {
      const state = current.current
      if (state.include) { writeNoteShareClipboard(editor.view.dom.ownerDocument, { version: 1, source: state.target, block: { path: [], fingerprint: '' }, include: state.include }, editor.getText()); return 'Copied shared content · paste to reuse' }
      if (!state.read) throw Error('The original Note file mapping is unconfirmed. Your content is kept; restore this file position and retry.')
      const copy = copyNoteBlock(editor, position, state.target, state.read)
      writeNoteShareClipboard(editor.view.dom.ownerDocument, copy, editor.state.doc.nodeAt(position)?.textContent ?? 'Shared Note content')
      const type = noteNodeAtPath(editor.getJSON(), copy.block.path)?.type
      return type === 'table' ? 'Copied whole table · paste to share' : type === 'taskItem' ? 'Copied task item · paste to share' : 'Copied · paste to share'
    },
    paste(editor: import('@tiptap/core').Editor, event: ClipboardEvent) {
      const copy = readNoteShareClipboard(event, editor.view.dom.ownerDocument)
      if (!copy) return false
      event.preventDefault()
      const destination = documentKey(current.current.target.workspaceId, current.current.target.path)
      return editor.chain().focus().command(({ tr }) => { closeHistory(tr); tr.setMeta('uiEvent', 'paste'); return true }).insertContent({ type: 'noteInclude', attrs: stageNoteShare(destination, copy) }).run()
    }
  }), [scope.target.workspaceId, scope.target.path, scope.target.noteId, scope.occurrence, scope.active, scope.knowledge, scope.onOpen, graph.snapshot, graph.issue, graph.busy, graph.refresh, trail, owner.focusedEditor, owner.focusedAttachments])
  return <NoteFileContext.Provider value={scope.target}><NoteSharedContext.Provider value={value}>{children}</NoteSharedContext.Provider></NoteFileContext.Provider>
}
/** Chrome is presentation only; source identity stays in the original Markdown declaration. */
function SharedFrame({ children, source = false, status, attention = false, actions, marker }: { children: ReactNode; source?: boolean; status?: string | undefined; attention?: boolean; actions?: ReactNode; marker?: ReactNode }) {
  const label = source ? 'Shared source' : 'Shared reference'
  return <section className="note-shared-content" data-shared-role={source ? 'source' : 'reference'} aria-label={label}>
    {marker}
    <div className="note-shared-block__header" data-attention={attention || undefined}><span className="note-shared-block__label">{label}</span><span role={attention ? 'status' : undefined}>{status ?? 'Edits update all uses'}</span>{actions}</div>
    {children}<div className="note-shared-block__end">End of {source ? 'shared source' : 'shared reference'}</div>
  </section>
}
function PendingSharedFile({ include, scope, remove, graph, trail, owner }: { include: NoteInclude; scope: Scope; remove: () => void; graph: Observation; trail: readonly string[]; owner: EditorOwner }) {
  const ticket = pendingNoteShares(documentKey(scope.target.workspaceId, scope.target.path)).get(include.referenceId)
  const target = useMemo(() => ticket?.copy.source, [ticket?.copy.source.workspaceId, ticket?.copy.source.path, ticket?.copy.source.hostId, ticket?.copy.source.workspacePath, ticket?.copy.source.noteId])
  const occurrence = `${scope.occurrence}/${include.referenceId}/pending-source`
  useEffect(() => target ? useAppStore.getState().observeNoteFile(target, occurrence, false) : undefined, [target, occurrence])
  useEffect(() => { if (scope.active && target) useAppStore.getState().loadNoteFile(target) }, [scope.active, target])
  const original = useAppStore(state => ticket ? state.documents[documentKey(ticket.copy.source.workspaceId, ticket.copy.source.path)] : undefined)
  const read = useMemo(() => original ? parseNoteFile(original) : null, [original])
  const issue = useAppStore(state => state.documentIssues[documentKey(scope.target.workspaceId, scope.target.path)])
  const sharing = useAppStore(state => state.documents[documentKey(scope.target.workspaceId, scope.target.path)]?.noteEditing?.share)
  const unconfirmed = sharing?.references.includes(include.referenceId) ?? false
  const node = useMemo(() => {
    if (read?.status !== 'valid' || !ticket || read.note.noteId !== ticket.copy.source.noteId) return undefined
    return notePendingSharePreview(read.note, ticket, new Set(Object.keys(original?.noteEditing?.shares ?? {})))
  }, [read, ticket])
  useEffect(() => {
    // This same clipboard proposal was already promoted in the original source.
    // Keep the PM atom's target unchanged so Undo/Redo remains an ordinary paste.
    if (!unconfirmed && node?.type === 'noteInclude' && node.attrs?.noteId === include.noteId && !original?.noteEditing?.shares?.[node.attrs?.referenceId]) clearPendingNoteShares(documentKey(scope.target.workspaceId, scope.target.path), [include.referenceId])
  }, [unconfirmed, node, include.noteId, include.referenceId, scope.target.workspaceId, scope.target.path, original?.noteEditing?.shares])
  return <SharedFrame attention status={unconfirmed ? 'Sharing needs confirmation' : 'Pending · save to share'} actions={!unconfirmed && <button type="button" className="note-text-button" onClick={remove}>Cancel this use</button>}>
    {node && target ? <SharedScope {...scope} target={target} read={ticket?.copy.read} occurrence={occurrence} graph={graph} trail={trail} owner={owner}><ReadOnlyBlock content={node} /></SharedScope> : <p className="note-knowledge-notice" role="status">Reading the original source. Save will check its exact identity and content before sharing.</p>}
    {unconfirmed || issue && 'message' in issue ? <p className="note-knowledge-notice" role="status">{issue && 'message' in issue ? issue.message : 'The original sharing operation is retained. Its complete result has not been confirmed.'}{unconfirmed && <><button type="button" className="note-text-button" onClick={() => void useAppStore.getState().inspectNoteShare(scope.target.workspaceId, scope.target.path)}>Check this sharing operation</button><button type="button" className="note-text-button" onClick={() => void useAppStore.getState().continueNoteShare(scope.target.workspaceId, scope.target.path)}>Continue this sharing</button></>}</p> : null}
    </SharedFrame>
}
function SharedFile({ include, scope, graph, trail, owner, remove, readOnly }: { readOnly: boolean; include: NoteInclude; remove: () => void; scope: Scope; graph: Observation; trail: readonly string[]; owner: EditorOwner }) {
  const ticket = pendingNoteShares(documentKey(scope.target.workspaceId, scope.target.path)).get(include.referenceId)
  const pending = ticket && ticket.include.noteId === include.noteId && ticket.include.path === include.path && (ticket.include.workspaceId ?? scope.target.workspaceId) === (include.workspaceId ?? scope.target.workspaceId)
  const observations = useMemo(() => graph.snapshot?.graph.observations.filter(value => value.noteId === include.noteId && value.status === 'read' && value.kind === 'shared-block' && value.fileIdentity === 'confirmed') ?? [], [graph.snapshot, include.noteId])
  const found = !graph.snapshot?.graph.duplicateNoteIds.includes(include.noteId) && observations.length === 1 ? observations[0] : undefined
  const target = useMemo<NoteFileTarget | null>(() => found ? { ...found.resource, noteId: include.noteId } : null,
    [found?.resource.hostId, found?.resource.workspaceId, found?.resource.workspacePath, found?.resource.path, include.noteId])
  const occurrence = `${scope.occurrence}/${include.referenceId}`
  const key = target ? documentKey(target.workspaceId, target.path) : ''
  const original = useAppStore(state => target ? state.documents[key] : undefined)
  const dirty = useAppStore(state => target ? Boolean(state.dirtyDocuments[key]) : false)
  const saving = useAppStore(state => target ? Boolean(state.savingDocuments[key]) : false)
  const fileIssue = useAppStore(state => target ? state.documentIssues[key] : undefined)
  const [issue, setIssue] = useState<string | null>(null)
  const read = useMemo(() => original ? parseNoteFile(original) : null, [original])
  const links = useNoteLinkNavigation(async (page, blockId, signal) => {
    if (scope.onOpenOriginal) await scope.onOpenOriginal({ ...page.resource, noteId: page.noteId }, blockId, signal)
  }, graph.snapshot?.catalog, scope.active, undefined, key, scope.onOpenOriginal)
  useEffect(() => {
    if (!target || trail.includes(include.noteId)) return
    return useAppStore.getState().observeNoteFile(target, occurrence, false)
  }, [target, occurrence, include.noteId, trail])
  useEffect(() => { if (scope.active && target && !trail.includes(include.noteId)) useAppStore.getState().loadNoteFile(target) }, [scope.active, target, include.noteId, trail])
  const composition = useCallback((active: boolean) => setNoteComposition(key, occurrence, active), [key, occurrence])
  useEffect(() => () => setNoteComposition(key, occurrence, false), [key, occurrence])
  const nextTrail = useMemo(() => [...trail, include.noteId], [trail, include.noteId])
  if (trail.includes(include.noteId)) return <p className="note-shared-notice" role="status">Circular reference · this use is kept without expanding itself.</p>
  if (pending) return <PendingSharedFile include={include} scope={scope} remove={remove} graph={graph} trail={nextTrail} owner={owner} />
  if (!target || !original || read?.status !== 'valid' || read.note.noteId !== include.noteId || read.note.kind !== 'shared-block') return <p className="note-shared-notice" role="status">{graph.issue ?? (graph.snapshot?.graph.duplicateNoteIds.includes(include.noteId) ? 'Multiple files have this shared identity. The original reference is kept.' : graph.busy ? 'Reading shared sources…' : fileIssue && 'message' in fileIssue ? fileIssue.message : 'The original shared content is not confirmed. Its reference is kept.')} <button type="button" className="note-text-button" onClick={graph.refresh}>Check shared sources</button></p>
  const source = graph.snapshot ? noteSharedRelations(graph.snapshot, include.noteId, read.note.origin, { target: scope.target, referenceId: include.referenceId }).uses.some(use => use.current && use.source) : false
  return <SharedFrame source={source} attention={saving || dirty} status={saving ? 'Saving…' : dirty ? 'Unsaved changes' : undefined}
    marker={scope.onOpenOriginal && <NoteSharedDetails note={read.note} target={target} host={scope.target} include={include} graph={graph} active={scope.active} onOpen={scope.onOpenOriginal} />}
    actions={!readOnly && dirty && <button type="button" className="note-text-button" onClick={() => void useAppStore.getState().saveNoteFile(target)} disabled={saving}>Save</button>}>
    {original.noteEditing?.shareUndo ? <p className="note-knowledge-notice" role="status">{saving ? 'Saving this shared-reference removal…' : fileIssue && 'message' in fileIssue ? fileIssue.message : noteShareUndoRecoveryMessage(original.noteEditing)}
      {!saving && <><button type="button" className="note-text-button" onClick={() => void useAppStore.getState().inspectNoteShareUndo(target.workspaceId, target.path)}>Check this removal</button><button type="button" className="note-text-button" onClick={() => void useAppStore.getState().continueNoteShareUndo(target.workspaceId, target.path)}>Continue this removal</button></>}
    </p> : issue || fileIssue ? <p className="note-knowledge-notice" role="status">{issue ?? (fileIssue && 'message' in fileIssue ? fileIssue.message : 'This shared file changed. Your draft is kept; inspect its original source before saving.')}<button type="button" className="note-text-button" onClick={() => void useAppStore.getState().refreshDocument(target.workspaceId, target.path)}>Check original</button></p> : original.noteEditing?.shareUndoReceipt?.retained.length ? <p className="note-knowledge-notice" role="status">{original.noteEditing.shareUndoReceipt.status === 'partial' ? noteShareUndoRecoveryMessage(original.noteEditing) : [...new Set(original.noteEditing.shareUndoReceipt.retained.map(value => value.message))].join(' ')}</p> : null}
    <SharedScope {...scope} target={target} include={include} read={undefined} occurrence={occurrence} graph={graph} trail={nextTrail} owner={owner}>
      {readOnly ? <ReadOnlyBlock content={read.note.content} /> : <NoteBlockEditor note={read.note} knowledge={scope.knowledge} active={scope.active} showBacklinks={false} sourceIdentity={key}
        onChange={(raw, before) => useAppStore.getState().updateNoteFile(target, raw, before ?? original.content)}
        onSave={() => void useAppStore.getState().saveNoteFile(target)} onIssue={setIssue} onOpen={scope.onOpen} onOpenLink={links.openLink} onCompositionChange={composition} />}
    </SharedScope>{links.dialog}</SharedFrame>
}
