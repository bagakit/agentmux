import { AgentMuxError } from './errors.js'
import { parseNoteContentObservation, type NoteContentMetadata } from './notebook-observation.js'
import { notebookFingerprint, type NoteResource } from './notebook-catalog.js'

export type NoteLinkTarget = { noteId: string; blockId?: string }
export type NoteInlineLinkAttributes = { referenceId: string; text: string; target: NoteLinkTarget | null }
export type NoteWikiQuery = { page: string; fragment?: { kind: 'heading-or-block' | 'block'; value: string } }
export type NoteWikiToken = { from: number; to: number; text: string; query: NoteWikiQuery }
export type NotePageCandidate = { noteId: string; notebookId: string; title: string; resource: NoteResource }
export type NoteBlockCandidate = { blockId: string; text: string; type: string }
export type NotebookResolveParams =
  | { mode: 'search'; query: string; limit?: number }
  | { mode: 'resolve'; text: string; select?: NoteLinkTarget; maxBytes?: number }
export type NotebookResolveResult =
  | { mode: 'search'; catalogRevision: number; query: string; candidates: NotePageCandidate[]; total: number; truncated: boolean }
  | { mode: 'resolve'; catalogRevision: number; text: string; query: NoteWikiQuery; candidates: NotePageCandidate[];
      blocks: NoteBlockCandidate[]; observation: NoteContentMetadata | null; result:
      | { status: 'resolved'; target: NoteLinkTarget }
      | { status: 'ambiguous' | 'missing' | 'unknown'; stage: 'page' | 'original' | 'fragment'; message: string } }

