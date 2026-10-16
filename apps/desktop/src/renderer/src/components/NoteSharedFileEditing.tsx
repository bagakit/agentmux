import type { Editor } from '@tiptap/core'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { FileReadParams } from '@agentmux/core/files'
import type { NoteInclude } from '../../../shared/note-document'
import { parseNoteFile, type NoteKnowledge, type NoteSource } from '../lib/note-knowledge'
import type { NoteFileTarget } from '../lib/file-document-consumers'
import { NoteSharedContext } from '../lib/note-shared-context'
import { clearPendingNoteShares, copyNoteBlock, focusIncludedNoteDraft, noteBlockFingerprint, noteNodeAtPath, pendingNoteShares, readNoteShareClipboard, stageNoteShare, writeNoteShareClipboard } from '../lib/note-share-staging'
import { documentKey } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { setNoteComposition } from '../lib/note-live-merge'
import { NoteBlockEditor, ReadOnlyBlock } from './NoteBlockEditor'
import { useNoteCanvasObservation } from '../lib/use-note-canvas-observation'

type EditorOwner = { focusedEditor: Editor | null; focusEditor(editor: Editor): void }
type Observation = ReturnType<typeof useNoteCanvasObservation>
type Scope = { include?: NoteInclude; target: NoteFileTarget; read?: FileReadParams | undefined; occurrence: string; active: boolean; knowledge: NoteKnowledge; onOpen(source: NoteSource, blockId: string): void }
/** One graph observation for all includes on this Note; typing never rescans the workspace. */
export function NoteSharedFileEditing({ children, hasIncludes, ...scope }: Scope & { children: ReactNode; hasIncludes: boolean }) {
  const graph = useNoteCanvasObservation(scope.active && hasIncludes, false)
  const fileRevision = useAppStore(state => state.workspaceFileRevisions[scope.target.workspaceId] ?? 0), previousRevision = useRef(fileRevision)
  useEffect(() => { if (previousRevision.current !== fileRevision) { previousRevision.current = fileRevision; graph.refresh() } }, [fileRevision, graph.refresh])
  const [focusedEditor, focusEditor] = useState<Editor | null>(null), trail = useMemo(() => [scope.target.noteId], [scope.target.noteId])
  const confirmedIncludes = useMemo(() => graph.snapshot?.graph.observations.flatMap(value => value.status === 'read' && value.kind === 'shared-block' && value.fileIdentity === 'confirmed' ? [{ noteId: value.noteId, workspaceId: value.resource.workspaceId, path: value.resource.path, revision: value.revision }] : []) ?? [], [graph.snapshot])
  const knowledge = useMemo(() => ({ ...scope.knowledge, confirmedIncludes }), [scope.knowledge, confirmedIncludes])
  return <SharedScope {...scope} knowledge={knowledge} owner={{ focusedEditor, focusEditor }} graph={graph} trail={trail}>{children}</SharedScope>
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
      if (state.include) { writeNoteShareClipboard(editor.view.dom.ownerDocument, { version: 1, source: state.target, block: { path: [], fingerprint: '' }, include: state.include }, editor.getText()); return }
      if (!state.read) throw Error('The original Note file mapping is unconfirmed. Your content is kept; restore this file position and retry.')
      const copy = copyNoteBlock(editor, position, state.target, state.read)
      writeNoteShareClipboard(editor.view.dom.ownerDocument, copy, editor.state.doc.nodeAt(position)?.textContent ?? 'Shared Note content')
    },
    paste(editor: import('@tiptap/core').Editor, event: ClipboardEvent) {
      const copy = readNoteShareClipboard(event, editor.view.dom.ownerDocument)
      if (!copy) return false
      event.preventDefault()
      const destination = documentKey(current.current.target.workspaceId, current.current.target.path)
      return editor.chain().focus().insertContent({ type: 'noteInclude', attrs: stageNoteShare(destination, copy) }).run()
    }
  }), [scope.target.workspaceId, scope.target.path, scope.target.noteId, scope.occurrence, scope.active, scope.knowledge, scope.onOpen, graph.snapshot, graph.issue, graph.busy, graph.refresh, trail, owner.focusedEditor])
  return <NoteSharedContext.Provider value={value}>{children}</NoteSharedContext.Provider>
}
function PendingSharedFile({ include, scope, remove }: { include: NoteInclude; scope: Scope; remove: () => void }) {
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
    if (!ticket.copy.block.blockId) {
      const promoted: import('@tiptap/core').JSONContent[] = [], visit = (value: import('@tiptap/core').JSONContent) => { if (value.type === 'noteInclude' && value.attrs?.noteId === ticket.include.noteId && !original?.noteEditing?.shares?.[value.attrs?.referenceId]) promoted.push(value); value.content?.forEach(visit) }; visit(read.note.content)
      if (promoted.length === 1) return promoted[0]
      const at = noteNodeAtPath(read.note.content, ticket.copy.block.path); return at && noteBlockFingerprint(at) === ticket.copy.block.fingerprint ? at : undefined
    }
    const found: import('@tiptap/core').JSONContent[] = [], visit = (value: import('@tiptap/core').JSONContent) => { if (value.attrs?.blockId === ticket.copy.block.blockId) found.push(value); value.content?.forEach(visit) }; visit(read.note.content)
    return found.length === 1 ? found[0] : undefined
  }, [read, ticket])
  useEffect(() => {
    // This same clipboard proposal was already promoted in the original source.
    // Keep the PM atom's target unchanged so Undo/Redo remains an ordinary paste.
    if (!unconfirmed && node?.type === 'noteInclude' && node.attrs?.noteId === include.noteId && !original?.noteEditing?.shares?.[node.attrs?.referenceId]) clearPendingNoteShares(documentKey(scope.target.workspaceId, scope.target.path), [include.referenceId])
  }, [unconfirmed, node, include.noteId, include.referenceId, scope.target.workspaceId, scope.target.path, original?.noteEditing?.shares])
  return <><div className="note-shared-block__header"><span>Shared content</span><span>{unconfirmed ? 'Sharing needs confirmation' : 'Pending · save to share'}</span>{!unconfirmed && <button type="button" className="note-text-button" onClick={remove}>Cancel this use</button>}</div>
    {node ? <ReadOnlyBlock content={node} /> : <p className="note-knowledge-notice" role="status">Reading the original source. Save will check its exact identity and content before sharing.</p>}
    {unconfirmed || issue && 'message' in issue ? <p className="note-knowledge-notice" role="status">{issue && 'message' in issue ? issue.message : 'The original sharing operation is retained. Its complete result has not been confirmed.'}{unconfirmed && <><button type="button" className="note-text-button" onClick={() => void useAppStore.getState().inspectNoteShare(scope.target.workspaceId, scope.target.path)}>Check this sharing operation</button><button type="button" className="note-text-button" onClick={() => void useAppStore.getState().continueNoteShare(scope.target.workspaceId, scope.target.path)}>Continue this sharing</button></>}</p> : null}
    <div className="note-shared-block__end">{unconfirmed ? 'Original sharing operation retained · check before continuing' : 'Save to share this original content · undo removes this pending use'}</div></>
}
function SharedFile({ include, scope, graph, trail, owner, remove, readOnly }: { readOnly: boolean; include: NoteInclude; remove: () => void; scope: Scope; graph: Observation; trail: readonly string[]; owner: EditorOwner }) {
  const pending = pendingNoteShares(documentKey(scope.target.workspaceId, scope.target.path)).has(include.referenceId)
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
  useEffect(() => {
    if (!target || trail.includes(include.noteId)) return
    return useAppStore.getState().observeNoteFile(target, occurrence, false)
  }, [target, occurrence, include.noteId, trail])
  useEffect(() => { if (scope.active && target && !trail.includes(include.noteId)) useAppStore.getState().loadNoteFile(target) }, [scope.active, target, include.noteId, trail])
  const composition = useCallback((active: boolean) => setNoteComposition(key, occurrence, active), [key, occurrence])
  useEffect(() => () => setNoteComposition(key, occurrence, false), [key, occurrence])
  const nextTrail = useMemo(() => [...trail, include.noteId], [trail, include.noteId])
  if (pending) return <PendingSharedFile include={include} scope={scope} remove={remove} />
  if (trail.includes(include.noteId)) return <><div className="note-shared-block__header">Shared content</div><p className="note-knowledge-notice" role="status">This include is circular. The original reference is preserved.</p></>
  if (!target || !original || read?.status !== 'valid' || read.note.noteId !== include.noteId || read.note.kind !== 'shared-block') return <><div className="note-shared-block__header">Shared content</div><p className="note-knowledge-notice" role="status">{graph.issue ?? (graph.snapshot?.graph.duplicateNoteIds.includes(include.noteId) ? 'Multiple files have this shared identity. The original reference is kept.' : graph.busy ? 'Reading shared sources…' : fileIssue && 'message' in fileIssue ? fileIssue.message : 'The original shared content is not confirmed. Its reference is kept.')} <button type="button" className="note-text-button" onClick={graph.refresh}>Check shared sources</button></p></>
  return <><div className="note-shared-block__header"><span title={target.path}>Shared content</span><span role="status">{saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Shared across notes'}</span>
    {!readOnly && dirty && <button type="button" className="note-text-button" onClick={() => void useAppStore.getState().saveNoteFile(target)} disabled={saving}>Save</button>}</div>
    {issue || fileIssue ? <p className="note-knowledge-notice" role="status">{issue ?? (fileIssue && 'message' in fileIssue ? fileIssue.message : 'This shared file changed. Your draft is kept; inspect its original source before saving.')}<button type="button" className="note-text-button" onClick={() => void useAppStore.getState().refreshDocument(target.workspaceId, target.path)}>Check original</button></p> : null}
    <SharedScope {...scope} target={target} include={include} read={undefined} occurrence={occurrence} graph={graph} trail={nextTrail} owner={owner}>
      {readOnly ? <ReadOnlyBlock content={read.note.content} /> : <NoteBlockEditor note={read.note} knowledge={scope.knowledge} active={scope.active} showBacklinks={false} sourceIdentity={key}
        onChange={(raw, before) => useAppStore.getState().updateNoteFile(target, raw, before ?? original.content)}
        onSave={() => void useAppStore.getState().saveNoteFile(target)} onIssue={setIssue} onOpen={scope.onOpen} onCompositionChange={composition} />}
    </SharedScope><div className="note-shared-block__end">End of shared content</div></>
}
