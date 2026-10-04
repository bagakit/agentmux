import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, open, readFile, realpath, lstat, unlink, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { durableWriteFile } from './durable-write.js'
import { defaultAgentMuxStateDirectory } from './runtime-paths.js'
import { AgentMuxError } from './errors.js'
import { applyNotebookChange, emptyNotebookState, parseNotebookState, type NoteResource, type NotebookState } from './notebook-catalog.js'
export type NotesResourceChange = { noteId: string; from: NoteResource; to: NoteResource }
export type NotesStorageChange = { operationId: string; expectedDirectory: string; directory: string }
export type NotesStorageOperation = NotesStorageChange & { phase: 'prepared' | 'committed'; resourceChanges: NotesResourceChange[]; files: { source: string; destination: string; hash: string }[]; catalog: NotebookState; sourceCatalog: string; sourceCatalogHash: string }
export type NotesStorageSnapshot = { directory: string; catalogPath: string; resourceChanges: NotesResourceChange[]; directoryChanges: { from: string; to: string }[]; operation: NotesStorageOperation | null }
export type NotesStorageApi = { inspect(operationId?: string): Promise<NotesStorageSnapshot>; change(input: NotesStorageChange): Promise<NotesStorageSnapshot>; onChange(listener: (snapshot: NotesStorageSnapshot) => void): () => void }
type Location = { schemaVersion: 1; directory: string; operations: Record<string, NotesStorageOperation>; pending: string | null; catalogEstablished?: true }
const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
export const NOTES_RESOURCE_WORKSPACE_ID = '__notes__'
export const defaultNotesDirectory = () => join(homedir(), '.agentmux', 'notes')
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const failure = (message: string, code = 'NOTES_STORAGE_UNCONFIRMED') => new AgentMuxError(message + ' Original notes, references and work surfaces are retained.', code)
export function parseNotesStorageOperation(value: unknown): NotesStorageOperation {
  const operation = value as NotesStorageOperation
  if (!operation || typeof operation !== 'object' || Object.keys(operation).some(key => !['operationId', 'expectedDirectory', 'directory', 'phase', 'resourceChanges', 'files', 'catalog', 'sourceCatalog', 'sourceCatalogHash'].includes(key)) || typeof operation.operationId !== 'string' || !operation.operationId.trim() || !isAbsolute(operation.directory) || !isAbsolute(operation.expectedDirectory) || !isAbsolute(operation.sourceCatalog) || !['prepared', 'committed'].includes(operation.phase) || !/^[a-f0-9]{64}$/.test(operation.sourceCatalogHash) || !Array.isArray(operation.files) || !Array.isArray(operation.resourceChanges)) throw failure('The original directory operation cannot be confirmed.')
  parseNotebookState(operation.catalog)
  for (const file of operation.files) if (!file || !isAbsolute(file.source) || !isAbsolute(file.destination) || !/^[a-f0-9]{64}$/.test(file.hash)) throw failure('A stored Note transfer identity cannot be confirmed.')
  for (const change of operation.resourceChanges) for (const resource of [change.from, change.to]) if (typeof change.noteId !== 'string' || !resource || !['hostId', 'workspaceId', 'workspacePath', 'path'].every(key => typeof resource[key as keyof NoteResource] === 'string') || !isAbsolute(resource.workspacePath) || resource.path.startsWith('/') || resource.path.split(/[\\/]/).includes('..')) throw failure('A stored Note resource change cannot be confirmed.')
  return operation
}
/** One host-local directory authority, independent of Electron and client projections. */
export class AgentMuxNotesStorage {
  constructor(readonly locatorPath = join(defaultAgentMuxStateDirectory(), 'notes-location.json'), readonly initialDirectory = defaultNotesDirectory(), private readonly ports: { beforeSourceCleanup?(changes: NotesResourceChange[]): Promise<void> } = {}) {}
  private async location(): Promise<Location> {
    try { const value = JSON.parse(await readFile(this.locatorPath, 'utf8')) as Location
      if (value.schemaVersion !== 1 || !isAbsolute(value.directory) || !value.operations || !Object.hasOwn(value, 'pending')) throw failure('The original Notes location cannot be confirmed.')
      for (const [id, operation] of Object.entries(value.operations)) if (parseNotesStorageOperation(operation).operationId !== id) throw failure('The saved directory operation identity is ambiguous.')
      if (value.pending && !Object.hasOwn(value.operations, value.pending)) throw failure('The original pending directory operation is missing.')
      return value
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, directory: resolve(this.initialDirectory), operations: {}, pending: null }; throw error }
  }
  async hasLocation(): Promise<boolean> { try { await readFile(this.locatorPath); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
  async catalogEstablished(): Promise<boolean> { const location = await this.location(); return !!location.catalogEstablished || Object.keys(location.operations).length > 0 }
  async confirmCatalog(): Promise<void> { const location = await this.location(); if (!location.catalogEstablished) await this.persist({ ...location, catalogEstablished: true }) }
  async inspect(operationId?: string): Promise<NotesStorageSnapshot> { const location = await this.location(); return { directory: location.directory, catalogPath: location.pending ? location.operations[location.pending]!.sourceCatalog : join(location.directory, 'notebooks.json'), resourceChanges: Object.values(location.operations).filter(o => o.phase === 'committed').flatMap(o => o.resourceChanges), directoryChanges: Object.values(location.operations).filter(o => o.phase === 'committed' && o.expectedDirectory !== o.directory).map(o => ({ from: o.expectedDirectory, to: o.directory })), operation: operationId ? Object.hasOwn(location.operations, operationId) ? location.operations[operationId]! : null : location.pending ? location.operations[location.pending] ?? null : null } }
  async withLock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.locatorPath), { recursive: true, mode: 0o700 }); const lock = await open(this.locatorPath + '.lock', 'a+', 0o600)
    try { const deadline = Date.now() + 5000; while (!native.tryLock(lock.fd)) { if (Date.now() > deadline) throw failure('Notes storage is completing its original change. Retry the same operation.', 'NOTEBOOK_BUSY'); await delay(10) }; return await work() } finally { await lock.close() }
  }
  private persist(value: Location) { return durableWriteFile(this.locatorPath, JSON.stringify(value) + '\n', { requireDirectorySync: true }) }
  private async readCatalog(path: string, required = false): Promise<NotebookState> { try { return parseNotebookState(JSON.parse(await readFile(path, 'utf8'))) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { if (required) throw failure('The original confirmed Notebook catalog is unavailable.', 'NOTEBOOK_READ_UNCONFIRMED'); return emptyNotebookState() } throw e } }
  /** Bootstrap passes explicit legacy owners; it uses the exact same journal/cutover as Settings. */
  async change(input: NotesStorageChange, adoption?: { catalogPath: string; workspace: { id: string; hostId: string; path: string }; destinationWorkspaceId: string }): Promise<NotesStorageSnapshot> {
    return this.withLock(async () => {
      if (!input.operationId?.trim() || !isAbsolute(input.directory) || !isAbsolute(input.expectedDirectory)) throw failure('Choose an absolute Notes directory and the original operation identity.', 'NOTES_STORAGE_INPUT_INVALID')
      let location = await this.location(); const existing = Object.hasOwn(location.operations, input.operationId) ? location.operations[input.operationId] : undefined
      if (existing) { if (existing.directory !== resolve(input.directory) || existing.expectedDirectory !== resolve(input.expectedDirectory)) throw failure('This operation identity belongs to a different directory change.', 'NOTES_STORAGE_INPUT_INVALID'); if (existing.phase === 'prepared') await this.finish(location, existing); else await this.cleanup(existing); return this.inspect(input.operationId) }
      if (location.pending) throw failure('Another Notes directory change needs recovery first.', 'NOTEBOOK_BUSY')
      if (location.directory !== resolve(input.expectedDirectory)) throw failure('The Notes directory changed after this setting was opened.', 'CONFIG_CONFLICT')
      const destination = resolve(input.directory), sourceRoot = location.directory
      if (!adoption && destination === sourceRoot) return this.inspect()
      const nested = (parent: string, child: string) => { const path = relative(parent, child); return path !== '' && !path.startsWith('..') && !isAbsolute(path) }
      if (destination !== sourceRoot && (nested(sourceRoot, destination) || nested(destination, sourceRoot))) throw failure('The new Notes directory must be outside the old directory.', 'NOTES_STORAGE_INPUT_INVALID')
      await mkdir(destination, { recursive: true, mode: 0o700 })
      if ((await lstat(destination)).isSymbolicLink()) throw failure('Choose the actual Notes directory rather than a symbolic link.', 'NOTES_STORAGE_INPUT_INVALID')
      const sourceCatalog = adoption?.catalogPath ?? join(sourceRoot, 'notebooks.json')
      let catalog = await this.readCatalog(sourceCatalog, !!location.catalogEstablished || Object.keys(location.operations).length > 0)
      if (join(destination, 'notebooks.json') !== sourceCatalog) { try { const occupiedCatalog = parseNotebookState(JSON.parse(await readFile(join(destination, 'notebooks.json'), 'utf8'))); if (JSON.stringify(occupiedCatalog) !== JSON.stringify(catalog)) throw failure('The target already contains another Notebook directory.', 'NOTES_STORAGE_CONFLICT') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
      const resourceChanges: NotesResourceChange[] = [], files: NotesStorageOperation['files'] = []
      for (const page of Object.values(catalog.pages)) {
        const r = page.resource
        const owned = adoption ? r.hostId === adoption.workspace.hostId && r.workspaceId === adoption.workspace.id && r.workspacePath === adoption.workspace.path && !r.path.includes('/') : r.hostId === 'local' && r.workspacePath === sourceRoot
        if (!owned) continue
        const source = resolve(r.workspacePath, r.path), destinationFile = resolve(destination, r.path)
        if (!nested(r.workspacePath, source) || !nested(destination, destinationFile)) throw failure('A Note resource escaped its original directory.', 'NOTES_STORAGE_INPUT_INVALID')
        if (!(await lstat(source)).isFile() || !nested(await realpath(r.workspacePath), await realpath(source))) throw failure('The original Note file cannot be confirmed.')
        const bytes = await readFile(source), document = JSON.parse(bytes.toString())
        if (document.noteId !== page.noteId) throw failure('The original Note identity does not match its file.')
        files.push({ source, destination: destinationFile, hash: digest(bytes) })
        const to = { ...r, workspacePath: destination, ...(adoption ? { workspaceId: adoption.destinationWorkspaceId } : {}) }
        resourceChanges.push({ noteId: page.noteId, from: r, to })
        catalog = applyNotebookChange(catalog, { expectedRevision: catalog.revision, operationId: input.operationId + ':' + page.noteId, change: { kind: 'relocate', noteId: page.noteId, from: r, resource: to } }, { kind: 'user', id: 'notes-directory-owner' }, Date.now())
      }
      if (!adoption) {
        const registeredFiles = new Set(files.map(file => file.source)), noteIds = new Set(Object.keys(catalog.pages))
        const collect = async (directory: string) => {
          for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT' && directory === sourceRoot) return []; throw error })) {
            const source = join(directory, entry.name)
            if (entry.isDirectory()) { await collect(source); continue }
            if (!entry.name.endsWith('.note.json') || registeredFiles.has(source)) continue
            if (!entry.isFile()) throw failure('A managed Note is not an ordinary file. Confirm its original owner before moving.', 'NOTES_STORAGE_INPUT_INVALID')
            const bytes = await readFile(source), document = JSON.parse(bytes.toString())
            if (document.schema !== 'agentmux.note.v1' || typeof document.noteId !== 'string' || !document.noteId.trim() || noteIds.has(document.noteId)) throw failure('A managed Note identity or format could not be confirmed.')
            noteIds.add(document.noteId)
            const path = relative(sourceRoot, source), from = { hostId: 'local', workspaceId: NOTES_RESOURCE_WORKSPACE_ID, workspacePath: sourceRoot, path }, to = { ...from, workspacePath: destination }
            files.push({ source, destination: join(destination, path), hash: digest(bytes) }); resourceChanges.push({ noteId: document.noteId, from, to })
          }
        }
        await collect(sourceRoot)
      }
      const operation: NotesStorageOperation = { ...input, directory: destination, expectedDirectory: sourceRoot, phase: 'prepared', resourceChanges, files, catalog, sourceCatalog, sourceCatalogHash: digest(await readFile(sourceCatalog).catch(error => { if (error.code !== 'ENOENT') throw error; return Buffer.alloc(0) })) }
      location = { ...location, pending: input.operationId, operations: { ...location.operations, [input.operationId]: operation } }; await this.persist(location); await this.finish(location, operation); return this.inspect(input.operationId)
    })
  }
  private async finish(location: Location, operation: NotesStorageOperation): Promise<void> {
    for (const file of operation.files) {
      const bytes = await readFile(file.source)
      if (digest(bytes) !== file.hash) throw failure('A Note changed while its directory operation was prepared.', 'NOTES_STORAGE_CONFLICT')
      await mkdir(dirname(file.destination), { recursive: true, mode: 0o700 })
      const targetRoot = await realpath(operation.directory), parent = await realpath(dirname(file.destination)), parentRelative = relative(targetRoot, parent)
      if (parentRelative.startsWith('..') || isAbsolute(parentRelative)) throw failure('The target file escaped its Notes directory.', 'NOTES_STORAGE_INPUT_INVALID')
      if (file.destination === file.source) continue
      try { if (!(await lstat(file.destination)).isFile()) throw failure('The destination is not an ordinary Note file.', 'NOTES_STORAGE_CONFLICT'); if (digest(await readFile(file.destination)) !== file.hash) throw failure('The target already contains a different Note file.', 'NOTES_STORAGE_CONFLICT') }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; await durableWriteFile(file.destination, bytes, { requireDirectorySync: true }) }
      if (digest(await readFile(file.destination)) !== file.hash) throw failure('The copied Note bytes could not be confirmed.')
    }
    await durableWriteFile(join(operation.directory, 'notebooks.json'), JSON.stringify(operation.catalog) + '\n', { requireDirectorySync: true })
    operation.phase = 'committed'; location.directory = operation.directory; location.pending = null; await this.persist(location)
    await this.cleanup(operation)
  }
  private async cleanup(operation: NotesStorageOperation): Promise<void> {
    await this.ports.beforeSourceCleanup?.(operation.resourceChanges)
    // A retained source is recovery evidence, never a second writable owner. Delete only confirmed owned bytes.
    for (const file of operation.files) if (file.source !== file.destination && digest(await readFile(file.source).catch(() => Buffer.alloc(0))) === file.hash) await unlink(file.source)
    if (operation.sourceCatalog !== join(operation.directory, 'notebooks.json')) {
      const original = await readFile(operation.sourceCatalog).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
      if (original && digest(original) === operation.sourceCatalogHash) await unlink(operation.sourceCatalog)
    }
  }
  async bootstrap(legacy: { catalogPath: string; workspace: { id: string; hostId: string; path: string }; destinationWorkspaceId: string }): Promise<NotesStorageSnapshot> {
    await this.withLock(async () => {
      try { await readFile(this.locatorPath); return } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      try { await readFile(legacy.catalogPath) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e }
      await this.persist({ schemaVersion: 1, directory: dirname(legacy.catalogPath), operations: {}, pending: null })
    })
    const current = await this.inspect()
    if (current.directory !== dirname(legacy.catalogPath)) {
      await this.resume()
      const catalog = await this.readCatalog(current.catalogPath, await this.catalogEstablished())
      if (!Object.values(catalog.pages).some(p => p.resource.hostId === legacy.workspace.hostId && p.resource.workspaceId === legacy.workspace.id && p.resource.workspacePath === legacy.workspace.path && !p.resource.path.includes('/'))) return this.inspect()
      return this.change({ operationId: 'adopt-original-note-resources', expectedDirectory: current.directory, directory: current.directory }, { ...legacy, catalogPath: current.catalogPath })
    }
    return this.change({ operationId: 'adopt-original-notes-directory', expectedDirectory: current.directory, directory: this.initialDirectory }, legacy)
  }
  async resume(): Promise<void> { await this.withLock(async () => { const location = await this.location(); if (location.pending) await this.finish(location, location.operations[location.pending]! ) }) }
}
