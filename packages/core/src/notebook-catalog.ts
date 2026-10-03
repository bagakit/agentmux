/** Durable knowledge references. Note bodies remain with their original filesystem owner. */
export const DEFAULT_NOTEBOOK_ID = 'quick-notes'
export const DEFAULT_NOTEBOOK_NAME = '随手记'
export type NotebookActor = { kind: 'user' | 'agent' | 'device'; id: string }
export type NotebookWorkface = { zoneId: string; workspaceId: string }
export type NoteResource = { hostId: string; workspaceId: string; workspacePath: string; path: string }
export type NoteSource = { sourceId: string; url: string; title: string | null; recordedAt: number;
  operator?: NotebookActor; position?: { zoneId: string; tabId: string; regionId: string } }
export type Notebook = { notebookId: string; name: string; createdAt: number; workface?: NotebookWorkface }
export type NotebookPage = { noteId: string; notebookId: string; parentNoteId: string | null; title: string;
  resource: NoteResource; workface?: NotebookWorkface; createdAt: number; updatedAt: number; sources: NoteSource[];
  topics: { spaceId: string; topicId?: string }[] }
export type NoteTrailEvent = { eventId: string; operationId: string; noteId: string; at: number; actor: NotebookActor;
  action: 'created' | 'moved' | 'renamed' | 'source-added' | 'organized' | 'relocated';
  before: { notebookId: string; parentNoteId: string | null; title: string; resource: NoteResource } | null;
  after: { notebookId: string; parentNoteId: string | null; title: string; resource: NoteResource };
  source?: NoteSource; topic?: { spaceId: string; topicId?: string } }
export type NotebookChange =
  | { kind: 'create'; notebookId: string; name: string; workface?: NotebookWorkface }
  | { kind: 'rename'; notebookId: string; name: string }
  | { kind: 'bind'; notebookId: string; workface: NotebookWorkface }
  | { kind: 'register'; noteId: string; notebookId?: string; parentNoteId?: string | null; title: string;
      resource: NoteResource; workface?: NotebookWorkface; source?: NoteSource }
  | { kind: 'move'; noteId: string; notebookId: string; parentNoteId: string | null }
  | { kind: 'rename-page'; noteId: string; title: string }
  | { kind: 'source'; noteId: string; source: NoteSource }
  | { kind: 'organize'; noteId: string; topic: { spaceId: string; topicId?: string } }
  | { kind: 'relocate'; noteId: string; resource: NoteResource; from?: NoteResource }
export type NotebookWrite = { expectedRevision: number; operationId: string; change: NotebookChange }
export type NotebookState = { schemaVersion: 1; revision: number; notebooks: Record<string, Notebook>;
  pages: Record<string, NotebookPage>; trail: NoteTrailEvent[];
  operations: Record<string, { fingerprint: string; actor: NotebookActor }> }
export type NotebookObservation = { state: NotebookState } | { issue: string }
export type NotebookApi = { read(): Promise<NotebookState>; apply(input: NotebookWrite): Promise<NotebookState>;
  onChange(listener: (event: NotebookObservation) => void): () => void }
