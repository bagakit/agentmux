import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { durableWriteFile } from './durable-write.js'
import { AgentMuxNotesStorage, defaultNotesDirectory, withNotesStorageFileLock } from './notes-storage.js'
import { AgentMuxError } from './errors.js'
import { applyNotebookChange, emptyNotebookState, notebookFingerprint, parseNotebookState, type NoteResource, type NotebookActor, type NotebookObservation, type NotebookState, type NotebookWrite } from './notebook-catalog.js'
import { NOTEBOOK_ROOT_NAME, notebookFileRoot, notebookFilesLocated, initializeNotebookFiles, readNotebookFiles, readNotebookProvenance, writeNotebookFiles, readNotebookHistory, writeNotebookHistory, readNotebookHistoryProvenance, readNotebookHistoryOperation, readNotebookHistoryBatch } from './notebook-files.js'
import { parseNoteProvenanceWrite, type NoteProvenanceQuery, type NoteProvenanceSnapshot, type NoteProvenanceWrite } from './note-provenance.js'
import { parseNoteFileTitle, parseNoteTitleIntent, parseNoteTitleOperation, type NoteTitlePort, type NoteTitleIntent, type NoteTitleOperation, type NoteFileTitle, type NoteTitleProjection, type NoteTitleInspection } from './note-title.js'
import { noteProvenanceResourceKey } from './note-provenance.js'
import { parseNoteHistoryQuery, parseNoteHistoryRecord, type NoteHistoryQuery, type NoteHistoryRecord, type NoteHistorySnapshot, type NoteHistoryEntry } from './note-history.js'
export * from './notes-storage.js'
export * from './notebook-catalog.js'
export * from './note-provenance.js'
export * from './note-history.js'
/** The stable original catalog lock also serializes attribution and directory publication. */
export async function withNotebookFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  return withNotesStorageFileLock(path, work)
}
/** One durable local-file metadata owner. Original Markdown bodies remain with Files. */
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
  constructor(path?: string, storage = new AgentMuxNotesStorage(), private readonly options: { title?: NoteTitlePort } = {}) {
    this.storage = path === undefined ? storage : null
    this.currentPath = notebookFileRoot(path ?? join(defaultNotesDirectory(), NOTEBOOK_ROOT_NAME))
    this.legacyPath = this.currentPath.slice(0, -'.root.json'.length) + '.json'
    if (!isAbsolute(this.currentPath)) throw new AgentMuxError('Notebook storage needs an absolute owner path.', 'NOTEBOOK_INPUT_INVALID')
  }
  private async locate(writing = false): Promise<void> {
    if (!this.storage) return
    await this.ready()
    const observed = await this.storage.inspect()
    if (writing && observed.operation) throw new AgentMuxError('The original Notes directory change needs recovery. Saved pages and unrelated work remain available.', 'NOTEBOOK_BUSY')
    this.currentPath = notebookFileRoot(observed.catalogPath)
    this.legacyPath = this.currentPath.slice(0, -'.root.json'.length) + '.json'
  }
  private withWriteLock<T>(work: () => Promise<T>) {
    return withNotebookFileLock(this.legacyPath, () => withNotebookFileLock(this.path, work))
  }
  private async requireEstablishedRoot(): Promise<void> {
    if (this.confirmedPath === this.path || this.storage && await this.storage.fileAuthorityEstablished()) {
      try { await stat(this.path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AgentMuxError('The confirmed original Notebook file root is missing; older inputs were not substituted.', 'NOTEBOOK_READ_UNCONFIRMED')
        throw error
      }
    }
  }
  private confirmedPath: string | null = null
  /** First read establishes the selected file owner; subsequent exact metadata reads never load the catalog. */
  private async ensureReadableFiles(): Promise<void> {
    await this.locate()
    await this.requireEstablishedRoot()
    if (this.confirmedPath === this.path || await notebookFilesLocated(this.path)) { this.confirmedPath = this.path; return }
    let input = false
    for (const path of [this.path, this.legacyPath, this.path.slice(0, -'.root.json'.length) + '.sqlite', this.path.slice(0, -'.root.json'.length) + '.sqlite.sqlite-identity', this.path + '.importing.json']) {
      try { await readFile(path); input = true; break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (!input) {
      if (this.storage && await this.storage.catalogEstablished()) throw new AgentMuxError('The confirmed original Notebook root is missing.', 'NOTEBOOK_READ_UNCONFIRMED')
      return
    }
    const initialize = async () => {
      await this.locate(true)
      await this.withWriteLock(async () => {
        await initializeNotebookFiles(this.path, this.legacyPath, true)
        if (this.storage) await this.storage.confirmCatalog()
      })
    }
    if (this.storage) await this.storage.withLock(initialize); else await initialize()
    this.confirmedPath = this.path
  }
  async read(): Promise<NotebookState> {
    try {
      await this.ensureReadableFiles()
      return (await readNotebookFiles(this.path, false))?.state ?? emptyNotebookState()
    } catch (error) {
      throw new AgentMuxError('The Notebook directory could not be read. Original bytes, Note files and work surfaces are kept; restore or repair this same catalog.', 'NOTEBOOK_READ_UNCONFIRMED', error instanceof Error ? error.message : String(error))
    }
  }
  /** Ownership presence only; an unavailable original owner remains authoritative. */
  hasTitleOwner(): boolean { return this.options.title !== undefined }
  /** Trusted file/history actions share the original reentrant owner lease, including explicit-path hosts. */
  async runWithWriteLease<T>(work: () => Promise<T>): Promise<T> {
    await this.ready()
    return this.storage ? this.storage.withLock(work) : this.withWriteLock(work)
  }
  async apply(input: NotebookWrite, actor: NotebookActor): Promise<NotebookState> {
    const original = structuredClone(input), originalActor = structuredClone(actor)
    const run = () => original?.change?.kind === 'rename-page' ? this.renamePage(original, originalActor) : this.write(original, originalActor)
    return this.runWithWriteLease(run)
  }
  private titleFailure(message: string, code = 'NOTE_TITLE_OPERATION_UNCONFIRMED'): never {
    throw new AgentMuxError(message + ' Run notebook inspect --operation-id with this same operation; original files, history and other work are retained.', code)
  }
  private async originalCatalog() {
    if (this.storage && await this.storage.fileAuthorityEstablished() && !await readNotebookFiles(this.path, false)) throw new AgentMuxError('The confirmed original Notebook file root is missing. Original files are retained.', 'NOTEBOOK_READ_UNCONFIRMED')
    return initializeNotebookFiles(this.path, this.legacyPath, !!this.storage && await this.storage.catalogEstablished())
  }
  private async publishCatalog(before: NotebookState, next: NotebookState): Promise<NotebookState> {
    if (next === before) return before
    await durableWriteFile(this.path + '.previous', JSON.stringify(before) + '\n', { requireDirectorySync: true })
    await writeNotebookFiles(this.path, { state: next })
    if (this.storage) await this.storage.confirmCatalog()
    this.emit({ state: next }); return next
  }
  private async fileTitle(noteId: string, resource: NoteResource): Promise<NoteFileTitle> {
    if (!this.options.title) return { status: 'unknown', noteId, resource: structuredClone(resource), reason: 'The original Host title reader is unavailable.' }
    try {
      const current = parseNoteFileTitle(await this.options.title.current(noteId, structuredClone(resource)))
      if (current.noteId !== noteId || noteProvenanceResourceKey(current.resource) !== noteProvenanceResourceKey(resource)) throw new Error('The original title reader returned another Note or resource.')
      return current
    } catch (error) { return { status: 'unknown', noteId, resource: structuredClone(resource), reason: error instanceof Error ? error.message : String(error) } }
  }
  private assertTitleRequest(operation: Extract<NoteTitleOperation, { status: 'recorded' }>, input: NotebookWrite, actor: NotebookActor): void {
    if (input.change.kind !== 'rename-page' || operation.intent.noteId !== input.change.noteId || operation.intent.title !== input.change.title.trim() || notebookFingerprint(operation.intent.actor) !== notebookFingerprint(actor)) this.titleFailure('This operation belongs to another original title request or author.', 'NOTE_TITLE_OPERATION_CONFLICT')
  }
  private async renamePage(input: NotebookWrite, actor: NotebookActor): Promise<NotebookState> {
    if (!this.options.title) this.titleFailure('The original Host title writer is unavailable; no metadata-only rename was applied.', 'NOTE_TITLE_UNAVAILABLE')
    const change = input.change
    if (change.kind !== 'rename-page' || typeof input.operationId !== 'string' || !input.operationId || /[\0\r\n]/u.test(input.operationId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
        Object.keys(input).some(key => !['operationId','expectedRevision','change'].includes(key)) || Object.keys(change).some(key => !['kind','noteId','title'].includes(key)) || typeof change.noteId !== 'string' || !change.noteId || typeof change.title !== 'string' || !change.title.trim() || /[\0\r\n]/u.test(change.title)) throw new AgentMuxError('An exact original Note title intent is required.', 'NOTEBOOK_INPUT_INVALID')
    // Inspect the original file operation before a new catalog CAS. A committed file write is
    // already applied even when its catalog publication failed or the file later changed again.
    let operation = parseNoteTitleOperation(await this.options.title.inspect(input.operationId), input.operationId)
    if (operation.status === 'absent') {
      await this.locate(true)
      const intent = await this.withWriteLock(async () => {
        const before = await this.originalCatalog()
        applyNotebookChange(before.state, input, actor, Date.now()) // validate the exact new catalog CAS without publishing a title
        if (Object.hasOwn(before.state.operations, input.operationId)) this.titleFailure('This original metadata operation has no confirmed file title event; it was not replayed.')
        const page = before.state.pages[change.noteId]!
        return parseNoteTitleIntent({ operationId: input.operationId, noteId: change.noteId, resource: page.resource, title: change.title.trim(), actor })
      })
      // The original async owner lease is reentrant. Default storage releases the inner
      // catalog lock here; an explicit-path Host reuses its outer catalog lease.
      operation = parseNoteTitleOperation(await this.options.title.write(intent), input.operationId)
    }
    if (operation.status !== 'recorded') this.titleFailure(operation.status === 'different-operation' ? 'This identity belongs to a different original operation.' : 'The original file title outcome is unavailable; no replay was attempted.', operation.status === 'different-operation' ? 'NOTE_TITLE_OPERATION_CONFLICT' : 'NOTE_TITLE_OPERATION_UNCONFIRMED')
    this.assertTitleRequest(operation, input, actor)
    if (operation.history.status !== 'committed') this.titleFailure('The original title event is ' + operation.history.status + '; current file bytes do not prove it committed.', operation.history.status === 'not-applied' ? 'NOTE_TITLE_NOT_APPLIED' : 'NOTE_TITLE_OPERATION_UNCONFIRMED')
    try {
      await this.locate(true)
      return await this.withWriteLock(async () => {
        const before = await this.originalCatalog(), page = before.state.pages[operation.intent.noteId]
        if (!page || noteProvenanceResourceKey(page.resource) !== noteProvenanceResourceKey(operation.resource)) this.titleFailure('The original title event and current catalog resource cannot be reconciled.', 'NOTE_TITLE_PROJECTION_UNCONFIRMED')
        const existing = before.state.operations[input.operationId], fingerprint = notebookFingerprint(input.change)
        if (existing && (existing.fingerprint !== fingerprint || notebookFingerprint(existing.actor) !== notebookFingerprint(actor))) this.titleFailure('This catalog identity already records another request or actor.', 'NOTE_TITLE_OPERATION_CONFLICT')
        const current = await this.fileTitle(page.noteId, page.resource)
        if (current.status !== 'read') this.titleFailure('The file title operation committed, but its current original title is not confirmed.', 'NOTE_TITLE_PROJECTION_UNCONFIRMED')
        if (existing && page.title === current.title) return before.state
        const next = parseNotebookState(before.state)
        next.pages[page.noteId]!.title = current.title
        // This is an observation/acknowledgement, not a second rename journal or forged author trail.
        next.operations[input.operationId] = { fingerprint, actor: structuredClone(actor) }
        next.revision++
        return this.publishCatalog(before.state, next)
      })
    } catch (error) {
      if (error instanceof AgentMuxError && ['NOTE_TITLE_OPERATION_CONFLICT', 'NOTE_TITLE_PROJECTION_UNCONFIRMED'].includes(error.code)) throw error
      this.titleFailure('The original file title committed, but catalog publication is unconfirmed: ' + (error instanceof Error ? error.message : String(error)), 'NOTE_TITLE_PROJECTION_UNCONFIRMED')
    }
  }
  /** Host-internal best effort projection after a body write. It cannot change the body receipt. */
  async refreshFileTitle(noteId: string, resource: NoteResource): Promise<NoteTitleProjection> {
    const original = structuredClone(resource)
    if (!this.options.title) return { status: 'unconfirmed', noteId, resource: original, code: 'host-unavailable', message: 'The original Host title reader is unavailable.' }
    try {
      await this.ready()
      const run = async (): Promise<NoteTitleProjection> => {
        await this.locate(true)
        return this.withWriteLock(async () => {
          const before = await this.originalCatalog(), page = before.state.pages[noteId]
          if (!page) return { status: 'not-registered', noteId, resource: original }
          if (noteProvenanceResourceKey(page.resource) !== noteProvenanceResourceKey(original)) return { status: 'unconfirmed', noteId, resource: original, code: 'resource-mismatch', message: 'This Note belongs to another confirmed catalog resource.' }
          const current = await this.fileTitle(noteId, original)
          if (current.status !== 'read') return { status: 'unconfirmed', noteId, resource: original, code: 'source-unconfirmed', message: 'The current original file title is ' + current.status + '.' }
          let revision = before.state.revision
          if (page.title !== current.title) {
            const next = parseNotebookState(before.state)
            next.pages[noteId]!.title = current.title; next.revision++
            revision = (await this.publishCatalog(before.state, next)).revision
          }
          return { status: 'projected', noteId, resource: original, revision: current.revision, title: current.title, catalogRevision: revision }
        })
      }
      return this.storage ? await this.storage.withLock(run) : await run()
    } catch (error) { return { status: 'unconfirmed', noteId, resource: original, code: 'catalog-unavailable', message: error instanceof Error ? error.message : String(error) } }
  }
  /** Typed, read-only recovery facts. Prepared/unknown history never becomes committed from a digest. */
  async inspectTitleOperation(operationId: string): Promise<NoteTitleInspection> {
    let operation: NoteTitleOperation
    try { operation = this.options.title ? parseNoteTitleOperation(await this.options.title.inspect(operationId), operationId) : { status: 'unavailable', operationId, reason: 'The original Host title operation reader is unavailable.' } }
    catch (error) { operation = { status: 'unavailable', operationId, reason: error instanceof Error ? error.message : String(error) } }
    if (operation.status !== 'recorded') return { operation, file: null, projection: null }
    const file = await this.fileTitle(operation.intent.noteId, operation.resource)
    let projection: NoteTitleProjection
    try {
      const state = await this.read(), page = state.pages[operation.intent.noteId]
      projection = !page ? { status: 'not-registered', noteId: operation.intent.noteId, resource: operation.resource }
        : noteProvenanceResourceKey(page.resource) !== noteProvenanceResourceKey(operation.resource) ? { status: 'unconfirmed', noteId: operation.intent.noteId, resource: operation.resource, code: 'resource-mismatch', message: 'The catalog page names another original resource.' }
        : file.status === 'read' && page.title === file.title ? { status: 'projected', noteId: file.noteId, resource: file.resource, revision: file.revision, title: file.title, catalogRevision: state.revision }
        : { status: 'unconfirmed', noteId: operation.intent.noteId, resource: operation.resource, code: 'projection-mismatch', message: 'The current file title and catalog projection are not confirmed equal.' }
    } catch (error) { projection = { status: 'unconfirmed', noteId: operation.intent.noteId, resource: operation.resource, code: 'catalog-unavailable', message: error instanceof Error ? error.message : String(error) } }
    return { operation, file, projection }
  }
  private async write(input: NotebookWrite, actor: NotebookActor): Promise<NotebookState> {
    await this.locate(true)
    return this.withWriteLock(async () => {
      if (this.storage && await this.storage.fileAuthorityEstablished() && !await readNotebookFiles(this.path, false)) throw new AgentMuxError('The confirmed original Notebook file root is missing. Original files are retained.', 'NOTEBOOK_READ_UNCONFIRMED')
      const before = await initializeNotebookFiles(this.path, this.legacyPath, !!this.storage && await this.storage.catalogEstablished())
      const next = applyNotebookChange(before.state, input, actor, Date.now())
      if (next !== before.state) await durableWriteFile(this.path + '.previous', JSON.stringify(before.state) + '\n', { requireDirectorySync: true })
      const relocation = next !== before.state && input.change.kind === 'relocate'
        ? { noteId: input.change.noteId, from: before.state.pages[input.change.noteId]!.resource, to: next.pages[input.change.noteId]!.resource }
        : undefined
      await writeNotebookFiles(this.path, { state: next, ...(relocation ? { relocation } : {}) })
      if (this.storage) await this.storage.confirmCatalog()
      this.emit({ state: next }); return next
    })
  }
  async readProvenance(query: NoteProvenanceQuery): Promise<NoteProvenanceSnapshot> {
    parseNoteProvenanceWrite({ noteId: query.noteId, resource: query.resource, revision: query.revision, blocks: Object.fromEntries(query.blockIds.map(id => [id, { created: null, lastEdited: null }])) })
    await this.ensureReadableFiles()
    const provenance = await readNotebookProvenance(this.path, query)
    // Historical events distinguish a new edit/restore even when its body digest repeats.
    let latest: Awaited<ReturnType<typeof readNotebookHistoryProvenance>>
    try { latest = await readNotebookHistoryProvenance(this.path, query) }
    catch (error) { return { ...provenance, status: 'unconfirmed', reason: error instanceof Error ? error.message : String(error),
      blocks: Object.fromEntries(query.blockIds.map(id => [id, { created: provenance.blocks[id]?.created ?? null, lastEdited: null }])) } }
    if (latest?.status === 'committed' && latest.revision === query.revision && latest.provenance && query.blockIds.every(id => Object.hasOwn(latest.provenance!.blocks, id))) {
      const blocks = Object.fromEntries(query.blockIds.map(id => [id, latest.provenance!.blocks[id]!]))
      const { reason: _reason, ...baseline } = provenance
      return { ...baseline, blocks, status: 'recorded' }
    }
    if (latest && (['prepared', 'unconfirmed'].includes(latest.status) || latest.revision !== query.revision)) return {
      ...provenance, status: 'unconfirmed', reason: 'The latest original write or observed body is unconfirmed; a historical digest cannot confirm its current author or receipt.',
      blocks: Object.fromEntries(query.blockIds.map(id => [id, { created: provenance.blocks[id]?.created ?? null, lastEdited: null }]))
    }
    return provenance
  }
  async readHistory(query: NoteHistoryQuery): Promise<NoteHistorySnapshot> {
    const original = parseNoteHistoryQuery(query)
    await this.ensureReadableFiles()
    return readNotebookHistory(this.path, original)
  }
  /** Trusted history action owner: exact full batch metadata, not a public pagination bypass. */
  async readHistoryBatch(query: Pick<NoteHistoryQuery, 'noteId' | 'resource'> & { batchId: string }): Promise<NoteHistoryEntry[]> {
    const original = parseNoteHistoryQuery({ noteId: query.noteId, resource: query.resource })
    if (typeof query.batchId !== 'string' || !query.batchId || /[\0\r\n]/u.test(query.batchId)) throw new AgentMuxError('An exact original history batch is required.', 'NOTE_HISTORY_INVALID')
    const input = { noteId: original.noteId, resource: original.resource, batchId: query.batchId }
    const run = async () => { await this.ensureReadableFiles(); return this.withWriteLock(() => readNotebookHistoryBatch(this.path, input)) }
    return this.storage ? this.storage.withLock(run) : run()
  }
  /** Original writer only: includes the private request fingerprint, never exposed by file.history. */
  async readHistoryOperation(eventId: string): Promise<NoteHistoryRecord | undefined> {
    if (typeof eventId !== 'string' || !eventId || /[\0\r\n]/u.test(eventId)) throw new AgentMuxError('An original operation identity is required.', 'NOTE_HISTORY_INVALID')
    const run = async () => { await this.ensureReadableFiles(); return this.withWriteLock(() => readNotebookHistoryOperation(this.path, eventId)) }
    return this.storage ? this.storage.withLock(run) : run()
  }
  /** Trusted host-internal journal port; body callers cannot submit authors or event outcomes. */
  async recordHistory(input: NoteHistoryRecord): Promise<NoteHistoryRecord> {
    const value = parseNoteHistoryRecord(input)
    await this.ready()
    const run = async () => {
      await this.locate(true)
      return this.withWriteLock(async () => {
        await this.requireEstablishedRoot()
        if (!await notebookFilesLocated(this.path)) await initializeNotebookFiles(this.path, this.legacyPath, !!this.storage && await this.storage.catalogEstablished())
        const saved = await writeNotebookHistory(this.path, value)
        if (this.storage) await this.storage.confirmCatalog()
        return saved
      })
    }
    return this.storage ? this.storage.withLock(run) : run()
  }
  /** Host-internal trusted writer/import port, never a caller-provided author RPC. */
  async recordProvenance(input: NoteProvenanceWrite): Promise<NoteProvenanceSnapshot> {
    const value = parseNoteProvenanceWrite(input)
    await this.ready()
    const run = async () => {
      await this.locate(true)
      await this.withWriteLock(async () => {
        await this.requireEstablishedRoot()
        if (!await notebookFilesLocated(this.path)) await initializeNotebookFiles(this.path, this.legacyPath, !!this.storage && await this.storage.catalogEstablished())
        await writeNotebookFiles(this.path, { provenance: value })
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
