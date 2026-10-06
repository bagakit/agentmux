import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, open, readFile, realpath, lstat, unlink, readdir, link } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { durableWriteFile } from './durable-write.js'
import { defaultAgentMuxStateDirectory } from './runtime-paths.js'
import { AgentMuxError } from './errors.js'
import { applyNotebookChange, parseNotebookState, notebookFingerprint, type NoteResource, type NotebookState } from './notebook-catalog.js'
import { NOTE_FILE_EXTENSION, readNoteMarkdownHeader } from './note-format.js'
import { initializeNotebookDatabase, NOTEBOOK_DATABASE_NAME, notebookDatabaseFingerprint, publishNotebookDatabase, readNotebookDatabase, replaceNotebookDatabase, type NotebookDatabaseSnapshot } from './notebook-database.js'
import { noteProvenanceResourceKey, parseNoteProvenanceWrite, type NoteProvenanceWrite } from './note-provenance.js'
export type NotesResourceChange = { noteId: string; from: NoteResource; to: NoteResource; conversion?: { sourceRevision: string; targetRevision: string } }
export type NotesStorageChange = { operationId: string; expectedDirectory: string; directory: string }
export type NotesConversionIssue = { noteId: string | null; resource: NoteResource | null; code: string; message: string }
export type NotesStorageTransfer = { source: string; destination: string; hash: string; preparedSource?: string; targetHash?: string; backup?: string }
export type NotesStorageOperation = NotesStorageChange & { phase: 'prepared' | 'committed'; resourceChanges: NotesResourceChange[]; files: NotesStorageTransfer[]; catalog: NotebookState; sourceCatalog: string; sourceCatalogHash: string; database?: { incarnation: string; snapshotPath: string; snapshotHash: string }; kind?: 'convert' }
export type NotesStorageSnapshot = { directory: string; catalogPath: string; resourceChanges: NotesResourceChange[]; directoryChanges: { from: string; to: string }[]; operation: NotesStorageOperation | null; conversionIssues?: NotesConversionIssue[] }
export type NotesStorageApi = { inspect(operationId?: string): Promise<NotesStorageSnapshot>; change(input: NotesStorageChange): Promise<NotesStorageSnapshot>; onChange(listener: (snapshot: NotesStorageSnapshot) => void): () => void }
/** The converter stages fsynced Markdown; this original owner journals and publishes it. */
export type NotesStorageConversion = { files: NotesStorageTransfer[]; resourceChanges: NotesResourceChange[]; provenance: NoteProvenanceWrite[]; issues?: NotesConversionIssue[] }
type Location = { schemaVersion: 1; directory: string; operations: Record<string, NotesStorageOperation>; pending: string | null; catalogEstablished?: true; catalogFormat?: 'sqlite'; conversionIssues?: NotesConversionIssue[] }
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
const heldLocks = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>()
/** Reuse only a lease held by this async operation, never an independent request. */
export async function withNotesStorageFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(path), held = heldLocks.getStore()
  if (held?.get(key)?.active) return work()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const lock = await open(path + '.lock', 'a+', 0o600)
  try {
    const deadline = Date.now() + 5000
    while (!native.tryLock(lock.fd)) { if (Date.now() > deadline) throw failure('Notes storage is completing its original change. Retry the same operation.', 'NOTEBOOK_BUSY'); await delay(10) }
    const lease = { active: true }
    try { return await heldLocks.run(new Map([...(held ?? []), [key, lease]]), work) }
    finally { lease.active = false }
  } finally { await lock.close() }
}
export const NOTES_RESOURCE_WORKSPACE_ID = '__notes__'
export const defaultNotesDirectory = () => join(homedir(), '.agentmux', 'notes')
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const failure = (message: string, code = 'NOTES_STORAGE_UNCONFIRMED') => new AgentMuxError(message + ' Original notes, references and work surfaces are retained.', code)
export function parseNotesConversionIssue(value: unknown): NotesConversionIssue {
  const issue = value as NotesConversionIssue
  if (!issue || typeof issue !== 'object' || Array.isArray(issue) || Object.keys(issue).some(key => !['noteId', 'resource', 'code', 'message'].includes(key)) || issue.noteId !== null && (typeof issue.noteId !== 'string' || !issue.noteId.trim()) || typeof issue.code !== 'string' || !issue.code.trim() || typeof issue.message !== 'string' || !issue.message.trim()) throw failure('The original conversion observation cannot be confirmed.')
  if (issue.resource !== null) noteProvenanceResourceKey(issue.resource)
  return structuredClone(issue)
}
const nested = (parent: string, child: string) => { const path = relative(parent, child); return path !== '' && !path.startsWith('..') && !isAbsolute(path) }
const databasePath = (path: string) => path.endsWith('.json') ? path.slice(0, -5) + '.sqlite' : path
const targetHash = (file: NotesStorageTransfer) => file.targetHash ?? file.hash
const operationDatabase = async (operation: NotesStorageOperation): Promise<NotebookDatabaseSnapshot> => {
  if (!operation.database) throw failure('The original JSON directory operation needs explicit format recovery before cutover.', 'NOTES_STORAGE_CONVERSION_REQUIRED')
  const bytes = await readFile(operation.database.snapshotPath)
  if (digest(bytes) !== operation.database.snapshotHash) throw failure('The original prepared metadata export changed.')
  const value = JSON.parse(bytes.toString('utf8')) as NotebookDatabaseSnapshot
  parseNotebookState(value.state); value.provenance.forEach(parseNoteProvenanceWrite)
  if (value.incarnation !== operation.database.incarnation || notebookFingerprint(value.state) !== notebookFingerprint(operation.catalog)) throw failure('The original prepared metadata export identity changed.')
  return value
}
export function parseNotesStorageOperation(value: unknown): NotesStorageOperation {
  const operation = value as NotesStorageOperation
  if (!operation || typeof operation !== 'object' || Object.keys(operation).some(key => !['operationId', 'expectedDirectory', 'directory', 'phase', 'resourceChanges', 'files', 'catalog', 'sourceCatalog', 'sourceCatalogHash', 'database', 'kind'].includes(key)) || typeof operation.operationId !== 'string' || !operation.operationId.trim() || !isAbsolute(operation.directory) || !isAbsolute(operation.expectedDirectory) || !isAbsolute(operation.sourceCatalog) || !['prepared', 'committed'].includes(operation.phase) || !/^[a-f0-9]{64}$/.test(operation.sourceCatalogHash) || !Array.isArray(operation.files) || !Array.isArray(operation.resourceChanges) || operation.kind !== undefined && operation.kind !== 'convert') throw failure('The original directory operation cannot be confirmed.')
  parseNotebookState(operation.catalog)
  if (operation.database) {
    if (Object.keys(operation.database).some(key => !['incarnation', 'snapshotPath', 'snapshotHash'].includes(key)) || typeof operation.database.incarnation !== 'string' || !operation.database.incarnation || !isAbsolute(operation.database.snapshotPath) || !/^[a-f0-9]{64}$/.test(operation.database.snapshotHash)) throw failure('The original Notebook metadata transfer cannot be confirmed.')
  }
  for (const file of operation.files) if (!file || Object.keys(file).some(key => !['source', 'destination', 'hash', 'preparedSource', 'targetHash', 'backup'].includes(key)) || !isAbsolute(file.source) || !isAbsolute(file.destination) || !/^[a-f0-9]{64}$/.test(file.hash) || file.preparedSource !== undefined && !isAbsolute(file.preparedSource) || file.targetHash !== undefined && !/^[a-f0-9]{64}$/.test(file.targetHash) || file.backup !== undefined && !isAbsolute(file.backup) || operation.kind === 'convert' && (!file.preparedSource || !file.targetHash || !file.backup || file.destination === file.source || file.backup === file.source || file.backup === file.destination)) throw failure('A stored Note transfer identity cannot be confirmed.')
  for (const change of operation.resourceChanges) {
    if (!change || Object.keys(change).some(key => !['noteId', 'from', 'to', 'conversion'].includes(key))) throw failure('A stored Note resource change cannot be confirmed.')
    for (const resource of [change.from, change.to]) if (typeof change.noteId !== 'string' || !resource || !['hostId', 'workspaceId', 'workspacePath', 'path'].every(key => typeof resource[key as keyof NoteResource] === 'string') || !isAbsolute(resource.workspacePath) || resource.path.startsWith('/') || resource.path.split(/[\\/]/).includes('..')) throw failure('A stored Note resource change cannot be confirmed.')
    if (change.conversion) {
      const file = operation.files.find(file => file.source === resolve(change.from.workspacePath, change.from.path) && file.destination === resolve(change.to.workspacePath, change.to.path))
      if (Object.keys(change.conversion).some(key => !['sourceRevision', 'targetRevision'].includes(key)) || !/^sha256:[a-f0-9]{64}$/.test(change.conversion.sourceRevision) || !/^sha256:[a-f0-9]{64}$/.test(change.conversion.targetRevision) || !file || change.conversion.sourceRevision !== 'sha256:' + file.hash || change.conversion.targetRevision !== 'sha256:' + targetHash(file)) throw failure('A converted original body revision cannot be confirmed.')
    }
  }
  return operation
}
/** One host-local directory authority, independent of Electron and client projections. */
export class AgentMuxNotesStorage {
  constructor(readonly locatorPath = join(defaultAgentMuxStateDirectory(), 'notes-location.json'), readonly initialDirectory = defaultNotesDirectory(), private readonly ports: { beforeSourceCleanup?(changes: NotesResourceChange[]): Promise<void> } = {}) {}
  private async location(): Promise<Location> {
    try { const value = JSON.parse(await readFile(this.locatorPath, 'utf8')) as Location
      if (value.schemaVersion !== 1 || !isAbsolute(value.directory) || !value.operations || !Object.hasOwn(value, 'pending')) throw failure('The original Notes location cannot be confirmed.')
      for (const [id, operation] of Object.entries(value.operations)) if (parseNotesStorageOperation(operation).operationId !== id) throw failure('The saved directory operation identity is ambiguous.')
      if (value.conversionIssues !== undefined) try {
        if (!Array.isArray(value.conversionIssues)) throw new Error('The last conversion observation is not a list.')
        value.conversionIssues.forEach(parseNotesConversionIssue)
      } catch {
        value.conversionIssues = [{ noteId: null, resource: null, code: 'CONVERSION_OBSERVATION_UNCONFIRMED', message: 'The last conversion observation cannot be read. Original Notes and directory operations remain available; retry conversion to observe these same sources again.' }]
      }
      if (value.pending && !Object.hasOwn(value.operations, value.pending)) throw failure('The original pending directory operation is missing.')
      return value
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, directory: resolve(this.initialDirectory), operations: {}, pending: null }; throw error }
  }
  async hasLocation(): Promise<boolean> { try { await readFile(this.locatorPath); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
  async catalogEstablished(): Promise<boolean> { const location = await this.location(); return !!location.catalogEstablished || Object.keys(location.operations).length > 0 }
  async databaseEstablished(): Promise<boolean> { const location = await this.location(); return location.catalogFormat === 'sqlite' || Object.values(location.operations).some(operation => !!operation.database) }
  async confirmCatalog(): Promise<void> { const location = await this.location(); if (!location.catalogEstablished || location.catalogFormat !== 'sqlite') await this.persist({ ...location, catalogEstablished: true, catalogFormat: 'sqlite' }) }
  async inspect(operationId?: string): Promise<NotesStorageSnapshot> { const location = await this.location(); return { directory: location.directory, catalogPath: location.pending && location.operations[location.pending]!.phase === 'prepared' ? location.operations[location.pending]!.sourceCatalog : join(location.directory, NOTEBOOK_DATABASE_NAME), resourceChanges: Object.values(location.operations).filter(o => o.phase === 'committed').flatMap(o => o.resourceChanges), directoryChanges: Object.values(location.operations).filter(o => o.phase === 'committed' && o.expectedDirectory !== o.directory).map(o => ({ from: o.expectedDirectory, to: o.directory })), operation: operationId ? Object.hasOwn(location.operations, operationId) ? location.operations[operationId]! : null : location.pending ? location.operations[location.pending] ?? null : null, ...location.conversionIssues?.length ? { conversionIssues: structuredClone(location.conversionIssues) } : {} } }
  async withLock<T>(work: () => Promise<T>): Promise<T> {
    return this.lock(this.locatorPath, work)
  }
  private async lock<T>(path: string, work: () => Promise<T>): Promise<T> {
    return withNotesStorageFileLock(path, work)
  }
  private persist(value: Location) { return durableWriteFile(this.locatorPath, JSON.stringify(value) + '\n', { requireDirectorySync: true }) }
  private async originalDatabase(path: string, required: boolean, legacyPath?: string) {
    if (await this.databaseEstablished() && !await readNotebookDatabase(path, false)) throw failure('The confirmed original SQLite directory is missing.', 'NOTEBOOK_READ_UNCONFIRMED')
    return initializeNotebookDatabase(path, legacyPath ?? join(dirname(path), 'notebooks.json'), required)
  }
  private databaseLock<T>(path: string, work: () => Promise<T>) {
    const legacy = path.endsWith('.sqlite') ? path.slice(0, -7) + '.json' : join(dirname(path), 'notebooks.json')
    return this.lock(legacy, () => this.lock(path, work))
  }
  /** Import directory metadata before the explicit body converter; no resource is moved here. */
  async importLegacyCatalog(legacyPath: string): Promise<NotesStorageSnapshot> {
    if (!isAbsolute(legacyPath) || !legacyPath.endsWith('.json')) throw failure('The original legacy catalog path is required.', 'NOTES_STORAGE_INPUT_INVALID')
    await this.withLock(async () => {
      if (await this.hasLocation()) return
      try { await readFile(legacyPath) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
      const path = databasePath(legacyPath)
      await this.lock(legacyPath, () => this.lock(path, () => initializeNotebookDatabase(path, legacyPath, true)))
      await this.persist({ schemaVersion: 1, directory: dirname(legacyPath), operations: {}, pending: null, catalogEstablished: true, catalogFormat: 'sqlite' })
    })
    return this.inspect()
  }
  /** Bootstrap is explicit old-directory adoption; normal moves read only managed Markdown. */
  async change(input: NotesStorageChange, adoption?: { catalogPath: string; workspace: { id: string; hostId: string; path: string }; destinationWorkspaceId: string }): Promise<NotesStorageSnapshot> {
    return this.withLock(async () => {
      if (!input.operationId?.trim() || !isAbsolute(input.directory) || !isAbsolute(input.expectedDirectory)) throw failure('Choose an absolute Notes directory and the original operation identity.', 'NOTES_STORAGE_INPUT_INVALID')
      let location = await this.location(); const existing = Object.hasOwn(location.operations, input.operationId) ? location.operations[input.operationId] : undefined
      if (existing) { if (existing.kind || existing.directory !== resolve(input.directory) || existing.expectedDirectory !== resolve(input.expectedDirectory)) throw failure('This operation identity belongs to a different directory change.', 'NOTES_STORAGE_INPUT_INVALID'); return this.retry(location, existing) }
      if (location.pending) throw failure('Another Notes directory change needs recovery first.', 'NOTEBOOK_BUSY')
      if (location.directory !== resolve(input.expectedDirectory)) throw failure('The Notes directory changed after this setting was opened.', 'CONFIG_CONFLICT')
      const destination = resolve(input.directory), sourceRoot = location.directory
      if (!adoption && destination === sourceRoot) return this.inspect()
      if (destination !== sourceRoot && (nested(sourceRoot, destination) || nested(destination, sourceRoot))) throw failure('The new Notes directory must be outside the old directory.', 'NOTES_STORAGE_INPUT_INVALID')
      await mkdir(destination, { recursive: true, mode: 0o700 })
      if ((await lstat(destination)).isSymbolicLink()) throw failure('Choose the actual Notes directory rather than a symbolic link.', 'NOTES_STORAGE_INPUT_INVALID')
      const sourceCatalog = databasePath(adoption?.catalogPath ?? join(sourceRoot, NOTEBOOK_DATABASE_NAME))
      return this.databaseLock(sourceCatalog, async () => {
        await this.originalDatabase(sourceCatalog, !!location.catalogEstablished || Object.keys(location.operations).length > 0, adoption?.catalogPath.endsWith('.json') ? adoption.catalogPath : undefined)
        const original = (await readNotebookDatabase(sourceCatalog))!
        let catalog = original.state
        if (join(destination, NOTEBOOK_DATABASE_NAME) !== sourceCatalog && await readNotebookDatabase(join(destination, NOTEBOOK_DATABASE_NAME))) throw failure('The target already contains a Notebook directory.', 'NOTES_STORAGE_CONFLICT')
        const resourceChanges: NotesResourceChange[] = [], files: NotesStorageTransfer[] = []
        // Explicit adoption consumes only the original converter's latest exact observation.
        // Ordinary directory changes must still confirm every managed source.
        const deferred = new Set(adoption ? (location.conversionIssues ?? []).flatMap(issue => issue.resource ? [noteProvenanceResourceKey(issue.resource)] : []) : [])
        for (const page of Object.values(catalog.pages)) {
          const r = page.resource
          const owned = adoption ? r.hostId === adoption.workspace.hostId && r.workspaceId === adoption.workspace.id && r.workspacePath === adoption.workspace.path && !r.path.includes('/') : r.hostId === 'local' && r.workspacePath === sourceRoot
          if (!owned || deferred.has(noteProvenanceResourceKey(r))) continue
          const source = resolve(r.workspacePath, r.path), destinationFile = resolve(destination, r.path)
          await this.confirmOriginal(source, r.workspacePath)
          if (!nested(destination, destinationFile)) throw failure('A Note resource escaped its original directory.', 'NOTES_STORAGE_INPUT_INVALID')
          const bytes = await readFile(source), document = readNoteMarkdownHeader(bytes.toString('utf8'))
          if (document.status !== 'valid' || document.noteId !== page.noteId) throw failure('The original Note Markdown identity does not match its file. Convert legacy bodies explicitly before moving.')
          files.push({ source, destination: destinationFile, hash: digest(bytes) })
          const to = { ...r, workspacePath: destination, ...(adoption ? { workspaceId: adoption.destinationWorkspaceId } : {}) }
          resourceChanges.push({ noteId: page.noteId, from: r, to })
          catalog = this.relocate(catalog, resourceChanges.at(-1)!, input.operationId)
        }
        if (!adoption) {
          const registeredFiles = new Set(files.map(file => file.source)), noteIds = new Set(Object.keys(catalog.pages))
          const collect = async (directory: string) => {
            for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT' && directory === sourceRoot) return []; throw error })) {
              const source = join(directory, entry.name)
              if (entry.isDirectory()) { await collect(source); continue }
              if (entry.name.endsWith('.note.json')) throw failure('An original legacy Note still needs explicit Markdown conversion before this directory can move.', 'NOTES_STORAGE_CONVERSION_REQUIRED')
              if (!entry.name.endsWith(NOTE_FILE_EXTENSION) || registeredFiles.has(source)) continue
              if (!entry.isFile()) throw failure('A managed Note is not an ordinary file. Confirm its original owner before moving.', 'NOTES_STORAGE_INPUT_INVALID')
              const bytes = await readFile(source), document = readNoteMarkdownHeader(bytes.toString('utf8'))
              if (document.status !== 'valid' || noteIds.has(document.noteId)) throw failure('A managed Note identity or format could not be confirmed.')
              noteIds.add(document.noteId)
              const path = relative(sourceRoot, source), from = { hostId: 'local', workspaceId: NOTES_RESOURCE_WORKSPACE_ID, workspacePath: sourceRoot, path }, to = { ...from, workspacePath: destination }
              files.push({ source, destination: join(destination, path), hash: digest(bytes) }); resourceChanges.push({ noteId: document.noteId, from, to })
            }
          }
          await collect(sourceRoot)
        }
        const provenance = this.relocateProvenance(original.provenance, resourceChanges)
        const operation: NotesStorageOperation = { ...input, directory: destination, expectedDirectory: sourceRoot, phase: 'prepared', resourceChanges, files, catalog, sourceCatalog, sourceCatalogHash: notebookDatabaseFingerprint(original), database: await this.exportMetadata({ incarnation: original.incarnation, state: catalog, provenance }) }
        location = { ...location, pending: input.operationId, operations: { ...location.operations, [input.operationId]: operation } }; await this.persist(location); await this.finish(location, operation, true); return this.inspect(input.operationId)
      })
    })
  }
  /** Explicit one-time conversion shares the same journal, locks and host acknowledgement. */
  async convert(input: { operationId: string; expectedDirectory: string }, prepare: (snapshot: NotebookDatabaseSnapshot) => Promise<NotesStorageConversion>): Promise<NotesStorageSnapshot> {
    return this.withLock(async () => {
      if (!input.operationId?.trim() || !isAbsolute(input.expectedDirectory)) throw failure('The original conversion identity and Notes directory are required.', 'NOTES_STORAGE_INPUT_INVALID')
      let location = await this.location(); const existing = Object.hasOwn(location.operations, input.operationId) ? location.operations[input.operationId] : undefined
      if (existing) { if (existing.kind !== 'convert' || existing.expectedDirectory !== resolve(input.expectedDirectory)) throw failure('This operation identity belongs to another original operation.', 'NOTES_STORAGE_INPUT_INVALID'); return this.retry(location, existing) }
      if (location.pending) throw failure('The original Notes directory operation needs recovery before conversion.', 'NOTEBOOK_BUSY')
      if (location.directory !== resolve(input.expectedDirectory)) throw failure('The original Notes directory changed before conversion.', 'CONFIG_CONFLICT')
      const sourceCatalog = join(location.directory, NOTEBOOK_DATABASE_NAME)
      return this.databaseLock(sourceCatalog, async () => {
        await this.originalDatabase(sourceCatalog, !!location.catalogEstablished || Object.keys(location.operations).length > 0)
        const original = (await readNotebookDatabase(sourceCatalog))!, prepared = await prepare(structuredClone(original))
        location.conversionIssues = (prepared.issues ?? []).map(parseNotesConversionIssue)
        let catalog = original.state
        if (!prepared.files.length && !prepared.resourceChanges.length && !prepared.provenance.length) { await this.persist(location); return this.inspect() }
        if (prepared.files.length !== prepared.resourceChanges.length) throw failure('Each converted original needs one exact resource receipt.', 'NOTES_STORAGE_INPUT_INVALID')
        const sources = new Set<string>(), destinations = new Set<string>(), noteIds = new Set<string>()
        for (const change of prepared.resourceChanges) {
          const file = prepared.files.find(file => file.source === resolve(change.from.workspacePath, change.from.path) && file.destination === resolve(change.to.workspacePath, change.to.path))
          if (!file || noteIds.has(change.noteId) || sources.has(file.source) || destinations.has(file.destination) || change.from.hostId !== 'local' || change.to.hostId !== change.from.hostId || change.to.workspaceId !== change.from.workspaceId || change.to.workspacePath !== change.from.workspacePath || !change.to.path.endsWith(NOTE_FILE_EXTENSION)) throw failure('A converted Note resource is not the exact original.', 'NOTES_STORAGE_INPUT_INVALID')
          noteIds.add(change.noteId); sources.add(file.source); destinations.add(file.destination)
          await this.confirmOriginal(file.source, change.from.workspacePath)
          if (!nested(change.to.workspacePath, file.destination)) throw failure('A converted Note escaped its original workspace.', 'NOTES_STORAGE_INPUT_INVALID')
          const raw = await readFile(file.source), body = await readFile(file.preparedSource!), header = readNoteMarkdownHeader(body.toString('utf8'))
          if (digest(raw) !== file.hash || digest(body) !== file.targetHash || header.status !== 'valid' || header.noteId !== change.noteId) throw failure('The original or staged converted Note changed.', 'NOTES_STORAGE_CONFLICT')
          if (catalog.pages[change.noteId]) catalog = this.relocate(catalog, change, input.operationId)
          else if (Object.values(catalog.pages).some(page => noteProvenanceResourceKey(page.resource) === noteProvenanceResourceKey(change.from))) throw failure('This source resource belongs to a different original Note.', 'NOTES_STORAGE_CONFLICT')
        }
        const provenance = this.relocateProvenance(original.provenance, prepared.resourceChanges)
        for (const candidate of prepared.provenance) {
          const value = parseNoteProvenanceWrite(candidate), change = prepared.resourceChanges.find(change => change.noteId === value.noteId && noteProvenanceResourceKey(change.to) === noteProvenanceResourceKey(value.resource)), file = change && prepared.files.find(file => file.destination === resolve(change.to.workspacePath, change.to.path))
          if (!file || value.revision !== 'sha256:' + file.targetHash) throw failure('Converted attribution does not describe the exact staged body.', 'NOTES_STORAGE_INPUT_INVALID')
          const existing = provenance.find(row => row.noteId === value.noteId && noteProvenanceResourceKey(row.resource) === noteProvenanceResourceKey(value.resource) && row.revision === value.revision)
          if (existing && notebookFingerprint(existing) !== notebookFingerprint(value)) throw failure('Converted attribution conflicts with original trusted metadata.', 'NOTES_STORAGE_CONFLICT')
          if (!existing) provenance.push(value)
        }
        const operation: NotesStorageOperation = { operationId: input.operationId, expectedDirectory: location.directory, directory: location.directory, kind: 'convert', phase: 'prepared', resourceChanges: prepared.resourceChanges, files: prepared.files, catalog, sourceCatalog, sourceCatalogHash: notebookDatabaseFingerprint(original), database: await this.exportMetadata({ incarnation: original.incarnation, state: catalog, provenance }) }
        parseNotesStorageOperation(operation)
        location = { ...location, pending: input.operationId, operations: { ...location.operations, [input.operationId]: operation } }; await this.persist(location); await this.finish(location, operation, true); return this.inspect(input.operationId)
      })
    })
  }
  /** One-time recovery of the prior JSON journal, without enabling JSON in normal moves. */
  async recoverLegacyOperation(operationId: string, prepare: (original: NotesStorageOperation, snapshot: NotebookDatabaseSnapshot) => Promise<NotesStorageConversion>): Promise<NotesStorageSnapshot> {
    return this.withLock(async () => {
      const location = await this.location(), originalOperation = Object.hasOwn(location.operations, operationId) ? location.operations[operationId] : undefined
      if (!originalOperation || location.pending !== operationId) throw failure('The exact original pending Notes operation is required.', 'NOTES_STORAGE_INPUT_INVALID')
      if (originalOperation.database) return this.retry(location, originalOperation)
      const legacyPath = originalOperation.phase === 'prepared' ? originalOperation.sourceCatalog : join(originalOperation.directory, 'notebooks.json')
      return this.lock(originalOperation.sourceCatalog, async () => {
        const bytes = await readFile(legacyPath), expectedHash = originalOperation.phase === 'prepared' ? originalOperation.sourceCatalogHash : digest(Buffer.from(JSON.stringify(originalOperation.catalog) + '\n'))
        if (digest(bytes) !== expectedHash) throw failure('The original pending JSON directory changed before explicit recovery.', 'NOTES_STORAGE_CONFLICT')
        const sourceCatalog = databasePath(legacyPath)
        return this.lock(sourceCatalog, async () => {
          const state = parseNotebookState(JSON.parse(bytes.toString('utf8')))
          await initializeNotebookDatabase(sourceCatalog, legacyPath, true)
          const original = (await readNotebookDatabase(sourceCatalog))!
          if (notebookFingerprint(original.state) !== notebookFingerprint(state)) throw failure('The imported original directory changed before recovery.', 'NOTES_STORAGE_CONFLICT')
          for (const file of originalOperation.files) {
            const raw = await readFile(file.source).catch(error => { if (error.code !== 'ENOENT' || originalOperation.phase === 'prepared') throw error; return null })
            if (raw && digest(raw) !== file.hash) throw failure('An original Note changed before explicit pending-operation recovery.', 'NOTES_STORAGE_CONFLICT')
          }
          const prepared = await prepare(structuredClone(originalOperation), structuredClone(original))
          let catalog = originalOperation.catalog
          for (const change of prepared.resourceChanges) {
            const page = catalog.pages[change.noteId]
            const originalMove = originalOperation.resourceChanges.find(old => old.noteId === change.noteId && noteProvenanceResourceKey(old.from) === noteProvenanceResourceKey(change.from) && page && noteProvenanceResourceKey(old.to) === noteProvenanceResourceKey(page.resource))
            if (page && (noteProvenanceResourceKey(page.resource) === noteProvenanceResourceKey(change.from) || originalMove)) catalog = this.relocate(catalog, { ...change, from: page.resource }, operationId + ':markdown')
          }
          for (const page of Object.values(catalog.pages)) if (originalOperation.resourceChanges.some(change => change.noteId === page.noteId) && !page.resource.path.endsWith(NOTE_FILE_EXTENSION)) throw failure('The recovered original Note has no exact Markdown resource.', 'NOTES_STORAGE_CONFLICT')
          const provenance = this.relocateProvenance(original.provenance, prepared.resourceChanges)
          for (const candidate of prepared.provenance) {
            const value = parseNoteProvenanceWrite(candidate), change = prepared.resourceChanges.find(change => change.noteId === value.noteId && noteProvenanceResourceKey(change.to) === noteProvenanceResourceKey(value.resource)), file = change && prepared.files.find(file => file.destination === resolve(change.to.workspacePath, change.to.path))
            if (!file || value.revision !== 'sha256:' + file.targetHash) throw failure('The recovered attribution does not describe its exact staged body.', 'NOTES_STORAGE_INPUT_INVALID')
            const old = provenance.find(row => row.noteId === value.noteId && row.revision === value.revision && noteProvenanceResourceKey(row.resource) === noteProvenanceResourceKey(value.resource))
            if (old && notebookFingerprint(old) !== notebookFingerprint(value)) throw failure('Recovered attribution conflicts with the original trusted authors.', 'NOTES_STORAGE_CONFLICT')
            if (!old) provenance.push(value)
          }
          const operation: NotesStorageOperation = { ...originalOperation, kind: 'convert', phase: 'prepared', files: prepared.files, resourceChanges: prepared.resourceChanges, catalog, sourceCatalog, sourceCatalogHash: notebookDatabaseFingerprint(original), database: await this.exportMetadata({ incarnation: original.incarnation, state: catalog, provenance }) }
          parseNotesStorageOperation(operation)
          location.pending = operationId; location.operations[operationId] = operation
          await this.persist(location); await this.finish(location, operation, true); return this.inspect(operationId)
        })
      })
    })
  }
  private async exportMetadata(value: NotebookDatabaseSnapshot): Promise<NonNullable<NotesStorageOperation['database']>> {
    const bytes = Buffer.from(JSON.stringify(value) + '\n'), snapshotPath = join(this.locatorPath + '.operations', randomUUID() + '.metadata.json')
    await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 })
    await durableWriteFile(snapshotPath, bytes, { mode: 0o600, requireDirectorySync: true })
    return { incarnation: value.incarnation, snapshotPath, snapshotHash: digest(bytes) }
  }
  private relocate(catalog: NotebookState, change: NotesResourceChange, operationId: string) {
    return applyNotebookChange(catalog, { expectedRevision: catalog.revision, operationId: operationId + ':' + change.noteId, change: { kind: 'relocate', noteId: change.noteId, from: change.from, resource: change.to } }, { kind: 'user', id: 'notes-directory-owner' }, Date.now())
  }
  private relocateProvenance(rows: NoteProvenanceWrite[], changes: NotesResourceChange[]) {
    return rows.map(row => { const change = changes.find(change => change.noteId === row.noteId && noteProvenanceResourceKey(change.from) === noteProvenanceResourceKey(row.resource)); return { ...row, resource: change?.to ?? row.resource } })
  }
  private async confirmOriginal(source: string, workspacePath: string) {
    if (!nested(workspacePath, source) || !(await lstat(source)).isFile() || !nested(await realpath(workspacePath), await realpath(source))) throw failure('The original Note file cannot be confirmed.')
  }
  private async retry(location: Location, operation: NotesStorageOperation) {
    if (operation.phase === 'prepared') await this.finish(location, operation)
    else { await this.cleanup(operation); if (location.pending === operation.operationId) { location.pending = null; await this.persist(location) } }
    return this.inspect(operation.operationId)
  }
  /** Atomic create: an external file appearing at the destination is never replaced. */
  private async createFile(path: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = path + '.' + randomUUID() + '.notes-transfer'
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      try { await link(temporary, path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (!(await lstat(path)).isFile() || digest(await readFile(path)) !== digest(bytes)) throw failure('The destination contains a different file.', 'NOTES_STORAGE_CONFLICT') }
      const directory = await open(dirname(path), 'r'); try { await directory.sync() } finally { await directory.close() }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  private async finish(location: Location, operation: NotesStorageOperation, locked = false): Promise<void> {
    if (!locked) return this.databaseLock(operation.sourceCatalog, () => this.finish(location, operation, true))
    const targetCatalog = join(operation.directory, NOTEBOOK_DATABASE_NAME), prepared = await operationDatabase(operation), preparedHash = notebookDatabaseFingerprint(prepared)
    const original = await readNotebookDatabase(operation.sourceCatalog)
    if (!original || notebookDatabaseFingerprint(original) !== operation.sourceCatalogHash && !(targetCatalog === operation.sourceCatalog && notebookDatabaseFingerprint(original) === preparedHash)) throw failure('The original Notebook catalog changed after this operation was prepared.', 'NOTES_STORAGE_CONFLICT')
    if (targetCatalog !== operation.sourceCatalog) {
      const existing = await readNotebookDatabase(targetCatalog)
      if (existing && notebookDatabaseFingerprint(existing) !== preparedHash) throw failure('The destination Notebook catalog changed after this operation was prepared.', 'NOTES_STORAGE_CONFLICT')
    }
    for (const file of operation.files) {
      const bytes = await readFile(file.source)
      if (digest(bytes) !== file.hash) throw failure('A Note changed while its directory operation was prepared.', 'NOTES_STORAGE_CONFLICT')
      if (file.backup) await this.createFile(file.backup, bytes)
      const targetBytes = file.preparedSource ? await readFile(file.preparedSource) : bytes
      if (digest(targetBytes) !== targetHash(file)) throw failure('The staged converted Markdown changed before publication.', 'NOTES_STORAGE_CONFLICT')
      if (operation.kind === 'convert') {
        const change = operation.resourceChanges.find(change => resolve(change.from.workspacePath, change.from.path) === file.source && resolve(change.to.workspacePath, change.to.path) === file.destination), header = readNoteMarkdownHeader(targetBytes.toString('utf8'))
        if (!change || header.status !== 'valid' || header.noteId !== change.noteId) throw failure('The converted Markdown does not confirm this original Note identity.', 'NOTES_STORAGE_CONFLICT')
      }
      await mkdir(dirname(file.destination), { recursive: true, mode: 0o700 })
      const root = operation.kind === 'convert' ? operation.resourceChanges.find(change => resolve(change.to.workspacePath, change.to.path) === file.destination)!.to.workspacePath : operation.directory
      const targetRoot = await realpath(root), parent = await realpath(dirname(file.destination)), parentRelative = relative(targetRoot, parent)
      if (parentRelative.startsWith('..') || isAbsolute(parentRelative)) throw failure('The target file escaped its Notes directory.', 'NOTES_STORAGE_INPUT_INVALID')
      if (file.destination !== file.source) await this.createFile(file.destination, targetBytes)
      if (!(await lstat(file.destination)).isFile() || digest(await readFile(file.destination)) !== targetHash(file)) throw failure('The target already contains a different Note file.', 'NOTES_STORAGE_CONFLICT')
    }
    if (targetCatalog === operation.sourceCatalog) await replaceNotebookDatabase(targetCatalog, prepared)
    else await publishNotebookDatabase(targetCatalog, prepared)
    operation.phase = 'committed'; location.directory = operation.directory; location.catalogEstablished = true; location.catalogFormat = 'sqlite'; location.pending = operation.operationId; await this.persist(location)
    await this.cleanup(operation, true)
    location.pending = null; await this.persist(location)
  }
  private async cleanup(operation: NotesStorageOperation, locked = false): Promise<void> {
    if (!locked) return this.databaseLock(operation.sourceCatalog, () => this.cleanup(operation, true))
    const pending: NotesStorageTransfer[] = []
    for (const file of operation.files) if (file.source !== file.destination) {
      const original = await readFile(file.source).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
      if (original && digest(original) !== file.hash) throw failure('An original Note changed before its copies were acknowledged.')
      if (original) pending.push(file)
    }
    const targetCatalog = join(operation.directory, NOTEBOOK_DATABASE_NAME)
    let originalCatalog: NotebookDatabaseSnapshot | null = null
    if (operation.sourceCatalog !== targetCatalog) {
      try { originalCatalog = await readNotebookDatabase(operation.sourceCatalog) } catch (error) {
        try { await lstat(operation.sourceCatalog); throw error } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      }
    }
    if (originalCatalog && notebookDatabaseFingerprint(originalCatalog) !== operation.sourceCatalogHash) throw failure('The original Notebook catalog changed before its copies were acknowledged.')
    const confirmDestination = async () => {
      if (!pending.length && !originalCatalog) return
      const destination = await readNotebookDatabase(targetCatalog)
      if (!destination) throw failure('The destination Notebook catalog is unavailable.')
      for (const file of pending) {
        if (!(await lstat(file.destination)).isFile() || digest(await readFile(file.destination)) !== targetHash(file)) throw failure('A destination Note is unavailable or changed; the last original copy is retained.')
        if (file.backup && (!(await lstat(file.backup)).isFile() || digest(await readFile(file.backup)) !== file.hash)) throw failure('The original JSON backup is unavailable; its original is retained.')
      }
      for (const change of operation.resourceChanges) if (operation.catalog.pages[change.noteId]) {
        const current = destination.state.pages[change.noteId]?.resource
        if (!current || noteProvenanceResourceKey(current) !== noteProvenanceResourceKey(change.to)) throw failure('The destination Notebook no longer confirms this original Note resource.')
      }
      for (const expected of (await operationDatabase(operation)).provenance) {
        const actual = destination.provenance.find(row => row.noteId === expected.noteId && row.revision === expected.revision && noteProvenanceResourceKey(row.resource) === noteProvenanceResourceKey(expected.resource))
        if (!actual || notebookFingerprint(actual) !== notebookFingerprint(expected)) throw failure('The destination no longer confirms the original trusted attribution.')
      }
    }
    await confirmDestination()
    await this.ports.beforeSourceCleanup?.(operation.resourceChanges)
    await confirmDestination()
    for (const file of pending) if (digest(await readFile(file.source)) !== file.hash) throw failure('An original Note changed during the host acknowledgement.')
    if (originalCatalog && notebookDatabaseFingerprint((await readNotebookDatabase(operation.sourceCatalog))!) !== operation.sourceCatalogHash) throw failure('The original Notebook catalog changed during the host acknowledgement.')
    // All destination bytes, metadata, backups and host references are confirmed before deleting any source.
    for (const file of pending) if (digest(await readFile(file.source)) === file.hash) await unlink(file.source)
    if (originalCatalog) { await unlink(operation.sourceCatalog); await unlink(operation.sourceCatalog + '.sqlite-identity').catch(error => { if (error.code !== 'ENOENT') throw error }) }
    for (const file of operation.files) if (file.preparedSource) await unlink(file.preparedSource).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (operation.database) await unlink(operation.database.snapshotPath).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  async bootstrap(legacy: { catalogPath: string; workspace: { id: string; hostId: string; path: string }; destinationWorkspaceId: string }): Promise<NotesStorageSnapshot> {
    return this.withLock(async () => {
      if (!await this.hasLocation()) {
        try {
          await readFile(legacy.catalogPath)
          await this.persist({ schemaVersion: 1, directory: dirname(legacy.catalogPath), operations: {}, pending: null })
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      }
      // A prior batch keeps its original operation identity; only newly observed sources
      // may start a new batch after that pending operation has settled.
      await this.resume()
      const current = await this.inspect()
      if (current.directory !== dirname(legacy.catalogPath)) {
        const catalog = (await readNotebookDatabase(current.catalogPath, false))?.state
        const deferred = new Set((current.conversionIssues ?? []).flatMap(issue => issue.resource ? [noteProvenanceResourceKey(issue.resource)] : []))
        if (!catalog || !Object.values(catalog.pages).some(p => p.resource.hostId === legacy.workspace.hostId && p.resource.workspaceId === legacy.workspace.id && p.resource.workspacePath === legacy.workspace.path && !p.resource.path.includes('/') && !deferred.has(noteProvenanceResourceKey(p.resource)))) return this.inspect()
        return this.change({ operationId: 'adopt-original-note-resources:' + randomUUID(), expectedDirectory: current.directory, directory: current.directory }, { ...legacy, catalogPath: current.catalogPath })
      }
      return this.change({ operationId: 'adopt-original-notes-directory:' + randomUUID(), expectedDirectory: current.directory, directory: this.initialDirectory }, legacy)
    })
  }
  async resume(): Promise<void> { await this.withLock(async () => { const location = await this.location(); if (location.pending) await this.retry(location, location.operations[location.pending]!) }) }
}
