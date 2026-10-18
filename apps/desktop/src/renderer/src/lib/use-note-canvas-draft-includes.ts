import { useEffect, useMemo } from 'react'
import type { JSONContent } from '@tiptap/core'
import type { NoteReaderDraftInclude } from '@agentmux/client-ui/components/NoteReader'
import { sameNoteDraftResource } from '@agentmux/client-ui/note/note-draft-includes'
import { parseNoteFile } from '@agentmux/client-ui/note/note-knowledge'
import { isNoteWorkspaceRelativePath } from '@agentmux/core/note-format'
import type { NoteDocument, NoteInclude } from '../../../shared/note-document'
import type { FileDocument } from '../../../shared/contracts'
import type { NoteFileTarget } from './file-document-consumers'
import { notePendingSharePreview } from './note-pending-share-preview'
import { documentKey } from './workbench-tabs'
import { useAppStore } from '../store'

type DraftState = Pick<ReturnType<typeof useAppStore.getState>, 'config' | 'documents'>
type Projection = { includes: readonly NoteReaderDraftInclude[]; sources: readonly NoteFileTarget[] }
const EMPTY: Projection = { includes: [], sources: [] }

function mapped(state: DraftState, target: NoteFileTarget): boolean {
  const matches = state.config?.workspaces.filter(workspace => workspace.id === target.workspaceId) ?? []
  return matches.length === 1 && matches[0]!.hostId === target.hostId && matches[0]!.path === target.workspacePath && isNoteWorkspaceRelativePath(target.path)
}
function parsedOriginal(document: FileDocument | undefined, target: NoteFileTarget) {
  if (!document || document.path !== target.path) return null
  // Byte/hash hydration is still parseNoteFile's job; metadata from another
  // original resource cannot lend authorship to this exact source draft.
  const { noteProvenance, ...body } = document
  return parseNoteFile(noteProvenance && !sameNoteDraftResource(noteProvenance.resource, target) ? body : document)
}
const includesIn = (content: JSONContent) => {
  const includes: NoteInclude[] = []
  const visit = (node: JSONContent) => { if (node.type === 'noteInclude') includes.push(node.attrs as NoteInclude); node.content?.forEach(visit) }
  visit(content)
  return includes
}

/** A selector-local memo over only its actual original documents, never another draft or relationship store. */
export function noteCanvasDraftIncludeSelector(host: NoteFileTarget | null, hostContent: string | undefined): (state: DraftState) => Projection {
  let previous: { workspaces: NonNullable<DraftState['config']>['workspaces'] | undefined; dependencies: Map<string, FileDocument | undefined>; value: Projection } | undefined
  return state => {
    if (!host || hostContent === undefined) return EMPTY
    if (previous && previous.workspaces === state.config?.workspaces && [...previous.dependencies].every(([key, document]) => state.documents[key] === document)) return previous.value
    const dependencies = new Map<string, FileDocument | undefined>()
    const documentFor = (target: NoteFileTarget) => { const key = documentKey(target.workspaceId, target.path), document = state.documents[key]; dependencies.set(key, document); return document }
    const document = documentFor(host), parsed = mapped(state, host) ? parsedOriginal(document, host) : null
    const includes: NoteReaderDraftInclude[] = [], sources = new Map<string, NoteFileTarget>(), visited = new Set<string>()
    type Frame = { target: NoteFileTarget; document: FileDocument; note: NoteDocument; content: JSONContent }
    const frames: Frame[] = document?.content === hostContent && parsed?.status === 'valid' && parsed.note.noteId === host.noteId ? [{ target: host, document, note: parsed.note, content: parsed.note.content }] : []
    for (const frame of frames) {
      const declarations = includesIn(frame.note.content)
      for (const include of includesIn(frame.content)) {
        const key = JSON.stringify([frame.target, include.referenceId])
        if (visited.has(key)) continue
        visited.add(key)
        const ticket = frame.document.noteEditing?.shares?.[include.referenceId]
        if (!ticket || ticket.include.referenceId !== include.referenceId || ticket.include.noteId !== include.noteId || ticket.include.path !== include.path ||
          (ticket.include.workspaceId ?? frame.target.workspaceId) !== (include.workspaceId ?? frame.target.workspaceId) || declarations.filter(value => value.referenceId === include.referenceId).length !== 1) continue
        const target = ticket.copy.source, original = documentFor(target), read = mapped(state, target) ? parsedOriginal(original, target) : null
        const base = { hostResource: frame.target, hostNoteId: frame.note.noteId, include, source: { resource: target, noteId: target.noteId, ...(ticket.copy.block.blockId ? { blockId: ticket.copy.block.blockId } : {}) } }
        if (!mapped(state, target)) { includes.push({ ...base, status: 'unknown', message: 'The exact original source Host or Workspace is unconfirmed. Its draft and reference are kept.' }); continue }
        sources.set(JSON.stringify(target), target)
        const preview = read?.status === 'valid' && read.note.noteId === target.noteId ? notePendingSharePreview(read.note, ticket, new Set(Object.keys(original?.noteEditing?.shares ?? {}))) : undefined
        if (!preview || !original || read?.status !== 'valid') { includes.push({ ...base, status: 'unknown', message: 'The original source range has not been confirmed. Open that exact original to inspect its retained content.' }); continue }
        const content = preview.type === 'doc' ? preview : { type: 'doc', content: [preview] }
        includes.push({ ...base, status: 'read', content })
        frames.push({ target, document: original, note: read.note, content })
      }
    }
    const value = { includes, sources: [...sources.values()] }
    previous = { workspaces: state.config?.workspaces, dependencies, value }
    return value
  }
}

/** Source reads use the existing original File owner. Hidden or removed occurrences retain no reader. */
export function useNoteCanvasDraftIncludes(active: boolean, host: NoteFileTarget | null, hostContent: string | undefined): readonly NoteReaderDraftInclude[] {
  const identity = JSON.stringify(host)
  const selector = useMemo(() => noteCanvasDraftIncludeSelector(active ? host : null, active ? hostContent : undefined), [active, identity, hostContent])
  const projection = useAppStore(selector)
  const sources = JSON.stringify(projection.sources)
  useEffect(() => {
    if (!active) return
    const releases = projection.sources.map(target => useAppStore.getState().observeNoteFile(target, `canvas-pending:${identity}:${JSON.stringify(target)}`, false))
    for (const target of projection.sources) void useAppStore.getState().loadNoteFile(target)
    return () => { for (const release of releases) release() }
  }, [active, identity, sources])
  return projection.includes
}
