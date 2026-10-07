import type { NoteDocument, NoteDocumentRead } from './note-document.js'
import { validateNoteDocument } from './note-document-validation.js'
import { noteWikiQueryForLabel } from './note-wikilinks.js'
/** Explicit conversion input only. Production Note readers accept Markdown exclusively. */
export function readLegacyNoteDocument(raw: string): NoteDocumentRead {
 try {
   const value: unknown = JSON.parse(raw)
   // This remains an explicit conversion input, never a second writable format.
   // Its former inline atom stored its visible text only in attributes.
   const restoreText = (node: unknown) => {
     if (!node || typeof node !== 'object' || Array.isArray(node)) return
     const content = node as Record<string, unknown>, attrs = content.attrs
     if (content.type === 'noteLink' && content.content === undefined && attrs && typeof attrs === 'object' && !Array.isArray(attrs) && typeof (attrs as Record<string, unknown>).text === 'string') {
       const fields = attrs as Record<string, unknown>
       fields.text = noteWikiQueryForLabel(fields.text as string)
       content.content = [{ type: 'text', text: `[[${fields.text}]]` }]
     }
     if (Array.isArray(content.content)) content.content.forEach(restoreText)
   }
   if (value && typeof value === 'object' && !Array.isArray(value)) restoreText((value as Record<string, unknown>).content)
   validateNoteDocument(value); return { status: 'valid', note: value as NoteDocument, unanchoredBlockCount: 0 }
 }
 catch (error) { return { status: 'invalid', raw, message: error instanceof Error ? error.message : String(error) } }
}
