import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { durableWriteFile } from './durable-write.js'
import { AgentMuxNotesStorage, defaultNotesDirectory, withNotesStorageFileLock } from './notes-storage.js'
import { AgentMuxError } from './errors.js'
import { applyNotebookChange, emptyNotebookState, type NotebookActor, type NotebookObservation, type NotebookState, type NotebookWrite } from './notebook-catalog.js'
import { NOTEBOOK_DATABASE_NAME, initializeNotebookDatabase, readNotebookDatabase, readNotebookProvenance, writeNotebookDatabase } from './notebook-database.js'
import { parseNoteProvenanceWrite, type NoteProvenanceQuery, type NoteProvenanceSnapshot, type NoteProvenanceWrite } from './note-provenance.js'
export * from './notes-storage.js'
export * from './notebook-catalog.js'
export * from './note-provenance.js'
const sqlitePath = (path: string) => path.endsWith('.json') ? path.slice(0, -5) + '.sqlite' : path
/** The stable original catalog lock also serializes attribution and directory publication. */
export async function withNotebookDatabaseLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  return withNotesStorageFileLock(path, work)
}
/** One durable SQLite metadata owner. Original Markdown bodies remain with Files. */
export class AgentMuxNotebookStore {
  readonly storage: AgentMuxNotesStorage | null
  private initialized: Promise<void> | null = null
  private ready(): Promise<void> {
    if (!this.storage) return Promise.resolve()
    return this.initialized ??= this.storage.hasLocation().then(async established => {
      if (!established) await this.storage!.bootstrap({ catalogPath: join(dirname(this.storage!.locatorPath), 'notebooks.json'), workspace: { id: 'external', hostId: 'unmanaged', path: '/' }, destinationWorkspaceId: 'external' })
    }).catch(error => { this.initialized = null; throw error })
  }
  private currentPath: string
  private legacyPath: string
  get path(): string { return this.currentPath }
  constructor(path?: string, storage = new AgentMuxNotesStorage()) {
    this.storage = path === undefined ? storage : null
    this.currentPath = sqlitePath(path ?? join(defaultNotesDirectory(), NOTEBOOK_DATABASE_NAME))
    this.legacyPath = path?.endsWith('.json') ? path : join(dirname(this.currentPath), 'notebooks.json')
    if (!isAbsolute(this.currentPath)) throw new AgentMuxError('Notebook storage needs an absolute owner path.', 'NOTEBOOK_INPUT_INVALID')
  }
  private async locate(writing = false): Promise<void> {
    if (!this.storage) return
    await this.ready()
    const observed = await this.storage.inspect()
    if (writing && observed.operation) throw new AgentMuxError('The original Notes directory change needs recovery. Saved pages and unrelated work remain available.', 'NOTEBOOK_BUSY')
    this.currentPath = sqlitePath(observed.catalogPath)
    this.legacyPath = observed.catalogPath.endsWith('.json') ? observed.catalogPath : join(dirname(this.currentPath), 'notebooks.json')
  }
  private withWriteLock<T>(work: () => Promise<T>) {
    return withNotebookDatabaseLock(this.legacyPath, () => withNotebookDatabaseLock(this.path, work))
  }
  async read(): Promise<NotebookState> {
    try {
      await this.locate()
      const current = await readNotebookDatabase(this.path, false)
      if (current) return current.state
      if (this.storage && await this.storage.databaseEstablished()) throw new Error('The confirmed original SQLite directory is missing.')
      let legacy = false
      try { await readFile(this.legacyPath); legacy = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (legacy) {
        const importOriginal = async () => {
          await this.locate(true)
          return this.withWriteLock(async () => {
            const imported = await initializeNotebookDatabase(this.path, this.legacyPath, true)
            if (this.storage) await this.storage.confirmCatalog()
            return imported.state
          })
        }
        return this.storage ? await this.storage.withLock(importOriginal) : await importOriginal()
      }
      if (this.storage && await this.storage.catalogEstablished()) throw new Error('The confirmed Notebook catalog is missing.')
      return emptyNotebookState()
    } catch (error) {
      throw new AgentMuxError('The Notebook directory could not be read. Original bytes, Note files and work surfaces are kept; restore or repair this same catalog.', 'NOTEBOOK_READ_UNCONFIRMED', error instanceof Error ? error.message : String(error))
    }
  }
  async apply(input: NotebookWrite, actor: NotebookActor): Promise<NotebookState> {
    await this.ready()
    const run = () => this.write(input, actor)
    return this.storage ? this.storage.withLock(run) : run()
  }
  private async write(input: NotebookWrite, actor: NotebookActor): Promise<NotebookState> {
    await this.locate(true)
    return this.withWriteLock(async () => {
      if (this.storage && await this.storage.databaseEstablished() && !await readNotebookDatabase(this.path, false)) throw new AgentMuxError('The confirmed original SQLite directory is missing. Original files are retained.', 'NOTEBOOK_READ_UNCONFIRMED')
      const before = await initializeNotebookDatabase(this.path, this.legacyPath, !!this.storage && await this.storage.catalogEstablished())
      const next = applyNotebookChange(before.state, input, actor, Date.now())
      if (next !== before.state) await durableWriteFile(this.path + '.previous', JSON.stringify(before.state) + '\n', { requireDirectorySync: true })
      await writeNotebookDatabase(this.path, { state: next })
      if (this.storage) await this.storage.confirmCatalog()
      this.emit({ state: next }); return next
    })
  }
  async readProvenance(query: NoteProvenanceQuery): Promise<NoteProvenanceSnapshot> {
    parseNoteProvenanceWrite({ noteId: query.noteId, resource: query.resource, revision: query.revision, blocks: Object.fromEntries(query.blockIds.map(id => [id, { created: null, lastEdited: null }])) })
    await this.locate()
    return readNotebookProvenance(this.path, query)
  }
  /** Host-internal trusted writer/import port, never a caller-provided author RPC. */
  async recordProvenance(input: NoteProvenanceWrite): Promise<NoteProvenanceSnapshot> {
    const value = parseNoteProvenanceWrite(input)
    await this.ready()
    const run = async () => {
      await this.locate(true)
      await this.withWriteLock(async () => {
        if (this.storage && await this.storage.databaseEstablished() && !await readNotebookDatabase(this.path, false)) throw new AgentMuxError('The confirmed original SQLite directory is missing. Original files are retained.', 'NOTEBOOK_READ_UNCONFIRMED')
        await initializeNotebookDatabase(this.path, this.legacyPath, !!this.storage && await this.storage.catalogEstablished())
        await writeNotebookDatabase(this.path, { provenance: value })
        if (this.storage) await this.storage.confirmCatalog()
      })
      return readNotebookProvenance(this.path, { ...value, blockIds: Object.keys(value.blocks) })
    }
    return this.storage ? this.storage.withLock(run) : run()
  }
  private listeners=new Set<(event:NotebookObservation)=>void>()
  private watcher:FSWatcher|null=null
  private generation=0
  private locationWatcher: FSWatcher | null = null
  private emit(event:NotebookObservation):void{for(const listener of this.listeners)try{listener(structuredClone(event))}catch(error){process.emitWarning(String(error),{code:'NOTEBOOK_OBSERVATION_FAILED'})}}
  subscribe(listener:(event:NotebookObservation)=>void):()=>void {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      const generation = ++this.generation
      let watchedPath: string | null = null
      const refresh = async () => {
        try {
          const state = await this.read()
          if (generation !== this.generation || !this.listeners.size) return
          if (watchedPath !== this.path) {
            this.watcher?.close(); await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
            watchedPath = this.path
            this.watcher = watch(dirname(this.path), (_kind, name) => { if (name === null || String(name) === basename(this.path)) void refresh() })
            this.watcher.on('error', error => this.emit({ issue: 'Notebook observation failed. Original knowledge is kept. ' + error.message }))
          }
          this.emit({state})
        } catch (error) { if (generation === this.generation) this.emit({issue: error instanceof Error ? error.message : String(error)}) }
      }
      if (this.storage) void mkdir(dirname(this.storage.locatorPath), { recursive: true, mode: 0o700 }).then(() => {
        if (generation !== this.generation || !this.listeners.size) return
        this.locationWatcher = watch(dirname(this.storage!.locatorPath), (_kind, name) => { if (name === null || String(name) === basename(this.storage!.locatorPath)) void refresh() })
        this.locationWatcher.on('error', error => this.emit({issue: String(error)})); void refresh()
      }).catch(error => this.emit({issue: String(error)}))
      else void refresh()
    }
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { this.generation++; this.watcher?.close(); this.watcher = null; this.locationWatcher?.close(); this.locationWatcher = null } }
  }
}
