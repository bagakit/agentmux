import { watch, type FSWatcher } from 'node:fs'
import { mkdir, open, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { durableWriteFile } from './durable-write.js'
import { AgentMuxNotesStorage, defaultNotesDirectory } from './notes-storage.js'
export * from './notes-storage.js'
import { AgentMuxError } from './errors.js'
import { applyNotebookChange, emptyNotebookState, parseNotebookState, type NotebookActor, type NotebookObservation, type NotebookState, type NotebookWrite } from './notebook-catalog.js'
export * from './notebook-catalog.js'
const nativeRequire = createRequire(import.meta.url)
/** One durable catalog, independent from App windows, open documents and spatial lifecycle. */
export class AgentMuxNotebookStore {
  readonly storage: AgentMuxNotesStorage | null
  private initialized: Promise<void> | null = null
  private ready(): Promise<void> {
    if (!this.storage) return Promise.resolve()
    return this.initialized ??= this.storage.hasLocation().then(async established => { if (!established) await this.storage!.bootstrap({ catalogPath: join(dirname(this.storage!.locatorPath), 'notebooks.json'), workspace: { id: 'external', hostId: 'unmanaged', path: '/' }, destinationWorkspaceId: 'external' }) }).catch(error => { this.initialized = null; throw error })
  }
  private currentPath: string
  get path(): string { return this.currentPath }
  constructor(path?: string, storage = new AgentMuxNotesStorage()) {
    this.storage = path === undefined ? storage : null
    this.currentPath = path ?? join(defaultNotesDirectory(), 'notebooks.json')
    path = this.currentPath
    if(!isAbsolute(path))throw new AgentMuxError('Notebook storage needs an absolute owner path.','NOTEBOOK_INPUT_INVALID')
  }
  async read(): Promise<NotebookState> {
    if (this.storage) { await this.ready(); this.currentPath = (await this.storage.inspect()).catalogPath }
    try{return parseNotebookState(JSON.parse(await readFile(this.path,'utf8')))}catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT' && (!this.storage || !(await this.storage.catalogEstablished())))return emptyNotebookState()
      throw new AgentMuxError('The Notebook directory could not be read. Original bytes, Note files and work surfaces are kept; restore or repair this same catalog.','NOTEBOOK_READ_UNCONFIRMED',error instanceof Error?error.message:String(error))
    }
  }
  async apply(input: NotebookWrite, actor: NotebookActor): Promise<NotebookState> {
    if (this.storage) { await this.ready(); return this.storage.withLock(() => this.write(input, actor)) }
    return this.write(input, actor)
  }
  private async write(input: NotebookWrite, actor: NotebookActor): Promise<NotebookState> {
    if (this.storage) { const storage = await this.storage.inspect(); if (storage.operation) throw new AgentMuxError('The original Notes directory change needs recovery. Saved pages and unrelated work remain available.', 'NOTEBOOK_BUSY'); this.currentPath = storage.catalogPath }
    await mkdir(dirname(this.path),{recursive:true,mode:0o700})
    const lock=await open(this.path+'.lock','a+',0o600)
    try{
      const native:{tryLock(fd:number):boolean}=nativeRequire('fs-native-extensions'),deadline=Date.now()+5000
      while(!native.tryLock(lock.fd)){if(Date.now()>=deadline)throw new AgentMuxError('The original Notebook writer is busy. Keep the page and retry this same operation.','NOTEBOOK_BUSY');await delay(10)}
      const before=await this.read(),next=applyNotebookChange(before,input,actor,Date.now())
      if(next!==before)await durableWriteFile(this.path+'.previous',JSON.stringify(before)+'\n',{requireDirectorySync:true})
      // Reapplying an exact operation confirms the same current bytes after an unknown flush; it never rewrites Note bodies or repeats history.
      await durableWriteFile(this.path,JSON.stringify(next)+'\n',{requireDirectorySync:true})
      if (this.storage) await this.storage.confirmCatalog()
      this.emit({state:next});return next
    }finally{await lock.close()}
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
