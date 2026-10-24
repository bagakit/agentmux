import { createHash } from 'node:crypto'
import { mkdir, open, readFile, link, unlink, stat } from 'node:fs/promises'
import { dirname, join, isAbsolute, resolve, relative } from 'node:path'
import { readNoteMarkdownHeader } from './note-format.js'
import { mintObjectId } from './object-id.js'
import { AgentMuxError } from './errors.js'
import { durableWriteFile } from './durable-write.js'
import { emptyNotebookState, notebookFingerprint, parseNotebookState, type NotebookState, type NoteResource } from './notebook-catalog.js'
import { noteProvenanceResourceKey, parseNoteProvenanceWrite, type NoteAuthorship, type NoteProvenanceQuery, type NoteProvenanceSnapshot, type NoteProvenanceWrite } from './note-provenance.js'
import { noteHistoryRevision, noteHistorySnapshot, parseNoteHistoryRecord, parseNoteHistoryQuery, parseNoteHistorySource, parseNoteFileWitness,
  type NoteHistoryRecord, type NoteHistoryEntry, type NoteHistoryQuery, type NoteHistorySnapshot } from './note-history.js'

export const NOTEBOOK_ROOT_NAME = 'notebooks.root.json'
export type NotebookFileSnapshot = { incarnation: string; libraryDirectory?: string; state: NotebookState; provenance: NoteProvenanceWrite[]; history?: NoteHistoryRecord[] }
type Event = Omit<NoteHistoryRecord, 'beforeContent' | 'content'>
type Original = { noteId: string; resource: NoteResource; metadata: string }
type Root = { schema: 'agentmux.notebook.files.v1'; incarnation: string; libraryDirectory: string; catalog: string; sequence: number; operations: Record<string, string>; originals: Record<string, Original> }
type Metadata = { schema: 'agentmux.note.metadata.v1'; noteId: string; resource: NoteResource; provenance: NoteProvenanceWrite[]; history: Event[] }
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const decoded = (bytes: Buffer): unknown => { try { return JSON.parse(bytes.toString('utf8')) } catch { throw failure('An original Notebook JSON file cannot be parsed.') } }
const encoded = (value: unknown) => JSON.stringify(value) + '\n'
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/[\0\r\n]/u.test(value)
const failure = (message: string) => new AgentMuxError(message + ' Original knowledge and files are retained.', 'NOTEBOOK_READ_UNCONFIRMED')
export const notebookFileRoot = (path: string) => path.endsWith('.root.json') ? path : path.replace(/\.(?:json|sqlite)$/u, '') + '.root.json'
const legacySqlite = (path: string) => path.slice(0, -'.root.json'.length) + '.sqlite'
const dataPath = (path: string, kind: 'catalog' | 'metadata' | 'bodies' | 'operations' | 'retired', name: string) => join(path + '.files', kind, name)
const originalKey = (noteId: string, resource: NoteResource) => hash(JSON.stringify([noteId, noteProvenanceResourceKey(resource)]))
async function optional(path: string): Promise<Buffer | null> { try { return await readFile(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
async function sync(path: string) { const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() } }
/** Immutable publication never replaces a different original under the same content address. */
async function publish(path: string, bytes: string | Uint8Array): Promise<void> {
  const value = Buffer.from(bytes), old = await optional(path)
  if (old) {
    if (!old.equals(value)) throw failure('An immutable Notebook file contains different bytes.')
    await sync(path); await sync(dirname(path)); return
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + mintObjectId() + '.tmp'
  try {
    await durableWriteFile(temporary, value, { requireDirectorySync: true })
    try { await link(temporary, path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await readFile(path)).equals(value)) throw error
    }
    await sync(dirname(path))
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
async function putJson(path: string, kind: 'catalog' | 'metadata' | 'operations' | 'retired', value: unknown) {
  const bytes = encoded(value), digest = hash(bytes)
  await publish(dataPath(path, kind, digest + '.json'), bytes); return digest
}
async function jsonAt(path: string, kind: 'catalog' | 'metadata' | 'operations' | 'retired', digest: string): Promise<unknown> {
  const bytes = await readFile(dataPath(path, kind, digest + '.json')).catch(() => { throw failure('The original Notebook ' + kind + ' file is unavailable.') })
  if (hash(bytes) !== digest) throw failure('The original Notebook ' + kind + ' checksum changed.')
  return decoded(bytes)
}
function parseRoot(value: unknown): Root {
  const root = value as Root
  if (!root || root.schema !== 'agentmux.notebook.files.v1' || !id(root.incarnation) || !isAbsolute(root.libraryDirectory ?? '') || !validHash(root.catalog) || !Number.isSafeInteger(root.sequence) || root.sequence < 0 || !root.operations || typeof root.operations !== 'object' || Array.isArray(root.operations) || Object.entries(root.operations).some(([bucket, digest]) => !/^[a-f0-9]{2}$/u.test(bucket) || !validHash(digest)) || !root.originals || typeof root.originals !== 'object' || Array.isArray(root.originals)) throw failure('The original Notebook root cannot be confirmed.')
  for (const [key, original] of Object.entries(root.originals)) {
    if (!original || !id(original.noteId) || !validHash(original.metadata) || key !== originalKey(original.noteId, original.resource)) throw failure('The original Notebook metadata address cannot be confirmed.')
  }
  return root
}
async function readRoot(path: string): Promise<Root | null> {
  const bytes = await optional(path), acknowledged = await optional(path + '.identity')
  if (!bytes) {
    if (acknowledged || await exists(path + '.files') && !await exists(path + '.importing.json')) throw failure('The established original Notebook root is missing; no older input was substituted.')
    return null
  }
  const root = parseRoot(decoded(bytes))
  if (acknowledged && acknowledged.toString('utf8') !== root.incarnation) throw failure('The acknowledged Notebook file identity changed.')
  return root
}
export async function notebookFilesLocated(path: string): Promise<boolean> {
  const root = await readRoot(path)
  return !!root && root.libraryDirectory === dirname(path) && await exists(path + '.identity') && !await exists(path + '.importing.json')
}
async function catalog(path: string, root: Root) { return parseNotebookState(await jsonAt(path, 'catalog', root.catalog)) }
function eventMetadata(value: Event, original: Pick<Original, 'noteId' | 'resource'>): Event {
  if (!value || value.noteId !== original.noteId || noteProvenanceResourceKey(value.resource) !== noteProvenanceResourceKey(original.resource) ||
      !id(value.eventId) || !id(value.batchId) || !id(value.requestFingerprint) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
      !Number.isSafeInteger(value.at) || value.at < 0 || !['prepared', 'committed', 'unconfirmed', 'not-applied'].includes(value.status) || !['edit', 'restore', 'undo', 'delete'].includes(value.operation) ||
      (value.operation === 'delete' ? value.revision !== null || value.baseRevision === null : !/^sha256:[a-f0-9]{64}$/u.test(value.revision!)) ||
      value.baseRevision !== null && !/^sha256:[a-f0-9]{64}$/u.test(value.baseRevision) ||
      value.parentEventId !== null && (!id(value.parentEventId) || value.parentEventId === value.eventId) ||
      value.actor !== null && (!['user', 'agent', 'device'].includes(value.actor.kind) || !id(value.actor.id))) throw failure('The original historical event identity cannot be confirmed.')
  noteProvenanceResourceKey(value.originalResource); parseNoteHistorySource(value.operation, value.source)
  if (value.fileWitness) parseNoteFileWitness(value.fileWitness)
  if (value.provenance) {
    parseNoteProvenanceWrite(value.provenance)
    if (value.provenance.noteId !== value.noteId || value.provenance.revision !== value.revision || noteProvenanceResourceKey(value.provenance.resource) !== noteProvenanceResourceKey(value.resource)) throw failure('The original historical attribution belongs to another body.')
  }
  return value
}
async function metadata(path: string, root: Root, noteId: string, resource: NoteResource, section: 'all' | 'provenance' | 'history' = 'all'): Promise<Metadata> {
  const reference = root.originals[originalKey(noteId, resource)]
  if (!reference) return { schema: 'agentmux.note.metadata.v1', noteId, resource: structuredClone(resource), provenance: [], history: [] }
  const value = await jsonAt(path, 'metadata', reference.metadata) as Metadata
  if (value?.schema !== 'agentmux.note.metadata.v1' || value.noteId !== noteId || noteProvenanceResourceKey(value.resource) !== noteProvenanceResourceKey(resource) || section !== 'history' && !Array.isArray(value.provenance) || section !== 'provenance' && !Array.isArray(value.history)) throw failure('The original Note metadata belongs to another resource.')
  const revisions = new Set<string>(), events = new Set<string>(); let sequence = 0
  for (const row of section === 'history' ? [] : value.provenance) {
    parseNoteProvenanceWrite(row)
    if (row.noteId !== noteId || noteProvenanceResourceKey(row.resource) !== noteProvenanceResourceKey(resource) || revisions.has(row.revision)) throw failure('The original attribution revision or resource changed.')
    revisions.add(row.revision)
  }
  for (const event of section === 'provenance' ? [] : value.history) {
    eventMetadata(event, reference)
    if (events.has(event.eventId) || event.sequence <= sequence || event.sequence > root.sequence) throw failure('The original historical sequence changed.')
    sequence = event.sequence; events.add(event.eventId)
  }
  return value
}
async function body(path: string, revision: string): Promise<string> {
  const bytes = await readFile(dataPath(path, 'bodies', revision.slice(7) + '.md')), content = bytes.toString('utf8')
  if (noteHistoryRevision(content) !== revision) throw failure('The original historical body checksum changed.')
  return content
}
async function record(path: string, event: Event): Promise<NoteHistoryRecord> {
  return parseNoteHistoryRecord({ ...event, beforeContent: event.baseRevision === null ? null : await body(path, event.baseRevision),
    content: event.revision === null ? null : await body(path, event.revision) } as NoteHistoryRecord)
}
async function saveBodies(path: string, value: NoteHistoryRecord) {
  if (value.content !== null) await publish(dataPath(path, 'bodies', value.revision.slice(7) + '.md'), value.content)
  if (value.beforeContent !== null) await publish(dataPath(path, 'bodies', value.baseRevision!.slice(7) + '.md'), value.beforeContent)
}
/** Small immutable indexes belong to the same root commit as their original events. */
async function operationIndex(path: string, root: Root, eventId: string): Promise<Record<string, { eventId: string; originals: string[] }>> {
  const bucket = hash(eventId).slice(0, 2), digest = root.operations[bucket]
  if (!digest) return {}
  const value = await jsonAt(path, 'operations', digest) as Record<string, { eventId: string; originals: string[] }>
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, entry]) => !entry || !id(entry.eventId) || hash(entry.eventId) !== key || key.slice(0, 2) !== bucket || !Array.isArray(entry.originals) || !entry.originals.length || entry.originals.some(key => !validHash(key)))) throw failure('The original operation index cannot be confirmed.')
  return value
}
async function indexEvent(path: string, root: Root, eventId: string, key: string, previousKey?: string) {
  const index = await operationIndex(path, root, eventId), digest = hash(eventId)
  const keys = (index[digest]?.originals ?? []).filter(key => key !== previousKey)
  if (!keys.includes(key)) keys.push(key)
  index[digest] = { eventId, originals: keys }
  root.operations[digest.slice(0, 2)] = await putJson(path, 'operations', index)
}
async function saveMetadata(path: string, root: Root, value: Metadata) {
  const key = originalKey(value.noteId, value.resource), digest = await putJson(path, 'metadata', value)
  root.originals[key] = { noteId: value.noteId, resource: value.resource, metadata: digest }
}
async function commit(path: string, root: Root, exclusive = false) {
  const acknowledged = await optional(path + '.identity')
  if (acknowledged && acknowledged.toString('utf8') !== root.incarnation) throw failure('The original acknowledged library identity changed before publication.')
  // All immutable dependencies and operation locators are durable before this sole publication point.
  if (exclusive) await publish(path, encoded(root))
  else await durableWriteFile(path, encoded(root), { requireDirectorySync: true })
  await publish(path + '.identity', root.incarnation)
}
export async function readNotebookFiles(path: string, includeMetadata = true): Promise<NotebookFileSnapshot | null> {
  const root = await readRoot(path)
  if (!root) return null
  return snapshotAt(path, root, includeMetadata)
}
async function snapshotAt(path: string, root: Root, includeMetadata = true): Promise<NotebookFileSnapshot> {
  const state = await catalog(path, root), provenance: NoteProvenanceWrite[] = [], history: NoteHistoryRecord[] = []
  if (includeMetadata) for (const original of Object.values(root.originals)) {
    const value = await metadata(path, root, original.noteId, original.resource)
    provenance.push(...value.provenance)
    for (const event of value.history) history.push(await record(path, event))
  }
  history.sort((a, b) => a.sequence - b.sequence)
  return { incarnation: root.incarnation, libraryDirectory: root.libraryDirectory, state, provenance, ...(history.length ? { history } : {}) }
}
export function notebookFilesFingerprint(value: NotebookFileSnapshot): string {
  const { libraryDirectory: _physicalDirectory, ...knowledge } = value
  return hash(notebookFingerprint({ ...knowledge, provenance: [...value.provenance].sort((a, b) => JSON.stringify([a.noteId, noteProvenanceResourceKey(a.resource), a.revision]).localeCompare(JSON.stringify([b.noteId, noteProvenanceResourceKey(b.resource), b.revision]))) }))
}
async function prepareSnapshot(path: string, value: NotebookFileSnapshot): Promise<Root> {
  const root: Root = { schema: 'agentmux.notebook.files.v1', incarnation: value.incarnation, libraryDirectory: dirname(path), catalog: await putJson(path, 'catalog', parseNotebookState(value.state)), sequence: 0, operations: {}, originals: {} }
  const originals = new Map<string, Metadata>()
  const original = (noteId: string, resource: NoteResource) => {
    const key = originalKey(noteId, resource)
    if (!originals.has(key)) originals.set(key, { schema: 'agentmux.note.metadata.v1', noteId, resource, provenance: [], history: [] })
    return originals.get(key)!
  }
  for (const row of value.provenance) original(row.noteId, row.resource).provenance.push(parseNoteProvenanceWrite(row))
  for (const row of value.history ?? []) {
    const event = parseNoteHistoryRecord(row), { content: _content, beforeContent: _before, ...entry } = event
    if (entry.sequence === 0) entry.sequence = root.sequence + 1
    root.sequence = Math.max(root.sequence, entry.sequence)
    original(event.noteId, event.resource).history.push(entry)
    await saveBodies(path, event); await indexEvent(path, root, event.eventId, originalKey(event.noteId, event.resource))
  }
  for (const value of originals.values()) { value.history.sort((a, b) => a.sequence - b.sequence); await saveMetadata(path, root, value) }
  const actual = await snapshotAt(path, root)
  if (notebookFilesFingerprint(actual) !== notebookFilesFingerprint(value)) throw failure('The complete original metadata export could not be confirmed before publication.')
  return root
}
/** New libraries and directory moves publish the exact complete snapshot, never replace another library. */
export async function publishNotebookFiles(path: string, value: NotebookFileSnapshot): Promise<void> {
  const existingBytes = await optional(path)
  if (existingBytes && JSON.parse(existingBytes.toString('utf8'))?.schema === 'agentmux.notebook.moved.v1') {
    const retired = (await retiredRoot(path))!
    if (retired.incarnation !== value.incarnation) throw failure('The destination belongs to another retired original library.')
    const root = await prepareSnapshot(path, value)
    await commit(path, root); return
  }
  if (existingBytes) {
    const current = await readNotebookFiles(path)
    if (!current || notebookFilesFingerprint(current) !== notebookFilesFingerprint(value)) throw new AgentMuxError('The destination contains different original Notebook files.', 'NOTES_STORAGE_CONFLICT')
    await sync(path); await sync(dirname(path)); await publish(path + '.identity', value.incarnation); return
  }
  if (await exists(path + '.identity')) throw failure('The established original Notebook root was removed.')
  const root = await prepareSnapshot(path, value)
  await commit(path, root, true)
}
/** Same-library cutover; the root atomically publishes catalog and every relocated original. */
export async function replaceNotebookFiles(path: string, value: NotebookFileSnapshot): Promise<void> {
  const current = await readRoot(path)
  if (!current || current.incarnation !== value.incarnation) throw failure('The original Notebook identity changed before cutover.')
  await commit(path, await prepareSnapshot(path, value))
}
type PendingImport = { schema: 'agentmux.notebook.import.v1'; target: string; legacyPath: string | null; snapshot: NotebookFileSnapshot; fingerprint: string; inputs: { path: string; hash: string | null; backup?: string }[] }
async function confirmImport(path: string, value: PendingImport): Promise<void> {
  if (value?.schema !== 'agentmux.notebook.import.v1' || value.target !== path || value.legacyPath !== null && value.legacyPath !== path.slice(0, -'.root.json'.length) + '.json' || !Array.isArray(value.inputs) || value.fingerprint !== notebookFilesFingerprint(value.snapshot)) throw failure('The original pending metadata export changed.')
  const expected = [legacySqlite(path), legacySqlite(path) + '.sqlite-identity', ...(value.inputs[0]?.hash === null && value.legacyPath ? [value.legacyPath] : [])]
  if (value.inputs.length !== expected.length || value.inputs.some((input, index) => input.path !== expected[index])) throw failure('The pending import does not retain its exact original input set.')
  for (const input of value.inputs) {
    if (!isAbsolute(input.path) || input.hash !== null && (!validHash(input.hash) || input.backup !== input.path + '.original-' + input.hash)) throw failure('The original import source identity changed.')
    const actual = await optional(input.path)
    if (input.hash === null ? actual !== null : !actual || hash(actual) !== input.hash || hash(await readFile(input.backup!)) !== input.hash) throw failure('The original import source changed after export; the same pending export and all originals are retained.')
  }
}
/** Explicit one-time import. A file root/identity always wins; damaged established files never fall back. */
export async function initializeNotebookFiles(path: string, legacyPath?: string, required = false): Promise<NotebookFileSnapshot> {
  const bytes = await optional(path)
  if (bytes) {
    const current = (await readNotebookFiles(path, false))!, pendingBytes = await optional(path + '.importing.json')
    if (pendingBytes) {
      const pending = decoded(pendingBytes) as PendingImport
      if (pending.schema !== 'agentmux.notebook.import.v1' || pending.target !== path || pending.fingerprint !== notebookFilesFingerprint(pending.snapshot) || notebookFilesFingerprint((await readNotebookFiles(path))!) !== pending.fingerprint) throw failure('The published root does not confirm its original pending export.')
      // Publication already happened. Reconfirm that exact root; older SQL is no longer an authority.
      await sync(path); await sync(dirname(path))
    } else if (!await exists(path + '.identity')) { await sync(path); await sync(dirname(path)) }
    await publish(path + '.identity', current.incarnation)
    if (pendingBytes) await unlink(path + '.importing.json')
    return current.libraryDirectory === dirname(path) ? current : adoptSelectedLibrary(path)
  }
  if (await exists(path + '.identity')) throw failure('The established original Notebook root is missing.')
  const pendingPath = path + '.importing.json', pendingBytes = await optional(pendingPath)
  let pending: PendingImport
  if (pendingBytes) pending = JSON.parse(pendingBytes.toString('utf8')) as PendingImport
  else {
    if (await exists(path + '.files')) throw failure('Original Notebook files exist without their root; no legacy input was substituted.')
    const { readLegacyNotebookDatabase } = await import('./notebook-sqlite-import.js')
    const old = await readLegacyNotebookDatabase(legacySqlite(path)), inputs = old.inputs
    let value: NotebookFileSnapshot
    if (old.snapshot) value = old.snapshot
    else {
      const raw = legacyPath ? await optional(legacyPath) : null
      if (required && !raw) throw failure('The established original Notebook catalog is missing.')
      if (legacyPath) inputs.push({ path: legacyPath, bytes: raw })
      value = { incarnation: mintObjectId(), state: raw ? parseNotebookState(JSON.parse(raw.toString('utf8'))) : emptyNotebookState(), provenance: [] }
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    pending = { schema: 'agentmux.notebook.import.v1', target: path, legacyPath: legacyPath ?? null, snapshot: value, fingerprint: notebookFilesFingerprint(value), inputs: [] }
    for (const input of inputs) {
      const digest = input.bytes === null ? null : hash(input.bytes), backup = digest === null ? undefined : input.path + '.original-' + digest
      if (backup) await publish(backup, input.bytes!)
      pending.inputs.push({ path: input.path, hash: digest, ...(backup ? { backup } : {}) })
    }
    await confirmImport(path, pending)
    await durableWriteFile(pendingPath, encoded(pending), { requireDirectorySync: true })
  }
  await confirmImport(path, pending)
  const root = await prepareSnapshot(path, pending.snapshot)
  await confirmImport(path, pending)
  await commit(path, root, true)
  await unlink(pendingPath)
  return (await readNotebookFiles(path, false))!
}
/** An explicitly selected complete library resolves its own managed resources at this location. */
async function adoptSelectedLibrary(path: string): Promise<NotebookFileSnapshot> {
  const original = (await readNotebookFiles(path))!, source = original.libraryDirectory!, directory = dirname(path)
  const relocate = (resource: NoteResource): NoteResource => resource.hostId === 'local' && resource.workspacePath === source ? { ...resource, workspacePath: directory } : resource
  for (const page of Object.values(original.state.pages)) {
    const resource = relocate(page.resource)
    if (resource === page.resource) continue
    const file = resolve(directory, resource.path), local = relative(directory, file)
    if (!local || local.startsWith('..') || isAbsolute(local)) throw failure('A selected library resource escaped its original root.')
    const bytes = await optional(file)
    // Missing originals remain exact missing resources; another Note never acquires this identity.
    if (bytes) { const header = readNoteMarkdownHeader(bytes.toString('utf8')); if (header.status !== 'valid' || header.noteId !== page.noteId) throw failure('A selected library body belongs to another original Note.') }
    page.resource = resource
  }
  original.provenance = original.provenance.map(row => ({ ...row, resource: relocate(row.resource) }))
  if (original.history) original.history = original.history.map(event => ({ ...event, resource: relocate(event.resource), ...(event.provenance ? { provenance: { ...event.provenance, resource: relocate(event.provenance.resource) } } : {}) }))
  await replaceNotebookFiles(path, original)
  return (await readNotebookFiles(path, false))!
}
type RetiredRoot = { schema: 'agentmux.notebook.moved.v1'; incarnation: string; operationId: string; destination: string; originalRoot: string }
async function retiredRoot(path: string): Promise<RetiredRoot | null> {
  const bytes = await optional(path)
  if (!bytes) return null
  const value = JSON.parse(bytes.toString('utf8')) as RetiredRoot
  if (value?.schema !== 'agentmux.notebook.moved.v1') return null
  if (Object.keys(value).some(key => !['schema', 'incarnation', 'operationId', 'destination', 'originalRoot'].includes(key)) || !id(value.incarnation) || !id(value.operationId) || !isAbsolute(value.destination ?? '') || value.destination === path || !validHash(value.originalRoot)) throw failure('The original library retirement receipt is incomplete.')
  const original = parseRoot(await jsonAt(path, 'retired', value.originalRoot)), acknowledged = await optional(path + '.identity')
  if (original.incarnation !== value.incarnation || original.libraryDirectory !== dirname(path) || !acknowledged || acknowledged.toString('utf8') !== value.incarnation) throw failure('The original retired library identity cannot be confirmed.')
  return value
}
export async function notebookFilesRetired(path: string, operationId?: string): Promise<boolean> {
  const retired = await retiredRoot(path)
  if (retired && operationId !== undefined && retired.operationId !== operationId) throw failure('The original retirement belongs to another move operation.')
  return !!retired
}
/** Retirement preserves exact root bytes and acknowledges the move without permitting stale re-import. */
export async function retireNotebookFiles(path: string, incarnation: string, operationId: string, destination: string): Promise<void> {
  if (await notebookFilesRetired(path, operationId)) return
  const bytes = await readFile(path), root = parseRoot(decoded(bytes))
  if (root.incarnation !== incarnation) throw failure('The original library identity changed before retirement.')
  const digest = hash(bytes)
  await publish(join(path + '.files', 'retired', digest + '.json'), bytes)
  await durableWriteFile(path, encoded({ schema: 'agentmux.notebook.moved.v1', incarnation, operationId, destination, originalRoot: digest }), { requireDirectorySync: true })
}
function creatorsFor(value: Metadata, blockIds: readonly string[]): Map<string, NoteAuthorship> {
  const remaining = new Set(blockIds), result = new Map<string, NoteAuthorship>()
  for (const row of value.provenance) {
    for (const id of remaining) if (Object.hasOwn(row.blocks, id) && row.blocks[id]?.created) { result.set(id, row.blocks[id]!.created!); remaining.delete(id) }
    if (!remaining.size) break
  }
  return result
}
export async function readNotebookProvenance(path: string, query: NoteProvenanceQuery): Promise<NoteProvenanceSnapshot> {
  const root = await readRoot(path), value = root ? await metadata(path, root, query.noteId, query.resource, 'provenance') : undefined
  const exact = value?.provenance.find(row => row.revision === query.revision), creators = value ? creatorsFor(value, query.blockIds) : new Map<string, NoteAuthorship>()
  const blocks = Object.fromEntries(query.blockIds.map(id => [id, { created: (exact && Object.hasOwn(exact.blocks, id) ? exact.blocks[id]?.created : null) ?? creators.get(id) ?? null,
    lastEdited: exact && Object.hasOwn(exact.blocks, id) ? exact.blocks[id]?.lastEdited ?? null : null }]))
  return { noteId: query.noteId, resource: structuredClone(query.resource), revision: query.revision, blocks,
    ...(exact && query.blockIds.every(id => Object.hasOwn(exact.blocks, id)) ? { status: 'recorded' as const } : { status: 'unconfirmed' as const, reason: 'Trusted block attribution is not confirmed for this exact original body revision.' }) }
}
export async function readNotebookHistory(path: string, query: NoteHistoryQuery): Promise<NoteHistorySnapshot> {
  parseNoteHistoryQuery(query)
  const root = await readRoot(path), value = root ? await metadata(path, root, query.noteId, query.resource, 'history') : undefined, limit = query.limit ?? 50
  const events = (value?.history ?? []).filter(event => query.eventId ? event.eventId === query.eventId : event.sequence < (query.before ?? Number.MAX_SAFE_INTEGER)).reverse()
  const entries: NoteHistoryEntry[] = []
  for (const event of events.slice(0, limit)) {
    const { requestFingerprint: _private, provenance, ...entry } = query.includeContent ? await record(path, event) : event
    entries.push({ ...entry, ...(query.includeContent && provenance ? { provenance } : {}) })
  }
  return noteHistorySnapshot(query, entries, events.length > limit)
}
export async function readNotebookHistoryBatch(path: string, query: Pick<NoteHistoryQuery, 'noteId' | 'resource'> & { batchId: string }): Promise<NoteHistoryEntry[]> {
  parseNoteHistoryQuery(query); if (!id(query.batchId)) throw new AgentMuxError('An exact original history batch is required.', 'NOTE_HISTORY_INVALID')
  const root = await readRoot(path)
  if (!root) return []
  return (await metadata(path, root, query.noteId, query.resource, 'history')).history.filter(event => event.batchId === query.batchId).map(({ requestFingerprint: _private, provenance: _provenance, ...event }) => event)
}
export async function readNotebookHistoryOperation(path: string, eventId: string): Promise<NoteHistoryRecord | undefined> {
  const root = await readRoot(path)
  if (!root) return
  const index = await operationIndex(path, root, eventId), keys = index[hash(eventId)]?.originals ?? [], events: Event[] = []
  for (const key of keys) {
    const original = root.originals[key]
    if (!original) throw failure('The indexed original operation resource is missing.')
    const event = (await metadata(path, root, original.noteId, original.resource, 'history')).history.find(event => event.eventId === eventId)
    if (!event) throw failure('The indexed original operation cannot be confirmed.')
    events.push(event)
  }
  if (events.length > 1) throw new AgentMuxError('This history operation is ambiguous across original Notes. All records are retained.', 'NOTE_HISTORY_OPERATION_CONFLICT')
  return events[0] ? record(path, events[0]) : undefined
}
export async function readNotebookHistoryProvenance(path: string, query: NoteProvenanceQuery): Promise<Pick<NoteHistoryRecord, 'status' | 'revision' | 'provenance'> | undefined> {
  const root = await readRoot(path)
  if (!root) return
  const latest = [...(await metadata(path, root, query.noteId, query.resource, 'history')).history].reverse().find(event => event.status !== 'not-applied')
  return latest && { status: latest.status, revision: latest.revision, ...(latest.provenance ? { provenance: latest.provenance } : {}) }
}
export async function writeNotebookHistory(path: string, candidate: NoteHistoryRecord): Promise<NoteHistoryRecord> {
  const root = await readRoot(path)
  if (!root) throw failure('The original Notebook root is missing.')
  const value = parseNoteHistoryRecord(candidate), metadataValue = await metadata(path, root, value.noteId, value.resource)
  const index = metadataValue.history.findIndex(event => event.eventId === value.eventId), oldEvent = metadataValue.history[index]
  if (oldEvent) {
    const old = await record(path, oldEvent)
    const immutable = (record: NoteHistoryRecord) => { const { sequence: _sequence, status: _status, provenance: _provenance, fileWitness: _fileWitness, ...entry } = record; if (entry.operation === 'delete') delete entry.retainedPath; return notebookFingerprint(entry) }
    if (immutable(old) !== immutable(value) || value.sequence !== old.sequence || ['committed', 'not-applied'].includes(old.status) &&
        (old.status !== value.status || notebookFingerprint(old.provenance ?? null) !== notebookFingerprint(value.provenance ?? null) || notebookFingerprint(old.fileWitness ?? null) !== notebookFingerprint(value.fileWitness ?? null))) throw new AgentMuxError('This original history operation records another request or terminal result. Its body and event are retained.', 'NOTE_HISTORY_OPERATION_CONFLICT')
  } else {
    if (value.sequence !== 0) throw new AgentMuxError('New history receives its original sequence from the owner.', 'NOTE_HISTORY_OPERATION_CONFLICT')
    value.sequence = ++root.sequence
  }
  await saveBodies(path, value)
  const { beforeContent: _before, content: _content, ...entry } = value
  if (oldEvent) metadataValue.history[index] = entry; else metadataValue.history.push(entry)
  await saveMetadata(path, root, metadataValue); await indexEvent(path, root, value.eventId, originalKey(value.noteId, value.resource)); await commit(path, root)
  return value
}
type Relocation = { noteId: string; from: NoteResource; to: NoteResource }
export async function writeNotebookFiles(path: string, update: { state?: NotebookState; provenance?: NoteProvenanceWrite; relocation?: Relocation }): Promise<void> {
  const root = await readRoot(path)
  if (!root) throw failure('The original Notebook root is missing.')
  const state = update.state && parseNotebookState(update.state)
  if (update.relocation) {
    const { noteId, from, to } = update.relocation, before = await catalog(path, root), fromKey = originalKey(noteId, from), toKey = originalKey(noteId, to)
    if (!state || !before.pages[noteId] || !state.pages[noteId] || noteProvenanceResourceKey(before.pages[noteId]!.resource) !== noteProvenanceResourceKey(from) || noteProvenanceResourceKey(state.pages[noteId]!.resource) !== noteProvenanceResourceKey(to)) throw failure('The original relocation and catalog resources cannot be confirmed.')
    if (fromKey !== toKey) {
      if (root.originals[toKey]) throw new AgentMuxError('The destination already has metadata for this Note. Original catalog and metadata are retained.', 'NOTE_METADATA_RELOCATION_CONFLICT')
      if (root.originals[fromKey]) {
        const value = await metadata(path, root, noteId, from)
        value.resource = structuredClone(to)
        value.provenance = value.provenance.map(row => ({ ...row, resource: structuredClone(to) }))
        value.history = value.history.map(event => ({ ...event, resource: structuredClone(to), ...(event.provenance ? { provenance: { ...event.provenance, resource: structuredClone(to) } } : {}) }))
        await saveMetadata(path, root, value); delete root.originals[fromKey]
        for (const event of value.history) await indexEvent(path, root, event.eventId, toKey, fromKey)
      }
    }
  }
  if (state) root.catalog = await putJson(path, 'catalog', state)
  if (update.provenance) {
    const row = parseNoteProvenanceWrite(update.provenance), value = await metadata(path, root, row.noteId, row.resource), creators = creatorsFor(value, Object.keys(row.blocks))
    for (const [id, block] of Object.entries(row.blocks)) {
      const created = creators.get(id)
      if (created) { if (block.created && notebookFingerprint(created) !== notebookFingerprint(block.created)) throw new AgentMuxError('The original block creator is already confirmed.', 'NOTE_PROVENANCE_CONFLICT'); block.created = created }
    }
    const old = value.provenance.find(entry => entry.revision === row.revision)
    if (old && notebookFingerprint(old) !== notebookFingerprint(row)) throw new AgentMuxError('This saved revision already has different original attribution.', 'NOTE_PROVENANCE_CONFLICT')
    if (!old) value.provenance.push(row)
    await saveMetadata(path, root, value)
  }
  await commit(path, root)
}
