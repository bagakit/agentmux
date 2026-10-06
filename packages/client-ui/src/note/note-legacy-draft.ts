import { readLegacyNoteDocument } from './note-legacy-document.js'
import { readNoteDocument, serializeNoteDocument } from './note-document.js'
import { noteContentSchema } from './note-content-schema.js'
import type { JSONContent } from '@tiptap/core'

/** Explicit storage-conversion boundary only; ordinary Note readers never fall back to JSON. */
export function convertLegacyNoteDraft(content: string, noteId: string): { status: 'converted'; content: string } | { status: 'unchanged'; content: string } | { status: 'unconfirmed'; message: string } {
  const markdown = readNoteDocument(content)
  if (markdown.status === 'valid') return markdown.note.noteId === noteId ? { status: 'unchanged', content } : { status: 'unconfirmed', message: 'The retained draft belongs to another Note.' }
  const legacy = readLegacyNoteDocument(content)
  if (legacy.status !== 'valid' || legacy.note.noteId !== noteId) return { status: 'unconfirmed', message: legacy.status === 'invalid' ? legacy.message : 'The retained draft belongs to another Note.' }
  try {
    const content = serializeNoteDocument(legacy.note), read = readNoteDocument(content)
    const normalized = (value: JSONContent) => {
      const node = noteContentSchema.nodeFromJSON(value).toJSON()
      const strip = (node: JSONContent) => { if (node.attrs) delete node.attrs.provenance; node.content?.forEach(strip) }
      strip(node); return JSON.stringify(node)
    }
    if (read.status !== 'valid' || read.unanchoredBlockCount || normalized(read.note.content) !== normalized(legacy.note.content)) return { status: 'unconfirmed', message: 'The retained draft cannot be converted without losing original content or identities.' }
    return { status: 'converted', content }
  }
  catch (error) { return { status: 'unconfirmed', message: error instanceof Error ? error.message : String(error) } }
}
