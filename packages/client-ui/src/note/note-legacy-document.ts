import type { NoteDocument, NoteDocumentRead } from './note-document.js'
import { validateNoteDocument } from './note-document-validation.js'
/** Explicit conversion input only. Production Note readers accept Markdown exclusively. */
export function readLegacyNoteDocument(raw: string): NoteDocumentRead {
 try { const value: unknown = JSON.parse(raw); validateNoteDocument(value); return { status: 'valid', note: value as NoteDocument, unanchoredBlockCount: 0 } }
 catch (error) { return { status: 'invalid', raw, message: error instanceof Error ? error.message : String(error) } }
}
