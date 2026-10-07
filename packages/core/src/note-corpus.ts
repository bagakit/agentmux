import { AgentMuxError } from './errors.js'
import type { NoteResource } from './notebook-catalog.js'
import type { NoteGraphOccurrence, NoteGraphTarget } from './notebook-observation.js'

/** A bounded, read-only projection of original files, independent of the durable App catalog. */
export type NoteCorpusParams = { workspaceId: string; path: string; maxFiles?: number; maxDirectories?: number; maxBytes?: number; query?: string; limit?: number }
export type NoteCorpusBlock = { blockId: string; type: string; text: string; headingLevel?: number }
export type NoteCorpusPage = { resource: NoteResource; noteId: string; title: string | null; revision: string; blocks: NoteCorpusBlock[]; unanchoredBlockCount: number }
export type NoteCorpusReference = { source: { noteId: string; blockId: string }; sourceResource: NoteResource; revision: string; target: NoteGraphTarget; occurrence: NoteGraphOccurrence; mode: 'reference' | 'embed' | 'link'; resolution: 'resolved' | 'ambiguous' | 'missing' | 'unknown'; query?: string }
export type NoteCorpusHit = { resource: NoteResource; noteId: string; title: string | null; blockId: string | null; revision: string; excerpt: string; match: { from: number; to: number } }
export type NoteCorpusResult = {
  scope: { workspaceId: string; path: string; resource: NoteResource | null; completeness: 'complete' | 'partial' | 'unknown'; snapshot: 'per-file' }
  coverage: { directories: number; files: number; bytes: number; limited: boolean; issues: { path: string; kind: 'unreadable' | 'invalid' | 'symlink' | 'budget' | 'mapping'; message: string }[] }
  pages: NoteCorpusPage[]; duplicateNoteIds: string[]; references: NoteCorpusReference[]
  search: { query: string | null; hits: NoteCorpusHit[]; total: number; truncated: boolean }
}
const bad = (message: string): never => { throw new AgentMuxError(message, 'INVALID_CONTROL_REQUEST') }
const object = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) bad('Unexpected Note corpus fields.')
  return value as Record<string, unknown>
}
const text = (value: unknown): string => typeof value === 'string' && !!value && !value.includes('\0') ? value : bad('An exact Note corpus identity is required.')
const member = (value: unknown, values: readonly string[]): boolean => typeof value === 'string' && values.includes(value)
const revision = (value: unknown): void => { if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) bad('The exact original Note source revision is required.') }
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) bad('Invalid Note corpus count.'); return value as number }
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : bad('A Note corpus list is required.')
const relative = (value: unknown) => { const path = text(value); if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') || path !== '.' && path.split('/').some(p => !p || p === '.')) bad('Choose the exact Workspace-relative Note directory.'); return path }
export function parseNoteCorpusParams(value: unknown): NoteCorpusParams {
  const p = object(value, ['workspaceId', 'path', 'maxFiles', 'maxDirectories', 'maxBytes', 'query', 'limit'])
  text(p.workspaceId); relative(p.path)
  for (const [field, max] of [['maxFiles',20000], ['maxDirectories',20000], ['maxBytes',64*1024*1024], ['limit',1000]] as const) if (p[field] !== undefined && count(p[field],max) < 1) bad('Note corpus budgets must be positive.')
  if (p.query !== undefined && (typeof p.query !== 'string' || !p.query.trim() || p.query.includes('\0'))) bad('Fulltext search requires nonempty literal text.')
  if (p.limit !== undefined && p.query === undefined) bad('A search result limit requires a query.')
  return structuredClone(p) as NoteCorpusParams
}
const resource = (value: unknown): NoteResource => { const r = object(value, ['hostId','workspaceId','workspacePath','path']); text(r.hostId); text(r.workspaceId); text(r.workspacePath); relative(r.path); return r as NoteResource }
const key = (r: NoteResource) => JSON.stringify([r.hostId,r.workspaceId,r.workspacePath,r.path])
export function parseNoteCorpusResult(value: unknown, input: NoteCorpusParams): NoteCorpusResult {
  try {
    const p = object(value, ['scope','coverage','pages','duplicateNoteIds','references','search']), s = object(p.scope, ['workspaceId','path','resource','completeness','snapshot'])
    if (s.workspaceId !== input.workspaceId || s.path !== input.path || s.snapshot !== 'per-file' || !member(s.completeness, ['complete','partial','unknown'])) bad('This corpus belongs to another requested source.')
    const root = s.resource === null ? null : resource(s.resource)
    if (root && (root.workspaceId !== input.workspaceId || root.path !== input.path)) bad('This corpus returned another Workspace directory.')
    const within = (r: NoteResource) => { if (!root || r.hostId !== root.hostId || r.workspaceId !== root.workspaceId || r.workspacePath !== root.workspacePath || input.path !== '.' && !r.path.startsWith(input.path + '/')) bad('A corpus source lies outside its exact directory.'); return r }
    const c = object(p.coverage, ['directories','files','bytes','limited','issues']); count(c.directories,input.maxDirectories ?? 200); count(c.files,input.maxFiles ?? 200); count(c.bytes,input.maxBytes ?? 4*1024*1024)
    if (typeof c.limited !== 'boolean') bad('Corpus coverage is unconfirmed.')
    for (const issue of array(c.issues)) { const i = object(issue,['path','kind','message']); relative(i.path); text(i.message); if (!member(i.kind, ['unreadable','invalid','symlink','budget','mapping'])) bad('Unknown corpus issue.') }
    const pages = array(p.pages).map(v => {
      const page = object(v,['resource','noteId','title','revision','blocks','unanchoredBlockCount']); within(resource(page.resource)); text(page.noteId); revision(page.revision); if (page.title !== null) text(page.title); count(page.unanchoredBlockCount)
      const ids = new Set<string>()
      for (const v of array(page.blocks)) { const b = object(v,['blockId','type','text','headingLevel']); text(b.blockId); text(b.type); if (typeof b.text !== 'string' || ids.has(String(b.blockId))) bad('Invalid corpus block.'); ids.add(String(b.blockId)); if (b.headingLevel !== undefined && (b.type !== 'heading' || count(b.headingLevel,6) < 1)) bad('Invalid corpus heading.') }
      return page as NoteCorpusPage
    })
    if (new Set(pages.map(page => key(page.resource))).size !== pages.length || pages.length > Number(c.files)) bad('Duplicated or unobserved corpus resources.')
    const groups = new Map<string,NoteCorpusPage[]>()
    for (const page of pages) { const list = groups.get(page.noteId) ?? []; list.push(page); groups.set(page.noteId,list) }
    const duplicates = [...groups].filter(([,pages])=>pages.length>1).map(([id])=>id)
    if (array(p.duplicateNoteIds).length !== duplicates.length || new Set(p.duplicateNoteIds as string[]).size !== duplicates.length || duplicates.some(id=>!(p.duplicateNoteIds as string[]).includes(id))) bad('Corpus duplicate identities are unconfirmed.')
    const byResource = new Map(pages.map(page => [key(page.resource), page]))
    const blockIds = new Map(pages.map(page => [key(page.resource), new Set(page.blocks.map(block => block.blockId))]))
    const sourceComplete = !c.limited && array(c.issues).length === 0 && pages.length === c.files
    const titlesKnown = pages.every(page => page.title !== null)
    const source = (r: NoteResource, id: unknown, revision: unknown, block: unknown, allowUnanchored = false): NoteCorpusPage => { const page = byResource.get(key(r)); if (!page) return bad('A corpus result does not name an observed exact source.'); if (page.noteId !== id || page.revision !== revision || (allowUnanchored && block === null ? page.unanchoredBlockCount === 0 : !blockIds.get(key(r))!.has(block as string))) bad('A corpus result does not name an observed exact block and revision.'); return page }
    for (const v of array(p.references)) {
      const ref = object(v,['source','sourceResource','revision','target','occurrence','mode','resolution','query']), origin = object(ref.source,['noteId','blockId']), r = within(resource(ref.sourceResource)); source(r,origin.noteId,ref.revision,origin.blockId)
      if (!member(ref.mode, ['reference','embed','link']) || !member(ref.resolution, ['resolved','ambiguous','missing','unknown'])) bad('Invalid corpus relationship.')
      const t = object(ref.target,['kind','noteId','blockId','text']); if (t.kind === 'unbound') { text(t.text); if (t.noteId !== undefined || t.blockId !== undefined || ref.mode !== 'link') bad('An unbound query cannot carry another target.'); } else { text(t.noteId); if (t.kind === 'block') text(t.blockId); else if (t.kind !== 'page' || t.blockId !== undefined || ref.mode !== 'link') bad('Invalid corpus target.'); if (t.text !== undefined) bad('A bound target cannot contain an unbound query.'); }
      const o = object(ref.occurrence,['kind','referenceId','revision','from','to']); if (o.kind === 'stored') { text(o.referenceId); if (o.revision !== undefined || o.from !== undefined || o.to !== undefined) bad('A stored occurrence cannot carry derived positions.'); } else if (o.kind !== 'text' || o.referenceId !== undefined || ref.mode !== 'link' || ref.query === undefined || o.revision !== ref.revision || count(o.to) <= count(o.from)) bad('Invalid corpus occurrence.')
      if (ref.query !== undefined) text(ref.query)
      const targets = groups.get(String(t.noteId)) ?? []
      if (ref.resolution === 'resolved' && (!sourceComplete || ref.query !== undefined && !titlesKnown || t.kind === 'unbound' || targets.length !== 1 || t.kind === 'block' && !blockIds.get(key(targets[0]!.resource))!.has(t.blockId as string))) bad('The corpus relationship target is not confirmed.')
    }
    const q = object(p.search,['query','hits','total','truncated']); if (q.query !== (input.query ?? null) || typeof q.truncated !== 'boolean') bad('This corpus search belongs to another query.')
    const hits = array(q.hits); count(q.total); if (hits.length > (input.limit ?? 30) || Number(q.total) < hits.length || q.truncated !== (Number(q.total)>hits.length)) bad('Invalid corpus result coverage.')
    for (const v of hits) { const hit = object(v,['resource','noteId','title','blockId','revision','excerpt','match']), page = source(within(resource(hit.resource)),hit.noteId,hit.revision,hit.blockId,true), m = object(hit.match,['from','to']); if (hit.title !== page.title || typeof hit.excerpt !== 'string' || !input.query || count(m.to)>hit.excerpt.length || count(m.to)<=count(m.from) || hit.excerpt.slice(Number(m.from),Number(m.to)) !== input.query) bad('Invalid corpus excerpt.') }
    if (s.completeness === 'complete' && (pages.length !== c.files || !root || c.limited || array(c.issues).length || duplicates.length || pages.some(p=>p.title===null||p.unanchoredBlockCount>0))) bad('Incomplete original files cannot confirm a complete corpus.')
    return structuredClone(value) as NoteCorpusResult
  } catch (error) { if (error instanceof AgentMuxError && error.code === 'INVALID_CONTROL_REQUEST') throw new AgentMuxError(error.message,'CONTROL_PROTOCOL_ERROR'); throw error }
}
