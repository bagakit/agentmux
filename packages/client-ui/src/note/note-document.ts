import type { JSONContent } from '@tiptap/core'
import { NOTE_SCHEMA } from './note-format.js'
export type { NoteLinkTarget, NoteInlineLinkAttributes } from '@agentmux/core/note-links'
export type { NoteBlockAuthorship, NoteBlockProvenance } from './note-provenance.js'
export { NOTE_BLOCK_TYPES } from './note-content-schema.js'
export { NOTE_SCHEMA, NOTE_FILE_EXTENSION } from './note-format.js'

export type NoteBlockTarget = { noteId: string; blockId: string }
export type NoteBlockReference = { referenceId: string; target: NoteBlockTarget; mode: 'reference' | 'embed' }
export type NoteDocument = { schema: typeof NOTE_SCHEMA; noteId: string; content: JSONContent }
export type NoteDocumentRead = { status: 'valid'; note: NoteDocument; unanchoredBlockCount: number } | { status: 'invalid'; raw: string; message: string }
export { serializeNoteDocument } from './note-markdown.js'
import { parseNoteMarkdown } from './note-markdown.js'
import { validateNoteDocument } from './note-document-validation.js'

/** Read original Markdown without repairing IDs or resolving a name to a target. */
export function readNoteDocument(raw: string): NoteDocumentRead {
  try { const note = parseNoteMarkdown(raw); const unanchoredBlockCount = validateNoteDocument(note, true); return { status: 'valid', note, unanchoredBlockCount } }
  catch (error) { return { status: 'invalid', raw, message: error instanceof Error ? error.message : String(error) } }
}

/** IDs are supplied once by the creating owner; candidate names never determine content identity. */
export function newNoteDocument(draft: string, noteId: string, blockId: string): NoteDocument {
  const content: JSONContent[] = []
  for (const [index, text] of draft.split(/\r?\n/).entries()) {
    if (index) content.push({ type: 'hardBreak' })
    if (text) content.push({ type: 'text', text })
  }
  return { schema: NOTE_SCHEMA, noteId, content: { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId }, ...(content.length ? { content } : {}) }] } }
}
