import type { JSONContent } from '@tiptap/core'
import { NOTE_BLOCK_TYPES, noteContentSchema } from './note-content-schema'
export { NOTE_BLOCK_TYPES } from './note-content-schema'

export const NOTE_SCHEMA = 'agentmux.note.v1'
export const NOTE_FILE_EXTENSION = '.note.json'
export type NoteBlockTarget = { noteId: string; blockId: string }
export type NoteBlockReference = { referenceId: string; target: NoteBlockTarget; mode: 'reference' | 'embed' }
export type NoteDocument = { schema: typeof NOTE_SCHEMA; noteId: string; content: JSONContent }
export type NoteDocumentRead = { status: 'valid'; note: NoteDocument } | { status: 'invalid'; raw: string; message: string }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** Validate without repairing IDs, rewriting raw content or resolving a name to a target. */
export function readNoteDocument(raw: string): NoteDocumentRead {
  try {
    const value: unknown = JSON.parse(raw)
    if (!record(value) || value.schema !== NOTE_SCHEMA || !identity(value.noteId) || !record(value.content) || value.content.type !== 'doc') throw new Error('The Note schema or identity is missing or unsupported.')
    const blocks = new Set<string>(), references = new Set<string>()
    const visit = (node: unknown): void => {
      if (!record(node) || !identity(node.type)) throw new Error('The Note contains an invalid content node.')
      const type = noteContentSchema.nodes[node.type]
      if (!type) throw new Error(`The Note contains an unsupported node: ${node.type}.`)
      if (Object.keys(node).some(key => !['type', 'attrs', 'content', 'marks', 'text'].includes(key))) throw new Error('The Note contains unsupported node data.')
      if (node.type === 'text' && typeof node.text !== 'string') throw new Error('The Note text is invalid.')
      if (node.type !== 'text' && node.text !== undefined) throw new Error('The Note contains text on a non-text node.')
      if (node.attrs !== undefined && (!record(node.attrs) || Object.keys(node.attrs).some(key => !(key in (type.spec.attrs ?? {}))))) throw new Error('The Note contains unsupported node attributes.')
      if (node.marks !== undefined) {
        if (!Array.isArray(node.marks)) throw new Error('The Note marks are invalid.')
        for (const mark of node.marks) {
          if (!record(mark) || !identity(mark.type) || !noteContentSchema.marks[mark.type]) throw new Error('The Note contains an unsupported mark.')
          if (Object.keys(mark).some(key => !['type', 'attrs'].includes(key))) throw new Error('The Note contains unsupported mark data.')
          const markType = noteContentSchema.marks[mark.type]!
          if (mark.attrs !== undefined && (!record(mark.attrs) || Object.keys(mark.attrs).some(key => !(key in (markType.spec.attrs ?? {}))))) throw new Error('The Note contains unsupported mark attributes.')
        }
      }
      if (NOTE_BLOCK_TYPES.some(type => type === node.type)) {
        if (!record(node.attrs) || !identity(node.attrs.blockId) || blocks.has(node.attrs.blockId)) throw new Error('A semantic block identity is missing or duplicated.')
        blocks.add(node.attrs.blockId)
      }
      if (node.type === 'blockReference') {
        const attrs = node.attrs
        if (!record(attrs) || !identity(attrs.referenceId) || references.has(attrs.referenceId) || !record(attrs.target) || !identity(attrs.target.noteId) || !identity(attrs.target.blockId) || (attrs.mode !== 'reference' && attrs.mode !== 'embed')) throw new Error('A block reference identity or exact target is invalid.')
        references.add(attrs.referenceId)
      }
      if (node.content !== undefined) {
        if (!Array.isArray(node.content)) throw new Error('The Note block tree is invalid.')
        node.content.forEach(visit)
      }
    }
    visit(value.content)
    noteContentSchema.nodeFromJSON(value.content).check()
    if (blocks.size === 0) throw new Error('The Note has no semantic block.')
    return { status: 'valid', note: value as NoteDocument }
  } catch (error) { return { status: 'invalid', raw, message: error instanceof Error ? error.message : String(error) } }
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
