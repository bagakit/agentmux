import type { FileWriteContext } from '@agentmux/core'
import { NOTE_FILE_EXTENSION, readNoteDocument } from '../shared/note-document.js'
import { attributeNoteBlocks } from '@agentmux/client-ui/note/note-provenance'
import { noteContentSchema } from '../shared/note-content-schema.js'
import type { WorkspaceFileWriteInput, WorkspaceFileWriteResult, WorkspaceRecord } from '../shared/contracts.js'
import type { WorkspaceFiles } from './workspace-files.js'

/** The original Files writer, enriched with Note metadata; neither a content store nor a new save lane. */
export class NoteFileWriter {
  constructor(private readonly files: Pick<WorkspaceFiles, 'read' | 'write'>) {}
  async write(workspace: WorkspaceRecord, input: WorkspaceFileWriteInput, context?: FileWriteContext): Promise<WorkspaceFileWriteResult> {
    if (!input.path.endsWith(NOTE_FILE_EXTENSION)) return this.files.write(workspace, input)
    const candidate = readNoteDocument(input.content)
    let content = input.content, reason: string | undefined
    if (candidate.status !== 'valid') reason = 'This source is not a valid Note. Its file bytes were saved without confirmed block attribution.'
    else {
      let before = null
      if (input.expectedRevision !== null) {
        try {
          const observed = await this.files.read(workspace, input.path)
          if (observed.status === 'read' && observed.document.revision === input.expectedRevision) {
            const parsed = readNoteDocument(observed.document.content)
            if (parsed.status === 'valid') before = parsed.note
            else reason = 'The original block authorship baseline is unconfirmed.'
          } else reason = 'The original file revision could not be observed for block attribution.'
        } catch { reason = 'The original file could not be read for block attribution.' }
      }
      const confirmedBaseline = input.expectedRevision === null || before?.noteId === candidate.note.noteId
      if (before && before.noteId !== candidate.note.noteId) reason = 'The original Note identity changed; block attribution is unconfirmed.'
      // Compare the original schema's canonical nodes so editor-added default attributes are not edits.
      const normalized = (note: typeof candidate.note) => ({ ...note, content: noteContentSchema.nodeFromJSON(note.content).toJSON() })
      const next = attributeNoteBlocks(before ? normalized(before) : null, normalized(candidate.note), confirmedBaseline ? context?.actor : undefined, Date.now())
      if (JSON.stringify(next) !== JSON.stringify(candidate.note)) content = JSON.stringify(next, null, 2) + '\n'
      if (!context?.actor) reason = 'The original write actor is unknown; changed block attribution is unconfirmed.'
    }
    const result = await this.files.write(workspace, { ...input, content })
    return result.status === 'written' ? { ...result, ...(content !== input.content ? { content } : {}),
      noteAttribution: reason ? { status: 'unconfirmed', reason } : { status: 'recorded' } } : result
  }
}