export const normalizeNoteLinkName = (name: string): string => name.normalize('NFC').trim()
export function matchingNoteLinkBlocks(blocks: readonly NoteBlockCandidate[], fragment: NonNullable<NoteWikiQuery['fragment']>): readonly NoteBlockCandidate[] {
  return blocks.filter(block => block.blockId === fragment.value || fragment.kind === 'heading-or-block' && block.type === 'heading' && normalizeNoteLinkName(block.text) === fragment.value)
}
const escaped = (text: string, at: number) => { let count = 0; while (at > 0 && text[--at] === '\\') count++; return count % 2 === 1 }
const decode = (text: string) => text.replace(/\\([\\#\[\]^])/gu, '$1')
/** Inner text only. Names are queries here, never identities or file paths. */
function readWikiQuery(text: string, partial: boolean): { status: 'valid'; query: NoteWikiQuery } | { status: 'invalid'; message: string } {
  if (typeof text !== 'string' || /[\0\r\n]/u.test(text)) return { status: 'invalid', message: 'A wiki link must contain one line of page text.' }
  let separator = -1
  for (let i = 0; i < text.length; i++) {
    if ((text[i] === '[' || text[i] === ']') && !escaped(text, i)) return { status: 'invalid', message: 'Escape literal brackets in a page query.' }
    if (text[i] === '#' && !escaped(text, i) && separator < 0) separator = i
  }
  const page = normalizeNoteLinkName(decode(separator < 0 ? text : text.slice(0, separator)))
  if (!page && !partial) return { status: 'invalid', message: 'A wiki link needs an exact page query.' }
  if (separator < 0) return { status: 'valid', query: { page } }
  const raw = text.slice(separator + 1).trim(), exactBlock = raw.startsWith('^')
  const value = normalizeNoteLinkName(decode(exactBlock ? raw.slice(1) : raw))
  if (!value && !partial) return { status: 'invalid', message: 'Choose a heading or exact block after #.' }
  return { status: 'valid', query: { page, fragment: { kind: exactBlock ? 'block' : 'heading-or-block', value } } }
}
export function parseNoteWikiQuery(text: string): { status: 'valid'; query: NoteWikiQuery } | { status: 'invalid'; message: string } { return readWikiQuery(text, false) }
/** An unfinished inner query for completion; it grants no target or persistent identity. */
export function parseNoteWikiPrefix(text: string): NoteWikiQuery | null { const parsed = readWikiQuery(text, true); return parsed.status === 'valid' ? parsed.query : null }
/** Complete non-nested syntax, retaining the author's exact inner text and UTF16 ranges. */
export function scanNoteWikiLinks(text: string): readonly NoteWikiToken[] {
  const tokens: NoteWikiToken[] = []
  for (let start = 0; start < text.length - 1; start++) {
    if (text.slice(start, start + 2) !== '[[' || escaped(text, start)) continue
    let end = start + 2
    while (end < text.length - 1 && !(text.slice(end, end + 2) === ']]' && !escaped(text, end))) end++
    if (end >= text.length - 1) break
    const inner = text.slice(start + 2, end), parsed = parseNoteWikiQuery(inner)
    if (parsed.status === 'valid') tokens.push({ from: start, to: end + 2, text: inner, query: parsed.query })
    start = end + 1
  }
  return tokens
}

function fail(message: string, code = 'INVALID_CONTROL_REQUEST'): never { throw new AgentMuxError(message, code) }
function record(value: unknown, fields: readonly string[], code?: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail('Unexpected Note link fields.', code)
  return value as Record<string, unknown>
}
function text(value: unknown, code?: string): string { return typeof value === 'string' && value.length > 0 && !value.includes('\0') ? value : fail('An exact Note link identity is required.', code) }
export function parseNoteLinkTarget(value: unknown, code = 'INVALID_CONTROL_REQUEST'): NoteLinkTarget {
  const target = record(value, ['noteId', 'blockId'], code)
  text(target.noteId, code); if (target.blockId !== undefined) text(target.blockId, code)
  return target as NoteLinkTarget
}
export function parseNotebookResolveParams(value: unknown): NotebookResolveParams {
  const p = record(value, ['mode', 'query', 'limit', 'text', 'select', 'maxBytes'])
  if (p.mode === 'search') {
    if (typeof p.query !== 'string' || p.query.includes('\0') || p.text !== undefined || p.select !== undefined || p.maxBytes !== undefined) fail('Search requires only its page query and optional limit.')
    if (p.limit !== undefined && (!Number.isSafeInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 100)) fail('The page search limit must be between 1 and 100.')
  } else if (p.mode === 'resolve') {
    if (typeof p.text !== 'string' || parseNoteWikiQuery(p.text).status !== 'valid' || p.query !== undefined || p.limit !== undefined) fail('Resolve requires valid inner wiki text.')
    if (p.select !== undefined) { const selected = parseNoteLinkTarget(p.select); const parsed = parseNoteWikiQuery(p.text as string); if (selected.blockId && parsed.status === 'valid' && !parsed.query.fragment) fail('A block selection requires a fragment query.') }
    if (p.maxBytes !== undefined && (!Number.isSafeInteger(p.maxBytes) || Number(p.maxBytes) < 1)) fail('The original Note byte cap must be positive.')
  } else fail('Choose the Note link search or resolve mode.')
  return p as NotebookResolveParams
}
export function parseNotebookResolveResult(value: unknown, params: NotebookResolveParams): NotebookResolveResult {
  const code = 'CONTROL_PROTOCOL_ERROR', p = record(value, params.mode === 'search' ? ['mode', 'catalogRevision', 'query', 'candidates', 'total', 'truncated'] : ['mode', 'catalogRevision', 'text', 'query', 'candidates', 'blocks', 'observation', 'result'], code)
  if (p.mode !== params.mode || !Number.isSafeInteger(p.catalogRevision) || Number(p.catalogRevision) < 0 || !Array.isArray(p.candidates)) fail('The original Note lookup is invalid.', code)
  const candidates = p.candidates.map(value => {
    const c = record(value, ['noteId', 'notebookId', 'title', 'resource'], code)
    for (const key of ['noteId', 'notebookId', 'title']) text(c[key], code)
    const r = record(c.resource, ['hostId', 'workspaceId', 'workspacePath', 'path'], code)
    for (const key of ['hostId', 'workspaceId', 'workspacePath', 'path']) text(r[key], code)
    if ((r.path as string).startsWith('/') || (r.path as string).split(/[\\/]/).includes('..')) fail('Another original Note resource was returned.', code)
    return c as NotePageCandidate
  })
  if (new Set(candidates.map(c => c.noteId)).size !== candidates.length) fail('The Note candidates contain duplicate identities.', code)
  if (params.mode === 'search') {
    if (p.query !== params.query || !Number.isSafeInteger(p.total) || Number(p.total) < candidates.length || typeof p.truncated !== 'boolean' || p.truncated !== (Number(p.total) > candidates.length) || candidates.length > (params.limit ?? 20)) fail('The Note search belongs to another query or scope.', code)
  } else {
    const query = parseNoteWikiQuery(params.text)
    if (query.status !== 'valid' || p.text !== params.text || notebookFingerprint(p.query) !== notebookFingerprint(query.query) || !Array.isArray(p.blocks)) fail('The Note lookup belongs to another query.', code)
    if (candidates.some(c => normalizeNoteLinkName(c.title) !== query.query.page)) fail('Another page query was returned.', code)
    const observation = p.observation === null ? null : parseNoteContentObservation(p.observation, false)
    if (observation && !candidates.some(c => c.noteId === observation.noteId && notebookFingerprint(c.resource) === notebookFingerprint(observation.resource))) fail('The lookup read another original Note.', code)
    if (observation && params.select && observation.noteId !== params.select.noteId) fail('The lookup read another selected Note.', code)
    const ids = new Set<string>()
    for (const value of p.blocks) { const b = record(value, ['blockId', 'text', 'type'], code); text(b.blockId, code); text(b.type, code); if (typeof b.text !== 'string' || ids.has(b.blockId as string) || observation?.status !== 'read' || !observation.blockIds.includes(b.blockId as string)) fail('The lookup contains an unconfirmed original block.', code); ids.add(b.blockId as string) }
    if (observation?.status === 'read' && (ids.size !== observation.blockIds.length || observation.blockIds.some(id => !ids.has(id)))) fail('The original block descriptor set is incomplete; uniqueness cannot be confirmed.', code)
    const result = record(p.result, ['status', 'target', 'stage', 'message'], code)
    if (result.status === 'resolved') {
      const target = parseNoteLinkTarget(result.target, code)
      if (!params.select && candidates.length !== 1) fail('An ambiguous page query cannot grant a selected target.', code)
      if (result.stage !== undefined || result.message !== undefined || observation?.status !== 'read' || target.noteId !== observation.noteId || target.blockId && !ids.has(target.blockId) || Boolean(query.query.fragment) !== Boolean(target.blockId)) fail('The lookup target is not confirmed in its original.', code)
      if (params.select?.blockId && params.select.blockId !== target.blockId) fail('The lookup returned another selected block.', code)
      if (query.query.fragment && !params.select?.blockId) {
        if (query.query.fragment.kind !== 'block' && (observation.unanchoredBlockCount ?? 0) > 0) fail('Unanchored original headings cannot grant a unique target.', code)
        const matches = matchingNoteLinkBlocks(p.blocks as NoteBlockCandidate[], query.query.fragment)
        if (matches.length !== 1 || matches[0]!.blockId !== target.blockId) fail('The returned block does not uniquely match the original fragment query.', code)
      }
    } else if (!['ambiguous', 'missing', 'unknown'].includes(String(result.status)) || !['page', 'original', 'fragment'].includes(String(result.stage)) || result.target !== undefined || typeof result.message !== 'string' || !result.message) fail('The Note lookup state is invalid.', code)
  }
  return value as NotebookResolveResult
}
