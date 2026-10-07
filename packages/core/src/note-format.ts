import { parseDocument } from 'yaml'
export const NOTE_MARKDOWN_SCHEMA = 'agentmux.note.md.v1'
export const NOTE_FILE_EXTENSION = '.note.md'
export type NoteMarkdownHeaderRead = { status: 'valid'; noteId: string; title?: string; schema: typeof NOTE_MARKDOWN_SCHEMA; body: string; bodyOffset: number } | { status: 'invalid'; raw: string; message: string }
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
    if (Object.keys(fields).some(key => !['schema', 'note-id', 'title'].includes(key))) throw new Error('The Note header contains unsupported fields; its original source is preserved.')
    if (fields.title !== undefined && (typeof fields.title !== 'string' || !fields.title.trim() || /[\0\r\n]/u.test(fields.title))) throw new Error('The original Note title must be nonempty single-line text.')
    return { status: 'valid', ...(fields.title === undefined ? {} : { title: fields.title as string }), noteId: fields['note-id'], schema: NOTE_MARKDOWN_SCHEMA, body: raw.slice(header[0].length), bodyOffset: header[0].length }
  } catch (error) { return { status: 'invalid', raw, message: error instanceof Error ? error.message : String(error) } }
}

/** Change only original YAML metadata. Body bytes/anchors/links are never parsed or rewritten. */
export function rewriteNoteMarkdownTitle(raw: string, title: string): string {
  const original = readNoteMarkdownHeader(raw)
  if (original.status !== 'valid') throw new Error(original.message)
  if (typeof title !== 'string' || !title.trim() || /[\0\r\n]/u.test(title)) throw new Error('The original Note title must be nonempty single-line text.')
  const header = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/u.exec(raw)!
  const document = parseDocument(header[1]!)
  document.set('title', title)
  const newline = raw.includes('\r\n') && raw.indexOf('\r\n') === raw.indexOf('\n') - 1 ? '\r\n' : '\n'
  const yaml = document.toString().replace(/\r?\n$/u, '').replace(/\r?\n/gu, newline)
  return (raw.startsWith('\uFEFF') ? '\uFEFF' : '') + '---' + newline + yaml + newline + '---' + (header[2] ? newline : '') + original.body
}
