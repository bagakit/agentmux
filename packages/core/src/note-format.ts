import { parseDocument } from 'yaml'
export const NOTE_MARKDOWN_SCHEMA = 'agentmux.note.md.v1'
export const NOTE_FILE_EXTENSION = '.note.md'
export type NoteSharedOrigin = { operationId: string; sourceNoteId: string; sourcePath: string; sourceRevision: string; sourceBlockId: string;
  requestFingerprint?: string; sourceOperationId?: string; destination?: { noteId: string; path: string; operationId: string; expectedRevision: string } }
export type NoteSharedMetadata = { kind?: 'shared-block'; origin?: NoteSharedOrigin }
export type NoteMarkdownHeaderRead = ({ status: 'valid'; noteId: string; title?: string; schema: typeof NOTE_MARKDOWN_SCHEMA; body: string; bodyOffset: number } & NoteSharedMetadata) | { status: 'invalid'; raw: string; message: string }
/** A hint remains within the original Workspace; it never grants a content identity. */
export const isNoteWorkspaceRelativePath = (value: unknown): value is string => typeof value === 'string' && !!value && !/[\\\0\r\n]/u.test(value) && !value.startsWith('/') && value.split('/').every(part => !!part && part !== '.' && part !== '..')
/** Recovery declarations travel with Markdown. They are not trusted author or commit receipts. */
export function parseNoteSharedMetadata(value: { kind?: unknown; origin?: unknown }): NoteSharedMetadata {
  if (value.kind !== undefined && value.kind !== 'shared-block') throw new Error('The Note content kind is unsupported.')
  if (value.origin === undefined) return value.kind === undefined ? {} : { kind: value.kind }
  const origin = value.origin
  if (value.kind !== 'shared-block' || !origin || typeof origin !== 'object' || Array.isArray(origin)) throw new Error('A shared origin requires its original shared Markdown file.')
  const fields = origin as Record<string, unknown>, names = ['operationId', 'sourceNoteId', 'sourcePath', 'sourceRevision', 'sourceBlockId']
  if (Object.keys(fields).some(key => ![...names, 'requestFingerprint', 'sourceOperationId', 'destination'].includes(key)) || names.some(key => typeof fields[key] !== 'string' || !fields[key] || /[\0\r\n]/u.test(String(fields[key]))) ||
      !isNoteWorkspaceRelativePath(fields.sourcePath) || !/^sha256:[a-f0-9]{64}$/u.test(String(fields.sourceRevision))) throw new Error('The shared Markdown origin is invalid; preserve the original file before repair.')
  if (fields.sourceOperationId !== undefined && (typeof fields.sourceOperationId !== 'string' || !fields.sourceOperationId || /[\0\r\n]/u.test(fields.sourceOperationId))) throw new Error('The original source operation identity is invalid.')
  if (fields.requestFingerprint !== undefined && (typeof fields.requestFingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(fields.requestFingerprint))) throw new Error('The original shared operation fingerprint is invalid.')
  if (fields.destination !== undefined) {
    const destination = fields.destination as Record<string, unknown>
    if (!destination || typeof destination !== 'object' || Array.isArray(destination) || Object.keys(destination).length !== 4 || Object.keys(destination).some(key => !['noteId','path','operationId','expectedRevision'].includes(key)) ||
        ['noteId','operationId'].some(key => typeof destination[key] !== 'string' || !destination[key] || /[\0\r\n]/u.test(String(destination[key]))) || !isNoteWorkspaceRelativePath(destination.path) ||
        (typeof destination.expectedRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(destination.expectedRevision))) throw new Error('The original shared destination is invalid.')
  }
  return { kind: 'shared-block', origin: structuredClone(fields) as NoteSharedOrigin }
}
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
    if (Object.keys(fields).some(key => !['schema', 'note-id', 'title', 'kind', 'origin'].includes(key))) throw new Error('The Note header contains unsupported fields; its original source is preserved.')
    if (fields.title !== undefined && (typeof fields.title !== 'string' || !fields.title.trim() || /[\0\r\n]/u.test(fields.title))) throw new Error('The original Note title must be nonempty single-line text.')
    return { status: 'valid', ...parseNoteSharedMetadata(fields), ...(fields.title === undefined ? {} : { title: fields.title as string }), noteId: fields['note-id'], schema: NOTE_MARKDOWN_SCHEMA, body: raw.slice(header[0].length), bodyOffset: header[0].length }
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
