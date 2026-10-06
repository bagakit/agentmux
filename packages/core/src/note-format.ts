import { parseDocument } from 'yaml'
export const NOTE_MARKDOWN_SCHEMA = 'agentmux.note.md.v1'
export const NOTE_FILE_EXTENSION = '.note.md'
export type NoteMarkdownHeaderRead = { status: 'valid'; noteId: string; schema: typeof NOTE_MARKDOWN_SCHEMA; body: string; bodyOffset: number } | { status: 'invalid'; raw: string; message: string }
/** A pure format header, shared by Core resource owners and the rich Markdown codec. */
export function readNoteMarkdownHeader(raw: string): NoteMarkdownHeaderRead {
  try {
    const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
    if (!header) throw new Error('The original Note Markdown identity header is missing.')
    const parsed = parseDocument(header[1]!)
    if (parsed.errors.length) throw new Error('The original Note Markdown header is invalid: ' + parsed.errors[0]!.message)
    const value: unknown = parsed.toJS({ maxAliasCount: 0 })
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The Note Markdown header must be a mapping.')
    const fields = value as Record<string, unknown>
    if (fields.schema !== NOTE_MARKDOWN_SCHEMA || typeof fields['note-id'] !== 'string' || !fields['note-id']) throw new Error('The original Note Markdown schema or identity is missing or unsupported.')
    if (Object.keys(fields).some(key => !['schema', 'note-id'].includes(key))) throw new Error('The Note header contains unsupported fields; its original source is preserved.')
    return { status: 'valid', noteId: fields['note-id'], schema: NOTE_MARKDOWN_SCHEMA, body: raw.slice(header[0].length), bodyOffset: header[0].length }
  } catch (error) { return { status: 'invalid', raw, message: error instanceof Error ? error.message : String(error) } }
}