export function emptyNotebookState(): NotebookState {
  return { schemaVersion: 1, revision: 0, notebooks: { [DEFAULT_NOTEBOOK_ID]: { notebookId: DEFAULT_NOTEBOOK_ID,
    name: DEFAULT_NOTEBOOK_NAME, createdAt: 0 } }, pages: {}, trail: [], operations: {} }
}
export class NotebookInputError extends Error {
  readonly code = 'NOTEBOOK_INPUT_INVALID'
}
const invalid = (message: string): never => { throw new NotebookInputError(message) }
function object(value: unknown, fields?: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('A knowledge object is required. Original pages are retained.')
  if (fields && Object.keys(value).some(key => !fields.includes(key))) invalid('Unexpected knowledge fields were retained outside this operation. Choose the original typed action.')
  return value as Record<string, any>
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) invalid(`An exact ${field} is required.`)
  return value as string
}
function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid('A confirmed record time is required.')
  return value as number
}
function resource(value: unknown): NoteResource {
  const r = object(value, ['hostId', 'workspaceId', 'workspacePath', 'path'])
  for (const key of ['hostId', 'workspaceId', 'workspacePath', 'path']) text(r[key], key)
  if (r.path.startsWith('/') || r.path.split(/[\\/]/).includes('..')) invalid('A Note resource uses its original Workspace-relative file path.')
  return { hostId: r.hostId, workspaceId: r.workspaceId, workspacePath: r.workspacePath, path: r.path }
}
function workface(value: unknown): NotebookWorkface {
  const w = object(value, ['zoneId', 'workspaceId']); return { zoneId: text(w.zoneId, 'Zone ID'), workspaceId: text(w.workspaceId, 'resource Workspace ID') }
}
function actor(value: unknown): NotebookActor {
  const a = object(value, ['kind', 'id'])
  if (!['user', 'agent', 'device'].includes(a.kind)) invalid('The recording actor is unconfirmed.')
  return { kind: a.kind, id: text(a.id, 'actor ID') }
}
function source(value: unknown): NoteSource {
  const s = object(value, ['sourceId', 'url', 'title', 'recordedAt', 'operator', 'position']), url = text(s.url, 'source URL')
  try { new URL(url) } catch { invalid('The source URL is invalid; no source was substituted.') }
  if (s.title !== null && typeof s.title !== 'string') invalid('A source title must be text or explicitly unknown.')
  const result: NoteSource = { sourceId: text(s.sourceId, 'source ID'), url, title: s.title, recordedAt: timestamp(s.recordedAt) }
  if (s.operator !== undefined) result.operator = actor(s.operator)
  if (s.position !== undefined) { const p = object(s.position, ['zoneId', 'tabId', 'regionId']); result.position = { zoneId: text(p.zoneId, 'source Zone ID'), tabId: text(p.tabId, 'source Tab ID'), regionId: text(p.regionId, 'source Region ID') } }
  return result
}
function topic(value: unknown): { spaceId: string; topicId?: string } {
  const t = object(value, ['spaceId', 'topicId']); return { spaceId: text(t.spaceId, 'Topic Space ID'), ...(t.topicId !== undefined ? { topicId: text(t.topicId, 'Topic ID') } : {}) }
}
function parent(state: NotebookState, noteId: string, notebookId: string, parentNoteId: string | null): void {
  if (parentNoteId === null) return
  const candidate = state.pages[text(parentNoteId, 'parent Note ID')]
  if (!candidate || candidate.notebookId !== notebookId) invalid('Choose a confirmed parent page in this Notebook. The original page is kept.')
  const seen = new Set<string>([noteId])
  let current: NotebookPage | undefined = candidate
  while (current) {
    if (seen.has(current.noteId)) invalid('A page cannot be placed inside its own descendants. Original organization is kept.')
    seen.add(current.noteId); current = current.parentNoteId ? state.pages[current.parentNoteId] : undefined
  }
}
/** Canonical parameter order allows exact operation reconciliation across transports. */
export function notebookFingerprint(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(notebookFingerprint).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + notebookFingerprint((value as Record<string, unknown>)[k])).join(',') + '}'
  return JSON.stringify(value)
}
export function parseNotebookState(value: unknown): NotebookState {
  const s = object(value, ['schemaVersion', 'revision', 'notebooks', 'pages', 'trail', 'operations'])
  if (s.schemaVersion !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0) invalid('The Notebook catalog revision is invalid.')
  const notebooks = object(s.notebooks), pages = object(s.pages), operations = object(s.operations)
  if (!Array.isArray(s.trail)) invalid('The original Note history is missing.')
  if (notebooks[DEFAULT_NOTEBOOK_ID]?.name !== DEFAULT_NOTEBOOK_NAME) invalid('The original 随手记 Notebook is missing.')
  for (const [id, n] of Object.entries(notebooks)) { if (object(n, ['notebookId', 'name', 'createdAt', 'workface']).notebookId !== id) invalid('A Notebook identity is ambiguous.'); text(n.name, 'Notebook name'); timestamp(n.createdAt); if(n.workface) workface(n.workface) }
  for (const [id, p] of Object.entries(pages)) {
    if (object(p, ['noteId', 'notebookId', 'parentNoteId', 'title', 'resource', 'workface', 'createdAt', 'updatedAt', 'sources', 'topics']).noteId !== id || !notebooks[p.notebookId]) invalid('A page or Notebook identity is unconfirmed.')
    text(p.title, 'page title'); resource(p.resource); timestamp(p.createdAt); timestamp(p.updatedAt); if(p.workface) workface(p.workface)
    if (!Array.isArray(p.sources) || !Array.isArray(p.topics)) invalid('A page has invalid source or Topic records.')
    p.sources.forEach(source); p.topics.forEach(topic); parent(s as NotebookState, id, p.notebookId, p.parentNoteId)
    if (new Set(p.sources.map((s: NoteSource) => s.sourceId)).size !== p.sources.length) invalid('A source identity is duplicated.')
  }
  const events = new Set<string>()
  for (const e of s.trail) { object(e, ['eventId', 'operationId', 'noteId', 'at', 'actor', 'action', 'before', 'after', 'source', 'topic']); if(!pages[e.noteId] || events.has(text(e.eventId,'event ID'))) invalid('A Note history identity is invalid.');events.add(e.eventId);text(e.operationId,'operation ID');timestamp(e.at);actor(e.actor);if(!['created','moved','renamed','source-added','organized','relocated'].includes(e.action))invalid('Unknown Note history action.');for (const point of e.before === null ? [e.after] : [e.before, e.after]) { object(point, ['notebookId', 'parentNoteId', 'title', 'resource']); text(point.notebookId, 'Notebook ID'); if (point.parentNoteId !== null) text(point.parentNoteId, 'parent Note ID'); text(point.title, 'page title'); resource(point.resource) }if(e.source)source(e.source);if(e.topic)topic(e.topic) }
  for (const [id, o] of Object.entries(operations)) { text(id,'operation ID');text(object(o, ['fingerprint', 'actor']).fingerprint,'original operation');actor(o.actor) }
  const result = structuredClone(s) as NotebookState
  for (const map of [result.notebooks, result.pages, result.operations]) Object.setPrototypeOf(map, null)
  return result
}
/** One semantic writer shared by Node persistence and the explicitly labelled Renderer preview. */
export function applyNotebookChange(state: NotebookState, input: NotebookWrite, recordedBy: NotebookActor, at: number): NotebookState {
  object(input, ['operationId', 'expectedRevision', 'change'])
  const fields: Record<string, readonly string[]> = { create: ['notebookId', 'name', 'workface'], rename: ['notebookId', 'name'], bind: ['notebookId', 'workface'], register: ['noteId', 'notebookId', 'parentNoteId', 'title', 'resource', 'workface', 'source'], move: ['noteId', 'notebookId', 'parentNoteId'], 'rename-page': ['noteId', 'title'], source: ['noteId', 'source'], organize: ['noteId', 'topic'], relocate: ['noteId', 'resource', 'from'] }
  const changeKind = object(input.change).kind
  if (!Object.hasOwn(fields, changeKind)) invalid('Unknown Notebook action. Original knowledge is kept.')
  object(input.change, ['kind', ...fields[changeKind]!])
  const operationId = text(input.operationId, 'operation ID'), change = object(input.change), recorded = actor(recordedBy)
  const fingerprint = notebookFingerprint(input.change), existing = Object.hasOwn(state.operations, operationId) ? state.operations[operationId] : undefined
  if (existing) {
    if (existing.fingerprint !== fingerprint || notebookFingerprint(existing.actor) !== notebookFingerprint(recorded)) invalid('This operation ID belongs to different knowledge changes. Read the original result; all pages are kept.')
    return state
  }
  if (input.expectedRevision !== state.revision) throw Object.assign(new Error('The Notebook changed. Refresh its directory before retrying this same operation; the Note file is kept.'), { code: 'NOTEBOOK_CONFLICT' })
  timestamp(at)
  const next = parseNotebookState(state), location = (p: NotebookPage) => ({ notebookId:p.notebookId,parentNoteId:p.parentNoteId,title:p.title,resource:structuredClone(p.resource) })
  const getPage = (id: unknown): NotebookPage => { const p = next.pages[text(id,'Note ID')]; if(!p)return invalid('The exact Note is not in the catalog. Keep its file and refresh the directory.'); return p }
  const getBook = (id: unknown): Notebook => { const n = next.notebooks[text(id,'Notebook ID')]; if(!n)return invalid('The exact Notebook is unavailable. Its pages and resources are kept.'); return n }
  const event = (p: NotebookPage, action: NoteTrailEvent['action'], before: NoteTrailEvent['before'], extra: Partial<Pick<NoteTrailEvent,'source'|'topic'>> = {}) => { p.updatedAt=at;next.trail.push({eventId:operationId+':'+p.noteId,operationId,noteId:p.noteId,at,actor:recorded,action,before,after:location(p),...extra}) }
  switch (change.kind) {
    case 'create': {
      const id=text(change.notebookId,'Notebook ID');if(next.notebooks[id])invalid('This Notebook identity already exists. Open the original Notebook instead.');
      next.notebooks[id]={notebookId:id,name:text(change.name,'Notebook name').trim(),createdAt:at,...(change.workface?{workface:workface(change.workface)}:{})};break
    }
    case 'rename': { const n=getBook(change.notebookId);if(n.notebookId===DEFAULT_NOTEBOOK_ID)invalid('随手记 keeps its default name. Choose another Notebook to rename.');n.name=text(change.name,'Notebook name').trim();break }
    case 'bind': getBook(change.notebookId).workface=workface(change.workface);break
    case 'register': {
      const id=text(change.noteId,'Note ID'),book=getBook(change.notebookId??DEFAULT_NOTEBOOK_ID),old=next.pages[id],r=resource(change.resource)
      if(old){if (change.notebookId !== undefined && change.notebookId !== old.notebookId || change.parentNoteId !== undefined && change.parentNoteId !== old.parentNoteId) invalid('This Note already has a confirmed Notebook location. Use move to change it; original placement is kept.'); if(notebookFingerprint(old.resource)!==notebookFingerprint(r))invalid('This Note ID already has another resource. Use its confirmed relocation operation; original references are kept.');break}
      const parentId=change.parentNoteId??null;parent(next,id,book.notebookId,parentId)
      const p:NotebookPage={noteId:id,notebookId:book.notebookId,parentNoteId:parentId,title:text(change.title,'page title').trim(),resource:r,
        ...(change.workface?{workface:workface(change.workface)}:{}),createdAt:at,updatedAt:at,sources:change.source?[source(change.source)]:[],topics:[]};next.pages[id]=p;event(p,'created',null,change.source?{source:p.sources[0]!}:{});break
    }
    case 'move': {
      const p=getPage(change.noteId),book=getBook(change.notebookId);if(p.notebookId===book.notebookId&&p.parentNoteId===change.parentNoteId)break;if(change.parentNoteId!==null)text(change.parentNoteId,'parent Note ID');parent(next,p.noteId,book.notebookId,change.parentNoteId)
      const members=new Set<string>([p.noteId]);let changed=true;while(changed){changed=false;for(const page of Object.values(next.pages))if(page.parentNoteId&&members.has(page.parentNoteId)&&!members.has(page.noteId)){members.add(page.noteId);changed=true}}
      for(const id of members){const page=next.pages[id]!,before=location(page);page.notebookId=book.notebookId;if(id===p.noteId)page.parentNoteId=change.parentNoteId;event(page,'moved',before)}break
    }
    case 'rename-page': {const p=getPage(change.noteId),before=location(p);const title=text(change.title,'page title').trim();if(title===p.title)break;p.title=title;event(p,'renamed',before);break}
    case 'source': {const p=getPage(change.noteId),added=source(change.source),old=p.sources.find(s=>s.sourceId===added.sourceId);if(old){if(notebookFingerprint(old)!==notebookFingerprint(added))invalid('The original source identity cannot be overwritten.');break}const before=location(p);p.sources.push(added);event(p,'source-added',before,{source:added});break}
    case 'organize': {const p=getPage(change.noteId),added=topic(change.topic);if(!p.topics.some(t=>t.spaceId===added.spaceId)){const before=location(p);p.topics.push(added);event(p,'organized',before,{topic:added})}break}
    case 'relocate': {const p=getPage(change.noteId),before=location(p);if(change.from && notebookFingerprint(p.resource)!==notebookFingerprint(resource(change.from)))invalid('The Note resource changed after this file operation. Its current reference is kept; inspect the original move before retrying.');const target=resource(change.resource);if(notebookFingerprint(p.resource)===notebookFingerprint(target))break;p.resource=target;event(p,'relocated',before);break}
    default: invalid('Unknown Notebook action. Original knowledge is kept.')
  }
  next.operations[operationId]={fingerprint,actor:recorded};next.revision=state.revision+1
  return parseNotebookState(next)
}

/** Exact result selection shared by the public owner and its response consumer. */
export function inspectNotebook(state: NotebookState, selection: { notebookId?: string; noteId?: string; operationId?: string }) {
  const { notebookId, noteId, operationId } = selection
  if ([notebookId, noteId, operationId].filter(value => value !== undefined).length !== 1)
    return invalid('Choose exactly one original Notebook, Note or operation.')
  for (const value of [notebookId, noteId, operationId]) if (value !== undefined) text(value, 'knowledge ID')
  return { state, notebook: notebookId && Object.hasOwn(state.notebooks, notebookId) ? state.notebooks[notebookId]! : null,
    pages: Object.values(state.pages).filter(page => noteId ? page.noteId === noteId : notebookId ? page.notebookId === notebookId : false),
    trail: state.trail.filter(event => noteId ? event.noteId === noteId : notebookId ? event.after.notebookId === notebookId || event.before?.notebookId === notebookId : false),
    recordedOperation: operationId && Object.hasOwn(state.operations, operationId) ? state.operations[operationId]! : null }
}
